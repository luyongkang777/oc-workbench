//! 远程访问的持久化凭据与 cookie 签名。
//!
//! 设计约束见 `specs/remote-access/product.md`：
//!   * 凭据必须**跨重启有效**，所以存 `settings.json`，不用每次启动的随机 token；
//!   * cookie 自包含签名，不维护会话表（重启后仍然有效）；
//!   * 每台机器一个 `remoteToken`，天然做到「凭据与实例绑定」——
//!     A 的 cookie 拿不到 B 的实例，因为签名 key 不同。

// T1 只建基础设施，签名函数到 T6（cookie 登录）才接入调用点。
// 接入后删除下面这一行，让真的死代码重新暴露出来。
#![allow(dead_code)]

use std::sync::OnceLock;

use sha2::{Digest, Sha256};

use crate::update;

/// `settings.json` 里的键：远程访问凭据（64 位 hex = 32 字节）。
const TOKEN_KEY: &str = "remoteToken";
/// `settings.json` 里的键：本地监听端口（0 = 随机）。
const PORT_KEY: &str = "remotePort";
/// `settings.json` 里的键：路径前缀（如 `/u/ab12cd34`，空 = 不启用）。
const BASE_KEY: &str = "remoteBase";
/// 凭据的随机字节数。
const TOKEN_BYTES: usize = 32;

/// 读 `remoteToken`；没有或格式不对就生成一个新的并落盘。
///
/// 落盘失败时不阻断功能：返回内存里的值，本次能用，下次启动会重新生成。
pub fn remote_token() -> String {
    let mut map = update::load_settings();
    if let Some(serde_json::Value::String(value)) = map.get(TOKEN_KEY) {
        let value = value.trim().to_string();
        if value.len() >= 32 && value.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return value;
        }
    }

    let token = random_hex(TOKEN_BYTES);
    map.insert(
        TOKEN_KEY.to_string(),
        serde_json::Value::String(token.clone()),
    );
    if let Err(err) = update::save_settings(map) {
        crate::append_log(&format!("[remote] 保存 remoteToken 失败：{err}\n"));
    }
    token
}

/// 读 `remotePort`；0 = 随机端口（默认，保持原有行为）。
///
/// 兼容数字和字符串两种写法：手改 settings.json 时写成 "17800" 也认。
pub fn remote_port() -> u16 {
    match update::load_settings().get(PORT_KEY) {
        Some(serde_json::Value::Number(value)) => {
            value.as_u64().unwrap_or(0).min(u16::MAX as u64) as u16
        }
        Some(serde_json::Value::String(text)) => text.trim().parse::<u16>().unwrap_or(0),
        _ => 0,
    }
}

static TOKEN_CACHE: OnceLock<String> = OnceLock::new();

/// 进程内缓存的 `remoteToken`：一次运行内不变，避免每个请求都读文件。
pub fn cached_token() -> &'static str {
    TOKEN_CACHE.get_or_init(remote_token).as_str()
}

/// 读 `remoteBase` 并规整；非法值一律当没设（宁可不用前缀，也不能把路由搞坏）。
pub fn remote_base() -> String {
    let raw = match update::load_settings().get(BASE_KEY) {
        Some(serde_json::Value::String(text)) => text.trim().to_string(),
        _ => String::new(),
    };
    let normalized = normalize_base(&raw);
    // 写错了不能静默降级：否则隧道照跑、页面 404，用户完全不知道为什么。
    if !raw.is_empty() && normalized.is_empty() {
        crate::append_log(&format!(
            "[remote] remoteBase 不合法，已按「无前缀」启动（原始值：{raw}）\n"
        ));
    }
    normalized
}

/// 规整前缀：去掉尾部斜杠、必须以 `/` 开头、只允许安全字符。
pub fn normalize_base(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() || !trimmed.starts_with('/') {
        return String::new();
    }
    if trimmed.len() > 128 {
        return String::new();
    }
    let safe = trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '/' || ch == '-' || ch == '_');
    if !safe {
        return String::new();
    }
    trimmed.to_string()
}

/// 生成 `<exp>.<签名>` 形式的会话值。
///
/// `exp` 是过期时间（Unix 秒）；`instance_id` 参与签名，
/// 让同一份凭据签出的 cookie 不能跨实例复用。
pub fn sign_session(token: &str, instance_id: &str, exp: u64) -> String {
    let signature = hmac_hex(token.as_bytes(), payload(instance_id, exp).as_bytes());
    format!("{exp}.{signature}")
}

