//! 码栖扫码绑定：不用装它的客户端也能接入。
//!
//! 上游的绑定接口对匿名开放，流程和它自己的桌面版一致：
//!
//! 1. `POST /app/bind/wechat/create` → `ticket` + `pollKey`（180 秒有效）
//! 2. 二维码内容是一个 JSON：`{"type":"maxi-pc-bind","version":1,"bindId":…,"serverHost":…}`
//! 3. 手机微信扫码确认后，`GET /app/bind/wechat/poll?ticket=…`（带 `X-Login-Poll-Key`）
//!    从 `pending` 变成 `confirmed`，同时返回登录令牌
//! 4. 用这个令牌 `POST /app/devices/register` 拿 `deviceId`，之后就能换模型访问令牌
//!
//! 二维码在这里渲染成 SVG（前端直接当图片用），不引 JS 库。

use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use qrcode::render::svg;
use qrcode::QrCode;
use serde_json::{json, Value};
use tiny_http::{Method, Request};

use crate::maxi_auth::{load, refresh, save, Auth};

/// 没有配置过时的默认服务端。
pub const DEFAULT_HOST: &str = "https://unimateapi.dt2008.cn";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(20);

fn agent() -> Result<ureq::Agent, String> {
    let connector = native_tls::TlsConnector::new().map_err(|e| format!("初始化 TLS 失败：{e}"))?;
    Ok(ureq::AgentBuilder::new()
        .tls_connector(std::sync::Arc::new(connector))
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .build())
}

fn field_str(value: &Value, name: &str) -> String {
    value
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// 当前使用的服务端：配置里有就用配置的，没有就用默认。
pub fn server_host() -> String {
    let auth = load();
    if auth.host.is_empty() {
        DEFAULT_HOST.to_string()
    } else {
        auth.host
    }
}

fn host_name(url: &str) -> String {
    url.trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string()
}

fn is_private(host: &str) -> bool {
    host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("172.")
        || host.starts_with("192.168.")
        || host == "localhost"
}

/// 计算机名，用作设备显示名。
fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "这台电脑".to_string())
}

fn random_hex(bytes: usize) -> String {
    let mut raw = vec![0u8; bytes];
    if getrandom::getrandom(&mut raw).is_err() {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos() as u64)
            .unwrap_or(0)
            ^ (std::process::id() as u64);
        for (index, byte) in raw.iter_mut().enumerate() {
            *byte = (seed >> ((index % 8) * 8)) as u8;
        }
    }
    raw.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 建二维码：返回给前端的字段与它自己桌面版一致。
pub fn create_ticket() -> Result<Value, String> {
    let host = server_host();
    let url = format!("{host}/app/bind/wechat/create");
    let value: Value = match agent()?.post(&url).send_bytes(b"{}") {
        Ok(res) => res.into_json().map_err(|e| format!("读取绑定响应失败：{e}"))?,
        Err(ureq::Error::Status(status, res)) => {
            let text = res.into_string().unwrap_or_default();
            return Err(format!("创建二维码失败（HTTP {status}）：{text}"));
        }
        Err(err) => return Err(format!("连不上 {host}：{err}")),
    };
    let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if code != 200 {
        let msg = field_str(&value, "msg");
        return Err(if msg.is_empty() {
            "创建二维码失败".to_string()
        } else {
            msg
        });
    }
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    let ticket = field_str(&data, "ticket");
    let poll_key = field_str(&data, "pollKey");
    if ticket.is_empty() || poll_key.is_empty() {
        return Err("服务器没有返回 ticket / pollKey".to_string());
    }
    let expires = data
        .get("expiresInSeconds")
        .and_then(Value::as_i64)
        .unwrap_or(180);

    // 服务器可能返回一堆内网地址，二维码里优先用公网域名/公网 IP。
    let mut hosts: Vec<String> = data
        .get("serverHosts")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if !hosts.iter().any(|item| !is_private(item)) {
        hosts.insert(0, host_name(&host));
    }
    let primary = hosts
        .iter()
        .find(|item| !is_private(item))
        .cloned()
        .unwrap_or_else(|| host_name(&host));

    let payload = json!({
        "type": "maxi-pc-bind",
        "version": 1,
        "bindId": ticket,
        "serverHost": primary,
        "serverHosts": hosts,
    })
    .to_string();

    let code = QrCode::new(payload.as_bytes()).map_err(|e| format!("生成二维码失败：{e}"))?;
    let rendered = code
        .render::<svg::Color>()
        .min_dimensions(240, 240)
        .quiet_zone(true)
        .build();
    let data_url = format!("data:image/svg+xml;base64,{}", B64.encode(rendered));

    Ok(json!({
        "ok": true,
        "ticket": ticket,
        "pollKey": poll_key,
        "qr": data_url,
        "expiresInSeconds": expires,
    }))
}

/// 注册本机设备，返回 (deviceId, deviceName)。
fn register_device(host: &str, token: &str) -> Result<(String, String), String> {
    let url = format!("{host}/app/devices/register");
    let name = device_name();
    let body = json!({
        "deviceNo": random_hex(16),
        "deviceName": name,
        "clientType": "pc",
        "platform": "windows",
    });
    let value: Value = match agent()?
        .post(&url)
        .set("authorization", token)
        .set("content-type", "application/json")
        .send_bytes(body.to_string().as_bytes())
    {
        Ok(res) => res.into_json().map_err(|e| format!("读取设备注册响应失败：{e}"))?,
        Err(ureq::Error::Status(status, res)) => {
            let text = res.into_string().unwrap_or_default();
            return Err(format!("注册电脑失败（HTTP {status}）：{text}"));
        }
        Err(err) => return Err(format!("连不上 {host}：{err}")),
    };
    let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if code != 200 {
        let msg = field_str(&value, "msg");
        return Err(if msg.is_empty() {
            "注册电脑失败".to_string()
        } else {
            msg
        });
    }
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    let device_id = field_str(&data, "deviceId");
    if device_id.is_empty() {
        return Err("服务器没有返回设备 ID".to_string());
    }
    let device_name = {
        let text = field_str(&data, "deviceName");
        if text.is_empty() {
            name
        } else {
            text
        }
    };
    Ok((device_id, device_name))
}

