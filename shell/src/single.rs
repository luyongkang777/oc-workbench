//! 单实例：同一 Windows 登录会话里只允许跑一个工作台。
//!
//! **为什么必须有**：开两个实例时「在线升级」会坏。
//!
//! 升级流程是「下载新 exe → 拉起替换脚本 → 本进程退出 → 脚本反复重试覆盖 exe →
//! 覆盖成功后 start 一次」。它只认**一个**目标文件：另一个实例仍占着旧 exe，
//! 覆盖就得一直重试到 120 次放弃；放弃分支还会照样 `start` 一次，
//! 最后可能是「两个窗口、版本还不一致」。用户感知就是「升级了但没生效 / 越升越乱」。
//!
//! 实现分两层：
//!   1. **窗口**：已经画出来的窗口最直观，先找它——双击两次时这一步立刻返回；
//!   2. **命名互斥体**：窗口还没画出来（启动中 / 正在退出）时靠它挡。
//!      `Local\` 前缀 = 按登录会话隔离，同一台机器不同用户互不干扰。
//!
//! 不用锁文件：进程被强杀时锁文件会残留、把以后所有启动都挡死；
//! 互斥体是内核对象，最后一个句柄关闭就消失。
//!
//! 重复启动不报错，而是把已经开着的窗口切到前台——双击两次是手滑，不该算故障。

#[cfg(windows)]
mod plat {
    use std::time::{Duration, Instant};

    /// 互斥体名字。`Local\` 让不同登录用户各开一个，互不影响。
    const MUTEX_NAME: &str = "Local\\oc-workbench-single-instance";
    /// 主窗口标题（main.rs 的 APP_TITLE 直接引用这个常量，别在两处各写一份）。
    pub const WINDOW_TITLE: &str = "OpenCode 工作台";

    /// 重复启动时最多等这么久「让老实例把窗口摆出来 / 把互斥体放掉」。
    ///
    /// 升级重启正好落在这个窗口期：老进程 `exit(0)` 之后脚本才替换 exe 并拉起新进程，
    /// 中间可能有几十到几百毫秒互斥体还没释放。等一会儿比「开不出来」好。
    pub const DUPLICATE_WAIT: Duration = Duration::from_secs(4);
    /// 找窗口 / 等互斥体的轮询间隔。
    const POLL: Duration = Duration::from_millis(100);
    /// 等窗口出现在前台的时间。
    const FOCUS_WAIT: Duration = Duration::from_secs(2);

    const ERROR_ALREADY_EXISTS: u32 = 183;
    const SW_RESTORE: i32 = 9;
    const SW_SHOW: i32 = 5;
    /// MB_OK | MB_ICONINFORMATION
    const MB_INFO: u32 = 0x40;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(
            attrs: *const std::ffi::c_void,
            owner: i32,
            name: *const u16,
        ) -> *mut std::ffi::c_void;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        fn GetLastError() -> u32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(class: *const u16, title: *const u16) -> *mut std::ffi::c_void;
        fn IsIconic(hwnd: *mut std::ffi::c_void) -> i32;
        fn ShowWindow(hwnd: *mut std::ffi::c_void, cmd: i32) -> i32;
        fn SetForegroundWindow(hwnd: *mut std::ffi::c_void) -> i32;
        fn MessageBoxW(
            hwnd: *mut std::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            utype: u32,
        ) -> i32;
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 本进程持有的单实例凭证；进程退出时内核自动回收。
    pub struct Instance {
        handle: *mut std::ffi::c_void,
    }

    impl Drop for Instance {
        fn drop(&mut self) {
            if !self.handle.is_null() {
                unsafe {
                    CloseHandle(self.handle);
                }
            }
        }
    }

    /// 抢单实例。`Some` = 本次启动可以继续；`None` = 已经有实例在跑。
    ///
    /// 顺序有讲究：**先看窗口，再看互斥体**。
    /// 双击两次时窗口早就画出来了，这一步立刻返回，不用等；
    /// 只有「互斥体还在、窗口还没出来」这种升级重启的空档才进 [`mutex_acquire`] 等。
    pub fn acquire() -> Option<Instance> {
        if find_window().is_some() {
            return None;
        }
        mutex_acquire(DUPLICATE_WAIT)
    }