/// 校验会话值：格式、过期时间、签名。
pub fn verify_session(token: &str, instance_id: &str, value: &str, now: u64) -> bool {
    let Some((exp_text, signature)) = value.trim().split_once('.') else {
        return false;
    };
    let Ok(exp) = exp_text.parse::<u64>() else {
        return false;
    };
    if exp <= now {
        return false;
    }
    let expected = hmac_hex(token.as_bytes(), payload(instance_id, exp).as_bytes());
    constant_time_eq(expected.as_bytes(), signature.as_bytes())
}

fn payload(instance_id: &str, exp: u64) -> String {
    format!("{instance_id}|{exp}")
}

fn hmac_hex(key: &[u8], data: &[u8]) -> String {
    hmac_sha256(key, data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// HMAC-SHA256：只用已经在依赖图里的 `sha2`，不引新 crate。
fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    // 块长 64 字节，超长的 key 先哈希一次。
    let mut block = [0u8; 64];
    if key.len() > 64 {
        let digest = Sha256::digest(key);
        block[..32].copy_from_slice(&digest);
    } else {
        block[..key.len()].copy_from_slice(key);
    }

    let mut inner_pad = [0x36u8; 64];
    let mut outer_pad = [0x5cu8; 64];
    for (index, byte) in block.iter().enumerate() {
        inner_pad[index] ^= byte;
        outer_pad[index] ^= byte;
    }

    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(data);
    let inner_digest = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    let outer_digest = outer.finalize();

    let mut out = [0u8; 32];
    out.copy_from_slice(&outer_digest);
    out
}

/// 常数时间比较：避免按字节提前返回泄漏签名前缀。
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    if getrandom::getrandom(&mut buffer).is_err() {
        // 极端情况：和 `server::new_token` 一样退化成时间 + pid，至少不会起不来。
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|delta| delta.as_nanos())
            .unwrap_or(0);
        for (index, slot) in buffer.iter_mut().enumerate() {
            let shift = (index % 16) * 8;
            *slot = ((nanos >> shift) & 0xff) as u8 ^ (std::process::id() as u8);
        }
    }
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn 签名能通过校验() {
        let value = sign_session(TOKEN, "u/abc", 2_000_000_000);
        assert!(verify_session(TOKEN, "u/abc", &value, 1_900_000_000));
    }

    #[test]
    fn 过期就失败() {
        let value = sign_session(TOKEN, "u/abc", 1_000);
        assert!(!verify_session(TOKEN, "u/abc", &value, 1_000));
        assert!(!verify_session(TOKEN, "u/abc", &value, 2_000));
    }

    #[test]
    fn 换个实例就失败() {
        let value = sign_session(TOKEN, "u/abc", 2_000_000_000);
        assert!(!verify_session(TOKEN, "u/xyz", &value, 1_900_000_000));
    }

    #[test]
    fn 换个凭据就失败() {
        let value = sign_session(TOKEN, "u/abc", 2_000_000_000);
        let other = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
        assert!(!verify_session(other, "u/abc", &value, 1_900_000_000));
    }

    #[test]
    fn 篡改过期时间失败() {
        let value = sign_session(TOKEN, "u/abc", 1_000);
        let forged = value.replace("1000.", "9999999999.");
        assert!(!verify_session(TOKEN, "u/abc", &forged, 1_900_000_000));
    }

    #[test]
    fn 格式不对一律失败() {
        assert!(!verify_session(TOKEN, "u/abc", "", 1));
        assert!(!verify_session(TOKEN, "u/abc", "abc", 1));
        assert!(!verify_session(TOKEN, "u/abc", "123.zzz", 1));
    }

    #[test]
    fn 前缀规整() {
        assert_eq!(normalize_base("/u/abc/"), "/u/abc");
        assert_eq!(normalize_base("  /u/abc  "), "/u/abc");
        assert_eq!(normalize_base("u/abc"), "", "没斜杠开头当没设");
        assert_eq!(normalize_base(""), "");
        assert_eq!(normalize_base("/"), "");
        assert_eq!(normalize_base("/u/a b"), "", "空格算非法");
        assert_eq!(normalize_base("/u/a?b"), "", "问号算非法");
    }

    #[test]
    fn hmac_对标准向量() {
        // RFC 4231 Test Case 2
        let out = hmac_hex(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            out,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }
}