/// 轮询扫码结果；确认后自动注册设备并落盘。
pub fn poll_ticket(ticket: &str, poll_key: &str) -> Result<Value, String> {
    if ticket.trim().is_empty() || poll_key.trim().is_empty() {
        return Err("缺少 ticket 或 pollKey".to_string());
    }
    let host = server_host();
    let url = format!(
        "{host}/app/bind/wechat/poll?ticket={}",
        ticket.trim()
    );
    let value: Value = match agent()?
        .get(&url)
        .set("x-login-poll-key", poll_key.trim())
        .call()
    {
        Ok(res) => res.into_json().map_err(|e| format!("读取轮询响应失败：{e}"))?,
        Err(ureq::Error::Status(status, res)) => {
            let text = res.into_string().unwrap_or_default();
            return Err(format!("轮询失败（HTTP {status}）：{text}"));
        }
        Err(err) => return Err(format!("连不上 {host}：{err}")),
    };
    let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if code != 200 {
        let msg = field_str(&value, "msg");
        return Err(if msg.is_empty() {
            "轮询扫码状态失败".to_string()
        } else {
            msg
        });
    }
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    let status = {
        let text = field_str(&data, "status");
        if text.is_empty() {
            "expired".to_string()
        } else {
            text
        }
    };

    if status != "confirmed" {
        return Ok(json!({ "ok": true, "status": status }));
    }

    let login_token = field_str(&data, "token");
    if login_token.is_empty() {
        return Err("登录已确认，但服务器没返回登录凭证".to_string());
    }
    let username = field_str(&data, "username");

    let (device_id, device_name) = register_device(&host, &login_token)?;
    let mut auth = Auth {
        host,
        login_token,
        device_id,
        device_no: String::new(),
        device_name: device_name.clone(),
        ..Default::default()
    };
    if let Ok(model) = refresh(&mut auth) {
        auth.model = model;
    }
    save(&auth);

    Ok(json!({
        "ok": true,
        "status": "confirmed",
        "configured": true,
        "deviceName": device_name,
        "username": username,
        "model": auth.model,
    }))
}

// ---------- HTTP ----------

pub fn handle(request: Request, path: &str, url: &str) {
    match path {
        "/local/maxi/bind/create" => {
            if request.method() != &Method::Post {
                let _ = crate::server::json_error(request, 405, "创建二维码只支持 POST");
                return;
            }
            let body = match create_ticket() {
                Ok(value) => value,
                Err(err) => json!({ "ok": false, "error": err }),
            };
            let _ = crate::server::respond_json(request, 200, body.to_string());
        }
        "/local/maxi/bind/poll" => {
            if request.method() != &Method::Get {
                let _ = crate::server::json_error(request, 405, "轮询只支持 GET");
                return;
            }
            let ticket = query_value(url, "ticket");
            let poll_key = query_value(url, "pollKey");
            let body = match poll_ticket(&ticket, &poll_key) {
                Ok(value) => value,
                Err(err) => json!({ "ok": false, "error": err }),
            };
            let _ = crate::server::respond_json(request, 200, body.to_string());
        }
        _ => {
            let _ = crate::server::json_error(request, 404, "未知的码栖绑定接口");
        }
    }
}

fn query_value(url: &str, name: &str) -> String {
    let Some((_, query)) = url.split_once('?') else {
        return String::new();
    };
    for pair in query.split('&') {
        let (key, value) = match pair.split_once('=') {
            Some(pair) => pair,
            None => (pair, ""),
        };
        if key == name {
            return decode(value);
        }
    }
    String::new()
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        if byte == b'+' {
            out.push(b' ');
        } else {
            out.push(byte);
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实环境：向码栖要一次绑定 ticket，并渲染二维码。
    /// 手动跑：cargo test creates_real_ticket -- --ignored --nocapture
    #[test]
    #[ignore]
    fn creates_real_ticket() {
        let value = create_ticket().expect("应当能创建二维码");
        let qr = value.get("qr").and_then(Value::as_str).unwrap_or("");
        println!(
            "ticket_len={} qr_len={} expires={}",
            value.get("ticket").and_then(Value::as_str).unwrap_or("").len(),
            qr.len(),
            value.get("expiresInSeconds").and_then(Value::as_i64).unwrap_or(0)
        );
        assert!(qr.starts_with("data:image/svg+xml;base64,"), "二维码应当是 SVG data URL");
        assert!(qr.len() > 500, "二维码内容太短，可能没渲染出来");
    }

    #[test]
    fn private_hosts_are_detected() {
        assert!(is_private("127.0.0.1"));
        assert!(is_private("192.168.1.2"));
        assert!(!is_private("unimateapi.dt2008.cn"));
        assert!(!is_private("45.136.119.33"));
    }

    #[test]
    fn query_parsing_handles_encoding() {
        assert_eq!(query_value("/x?ticket=a%2Bb&pollKey=k", "ticket"), "a+b");
        assert_eq!(query_value("/x?ticket=a+b&pollKey=k", "pollKey"), "k");
        assert_eq!(query_value("/x", "ticket"), "");
    }

    #[test]
    fn host_name_strips_scheme() {
        assert_eq!(host_name("https://a.com/"), "a.com");
        assert_eq!(host_name("http://b.cn"), "b.cn");
    }
}
