//! 远程入口的 cookie 登录。
//!
//! 浏览器拿不到外壳经 IPC 下发的 token，所以用一次性的 `?t=` 换一个签名 cookie。
//! cookie 自包含（不维护会话表），重启后仍然有效；每台机器用各自的 `remoteToken`
//! 签名，所以 A 的 cookie 拿到 B 的实例上验签必然失败——这是多实例不串号的凭据层。

use tiny_http::{Header, Request};

use crate::remote_auth;

/// cookie 名。
pub const COOKIE_NAME: &str = "oc_sess";
/// 有效期：30 天。
const MAX_AGE_SECS: u64 = 30 * 24 * 60 * 60;

/// 入口检查的结果。
pub enum LoginOutcome {
    /// URL 里没有 `t`，走正常流程。
    Ignore,
    /// 有 `t` 但不对。
    Rejected,
    /// 校验通过，带着要下发的 cookie 值。
    Accepted(String),
}

/// 检查 `?t=<token>`；`base` 参与签名，让 cookie 与实例绑定。
pub fn login_from_query(url: &str, base: &str, now: u64) -> LoginOutcome {
    let Some(token) = query_param(url, "t") else {
        return LoginOutcome::Ignore;
    };
    if token.is_empty() || token != remote_auth::cached_token() {
        return LoginOutcome::Rejected;
    }
    let exp = now + MAX_AGE_SECS;
    LoginOutcome::Accepted(remote_auth::sign_session(
        remote_auth::cached_token(),
        base,
        exp,
    ))
}

/// 构造 Set-Cookie 头。`Path` 限定在前缀下，避免实例之间互相覆盖。
pub fn cookie_header(base: &str, value: &str) -> Header {
    let path = if base.is_empty() {
        "/".to_string()
    } else {
        format!("{base}/")
    };
    let text = format!(
        "{COOKIE_NAME}={value}; Path={path}; Max-Age={MAX_AGE_SECS}; HttpOnly; SameSite=Lax"
    );
    Header::from_bytes(&b"set-cookie"[..], text.as_bytes()).expect("set-cookie 头构造失败")
}

/// `Referrer-Policy: no-referrer`：入口 URL 里带 token，不能被外链带走。
pub fn no_referrer() -> Header {
    Header::from_bytes(&b"referrer-policy"[..], b"no-referrer").expect("referrer-policy 头构造失败")
}

/// 入口跳转不能缓存：否则浏览器会一直用第一次那条 302（可能没带 cookie）。
pub fn no_store() -> Header {
    Header::from_bytes(&b"cache-control"[..], b"no-store").expect("cache-control 头构造失败")
}

/// 从请求里取某个 cookie 的值。
pub fn cookie_value(request: &Request, name: &str) -> Option<String> {
    let raw = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("cookie"))?
        .value
        .as_str();
    for part in raw.split(';') {
        if let Some((key, value)) = part.trim().split_once('=') {
            if key.trim() == name {
                return Some(value.trim().to_string());
            }
        }
    }
    None
}

fn query_param(url: &str, name: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if key == name {
            // token 是 hex，不需要百分号解码。
            return Some(value.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 没有t就忽略() {
        assert!(matches!(
            login_from_query("/api/info", "/u/abc", 0),
            LoginOutcome::Ignore
        ));
    }

    #[test]
    fn 错误的t被拒() {
        let token = remote_auth::cached_token().to_string();
        let wrong = if token == "deadbeef" { "cafe" } else { "deadbeef" };
        assert!(matches!(
            login_from_query(&format!("/?t={wrong}"), "/u/abc", 0),
            LoginOutcome::Rejected
        ));
    }

    #[test]
    fn 正确的t签发cookie且绑定实例() {
        let token = remote_auth::cached_token().to_string();
        match login_from_query(&format!("/?t={token}"), "/u/abc", 1_000) {
            LoginOutcome::Accepted(value) => {
                assert!(remote_auth::verify_session(&token, "/u/abc", &value, 1_000));
                // 同一份 cookie 拿到别的实例上必须失败
                assert!(!remote_auth::verify_session(&token, "/u/xyz", &value, 1_000));
            }
            _ => panic!("应该通过"),
        }
    }

    #[test]
    fn cookie路径跟着前缀() {
        let header = cookie_header("/u/abc", "v");
        let text = header.value.as_str();
        assert!(text.contains("Path=/u/abc/"), "{text}");
        assert!(text.contains("HttpOnly"), "{text}");

        let root = cookie_header("", "v");
        assert!(root.value.as_str().contains("Path=/;"), "{}", root.value.as_str());
    }
}
