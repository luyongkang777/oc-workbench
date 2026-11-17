//! WorkBuddy 的 HTTP 传输与编码工具（从 `workbuddy.rs` 拆出来）。

use std::io::Read;
use serde_json::Value;

use crate::workbuddy::{APP, ENDPOINT, NET_TIMEOUT};

/// 发一次请求，返回 (HTTP 状态, 解析后的 JSON)。
///
/// 上游把业务错误放在 `code` 里（HTTP 仍 200），所以状态码和 code 都要看。
pub(crate) fn raw(
    method: &str,
    path: &str,
    headers: &[(&str, String)],
    body: Option<&Value>,
) -> Result<(u16, Value), String> {
    let url = format!("{ENDPOINT}{path}");
    let agent = crate::fetch::agent(NET_TIMEOUT, Some(NET_TIMEOUT))?;
    let mut call = agent.request(method, &url);
    call = call
        .set("accept", "application/json")
        .set("content-type", "application/json")
        .set("user-agent", &format!("WorkBuddy/{APP}"));
    for (name, value) in headers {
        call = call.set(name, value);
    }
    let result = match body {
        Some(value) => call.send_bytes(value.to_string().as_bytes()),
        None => call.call(),
    };
    let (status, text) = match result {
        Ok(response) => {
            let status = response.status();
            (status, read_text(response)?)
        }
        Err(ureq::Error::Status(status, response)) => (status, read_text(response)?),
        Err(other) => return Err(format!("连不上 {url}：{other}")),
    };
    let value = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text));
    Ok((status, value))
}

fn read_text(response: ureq::Response) -> Result<String, String> {
    let mut reader = response.into_reader();
    let mut bytes: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 32 * 1024];
    loop {
        let read = reader
            .read(&mut chunk)
            .map_err(|err| format!("读 WorkBuddy 响应失败：{err}"))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("WorkBuddy 响应过大，已放弃".to_string());
        }
    }
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

pub(crate) fn query_value(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    for pair in query.split('&') {
        let (name, value) = match pair.split_once('=') {
            Some(pair) => pair,
            None => continue,
        };
        if name == key {
            return Some(decode(value));
        }
    }
    None
}

/// 只处理 `%XX` 与 `+`：state 是 UUID，够用。
pub(crate) fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            byte => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

pub(crate) fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}