    /// 只用互斥体挡（不看窗口）。抽出来是为了能单测，不受「本机是否正开着工作台」影响。
    pub fn mutex_acquire(wait: Duration) -> Option<Instance> {
        mutex_acquire_named(MUTEX_NAME, wait)
    }

    /// 同上，但可以指定互斥体名字。单测用独立名字，避免和正在运行的客户端抢同一个对象。
    fn mutex_acquire_named(name: &str, wait: Duration) -> Option<Instance> {
        let deadline = Instant::now() + wait;
        loop {
            let name = wide(name);
            // 不要求所有权（bInitialOwner = 0）：只需要「这个对象只被一个人建出来」。
            let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
            if handle.is_null() {
                // 建不出来就别拦人：宁可多开一个，也不能打不开。
                return Some(Instance {
                    handle: std::ptr::null_mut(),
                });
            }
            if unsafe { GetLastError() } != ERROR_ALREADY_EXISTS {
                return Some(Instance { handle });
            }
            unsafe {
                CloseHandle(handle);
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(POLL);
        }
    }

    /// 把已经在跑的窗口切到前台；找不到返回 false。
    pub fn focus_existing() -> bool {
        let deadline = Instant::now() + FOCUS_WAIT;
        loop {
            if let Some(hwnd) = find_window() {
                unsafe {
                    if IsIconic(hwnd) != 0 {
                        ShowWindow(hwnd, SW_RESTORE);
                    }
                    ShowWindow(hwnd, SW_SHOW);
                    SetForegroundWindow(hwnd);
                }
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(POLL);
        }
    }

    /// 找不到窗口时的兜底提示：至少让用户知道不是「双击没反应」。
    pub fn warn_already_running() {
        let text = wide(
            "OpenCode 工作台已经在运行（可能被最小化或藏在其他窗口后面）。\n\n\
             请到任务栏把它切出来，不要再开第二个：同时开两个会让在线升级换不成新版本。",
        );
        let caption = wide(WINDOW_TITLE);
        unsafe {
            MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), MB_INFO);
        }
    }

    /// 找主窗口。标题就是唯一标识（用户把 exe 改名也不影响）。
    pub fn find_window() -> Option<*mut std::ffi::c_void> {
        let title = wide(WINDOW_TITLE);
        let hwnd = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
        (!hwnd.is_null()).then_some(hwnd)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// 互斥体本身的行为：第一个拿到，第二个被挡，第一个释放后又能拿到。
        #[test]
        fn mutex_blocks_second_holder_and_frees_on_drop() {
            // 用独立名字：不能和正在运行的客户端抢同一个互斥体，否则本机开着工作台时这条必挂。
            let name = "Local\\oc-workbench-single-instance-test";
            let first = mutex_acquire_named(name, Duration::from_millis(0)).expect("第一次必须能拿到");
            assert!(
                mutex_acquire_named(name, Duration::from_millis(300)).is_none(),
                "第一个还活着时，第二个必须被挡住"
            );
            drop(first);
            assert!(
                mutex_acquire_named(name, Duration::from_millis(0)).is_some(),
                "释放之后必须能重新拿到（否则用户关掉再开就打不开了）"
            );
        }
    }
}

#[cfg(not(windows))]
mod plat {
    pub const WINDOW_TITLE: &str = "OpenCode 工作台";
    pub const DUPLICATE_WAIT: std::time::Duration = std::time::Duration::from_secs(0);

    pub struct Instance;

    pub fn acquire() -> Option<Instance> {
        Some(Instance)
    }

    pub fn mutex_acquire(_wait: std::time::Duration) -> Option<Instance> {
        Some(Instance)
    }

    pub fn focus_existing() -> bool {
        false
    }

    pub fn warn_already_running() {}
}

pub use plat::{focus_existing, warn_already_running, Instance, WINDOW_TITLE};

/// 获取单实例凭证；`None` 表示已有实例，本次启动应当退出。
pub fn acquire() -> Option<Instance> {
    plat::acquire()
}
