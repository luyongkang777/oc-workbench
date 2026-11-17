//! WorkBuddy 原生登录：`/local/workbuddy/*` 里的账号部分。
//!
//! | 接口 | 作用 |
//! |---|---|
//! | `GET  /local/workbuddy/status`      | 登录状态 + 本机转发密钥 |
//! | `POST /local/workbuddy/login/start` | 向腾讯要一个登录页（state + url） |
//! | `GET  /local/workbuddy/login/poll`  | 按 state 轮询令牌（未完成 = `pending`） |
//! | `POST /local/workbuddy/logout`      | 清掉本机令牌 |
//!
//! 令牌只落 `%LOCALAPPDATA%\oc-workbench\workbuddy.json`，不出现在日志里，也只在
//! `status` 里回「有没有、谁的、什么时候到期」，不回明文。
//!
//! 上游是 WorkBuddy 的插件接口（和它自己桌面客户端登录页同一套）：
//! `POST /v2/plugin/auth/state` → 浏览器登录 → `GET /v2/plugin/auth/token?state=`，
//! 未完成时 HTTP 200 + `code:11217`。

use std::fs;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tiny_http::{Method, Request};

use crate::workbuddy_http::{decode, encode, query_value, raw};
use crate::workbuddy_store::{
    auth_path, data_dir, now_ms, save, settings_path, with_port,
};
use crate::workbuddy_util::{code_of, expiry_of, field_i64, field_str, msg_of};
pub use crate::workbuddy_util::domain_of;
pub use crate::workbuddy_util::{ensure_fresh, refresh};
pub use crate::workbuddy_store::{heal_provider_port, Auth};
#[allow(unused_imports)]
use crate::workbuddy_store::*;

/// WorkBuddy 国内版固定入口。
pub const ENDPOINT: &str = "https://copilot.tencent.com";
/// 请求头里冒充的桌面版版本（UA 不是 `WorkBuddy/<版本>` 会被上游 10085 拒）。
pub const APP: &str = "5.9.3";
/// 桌面版内置 CLI 的版本。
pub const CLI: &str = "2.165.0";
/// 令牌快到期前多久就续期。
pub(crate) const EARLY_MS: i64 = 60_000;
pub(crate) const NET_TIMEOUT: Duration = Duration::from_secs(20);
/// 上游「还没登完」的错误码。
const LOGIN_PENDING_CODE: i64 = 11217;

pub fn handle(request: Request, path: &str, url: &str) {
    match path {
        "/local/workbuddy/status" => status_endpoint(request),
        "/local/workbuddy/login/start" => start_endpoint(request),
        "/local/workbuddy/login/poll" => poll_endpoint(request, url),
        "/local/workbuddy/logout" => logout_endpoint(request),
        "/local/workbuddy/billing" | "/local/workbuddy/checkin" => {
            crate::workbuddy_billing::handle(request, path, url)
        }
        _ => {
            let _ = crate::server::json_error(request, 404, "未知的 WorkBuddy 接口");
        }
    }
}

// ---------- 登录状态 ----------

fn status_endpoint(request: Request) {
    if request.method() != &Method::Get {
        let _ = crate::server::json_error(request, 405, "状态只支持 GET");
        return;
    }
    let _ = crate::server::respond_json(request, 200, status_json().to_string());
}

pub fn status_json() -> Value {
    let auth = load();
    json!({
        "ok": true,
        "configured": auth.configured(),
        "account": auth.account,
        "uid": auth.uid,
        "domain": auth.domain,
        "enterpriseId": auth.enterprise,
        "expires": auth.expires,
        "refreshExpiresAt": auth.refresh_expires,
        "endpoint": ENDPOINT,
        // 下面两个是给 provider 表单用的：地址由前端按自己的 origin 拼，路径这里给
        "path": "/local/workbuddy/v1",
        "apiKey": local_key(),
    })
}

// ---------- 开始登录 ----------

fn start_endpoint(request: Request) {
    if request.method() != &Method::Post {
        let _ = crate::server::json_error(request, 405, "开始登录只支持 POST");
        return;
    }
    let no_auth = [
        ("X-No-Authorization", "true".to_string()),
        ("X-No-User-Id", "true".to_string()),
        ("X-No-Enterprise-Id", "true".to_string()),
        ("X-No-Department-Info", "true".to_string()),
    ];
    let result = raw(
        "POST",
        "/v2/plugin/auth/state?platform=workbuddy",
        &no_auth,
        Some(&json!({})),
    );
    let body = match result {
        Ok((_, value)) if code_of(&value) == 0 => {
            let data = value.get("data").cloned().unwrap_or(Value::Null);
            let state = field_str(&data, "state");
            let url = field_str(&data, "authUrl");
            if state.is_empty() || url.is_empty() {
                json!({ "ok": false, "error": "WorkBuddy 没有返回登录页地址" })
            } else {
                json!({ "ok": true, "state": state, "url": url })
            }
        }
        Ok((status, value)) => json!({
            "ok": false,
            "error": format!("WorkBuddy 拒绝登录请求（HTTP {status}，code {}，{}）",
                code_of(&value), msg_of(&value)),
        }),
        Err(err) => json!({ "ok": false, "error": err }),
    };
    let _ = crate::server::respond_json(request, 200, body.to_string());
}

