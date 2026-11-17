//! WorkBuddy 的令牌续期与响应字段工具（从 `workbuddy.rs` 拆出来）。

use serde_json::{json, Value};

use crate::workbuddy::EARLY_MS;
use crate::workbuddy_http::{encode, raw};
use crate::workbuddy_store::{now_ms, Auth, save};

/// 快到期就先续期。续期失败直接报「重新登录」，别让上游 401 冒到界面上。
pub fn ensure_fresh(auth: &mut Auth) -> Result<(), String> {
    if auth.expires <= 0 || now_ms() < auth.expires - EARLY_MS {
        return Ok(());
    }
    refresh(auth)
}

/// 用 refresh token 换一对新令牌。
pub fn refresh(auth: &mut Auth) -> Result<(), String> {
    if auth.refresh.is_empty() {
        return Err("WorkBuddy 登录已失效，请重新登录".to_string());
    }
    if auth.refresh_expires > 0 && now_ms() >= auth.refresh_expires {
        return Err("WorkBuddy 登录已过期，请重新登录".to_string());
    }
    let headers = [
        ("X-Refresh-Token", auth.refresh.clone()),
        ("X-Auth-Refresh-Source", "plugin".to_string()),
    ];
    let (status, value) = raw(
        "POST",
        "/v2/plugin/auth/token/refresh",
        &headers,
        Some(&json!({})),
    )?;
    if status >= 400 || code_of(&value) != 0 {
        return Err(format!(
            "WorkBuddy 续期失败（HTTP {status}，code {}，{}），请重新登录",
            code_of(&value),
            msg_of(&value)
        ));
    }
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    let access = field_str(&data, "accessToken");
    if access.is_empty() {
        return Err("WorkBuddy 续期没有返回令牌，请重新登录".to_string());
    }
    auth.access = access;
    let next_refresh = field_str(&data, "refreshToken");
    if !next_refresh.is_empty() {
        auth.refresh = next_refresh;
    }
    auth.expires = expiry_of(&data, "expiresAt", "expiresIn");
    let refresh_expires = expiry_of(&data, "refreshExpiresAt", "refreshExpiresIn");
    if refresh_expires > 0 {
        auth.refresh_expires = refresh_expires;
    }
    save(auth);
    Ok(())
}

/// 账号的 domain：企业版是它自己的主机名，普通账号没有。
pub fn domain_of(auth: &Auth) -> String {
    if auth.domain.is_empty() {
        "copilot.tencent.com".to_string()
    } else {
        auth.domain.clone()
    }
}

pub(crate) fn code_of(value: &Value) -> i64 {
    value.get("code").and_then(Value::as_i64).unwrap_or(0)
}

pub(crate) fn msg_of(value: &Value) -> String {
    for key in ["msg", "message"] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

pub fn field_str(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

pub(crate) fn field_i64(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

/// 到期时间：上游给绝对时间戳（ms）就用它，给的是剩余秒数就换算成 ms。
pub(crate) fn expiry_of(data: &Value, at_key: &str, in_key: &str) -> i64 {
    let at = field_i64(data, at_key);
    if at > 0 {
        return at;
    }
    let inside = field_i64(data, in_key);
    if inside > 0 {
        return now_ms() + inside * 1000;
    }
    0
}

pub(crate) fn account_of(auth: &Auth, state: &str) -> Option<Value> {
    let path = format!(
        "/v2/plugin/login/account?state={}&platform=workbuddy",
        encode(state)
    );
    let headers = [
        ("Authorization", format!("Bearer {}", auth.access)),
        ("X-Domain", domain_of(auth)),
        ("X-No-User-Id", "true".to_string()),
        ("X-No-Enterprise-Id", "true".to_string()),
    ];
    let (_, value) = raw("GET", &path, &headers, None).ok()?;
    if code_of(&value) != 0 {
        return None;
    }
    value.get("data").cloned()
}
