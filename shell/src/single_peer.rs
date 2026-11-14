//! 「另一个工作台」的识别。
//!
//! 为什么需要这一层：老版本（1.3.6 及以前）的 exe 里没有任何单实例代码，
//! 它们被启动时不看互斥体。光靠互斥体只能挡住自己也检查互斥体的版本，
//! **新版本先开、老版本后开**照样双开。所以必须有「已经在跑的那一份去清场」，
//! 清场动作在 [`crate::single_guard`]，这里只负责**认出谁是工作台**。
//!
//! ## 判据：认进程，不认标题
//!
//! 只看窗口标题会出错：用浏览器打开 dev 页面（`index.html` 的 title 就是
//! 「OpenCode 工作台」）时，浏览器窗口和主窗口标题一模一样。
//! 真正的裁决依据是**窗口所属进程的 exe 文件名**是否含 `oc-workbench`。
//!
//! 标题只做两件事：
//!   1. 廉价预过滤——标题不含品牌词就不必 OpenProcess，省得每 2 秒扫全系统；
//!   2. 读不到进程路径时的兜底（要求标题逐字相等且窗口可见）。
//!
//! ## 「认得出」和「敢动手」是两件事
//!
//! 确认一个窗口属于工作台，不等于有权去关它：
//!   * 对方是管理员权限时，只申请只读权限能成功、带 `TERMINATE` 会被
//!     完整性级别（MIC）拦掉；
//!   * 读不到 exe 路径时，判定其实是按标题猜的，猜错就会关掉用户的浏览器。
//!
//! 所以 [`PeerWindow`] 把两件事分开：[`is_peer_window`] 说「这像是工作台」，
//! [`PeerWindow::can_close`] 说「身份已确认、可以动手」。

#[cfg(windows)]
mod plat {
    use crate::single::WINDOW_TITLE;
    use crate::win32::*;

    /// exe 文件名里带上这个名字就算工作台（不区分大小写）。
    const EXE_MARK: &str = "oc-workbench";
    /// 标题预过滤用的品牌词。用 `contains` 而不是全等：
    /// 将来标题改成「OpenCode 工作台 - 项目名」也不会漏。
    const TITLE_MARK: &str = "OpenCode";

    /// exe 文件名是不是工作台。只看文件名，不看目录：
    /// 用户把它复制到任何目录、改成别的目录名都不影响。
    pub fn exe_name_is_workbench(name: &str) -> bool {
        name.to_ascii_lowercase().contains(EXE_MARK)
    }

    /// 从完整路径里取文件名（不含目录）。
    pub fn file_name_of(path: &str) -> &str {
        path.rsplit(['\\', '/']).next().unwrap_or(path)
    }

    /// 标题是否值得进一步查（廉价预过滤）。
    ///
    /// 只过滤「明显不可能」的窗口；**标题相同不代表是工作台**，
    /// 最终仍由 [`is_peer_window`] 按 exe 名裁决。
    pub fn title_looks_like_workbench(title: &str) -> bool {
        title.contains(TITLE_MARK)
    }

    /// 一个窗口算不算「另一个工作台」。
    ///
    /// `path` 是窗口所属进程的 exe 完整路径，读不到时传 `None`。
    ///
    /// 读得到路径就**只认 exe 名**；读不到才退回「标题逐字相等 + 可见」。
    pub fn is_peer_window(title: &str, path: Option<&str>, visible: bool) -> bool {
        match path {
            Some(full) => exe_name_is_workbench(file_name_of(full)),
            None => visible && title == WINDOW_TITLE,
        }
    }

    /// 一个疑似「另一个工作台」的窗口。
    pub struct PeerWindow {
        /// 主窗口句柄（发 WM_CLOSE 用）。
        pub hwnd: Hwnd,
        /// 宿主进程 pid（只用于日志和去重）。
        pub pid: u32,
        title: String,
        path: Option<String>,
        /// 只读句柄（QUERY_LIMITED + SYNCHRONIZE）。
        ///
        /// **必须一直握着**：`TerminateProcess` 是按句柄杀的，不是按 pid 杀的。
        /// 若等 4 秒后重新用 pid 打开进程，而对方刚好在这 4 秒里退出、pid 又被
        /// 别的程序复用，杀的就是那个无辜程序。持着句柄则该 pid 不会被回收。
        pub process: Handle,
        /// 终止句柄。**只有确认身份后才申请**——带 `PROCESS_TERMINATE` 的请求
        /// 会被完整性级别拦下，扫描期就申请会导致「读不到路径」→ 退回按标题猜。
        killer: Handle,
        /// 是否按 exe 名确认过身份（而不是按标题猜的）。
        confirmed: bool,
    }

