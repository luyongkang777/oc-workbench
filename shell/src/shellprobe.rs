//! 启动 opencode 前把「存在但跑不起来的 pwsh」挡掉。
//!
//! 背景（opencode 2.3.0 实测）：
//!   - shell 工具选 shell 的顺序是 `pwsh → powershell → git bash → cmd.exe`，
//!     由 `ShellSelect.resolve` 里的 `Fr()` 实现，最后一句是 `return Si(f,r)[0]`，
//!     **取到第一个就直接用，不做可用性验证**。
//!   - Store/MSIX 版 PowerShell 在 PATH 里是
//!     `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` —— 一个 0 字节的
//!     「应用执行别名」（AppExecLink 重解析点）。它能不能被启动要看包状态与会话环境，
//!     起不来时 opencode 也不会回退，整条 shell 工具直接不可用。
//!     （本机实测：`winget.exe` 别名能跑、`wt.exe` 别名静默退出，行为不一致。）
//!
//! 做法：启动 opencode 前实测一次 pwsh。能跑就什么都不做；跑不起来就注入
//! `SHELL=<powershell.exe 全路径>` —— opencode 的 `gi()` 会优先读
//! `process.env.SHELL`，等于把 Windows PowerShell 5.1 顶上去。
//!
//! 为什么不直接查「是不是 WindowsApps 下的 0 字节文件」：
//!   0 字节别名并不必然坏（`winget.exe` 就是好的），误判会把能用的 pwsh 关掉。
//!   只有真的起不来才算坏。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// 探针最多等这么久。pwsh 冷启动通常 <1s；Store 别名卡住时也不必拖太久。
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// 探针轮询间隔。
const PROBE_POLL: Duration = Duration::from_millis(25);

/// 给 opencode 子进程用的 `SHELL` 覆盖值；`None` 表示不用覆盖。
///
/// 结果缓存：`build_command` 每次启动 opencode 子命令都会调，探针只该跑一次。
pub fn shell_override() -> Option<String> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let pwsh = find_pwsh();
            let runs = pwsh.as_deref().is_some_and(probe_runs);
            let powershell = powershell_path();
            decide(
                std::env::var("SHELL").ok().as_deref(),
                pwsh.as_deref(),
                runs,
                powershell.as_deref(),
            )
            .map(|path| path.to_string_lossy().into_owned())
        })
        .clone()
}


/// 纯决策：输入全部可注入，方便单测覆盖每一条分支。
fn decide(
    shell_env: Option<&str>,
    pwsh: Option<&Path>,
    pwsh_runs: bool,
    powershell: Option<&Path>,
) -> Option<PathBuf> {
    // 用户/上层显式设了 SHELL：尊重，绝不覆盖。
    if shell_env.is_some_and(|value| !value.trim().is_empty()) {
        return None;
    }
    // PATH 里根本没有 pwsh：opencode 自己会退到 powershell，不必插手。
    pwsh?;
    // 探针跑通了：保持原样，让它继续用 pwsh。
    if pwsh_runs {
        return None;
    }
    // pwsh 存在但起不来：用系统自带的 Windows PowerShell 兜底。
    powershell.map(Path::to_path_buf)
}

/// `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，存在才返回。
pub(crate) fn powershell_path() -> Option<PathBuf> {
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let exe = root
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    exe.is_file().then_some(exe)
}


/// 路径是否落在 WindowsApps 下（Store/MSIX 安装的应用）。
fn is_store_path(path: &Path) -> bool {
    path.to_string_lossy()
        .to_ascii_lowercase()
        .contains("\\windowsapps\\")
}

/// PATH 里的 pwsh 是否来自 WindowsApps（Store/MSIX 安装）。
///
/// 这类 pwsh 在**外壳进程**里用短别名能跑，但 opencode 服务进程会把它解析成
/// `C:\Program Files\WindowsApps\<包名>\pwsh.EXE` 再 spawn，实测直接失败：
/// `failed to spawn ... pwsh.EXE: OS Error -1073283067` —— 包目录 ACL 只放
/// 交互式登录用户，后台服务进程没有这个身份。
///
/// 所以「外壳探针跑通」不等于「服务端能用」，需要再实测一次（见 auth::discover）。
pub fn pwsh_from_windows_store() -> bool {
    find_pwsh().is_some_and(|path| is_store_path(&path))
}

