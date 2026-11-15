//! 新电脑的 ssh 自动配置：生成密钥、把公钥交给网关装到受限账号、写 ~/.ssh/config。
//!
//! 背景：隧道靠 `ssh -R`，但新装的工作台根本没有 ssh 别名和密钥，用户只看到
//! 「离线」。手工配一次（生成密钥、拷公钥到服务器、写 config）对普通用户来说
//! 门槛太高，所以这里做成一键：
//!
//! 1. 没有密钥就在 `~/.ssh/id_ed25519` 生成一把（不碰用户已有的）；
//! 2. 把公钥 POST 给网关，由网关装到**受限账号** `ocw-tunnel`
//!    （每把 key 带 `restrict,port-forwarding`，只能转发、不能执行命令）；
//! 3. 写 `~/.ssh/config` 的 `Host tiku`（只在自己没配过时写，不覆盖手工配置）。
//!
//! 已经有可用配置的电脑（比如配置了 root 的旧机器）直接跳过。

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::update;

/// ssh 配置里的别名，与 `tunnel.rs` 的 DEFAULT_HOST 一致。
const HOST_ALIAS: &str = "tiku";
/// 受限账号：由网关负责把公钥装进它的 authorized_keys。
const REMOTE_USER: &str = "ocw-tunnel";
const NET_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub struct SetupOutcome {
    pub ok: bool,
    /// 这次是不是**真的改了配置**（生成密钥 / 写了 ssh config）。
    ///
    /// 调用方只在 changed 时才重建隧道：已经配好的机器每刷新一次账号面板都会走
    /// 这里，若无条件重建，就会「面板一打开、隧道就断一下」，探测那几秒显示离线。
    pub changed: bool,
    pub message: String,
}

/// 确保这台电脑能连上隧道账号。幂等：已经配好就立刻返回。
pub fn ensure(gateway: &str, token: &str) -> SetupOutcome {
    if gateway.trim().is_empty() || token.trim().is_empty() {
        return fail("还没登录账号，配置通道需要在账号面板里登录一次".to_string());
    }
    let host = match host_of(gateway) {
        Some(host) => host,
        None => return fail(format!("网关地址不合法：{gateway}")),
    };
    if configured() {
        return SetupOutcome {
            ok: true,
            changed: false,
            message: "这台电脑已经配好 ssh，跳过".to_string(),
        };
    }

    let key = match ensure_key() {
        Ok(path) => path,
        Err(err) => return fail(format!("生成本机密钥失败：{err}")),
    };
    let pubkey = match std::fs::read_to_string(key.with_extension("pub")) {
        Ok(text) => text.trim().to_string(),
        Err(err) => return fail(format!("读取公钥失败：{err}")),
    };

    if let Err(err) = upload(gateway.trim_end_matches('/'), token, &pubkey) {
        return fail(format!("把公钥交给服务器失败：{err}"));
    }
    if let Err(err) = write_config(&host) {
        return fail(format!("写 ~/.ssh/config 失败：{err}"));
    }
    SetupOutcome {
        ok: true,
        changed: true,
        message: format!("已自动配置通道（{REMOTE_USER}@{host}）"),
    }
}

fn fail(message: String) -> SetupOutcome {
    SetupOutcome { ok: false, changed: false, message }
}


/// 从网关地址里取主机名（`http://81.70.181.82:7800` → `81.70.181.82`）。
fn host_of(gateway: &str) -> Option<String> {
    let rest = gateway
        .trim()
        .trim_end_matches('/')
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    let host = rest.split('/').next().unwrap_or("").split(':').next().unwrap_or("");
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

fn ssh_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from)?;
    let dir = home.join(".ssh");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// 判断本机是否已经有可用配置：`~/.ssh/config` 里出现这个别名就算配好了。
