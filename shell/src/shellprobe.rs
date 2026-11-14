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
fn powershell_path() -> Option<PathBuf> {
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
}