/// 按 PATH 找 `pwsh.exe`。
fn find_pwsh() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join("pwsh.exe"))
        .find(|candidate| candidate.is_file())
}

/// 实测 `<exe> -NoProfile -NonInteractive -Command "exit 0"` 能不能正常退出。
fn probe_runs(exe: &Path) -> bool {
    let mut cmd = std::process::Command::new(exe);
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", "exit 0"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::auth::CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(_) => return false,
    };
    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }
        std::thread::sleep(PROBE_POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn respects_explicit_shell() {
        assert_eq!(
            decide(
                Some(r"C:\Windows\System32\cmd.exe"),
                Some(&p(r"C:\pwsh.exe")),
                false,
                Some(&p(r"C:\ps.exe"))
            ),
            None
        );
    }

    #[test]
    fn blank_shell_is_treated_as_unset() {
        assert_eq!(
            decide(Some("   "), Some(&p(r"C:\pwsh.exe")), false, Some(&p(r"C:\ps.exe"))),
            Some(p(r"C:\ps.exe"))
        );
    }

    #[test]
    fn no_pwsh_means_hands_off() {
        assert_eq!(decide(None, None, false, Some(&p(r"C:\ps.exe"))), None);
    }

    #[test]
    fn working_pwsh_is_kept() {
        assert_eq!(
            decide(None, Some(&p(r"C:\pwsh.exe")), true, Some(&p(r"C:\ps.exe"))),
            None
        );
    }

    #[test]
    fn broken_pwsh_falls_back_to_powershell() {
        assert_eq!(
            decide(None, Some(&p(r"C:\pwsh.exe")), false, Some(&p(r"C:\ps.exe"))),
            Some(p(r"C:\ps.exe"))
        );
    }

    #[test]
    fn broken_pwsh_without_powershell_does_nothing() {
        assert_eq!(decide(None, Some(&p(r"C:\pwsh.exe")), false, None), None);
    }

    /// 本机必须能定位到 System32 下的 powershell.exe，否则兜底等于没有。
    #[test]
    fn powershell_exists_on_this_machine() {
        let exe = powershell_path().expect("应能找到 powershell.exe");
        assert!(exe.is_file(), "{} 不是文件", exe.display());
    }
    /// 探针遇到畸形 pwsh（0 字节 / 假 exe / 同名目录）必须判死，不能 panic。
    ///
    /// 这些是真实环境里会出现的：Store 别名没装完、杀软隔离后留下的残骸、
    /// 以及用户手工在同名路径建了目录。
    #[test]
    fn probe_rejects_malformed_pwsh() {
        let dir = std::env::temp_dir().join(format!("ocwb-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建目录");

        // 0 字节：Store 别名安装未完成的样子
        let zero = dir.join("zero.exe");
        std::fs::write(&zero, b"").expect("写 0 字节");
        assert!(!probe_runs(&zero), "0 字节必须判死");

        // 假 exe：内容是文本，CreateProcess 会失败
        let fake = dir.join("fake.exe");
        std::fs::write(&fake, b"not a real ever").expect("写假 exe");
        assert!(!probe_runs(&fake), "假 exe 必须判死");

        // 同名目录：is_file() 会挡住它，probe 也不能崩
        let as_dir = dir.join("dir.exe");
        std::fs::create_dir_all(&as_dir).expect("建同名目录");
        assert!(!probe_runs(&as_dir), "同名目录必须判死");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// WindowsApps 判定只看路径片段，不受大小写影响。
    #[test]
    fn store_path_detection() {
        assert!(is_store_path(&p(
            r"C:\Users\a\AppData\Local\Microsoft\WindowsApps\pwsh.exe"
        )));
        assert!(is_store_path(&p(
            r"C:\Program Files\WindowsApps\Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe\pwsh.EXE"
        )));
        assert!(!is_store_path(&p(r"C:\Program Files\PowerShell\7\pwsh.exe")));
        assert!(!is_store_path(&p(r"C:\Windows\System32\cmd.exe")));
    }

    /// 探针必须能正确判活真实的 powershell.exe（证明确实是「实测」而不是总判死）。
    #[test]
    fn probe_accepts_real_powershell() {
        let exe = powershell_path().expect("应能找到 powershell.exe");
        assert!(probe_runs(&exe), "真实 powershell 必须判活");
    }

}
