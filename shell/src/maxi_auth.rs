//! 码栖通道的账号与令牌管理。
//!
//! 令牌文件：`%LOCALAPPDATA%\oc-workbench\maxi.json`，只有本机读写。
//! 上游只给 30 分钟的访问令牌，所以这里缓存并在快到期前自动续；
//! 真正发聊天请求的是 [`crate::maxi_proxy`]。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tiny_http::{Method, Request};

/// 令牌快到期前多久就续（秒级留量，别卡在边界上）。
const EARLY_MS: i64 = 120_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default, Clone)]
pub struct Auth {
    pub host: String,
    pub login_token: String,
    pub device_id: String,
    pub device_no: String,
    pub device_name: String,
    pub access_token: String,
    pub access_expires: i64,
    pub model: String,
}

impl Auth {
    pub fn configured(&self) -> bool {
        !self.host.is_empty() && !self.login_token.is_empty() && !self.device_id.is_empty()
    }
}

fn config_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|dir| PathBuf::from(dir).join("oc-workbench"))
}

fn auth_path() -> PathBuf {
    config_dir()
        .map(|dir| dir.join("maxi.json"))
        .unwrap_or_else(|| PathBuf::from("maxi.json"))
}

fn field_str(value: &Value, name: &str) -> String {
    value
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn field_i64(value: &Value, name: &str) -> i64 {
    value.get(name).and_then(Value::as_i64).unwrap_or(0)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

pub fn load() -> Auth {
    let text = fs::read_to_string(auth_path()).unwrap_or_default();
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    Auth {
        host: field_str(&value, "host"),
        login_token: field_str(&value, "loginToken"),
        device_id: field_str(&value, "deviceId"),
        device_no: field_str(&value, "deviceNo"),
        device_name: field_str(&value, "deviceName"),
        access_token: field_str(&value, "accessToken"),
        access_expires: field_i64(&value, "accessExpires"),
        model: field_str(&value, "model"),
    }
}

pub fn save(auth: &Auth) {
    let Some(dir) = config_dir() else {
        return;
    };
    let _ = fs::create_dir_all(&dir);
    let body = json!({
        "host": auth.host,
        "loginToken": auth.login_token,
        "deviceId": auth.device_id,
        "deviceNo": auth.device_no,
        "deviceName": auth.device_name,
        "accessToken": auth.access_token,
        "accessExpires": auth.access_expires,
        "model": auth.model,
    });
    let _ = fs::write(auth_path(), body.to_string());
}

/// 从本机码栖客户端导入（微信小程序绑定过就行）。
pub fn import_from_client() -> Result<Auth, String> {
    let imported = crate::maxi_import::import()?;
    let mut auth = Auth {
        host: imported.host,
        login_token: imported.login_token,
        device_id: imported.device_id,
        device_no: imported.device_no,
        device_name: imported.device_name,
        ..Default::default()
    };
    save(&auth);
    // 立刻换一次访问令牌，顺便把上游的模型名带回来；失败不影响导入本身。
    if let Ok(model) = refresh(&mut auth) {
        auth.model = model;
        save(&auth);
    }
    Ok(auth)
}

/// 手动填写（没有装码栖客户端的机器）。
pub fn configure(host: &str, login_token: &str, device_id: &str) -> Result<Auth, String> {
    let host = crate::maxi_import::normalize_host(host);
    if host.is_empty() {
        return Err("服务器地址不能为空".to_string());
    }
    if login_token.trim().is_empty() {
        return Err("登录令牌不能为空".to_string());
    }
    if device_id.trim().is_empty() {
        return Err("设备 ID 不能为空".to_string());
    }
    let mut auth = Auth {
        host,
        login_token: login_token.trim().to_string(),
        device_id: device_id.trim().to_string(),
        ..Default::default()
    };
    if let Ok(model) = refresh(&mut auth) {
        auth.model = model;
    }
    save(&auth);
    Ok(auth)
}

pub fn clear() {
    save(&Auth::default());
}

fn agent() -> Result<ureq::Agent, String> {
    let connector = native_tls::TlsConnector::new().map_err(|e| format!("初始化 TLS 失败：{e}"))?;
    Ok(ureq::AgentBuilder::new()
        .tls_connector(std::sync::Arc::new(connector))
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .build())
}

/// 换一次访问令牌，成功时返回上游的模型名。
pub fn refresh(auth: &mut Auth) -> Result<String, String> {
    if !auth.configured() {
        return Err("还没配置码栖通道".to_string());
    }
    let url = format!("{}/app/model/default/token", auth.host);
    let response = agent()?
        .post(&url)
        .set("authorization", &auth.login_token)
        .set("x-device-id", &auth.device_id)
        .set("content-type", "application/json")
        .send_bytes(b"{}");

    let value: Value = match response {
        Ok(res) => res.into_json().map_err(|e| format!("读取令牌响应失败：{e}"))?,
        Err(ureq::Error::Status(status, res)) => {
            let text = res.into_string().unwrap_or_default();
            return Err(format!("换取访问令牌失败（HTTP {status}）：{text}"));
        }
        Err(err) => return Err(format!("连不上 {}：{err}", auth.host)),
    };

    let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if code != 200 {
        let msg = field_str(&value, "msg");
        return Err(if msg.is_empty() {
            "换取访问令牌失败".to_string()
        } else {
            msg
        });
    }
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    let token = field_str(&data, "token");
    let expires = data
        .get("expiresInSeconds")
        .and_then(Value::as_i64)
        .unwrap_or(1800);
    let model = field_str(&data, "model");
    if token.is_empty() {
        return Err("服务器没有返回访问令牌".to_string());
    }
    auth.access_token = token;
    auth.access_expires = now_ms() + expires * 1000;
    Ok(model)
}

/// 拿一个可用的访问令牌（过期就续，续失败直接报原因）。
pub fn ensure_token(auth: &mut Auth) -> Result<String, String> {
    if !auth.access_token.is_empty() && auth.access_expires - now_ms() > EARLY_MS {
        return Ok(auth.access_token.clone());
    }
    let model = refresh(auth)?;
    if !model.is_empty() {
        auth.model = model;
    }
    save(auth);
    Ok(auth.access_token.clone())
}

// ---------- 本机转发密钥 ----------

static KEY_LOCK: Mutex<()> = Mutex::new(());

/// opencode 直连本地转发口，手里没有页面令牌，用这把钥匙认它。
pub fn local_key() -> String {
    let _guard = KEY_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let Some(dir) = config_dir() else {
        return "maxi-local".to_string();
    };
    let path = dir.join("settings.json");
    let text = fs::read_to_string(&path).unwrap_or_default();
    let mut map: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    if let Some(existing) = map.get("maxiKey").and_then(Value::as_str) {
        if !existing.trim().is_empty() {
            return existing.to_string();
        }
    }
    let key = format!("maxi-{}", crate::workbuddy::hex(24));
    if let Some(obj) = map.as_object_mut() {
        obj.insert("maxiKey".to_string(), Value::String(key.clone()));
    }
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(&path, map.to_string());
    key
}

// ---------- HTTP 接口 ----------

pub fn handle(request: Request, path: &str, _url: &str) {
    // 扫码绑定单独一个模块，先分流。
    if path.starts_with("/local/maxi/bind/") {
        crate::maxi_bind::handle(request, path, _url);
        return;
    }
    match path {
        "/local/maxi/status" => {
            if request.method() != &Method::Get {
                let _ = crate::server::json_error(request, 405, "状态只支持 GET");
                return;
            }
            let _ = crate::server::respond_json(request, 200, status_json().to_string());
        }
        "/local/maxi/import" => import_endpoint(request),
        "/local/maxi/configure" => configure_endpoint(request),
        "/local/maxi/logout" => {
            if request.method() != &Method::Post {
                let _ = crate::server::json_error(request, 405, "退出只支持 POST");
                return;
            }
            clear();
            let _ = crate::server::respond_json(request, 200, status_json().to_string());
        }
        _ => {
            let _ = crate::server::json_error(request, 404, "未知的码栖接口");
        }
    }
}

fn import_endpoint(request: Request) {
    if request.method() != &Method::Post {
        let _ = crate::server::json_error(request, 405, "导入只支持 POST");
        return;
    }
    let body = match import_from_client() {
        Ok(auth) => json!({ "ok": true, "model": auth.model, "status": status_json() }),
        Err(err) => json!({ "ok": false, "error": err }),
    };
    let _ = crate::server::respond_json(request, 200, body.to_string());
}

fn configure_endpoint(request: Request) {
    if request.method() != &Method::Post {
        let _ = crate::server::json_error(request, 405, "配置只支持 POST");
        return;
    }
    let Some((request, read)) = crate::body::read_body_with_timeout(request, crate::body::MAX_BODY)
    else {
        return;
    };
    let raw = match read {
        crate::body::BodyRead::Ok(body) => body,
        crate::body::BodyRead::TooLarge => {
            let _ = crate::server::json_error(request, 413, "请求体超过 10MB 上限");
            return;
        }
        crate::body::BodyRead::Failed(err) => {
            let _ = crate::server::json_error(request, 400, &format!("读请求体失败：{err}"));
            return;
        }
    };
    let value: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    let host = field_str(&value, "host");
    let login_token = field_str(&value, "loginToken");
    let device_id = field_str(&value, "deviceId");
    let body = match configure(&host, &login_token, &device_id) {
        Ok(auth) => json!({ "ok": true, "model": auth.model, "status": status_json() }),
        Err(err) => json!({ "ok": false, "error": err }),
    };
    let _ = crate::server::respond_json(request, 200, body.to_string());
}

// ---------- 状态 ----------

pub fn status_json() -> Value {
    let auth = load();
    json!({
        "ok": true,
        "configured": auth.configured(),
        "available": crate::maxi_import::available(),
        "host": auth.host,
        "deviceId": auth.device_id,
        "deviceName": auth.device_name,
        "model": if auth.model.is_empty() { "gpt-6.2-sol".to_string() } else { auth.model.clone() },
        "expires": auth.access_expires,
        "path": "/local/maxi/v1",
        "apiKey": local_key(),
    })
}

// ---------- 端口自愈 ----------

/// 把本地转发地址的端口换成本次启动的端口；不是转发地址就返回 None。
pub fn with_port(base: &str, port: u16) -> Option<String> {
    let rest = base.strip_prefix("http://")?;
    let (host, path) = rest.split_once('/')?;
    let (name, old_port) = host.rsplit_once(':')?;
    if name != "127.0.0.1" && name != "localhost" {
        return None;
    }
    // 远程入口会在前面加 `/u/<id>` 前缀，所以按结尾判断。
    if !(path == "local/maxi/v1" || path.ends_with("/local/maxi/v1")) {
        return None;
    }
    if old_port.parse::<u16>().ok()? == port {
        return None;
    }
    Some(format!("http://{name}:{port}/{path}"))
}

/// 启动时把 `provider.maxi.options.baseURL` 校正到本次端口。
pub fn heal_provider_port(port: u16) {
    if port == 0 {
        return;
    }
    let Some(path) = crate::provider_store::config_path(None) else {
        return;
    };
    let (value, error) = crate::provider_store::read_config(&path);
    if error.is_some() {
        return;
    }
    let base = value
        .get("provider")
        .and_then(|providers| providers.get("maxi"))
        .and_then(|entry| entry.get("options"))
        .and_then(|options| options.get("baseURL"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let Some(next) = with_port(base, port) else {
        return;
    };
    let saved = crate::provider_store::save_config(&path, |map| {
        let entry = map
            .get_mut("provider")
            .and_then(Value::as_object_mut)
            .and_then(|providers| providers.get_mut("maxi"))
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "找不到 maxi 配置".to_string())?;
        let options = entry
            .entry("options".to_string())
            .or_insert_with(|| json!({}));
        let options = options
            .as_object_mut()
            .ok_or_else(|| "maxi 的 options 不是对象".to_string())?;
        options.insert("baseURL".to_string(), Value::String(next));
        Ok(())
    });
    if saved.is_ok() {
        crate::append_log(&format!("[maxi] 已把转发地址校正到端口 {port}\n"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_needs_all_three() {
        let mut auth = Auth::default();
        assert!(!auth.configured());
        auth.host = "https://x".into();
        auth.login_token = "t".into();
        assert!(!auth.configured());
        auth.device_id = "d".into();
        assert!(auth.configured());
    }
}
