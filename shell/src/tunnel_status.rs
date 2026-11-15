//! 隧道状态的对外表达：给界面看的 JSON、失败原因的人话翻译。
//!
//! 从 `tunnel.rs` 拆出来的（那边只管配置与生命周期，这里只管「怎么描述」）。
//!
//! 为什么需要：新电脑第一次装的时候，最常见的问题是「这台电脑没配 ssh 别名」，
//! 但界面上只会看到设备「离线」，用户完全不知道该去配 ssh。真实报错只在
//! tunnel.log 里（而且 ssh 的中文输出是 GBK，直接读会乱码），必须转成人话。

use std::sync::Mutex;

use crate::tunnel_proc as proc;

/// 最近一次失败原因。成功后会被清空。
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

pub fn set_error(message: Option<String>) {
    let mut guard = match LAST_ERROR.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    *guard = message;
}

pub fn last_error() -> Option<String> {
    let guard = match LAST_ERROR.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.clone()
}

/// 拼状态 JSON：`{"running":bool,"pid":n,"host":"..","relayPort":n,"localPort":n,"error":null|".."}`
pub fn status_json(host: &str, relay_port: u16, local_port: u16, pid: u32) -> String {
    let error = match last_error() {
        Some(msg) => format!("\"{}\"", escape(&msg)),
        None => "null".to_string(),
    };
    format!(
        "{{\"running\":{},\"pid\":{},\"host\":\"{}\",\"relayPort\":{},\"localPort\":{},\"error\":{}}}",
        pid > 0,
        pid,
        escape(host),
        relay_port,
        local_port,
        error
    )
}

/// 读 tunnel.log 最后一行（ssh 的原始 stderr）。
///
/// 只追加不清理的话，长期失败会让文件无限增长，超过 64KB 就清空一次。
pub fn last_log_line() -> Option<String> {
    let path = proc::log_file()?;
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 64 * 1024 {
            let _ = std::fs::write(&path, "");
        }
    }
    let text = std::fs::read_to_string(&path).ok()?;
    text.lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
}

/// 把 ssh 的报错转成用户能照着做的提示。
///
/// 关键词都是 ASCII，所以即使中文部分是 GBK 乱码也能匹配上。
pub fn describe_failure(detail: &str, host: &str, code: &str) -> String {
    if detail.contains("Could not resolve hostname") {
        return format!("连不上 ssh 主机 {host}：这台电脑没有配 ssh 别名（~/.ssh/config 里缺少 {host}）");
    }
    if detail.contains("Permission denied") {
        return format!("ssh 认证失败：{host} 的密钥没配对（把本机公钥加到服务器的 authorized_keys）");
    }
    if detail.contains("forwarding failed") {
        return "服务器上的端口被占用：多半是上次残留的隧道进程，或另一台设备用了同一个 ID".to_string();
    }
    if detail.contains("Connection refused") || detail.contains("Connection timed out") {
        return format!("连不上 {host}：网络不通，或服务器 sshd 没在跑");
    }
    if detail.trim().is_empty() {
        return format!("ssh 退出（{code}），详情见 tunnel.log");
    }
    let short: String = detail.chars().take(160).collect();
    format!("ssh 退出（{code}）：{short}")
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' | '\r' => out.push(' '),
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析常见的几种失败原因() {
        assert!(describe_failure("ssh: Could not resolve hostname tiku: ...", "tiku", "255")
            .contains("没有配 ssh 别名"));
        assert!(describe_failure("root@1.2.3.4: Permission denied (publickey).", "tiku", "255")
            .contains("密钥没配对"));
        assert!(describe_failure(
            "Error: remote port forwarding failed for listen port 17802",
            "tiku",
            "255"
        )
        .contains("端口被占用"));
        assert!(describe_failure("", "tiku", "255").contains("tunnel.log"));
    }

    #[test]
    fn json_转义引号与换行() {
        assert_eq!(escape("a\"b\\c\nd"), "a\\\"b\\\\c d");
    }

    #[test]
    fn 状态_json_字段齐全() {
        set_error(Some("boom \"x\"".to_string()));
        let json = status_json("tiku", 17802, 17800, 123);
        assert!(json.contains("\"running\":true"));
        assert!(json.contains("\"relayPort\":17802"));
        assert!(json.contains("boom \\\"x\\\""));
        set_error(None);
        assert!(status_json("tiku", 17802, 17800, 0).contains("\"error\":null"));
    }
}
