//! 单实例：同一 Windows 登录会话里只允许跑一个工作台，**不分版本**。
//!
//! **为什么必须有**：开两个实例时「在线升级」会坏。
//!
//! 升级流程是「下载新 exe → 拉起替换脚本 → 本进程退出 → 脚本反复重试覆盖 exe →
//! 覆盖成功后 start 一次」。它只认**一个**目标文件：另一个实例仍占着旧 exe，
//! 覆盖就得一直重试到 120 次放弃；放弃分支还会照样 `start` 一次，
//! 最后可能是「两个窗口、版本还不一致」。用户感知就是「升级了但没生效 / 越升越乱」。
//!
//! ## 为什么不能只靠互斥体
//!
//! 互斥体只能挡住「也写了互斥体检查的版本」——我们自己。1.3.6 及更早的 exe 里
//! 没有任何单实例代码，它们被启动时不会看互斥体。于是：
//!
//! * 老版本先开、新版本后开：新版本能挡住（它查得到老版本）；
//! * **新版本先开、老版本后开：老版本照开，双开成立**。
//!
//! 所以「挡」不够，还要「清」：见 [`guard`] 起的守护线程，
//! 进程识别与清理都在 [`crate::single_peer`]。
//!
//! ## 本模块负责什么
//!
//! * [`acquire`]：本次启动要不要继续（先看有没有别的实例，再抢互斥体）；
//! * [`focus_existing`]：把已经开着的窗口切到前台（抢不到就闪任务栏）；
//! * [`guard`]：起守护线程，清掉后启动的重复实例。
//!
//! 不用锁文件：进程被强杀时锁文件会残留、把以后所有启动都挡死；
//! 互斥体是内核对象，最后一个句柄关闭就消失。
//!
//! 重复启动不报错，而是把已经开着的窗口切到前台——双击两次是手滑，不该算故障。

#[cfg(windows)]
mod plat {
    use std::time::{Duration, Instant};

    use crate::win32::*;

    /// 互斥体名字。`Local\` 让不同登录用户各开一个，互不影响。
    const MUTEX_NAME: &str = "Local\\oc-workbench-single-instance";

    /// 重复启动时最多等这么久「让老实例把窗口摆出来 / 把互斥体放掉」。
    ///
    /// 升级重启正好落在这个窗口期：老进程 `exit(0)` 之后脚本才替换 exe 并拉起新进程，
    /// 中间可能有几十到几百毫秒互斥体还没释放。等一会儿比「开不出来」好。
    pub const DUPLICATE_WAIT: Duration = Duration::from_secs(4);
    /// 找窗口 / 等互斥体的轮询间隔。
    const POLL: Duration = Duration::from_millis(100);

    /// 看到「别的实例」时最多等这么久，确认它是真的在跑而不是正在退出。
    ///
    /// 覆盖升级重启的竞态：脚本 `taskkill /F` 之后到窗口销毁之间有一个短窗口期。
    /// 600ms 是两边的折中：实测杀掉之后窗口在 100ms 量级就消失，
    /// 足够兜住；而「真的双开」时用户也只多等半秒多，不觉得卡。
    const PEER_SETTLE: Duration = Duration::from_millis(600);

    /// 本进程持有的单实例凭证；进程退出时内核自动回收。
    pub struct Instance {
        handle: Handle,
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
    /// 顺序有讲究：**先看已有实例，再看互斥体**。
    /// 双击两次时窗口早就画出来了，这一步立刻返回，不用等；
    /// 只有「互斥体还在、窗口还没出来」这种升级重启的空档才进 [`mutex_acquire`] 等。
    pub fn acquire() -> Option<Instance> {
        // 看到别的实例时不能立刻判死：升级脚本是「taskkill 旧进程 → 覆盖 exe →
        // 立刻 start 新进程」。杀掉到窗口真正销毁之间有个很短的窗口期，
        // 若此刻直接返回 None，新版本会自己退出，用户看到的是「升级后打不开」。
        let deadline = Instant::now() + PEER_SETTLE;
        while !crate::single_peer::peer_windows().is_empty() {
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(POLL);
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
            let name = name.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
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
        crate::single_guard::focus_existing()
    }

    /// 起守护线程，清掉后启动的重复实例（跨版本有效）。
    pub fn spawn_guard<F>(self_hwnd: isize, log: F)
    where
        F: Fn(&str) + Send + 'static,
    {
        crate::single_guard::spawn_guard(self_hwnd, log);
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


    pub fn spawn_guard<F>(_self_hwnd: isize, _log: F)
    where
        F: Fn(&str) + Send + 'static,
    {
    }
}

/// 主窗口标题。同时是「找已有窗口」的键之一，只在 single_peer 里使用。
pub const WINDOW_TITLE: &str = "OpenCode 工作台";

pub use plat::{focus_existing, Instance};

/// 获取单实例凭证；`None` 表示已有实例，本次启动应当退出。
pub fn acquire() -> Option<Instance> {
    plat::acquire()
}

/// 起守护线程，清掉后启动的重复实例（跨版本有效）。
pub fn guard<F>(self_hwnd: isize, log: F)
where
    F: Fn(&str) + Send + 'static,
{
    plat::spawn_guard(self_hwnd, log)
}