    impl Drop for PeerWindow {
        fn drop(&mut self) {
            unsafe {
                if !self.killer.is_null() {
                    CloseHandle(self.killer);
                }
                if !self.process.is_null() {
                    CloseHandle(self.process);
                }
            }
        }
    }

    impl PeerWindow {
        /// 给日志用的一行说明（不含 hwnd，指针值对排查没意义）。
        pub fn describe(&self) -> String {
            format!(
                "pid={} 标题={} 路径={}",
                self.pid,
                self.title,
                self.path.as_deref().unwrap_or("<读不到>")
            )
        }

        /// 能不能动手关它。
        ///
        /// 只有「按 exe 名确认过是工作台」才允许：读不到路径时那个判定是按
        /// 标题猜的，猜错就把用户的浏览器关了。拿不到终止句柄时也不行。
        pub fn can_close(&self) -> bool {
            self.confirmed && !self.killer.is_null()
        }
    }

    /// 读某个进程的 exe 完整路径。权限不够 / 进程已退出时返回 None。
    fn process_path(handle: Handle) -> Option<String> {
        if handle.is_null() {
            return None;
        }
        unsafe {
            let mut buffer = [0u16; 1024];
            let mut size = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size);
            if ok == 0 || size == 0 {
                return None;
            }
            Some(String::from_utf16_lossy(&buffer[..size as usize]))
        }
    }

    unsafe extern "system" fn collect(hwnd: Hwnd, lparam: isize) -> i32 {
        let list = &mut *(lparam as *mut Vec<PeerWindow>);
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        // 自己不算「另一个实例」
        if pid == 0 || pid == GetCurrentProcessId() {
            return 1;
        }
        let mut buffer = [0u16; 512];
        let len = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
        let title = if len > 0 {
            String::from_utf16_lossy(&buffer[..len as usize])
        } else {
            String::new()
        };
        // 廉价预过滤：标题里连品牌词都没有，不可能是工作台，连句柄都不用开。
        if !title_looks_like_workbench(&title) {
            return 1;
        }
        // 扫描期只申请读权限：带 TERMINATE 的请求会被 MIC 拒，
        // 一旦被拒就读不到路径，判定会降级成「按标题猜」。
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid);
        let path = process_path(process);
        let visible = IsWindowVisible(hwnd) != 0;
        if !is_peer_window(&title, path.as_deref(), visible) {
            if !process.is_null() {
                CloseHandle(process);
            }
            return 1;
        }
        // 确认是工作台之后，才单独申请终止权限。
        let confirmed = path.is_some();
        let killer = if confirmed {
            OpenProcess(PROCESS_TERMINATE, 0, pid)
        } else {
            std::ptr::null_mut()
        };
        list.push(PeerWindow {
            hwnd,
            pid,
            title,
            path,
            process,
            killer,
            confirmed,
        });
        1
    }

    /// 枚举当前会话里所有「别的」工作台窗口（不含自己）。
    pub fn peer_windows() -> Vec<PeerWindow> {
        let mut list: Vec<PeerWindow> = Vec::new();
        unsafe {
            EnumWindows(Some(collect), &mut list as *mut _ as isize);
        }
        list
    }

    #[cfg(test)]
    mod can_close_tests {
        use super::*;
        use crate::single::WINDOW_TITLE;
        use crate::win32::Handle;

        fn peer(confirmed: bool, killer: Handle) -> PeerWindow {
            PeerWindow {
                hwnd: std::ptr::null_mut(),
                pid: 1234,
                title: WINDOW_TITLE.to_string(),
                path: if confirmed {
                    Some("C:\\x\\oc-workbench.exe".to_string())
                } else {
                    None
                },
                process: std::ptr::null_mut(),
                killer,
                confirmed,
            }
        }

        /// 「认得出」和「敢动手」必须分开。
        ///
        /// 读不到 exe 路径时判定是按标题猜的；这时就算标题刚好等于 WINDOW_TITLE，
        /// 也只能用来阻止自己启动，**绝不允许去关那个窗口**。
        /// 守的是「不会误杀用户的浏览器」：浏览器打开 dev 页时标题一模一样，
        /// 而某些权限场景（管理员进程）下我们读不到它的 exe 路径。
        #[test]
        fn guessed_identity_must_not_be_killable() {
            let fake = 1usize as Handle;
            assert!(!peer(false, std::ptr::null_mut()).can_close(), "无路径无句柄");
            assert!(!peer(false, fake).can_close(), "无路径但有句柄也不许动手");
            assert!(peer(true, fake).can_close(), "身份确认 + 有句柄才允许");
            assert!(!peer(true, std::ptr::null_mut()).can_close(), "身份确认但没句柄");
        }
    }
}


#[cfg(all(test, windows))]
#[path = "single_peer_tests.rs"]
mod tests;

pub use plat::*;
