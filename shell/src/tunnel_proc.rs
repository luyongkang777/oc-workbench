//! 隧道用到的系统操作：找 ssh、隐藏窗口、杀进程、记 PID。
//!
//! 从 `tunnel.rs` 拆出来的（那边只管配置与生命周期）。这些函数全是
//! 「跟操作系统打交道」的脏活，混在状态机里读起来很乱。

use std::process::{Command, Stdio};
use std::time::Duration;

/// 记下当前隧道子进程 PID 的文件名（与 settings.json 同目录）。
const PID_KEY: &str = "tunnel.pid";

/// 数据目录（`%LOCALAPPDATA%\oc-workbench`）。
pub fn data_dir() -> Option<std::path::PathBuf> {
    let dir = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from)?;
    let dir = dir.join("oc-workbench");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// 隧道 stderr 的落点。认证失败/端口被占只有这里看得到。
pub fn log_file() -> Option<std::path::PathBuf> {
    data_dir().map(|dir| dir.join("tunnel.log"))
}

pub fn remember_pid(pid: u32) {
    if let Some(path) = data_dir().map(|dir| dir.join(PID_KEY)) {
        let _ = std::fs::write(path, pid.to_string());
    }
}

pub fn forget_pid() {
    if let Some(path) = data_dir().map(|dir| dir.join(PID_KEY)) {
        let _ = std::fs::remove_file(path);
    }
}

/// 读上次记下的 PID 并删掉文件（读到就清，避免下次又杀一遍）。
pub fn take_pid() -> Option<u32> {
    let path = data_dir()?.join(PID_KEY);
    let text = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(path);
    text.trim().parse().ok()
}

/// 起一个 ssh 反向隧道进程：服务器 `relay_port` -> 本机 `local_port`。
pub fn spawn_ssh(relay_port: u16, local_port: u16, host: &str) -> Result<std::process::Child, String> {
    let ssh = ssh_path();
    let reverse = format!("127.0.0.1:{relay_port}:127.0.0.1:{local_port}");
    let mut cmd = Command::new(&ssh);
    cmd.args([
        "-N",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=20",
        "-o",
        "ServerAliveCountMax=3",
        "-R",
        &reverse,
        host,
    ]);
    if let Some(log) = log_file() {
        if let Ok(file) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
            if let Ok(err) = file.try_clone() {
                cmd.stderr(Stdio::from(err));
            }
            if let Ok(out) = file.try_clone() {
                cmd.stdout(Stdio::from(out));
            }
        }
    }
    hide_window(&mut cmd);
    cmd.spawn().map_err(|err| format!("{ssh}：{err}"))
}

/// 扫掉本机所有指向这个回环端口的 ssh。
///
/// 场景：用户以前手动跑过 `remote-tunnel.ps1`，或上一代 exe 被强杀留下孤儿。
/// 它们一直占着服务器端口，新隧道每次 `-R` 都失败（exit 255），
/// 网页端永远离线 —— 表现和「没连上」一模一样，很难看出是本地冲突。
#[cfg(windows)]
pub fn kill_by_port(relay_port: u16) {
    let script = format!(
        "Get-CimInstance Win32_Process -Filter \"Name='ssh.exe'\" | \
         Where-Object {{ $_.CommandLine -like '*-R 127.0.0.1:{relay_port}:*' }} | \
         ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    hide_window(&mut cmd);
    let _ = cmd.stdout(Stdio::null()).stderr(Stdio::null()).status();
}

/// 本机是否已经有一条指向该回环端口的 ssh 隧道？返回它的 PID。
///
/// 用途：新进程 `-R` 被拒（端口已被占）时，先看看是不是「本机已经有一条」——
/// 上一代 exe 被强杀留下的孤儿就属于这种，它指向的同样是本机 17800，
/// 功能是好的。这时候不该继续重试刷错，复用即可。
#[cfg(windows)]
pub fn tunnel_pid_for(relay_port: u16) -> Option<u32> {
    let script = format!(
        "Get-CimInstance Win32_Process -Filter \"Name='ssh.exe'\" | \
         Where-Object {{ $_.CommandLine -like '*-R 127.0.0.1:{relay_port}:*' }} | \
         Select-Object -First 1 -ExpandProperty ProcessId"
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    hide_window(&mut cmd);
    let out = cmd.output().ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse::<u32>().ok()
}

#[cfg(not(windows))]
pub fn tunnel_pid_for(relay_port: u16) -> Option<u32> {
    let out = Command::new("pgrep")
        .args(["-f", &format!("-R 127.0.0.1:{relay_port}:")])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()?
        .trim()
        .parse::<u32>()
        .ok()
}

/// 进程是否还活着（用于「复用已有隧道」时的存活监控）。
#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    let mut cmd = Command::new("tasklist");
    cmd.args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]);
    hide_window(&mut cmd);
    match cmd.output() {
        Ok(out) => !String::from_utf8_lossy(&out.stdout).contains("No tasks"),
        Err(_) => false,
    }
}

#[cfg(not(windows))]
pub fn pid_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn kill_by_port(relay_port: u16) {
    let _ = Command::new("pkill")
        .args(["-f", &format!("-R 127.0.0.1:{relay_port}:")])
        .status();
}

/// 杀指定 PID。调用方要先确认它是 ssh（见 [`is_ssh`]），避免 PID 复用误杀。
#[cfg(windows)]
pub fn kill_pid(pid: u32) {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/F"]);
    hide_window(&mut cmd);
    let _ = cmd.stdout(Stdio::null()).stderr(Stdio::null()).status();
}

#[cfg(not(windows))]
pub fn kill_pid(pid: u32) {
    let _ = Command::new("kill").arg(pid.to_string()).status();
}

#[cfg(windows)]
pub fn is_ssh(pid: u32) -> bool {
    let mut cmd = Command::new("tasklist");
    cmd.args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]);
    hide_window(&mut cmd);
    match cmd.output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .to_lowercase()
            .contains("ssh.exe"),
        Err(_) => false,
    }
}

#[cfg(not(windows))]
pub fn is_ssh(_pid: u32) -> bool {
    false
}

#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW：不然每次重连都会闪一个黑框。
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide_window(_cmd: &mut Command) {}

#[cfg(windows)]
fn ssh_path() -> String {
    let bundled = format!(
        "{}\\System32\\OpenSSH\\ssh.exe",
        std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string())
    );
    if std::path::Path::new(&bundled).is_file() {
        return bundled;
    }
    "ssh".to_string()
}

#[cfg(not(windows))]
fn ssh_path() -> String {
    "ssh".to_string()
}

/// 清理后等一下，让 sshd 一端释放端口（实测 Linux 侧有几毫秒延迟）。
pub const RELEASE_GRACE: Duration = Duration::from_millis(400);
