//! 找本地 opencode 服务，并拿到带认证的 cookie。
//!
//! 流程（实测 v2.2.5）：
//!   1. `opencode service status` 打印服务地址，例如 http://127.0.0.1:28894
//!   2. `opencode pair` 打印一次性配对链接 http://127.0.0.1:<port>/auth/connect/<code>
//!   3. 用带 `Accept: text/html` 的 GET 打开链接 → 302 + Set-Cookie: opencode_session_<port>=<token>
//!      （不带 text/html 只回 JSON token，那个 token 拿来当 Bearer 会 401）
//!
//! 注意：npm 装的 `opencode` 是 .cmd shim，`Command::new("opencode")` 在 Windows 找不到，
//! 必须走 `cmd /C opencode ...`。

use std::process::Command;
use std::time::Duration;

pub struct Backend {
    pub base: String,
    pub cookie: String,
}

fn run(args: &[&str]) -> String {
    #[cfg(windows)]
    let output = {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg("opencode");
        for arg in args {
            cmd.arg(arg);
        }
        cmd.output()
    };

    #[cfg(not(windows))]
    let output = Command::new("opencode").args(args).output();

    match output {
        Ok(out) => format!(
            "{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ),
        Err(_) => String::new(),
    }
}

fn trimmed(text: &str, start: usize) -> String {
    let rest = &text[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
        .unwrap_or(rest.len());
    rest[..end].to_string()
}

/// 从一段文本里截出一个 http://127.0.0.1:<port> 形式的地址。
fn find_base(text: &str) -> Option<String> {
    let start = text.find("http://127.0.0.1:")?;
    let base = trimmed(text, start);
    let base = base.trim_end_matches('/');
    if base.len() > "http://127.0.0.1:".len() {
        Some(base.to_string())
    } else {
        None
    }
}

fn find_link(text: &str) -> Option<String> {
    let start = text.find("http://127.0.0.1:")?;
    let link = trimmed(text, start);
    if link.contains("/auth/connect/") {
        Some(link)
    } else {
        None
    }
}

fn port_of(url: &str) -> Option<String> {
    let after = url.strip_prefix("http://127.0.0.1:")?;
    let port: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    if port.is_empty() {
        None
    } else {
        Some(port)
    }
}

pub fn discover() -> Option<Backend> {
    let base = find_base(&run(&["service", "status"]))?;
    let port = port_of(&base)?;

    let link = find_link(&run(&["pair"]))?;

    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(Duration::from_secs(10))
        .build();

    // 302 会被 ureq 当成正常响应返回（redirects(0)）；个别版本包成 Err(Status)，两种都取。
    let raw = match agent.get(&link).set("accept", "text/html").call() {
        Ok(resp) => resp.header("set-cookie").map(|v| v.to_string()),
        Err(ureq::Error::Status(_, resp)) => resp.header("set-cookie").map(|v| v.to_string()),
        Err(_) => None,
    }?;

    let cookie = raw.split(';').next()?.trim().to_string();
    if !cookie.starts_with(&format!("opencode_session_{port}=")) {
        return None;
    }

    Some(Backend { base, cookie })
}
