//! 「另一个工作台」的清理：把重复实例请走、把本窗口拉到前台。
//!
//! 识别逻辑在 [`crate::single_peer`]。这里只负责动作，以及**动作失败时不要
//! 变成骚扰**：关不掉的实例每轮再试一次，用户就会看到「每 6 秒抢一次焦点 +
//! 刷三行日志」，比不管更烦人。

#[cfg(windows)]
mod plat {
    use std::collections::HashSet;
    use std::time::{Duration, Instant};

    use crate::single_peer::PeerWindow;
    use crate::win32::*;

    /// 等窗口出现在前台的时间。
    const FOCUS_WAIT: Duration = Duration::from_secs(2);
    /// 窗口 / 进程状态的轮询间隔。
    const POLL: Duration = Duration::from_millis(100);
    /// 守护线程多久巡检一次。2 秒：双击后最迟 2 秒内就会被清掉，用户不会察觉卡顿。
    const GUARD_INTERVAL: Duration = Duration::from_secs(2);
    /// `FlashWindowEx` 的 FLASHWINFO（字段顺序必须与 Win32 一致）。
    #[repr(C)]
    struct FlashInfo {
        size: u32,
        hwnd: Hwnd,
        flags: u32,
        count: u32,
        timeout: u32,
    }

    /// 闪标题栏 + 任务栏按钮。
    const FLASH_ALL: u32 = 0x0000_0003;
    /// 一直闪到窗口被激活，而不是闪固定次数。
    const FLASH_TIMER_NO_FOREGROUND: u32 = 0x0000_000C;

    #[link(name = "user32")]
    extern "system" {
        fn FlashWindowEx(info: *mut FlashInfo) -> i32;
    }

    /// 发 WM_CLOSE 之后等它自己退出的时间，超时才强杀。
    const CLOSE_WAIT: Duration = Duration::from_secs(4);

    /// 把窗口切到前台；成功返回 true。
    ///
    /// `SetForegroundWindow` 在前台锁生效时会被系统忽略，只让任务栏闪一下。
    /// 这时补一次 `FlashWindowEx`：用户至少能看到「窗口在这儿」，
    /// 而**绝不能弹模态提示框**——那是一问一答，会把这次启动卡在那儿不退出。
    pub fn bring_to_front(hwnd: Hwnd) -> bool {
        unsafe {
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            ShowWindow(hwnd, SW_SHOW);
            let ok = SetForegroundWindow(hwnd) != 0;
            if !ok {
                let mut info = FlashInfo {
                    size: std::mem::size_of::<FlashInfo>() as u32,
                    hwnd,
                    flags: FLASH_ALL | FLASH_TIMER_NO_FOREGROUND,
                    count: 0,
                    timeout: 0,
                };
                FlashWindowEx(&mut info);
            }
            ok
        }
    }

    /// 把已经在跑的窗口切到前台；找不到返回 false。
    pub fn focus_existing() -> bool {
        let deadline = Instant::now() + FOCUS_WAIT;
        loop {
            if let Some(peer) = crate::single_peer::peer_windows().into_iter().next() {
                return bring_to_front(peer.hwnd);
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(POLL);
        }
    }

    /// 请另一个实例退出。返回 true = 它已经不在了（关掉或杀掉）；
    /// false = 关不掉（没权限 / 没响应），调用方不要再重试。
    fn close_peer(peer: &PeerWindow, log: &dyn Fn(&str)) -> bool {
        log(&format!(
            "[single] 发现另一个工作台（{}），请它退出\n",
            peer.describe()
        ));
        unsafe {
            PostMessageW(peer.hwnd, WM_CLOSE, 0, 0);
        }
        let deadline = Instant::now() + CLOSE_WAIT;
        while Instant::now() < deadline {
            if exited(peer) {
                log("[single] 对方已正常退出\n");
                return true;
            }
            std::thread::sleep(POLL);
        }
        // 刚出循环的那一刻退出的：别把它记成「强制结束失败」。
        if exited(peer) {
            log("[single] 对方已正常退出\n");
            return true;
        }
        if !peer.can_close() {
            log("[single] 无法确认对方身份或权限不足，不强制结束（不再重试）\n");
            return false;
        }
        log("[single] 对方没响应 WM_CLOSE，强制结束\n");
        let ok = unsafe { TerminateProcess(peer.process, 1) } != 0;
        log(if ok {
            "[single] 已强制结束对方\n"
        } else {
            "[single] 强制结束失败（不再重试）\n"
        });
        ok
    }

    /// 对方进程是否真的退出了。
    ///
    /// 判据以「进程退出」为准而不是「窗口消失」：将来某版若把关闭做成收进托盘、
    /// 只隐藏窗口，光看窗口会误判成功，而那个进程还攥着互斥体。
    fn exited(peer: &PeerWindow) -> bool {
        if peer.process.is_null() {
            // 拿不到句柄（权限不足）时只能看窗口。
            return unsafe { IsWindow(peer.hwnd) } == 0;
        }
        unsafe { WaitForSingleObject(peer.process, 0) == WAIT_OBJECT_0 }
    }

    /// 守护线程：**这是跨版本单实例的关键**。
    ///
    /// 老版本自己没有互斥体检查，被启动时谁也挡不住它。所以由已经在跑的这一份
    /// 盯着：一旦出现第二个工作台窗口，就把它关掉，再把自己的窗口拉到前台
    /// ——用户看到的效果就是「双击老图标，还是原来那个窗口」。
    ///
    /// 失败不重试：关不掉的（没权限）每轮再试一次只会变成骚扰。
    /// 已放弃的 pid 记在 `gave_up`，同时也不再为它抢前台。
    pub fn spawn_guard<F>(self_hwnd: isize, log: F)
    where
        F: Fn(&str) + Send + 'static,
    {
        std::thread::spawn(move || {
            let mut gave_up: HashSet<u32> = HashSet::new();
            loop {
                std::thread::sleep(GUARD_INTERVAL);
                // 升级替换脚本会在我们退出后拉起新进程：那时这个线程已经跟着进程
                // 没了，不会把「接班的自己」当对手杀掉。
                let mut closed_any = false;
                for peer in crate::single_peer::peer_windows() {
                    if gave_up.contains(&peer.pid) || !peer.can_close() {
                        continue;
                    }
                    if close_peer(&peer, &log) {
                        closed_any = true;
                    } else {
                        gave_up.insert(peer.pid);
                    }
                }
                // 只在真的清掉了对手时抢一次前台：
                // 无条件抢会让本窗口每 2 秒抢一次焦点，用户在别的程序里打字都会被弹回来。
                if closed_any && self_hwnd != 0 {
                    bring_to_front(self_hwnd as Hwnd);
                }
            }
        });
    }
}

pub use plat::*;