///
/// 只看别名，不去验证连不连得上 —— 验证要真连一次服务器，代价大且会把
/// 失败原因混在一起；连不上时隧道状态接口会单独报出来。
fn configured() -> bool {
    let Some(dir) = ssh_dir() else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(dir.join("config")) else {
        return false;
    };
    text.lines().any(|line| {
        let t = line.trim();
        // 大小写不敏感，容忍 `Host tiku other` 这种一行多个别名
        t.len() > 4
            && t[..4].eq_ignore_ascii_case("host")
            && t[4..]
                .split_whitespace()
                .any(|name| name.eq_ignore_ascii_case(HOST_ALIAS))
    })
}

/// 没有密钥就生成一把；已存在则直接复用（绝不覆盖用户已有密钥）。
fn ensure_key() -> Result<PathBuf, String> {
    let dir = ssh_dir().ok_or_else(|| "找不到用户目录".to_string())?;
    let key = dir.join("id_ed25519");
    if key.is_file() {
        return Ok(key);
    }
    let ssh_keygen = ssh_keygen_path();
    let mut cmd = Command::new(&ssh_keygen);
    cmd.args([
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        &key.to_string_lossy(),
        "-C",
        "ocw-tunnel",
    ]);
    hide_window(&mut cmd);
    let status = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| format!("{ssh_keygen}：{err}"))?;
    if !status.success() {
        return Err(format!("ssh-keygen 退出码 {status}"));
    }
    Ok(key)
}

fn upload(gateway: &str, token: &str, pubkey: &str) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new().timeout(NET_TIMEOUT).build();
    let payload = serde_json::json!({ "key": pubkey });
    match agent
        .post(&format!("{gateway}/portal/api/tunnelkey"))
        .set("authorization", &format!("Bearer {token}"))
        .send_json(payload)
    {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            Err(format!("服务器返回 {code}：{}", body.trim().chars().take(120).collect::<String>()))
        }
        Err(err) => Err(err.to_string()),
    }
}

/// 追加 `Host tiku` 段。调用方保证本机之前没有这个别名。
fn write_config(host: &str) -> Result<(), String> {
    let dir = ssh_dir().ok_or_else(|| "找不到用户目录".to_string())?;
    let path = dir.join("config");
    let mut text = std::fs::read_to_string(&path).unwrap_or_default();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    if !text.trim().is_empty() {
        text.push('\n');
    }
    text.push_str(&format!(
        "Host {HOST_ALIAS}\n    HostName {host}\n    User {REMOTE_USER}\n    IdentityFile ~/.ssh/id_ed25519\n    IdentitiesOnly yes\n    ServerAliveInterval 20\n"
    ));
    std::fs::write(&path, text).map_err(|err| format!("{err}"))
}

#[cfg(windows)]
fn ssh_keygen_path() -> String {
    let bundled = format!(
        "{}\\System32\\OpenSSH\\ssh-keygen.exe",
        std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string())
    );
    if std::path::Path::new(&bundled).is_file() {
        return bundled;
    }
    "ssh-keygen".to_string()
}

#[cfg(not(windows))]
fn ssh_keygen_path() -> String {
    "ssh-keygen".to_string()
}

#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide_window(_cmd: &mut Command) {}

/// 读 account.json 里的登录态（网关地址 + Bearer token）。
///
/// 和 `account.rs` 用同一个文件：登录成功后前端会把它写下来，所以这里不额外要参数。
pub fn saved_session() -> Option<(String, String)> {
    let dir = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    let text = std::fs::read_to_string(dir.join("oc-workbench").join("account.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let token = value.get("token")?.as_str()?.trim().to_string();
    let gateway = value
        .get("gateway")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| update::gateway_url())?;
    if token.is_empty() {
        return None;
    }
    Some((gateway, token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 网关地址取主机名() {
        assert_eq!(host_of("http://81.70.181.82:7800").as_deref(), Some("81.70.181.82"));
        assert_eq!(host_of("https://example.com").as_deref(), Some("example.com"));
        assert_eq!(host_of(""), None);
    }
}
