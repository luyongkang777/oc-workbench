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
//!
//! 所有失败都返回带原因的错误字符串（命令、io::Error、退出码、stderr 片段），
//! 由 main 写进 gui-error.log —— 这是排查「为什么没走自包含模式」的唯一线索。

use std::process::Command;
use std::time::Duration;

pub struct Backend {
    pub base: String,
    pub cookie: String,
}

/// 把多行输出压成一行，并截到 limit 个字符（错误日志里够用即可）。
fn snippet(text: &str, limit: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(limit).collect();
    if flat.chars().count() > limit {
        out.push_str("...");
    }
    out
}

/// 跑 `opencode <args>`，返回 stdout+stderr。
/// 执行失败（找不到命令）或退出码非 0 时返回 Err（含退出码与 stderr 前 200 字符）。
fn run(args: &[&str]) -> Result<String, String> {
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

    let out = output.map_err(|err| {
        format!(
            "执行 `opencode {}` 失败：{err}（确认 opencode 已安装并在 PATH 里）",
            args.join(" ")
        )
    })?;

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);

    if !out.status.success() {
        let code = out
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "无（被信号终止）".to_string());
        return Err(format!(
            "`opencode {}` 退出码 {code}，stderr：{}",
            args.join(" "),
            snippet(&stderr, 200)
        ));
    }

    Ok(format!("{stdout}\n{stderr}"))
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

pub fn discover() -> Result<Backend, String> {
    let status = run(&["service", "status"])
        .map_err(|err| format!("`opencode service status` 执行失败：{err}"))?;
    let base = find_base(&status).ok_or_else(|| {
        format!(
            "`opencode service status` 输出里没有 http://127.0.0.1:<端口>：{}",
            snippet(&status, 200)
        )
    })?;
    let port = port_of(&base)
        .ok_or_else(|| format!("`opencode service status` 给了地址但解析不出端口：{base}"))?;

    let pair = run(&["pair"]).map_err(|err| format!("`opencode pair` 执行失败：{err}"))?;
    let link = find_link(&pair).ok_or_else(|| {
        format!(
            "`opencode pair` 输出里没有配对链接：{}",
            snippet(&pair, 200)
        )
    })?;

    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(Duration::from_secs(10))
        .build();

    // 302 会被 ureq 当成正常响应返回（redirects(0)）；个别版本包成 Err(Status)，两种都取。
    let raw = match agent.get(&link).set("accept", "text/html").call() {
        Ok(resp) => resp.header("set-cookie").map(|v| v.to_string()),
        Err(ureq::Error::Status(_, resp)) => resp.header("set-cookie").map(|v| v.to_string()),
        Err(err) => return Err(format!("打开配对链接失败（{base}）：{err}")),
    }
    .ok_or_else(|| format!("配对链接没有返回 set-cookie（{base}）"))?;

    let cookie = raw
        .split(';')
        .next()
        .ok_or_else(|| "配对返回的 set-cookie 为空".to_string())?
        .trim()
        .to_string();
    // 只比对 cookie 名，避免把凭据本身写进日志。
    let cookie_name = cookie.split('=').next().unwrap_or("").to_string();
    if !cookie.starts_with(&format!("opencode_session_{port}=")) {
        return Err(format!(
            "cookie 名与服务端口不匹配：期望 opencode_session_{port}=...，实际 {cookie_name}=..."
        ));
    }

    Ok(Backend { base, cookie })
}