// ---------- 轮询令牌 ----------

fn poll_endpoint(request: Request, url: &str) {
    if request.method() != &Method::Get {
        let _ = crate::server::json_error(request, 405, "轮询只支持 GET");
        return;
    }
    let state = query_value(url, "state").unwrap_or_default();
    if state.is_empty() {
        let _ = crate::server::json_error(request, 400, "缺少 state");
        return;
    }
    let _ = crate::server::respond_json(request, 200, poll_json(&state).to_string());
}

fn poll_json(state: &str) -> Value {
    let path = format!("/v2/plugin/auth/token?state={}", encode(state));
    let (status, value) = match raw("GET", &path, &[], None) {
        Ok(pair) => pair,
        Err(err) => return json!({ "ok": false, "pending": false, "error": err }),
    };
    let code = code_of(&value);
    if code == LOGIN_PENDING_CODE {
        return json!({ "ok": true, "pending": true });
    }
    if status >= 400 || code != 0 {
        return json!({
            "ok": false,
            "pending": false,
            "error": format!("WorkBuddy 登录失败（HTTP {status}，code {code}，{}）", msg_of(&value)),
        });
    }
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    let access = field_str(&data, "accessToken");
    if access.is_empty() {
        return json!({ "ok": false, "pending": false, "error": "WorkBuddy 没有返回令牌" });
    }

    let mut auth = Auth {
        access,
        refresh: field_str(&data, "refreshToken"),
        expires: expiry_of(&data, "expiresAt", "expiresIn"),
        ..load()
    };
    if auth.refresh.is_empty() {
        auth.refresh = load().refresh;
    }
    let domain = field_str(&data, "domain");
    if !domain.is_empty() {
        auth.domain = domain;
    }

    // 账号信息拿不到不影响用：令牌才是关键，昵称只是展示
    if let Some(who) = crate::workbuddy_util::account_of(&auth, state) {
        auth.uid = field_str(&who, "uid");
        let nickname = field_str(&who, "nickname");
        let phone = field_str(&who, "phoneNumber");
        auth.account = if !nickname.is_empty() { nickname } else { phone };
        auth.enterprise = field_str(&who, "enterpriseId");
    }
    save(&auth);

    json!({
        "ok": true,
        "pending": false,
        "done": true,
        "account": auth.account,
        "uid": auth.uid,
        "expires": auth.expires,
    })
}


// ---------- 退出 ----------

fn logout_endpoint(request: Request) {
    if request.method() != &Method::Post {
        let _ = crate::server::json_error(request, 405, "退出登录只支持 POST");
        return;
    }
    save(&Auth::default());
    let _ = crate::server::respond_json(request, 200, status_json().to_string());
}

// ---------- 令牌续期（转发模块调用） ----------

pub fn load() -> Auth {
    let text = fs::read_to_string(auth_path()).unwrap_or_default();
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    Auth {
        access: field_str(&value, "access"),
        refresh: field_str(&value, "refresh"),
        expires: field_i64(&value, "expires"),
        refresh_expires: field_i64(&value, "refreshExpiresAt"),
        uid: field_str(&value, "uid"),
        domain: field_str(&value, "domain"),
        account: field_str(&value, "account"),
        enterprise: field_str(&value, "enterpriseId"),
    }
}




// ---------- 落盘与密钥 ----------

/// 本地转发用的随机密钥（`settings.json` 的 `workbuddyKey`）：opencode 直连转发端口，
/// 手里没有页面令牌，用这把钥匙认它。第一次调用时生成并落盘。
/// 本机转发密钥的生成与读取要串行，否则并发首个请求会各写一份。
static KEY_LOCK: Mutex<()> = Mutex::new(());

pub fn local_key() -> String {
    let _guard = KEY_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let text = fs::read_to_string(settings_path()).unwrap_or_default();
    let mut map: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    let existing = field_str(&map, "workbuddyKey");
    if !existing.is_empty() {
        return existing;
    }
    let key = format!("wb-{}", hex(24));
    if let Some(obj) = map.as_object_mut() {
        obj.insert("workbuddyKey".to_string(), Value::String(key.clone()));
    }
    let dir = data_dir();
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(settings_path(), map.to_string());
    key
}

// ---------- HTTP ----------



// ---------- 小工具 ----------






pub fn hex(bytes: usize) -> String {
    let mut raw = vec![0u8; bytes];
    if getrandom::getrandom(&mut raw).is_err() {
        // 极端情况下退回时间戳：强度差一点，但不能让登录整体失败
        let seed = now_ms() as u128 ^ ((std::process::id() as u128) << 64);
        for (index, byte) in raw.iter_mut().enumerate() {
            *byte = (seed >> ((index % 16) * 8)) as u8;
        }
    }
    let mut out = String::with_capacity(bytes * 2);
    for byte in raw {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}




#[cfg(test)]
#[path = "workbuddy_tests.rs"]
mod tests;
