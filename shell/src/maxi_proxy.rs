//! 码栖通道的本地转发：`/local/maxi/v1/*`。
//!
//! 为什么要在工作台里做：码栖上游只认 Responses API，密钥还是 30 分钟一换的，
//! opencode 既不会换协议也不会续期。这里补上两件事，opencode 那边就只是个普通
//! OpenAI 兼容端点。
//!
//! | 接口 | 作用 |
//! |---|---|
//! | `GET  /local/maxi/v1/models`            | 当前通道的模型 |
//! | `POST /local/maxi/v1/chat/completions`  | 转成 Responses 请求 → 上游 → 转回来 |
//!
//! 鉴权用独立密钥（`settings.json` 的 `maxiKey`），因为调用方是 opencode，
//! 它手里没有页面令牌。

use std::io::{Read, Write};
use std::time::Duration;

use serde_json::{json, Value};
use tiny_http::{Method, Request};

use crate::body::{read_body_with_timeout, BodyRead};
use crate::maxi_auth::{ensure_token, refresh, Auth};
use crate::maxi_convert::{to_responses, Translator};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(600);

pub fn handle(request: Request, path: &str, _url: &str) {
    if !authorized(&request) {
        let _ = crate::server::respond_json(
            request,
            401,
            json!({ "error": { "message": "码栖本地转发密钥不对", "type": "unauthorized" } })
                .to_string(),
        );
        return;
    }
    match path {
        "/local/maxi/v1/models" => models_endpoint(request),
        "/local/maxi/v1/chat/completions" => chat_endpoint(request),
        _ => {
            let _ = crate::server::json_error(request, 404, "未知的码栖转发路径");
        }
    }
}

fn authorized(request: &Request) -> bool {
    let expected = format!("Bearer {}", crate::maxi_auth::local_key());
    request.headers().iter().any(|header| {
        header.field.equiv("authorization") && header.value.as_str().trim() == expected
    })
}

fn model_of(auth: &Auth) -> String {
    if auth.model.is_empty() {
        "gpt-6.2-sol".to_string()
    } else {
        auth.model.clone()
    }
}

fn models_endpoint(request: Request) {
    let auth = crate::maxi_auth::load();
    let model = model_of(&auth);
    let body = json!({
        "object": "list",
        "data": [{ "id": model, "object": "model", "owned_by": "maxi" }],
    });
    let _ = crate::server::respond_json(request, 200, body.to_string());
}

fn chat_endpoint(request: Request) {
    if request.method() != &Method::Post {
        let _ = crate::server::json_error(request, 405, "聊天只支持 POST");
        return;
    }

    let Some((request, read)) = read_body_with_timeout(request, crate::body::MAX_BODY) else {
        return;
    };
    let raw = match read {
        BodyRead::Ok(body) => body,
        BodyRead::TooLarge => {
            let _ = crate::server::json_error(request, 413, "请求体超过 10MB 上限");
            return;
        }
        BodyRead::Failed(err) => {
            let _ = crate::server::json_error(request, 400, &format!("读请求体失败：{err}"));
            return;
        }
    };

    let chat: Value = match serde_json::from_slice(&raw) {
        Ok(value) => value,
        Err(err) => {
            let _ = crate::server::json_error(request, 400, &format!("请求体不是合法 JSON：{err}"));
            return;
        }
    };

    let mut auth = crate::maxi_auth::load();
    if !auth.configured() {
        let _ = crate::server::respond_json(
            request,
            401,
            json!({ "error": { "message": "还没接入码栖通道，先在工作台里点「导入本机登录态」", "type": "unauthorized" } })
                .to_string(),
        );
        return;
    }

    let token = match ensure_token(&mut auth) {
        Ok(token) => token,
        Err(err) => {
            let _ = crate::server::respond_json(
                request,
                401,
                json!({ "error": { "message": err, "type": "unauthorized" } }).to_string(),
            );
            return;
        }
    };

    let model = model_of(&auth);
    let body = to_responses(&chat, &model).to_string();
    let stream = chat.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let include_usage = chat
        .get("stream_options")
        .and_then(|options| options.get("include_usage"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let first = send(&auth.host, &token, &body);
    let response = match first {
        Ok(response) => response,
        Err(ForwardError::Unauthorized) => {
            // 服务器把令牌提前作废了：续一次再重发（body 还在手里）
            if let Err(err) = refresh(&mut auth) {
                let _ = crate::server::respond_json(
                    request,
                    401,
                    json!({ "error": { "message": err, "type": "unauthorized" } }).to_string(),
                );
                return;
            }
            match send(&auth.host, &auth.access_token, &body) {
                Ok(response) => response,
                Err(err) => {
                    let _ = fail(request, err);
                    return;
                }
            }
        }
        Err(err) => {
            let _ = fail(request, err);
            return;
        }
    };

    let id = format!("chatcmpl-{}", crate::workbuddy::hex(12));
    if stream {
        stream_back(request, response, Translator::new(&id, &model), include_usage);
    } else {
        collect_back(request, response, Translator::new(&id, &model));
    }
}

enum ForwardError {
    Unauthorized,
    Message(String),
}

fn fail(request: Request, err: ForwardError) -> std::io::Result<()> {
    let (status, message, kind) = match err {
        ForwardError::Unauthorized => (
            401,
            "码栖登录状态失效，请在工作台里重新导入登录态".to_string(),
            "unauthorized",
        ),
        ForwardError::Message(text) => (502, text, "upstream_error"),
    };
    crate::server::respond_json(
        request,
        status,
        json!({ "error": { "message": message, "type": kind } }).to_string(),
    )
}

fn send(host: &str, token: &str, body: &str) -> Result<ureq::Response, ForwardError> {
    let url = format!("{host}/app/model/default/v1/responses");
    let connector =
        native_tls::TlsConnector::new().map_err(|e| ForwardError::Message(format!("初始化 TLS 失败：{e}")))?;
    let agent = ureq::AgentBuilder::new()
        .tls_connector(std::sync::Arc::new(connector))
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .build();

    match agent
        .post(&url)
        .set("content-type", "application/json")
        .set("authorization", &format!("Bearer {token}"))
        .send_bytes(body.as_bytes())
    {
        Ok(response) => Ok(response),
        Err(ureq::Error::Status(401, _)) => Err(ForwardError::Unauthorized),
        Err(ureq::Error::Status(status, response)) => {
            let text = response.into_string().unwrap_or_default();
            Err(ForwardError::Message(format!("码栖返回 HTTP {status}：{text}")))
        }
        Err(other) => Err(ForwardError::Message(format!("连不上码栖：{other}"))),
    }
}

fn write_sse_head(writer: &mut dyn Write) -> bool {
    let head = concat!(
        "HTTP/1.1 200 OK\r\n",
        "Content-Type: text/event-stream; charset=utf-8\r\n",
        "Cache-Control: no-cache, no-transform\r\n",
        "X-Accel-Buffering: no\r\n",
        "Connection: close\r\n",
        "\r\n",
    );
    writer.write_all(head.as_bytes()).is_ok() && writer.flush().is_ok()
}

fn stream_back(request: Request, resp: ureq::Response, mut translator: Translator, include_usage: bool) {
    let mut writer = request.into_writer();
    if !write_sse_head(&mut *writer) {
        return;
    }
    let mut reader = resp.into_reader();
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let text = String::from_utf8_lossy(&buf[..n]).to_string();
                for chunk in translator.feed(&text) {
                    if writer.write_all(chunk.as_bytes()).is_err() || writer.flush().is_err() {
                        return;
                    }
                }
            }
            Err(_) => break,
        }
    }
    for chunk in translator.finish() {
        if writer.write_all(chunk.as_bytes()).is_err() {
            return;
        }
    }
    if include_usage {
        if let Some(usage) = &translator.usage {
            let body = json!({
                "id": translator_id(&translator),
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "maxi",
                "choices": [],
                "usage": usage,
            });
            let _ = writer.write_all(format!("data: {body}\n\n").as_bytes());
        }
    }
    let _ = writer.write_all(b"data: [DONE]\n\n");
    let _ = writer.flush();
}

fn translator_id(translator: &Translator) -> String {
    translator.id()
}

fn collect_back(request: Request, resp: ureq::Response, mut translator: Translator) {
    let mut reader = resp.into_reader();
    let mut buf = [0u8; 8192];
    let mut chunks: Vec<String> = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let text = String::from_utf8_lossy(&buf[..n]).to_string();
                chunks.extend(translator.feed(&text));
            }
            Err(_) => break,
        }
    }
    chunks.extend(translator.finish());

    let mut content = String::new();
    let mut calls: Vec<Value> = Vec::new();
    let mut finish = "stop".to_string();
    for chunk in &chunks {
        let Some(payload) = chunk.strip_prefix("data: ") else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<Value>(payload.trim()) else {
            continue;
        };
        let Some(choice) = event.get("choices").and_then(|list| list.get(0)) else {
            continue;
        };
        if let Some(delta) = choice.get("delta") {
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                content.push_str(text);
            }
            if let Some(list) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in list {
                    let index = call.get("index").and_then(Value::as_i64).unwrap_or(0);
                    while calls.len() <= index as usize {
                        calls.push(json!({
                            "id": "",
                            "type": "function",
                            "function": { "name": "", "arguments": "" }
                        }));
                    }
                    let slot = &mut calls[index as usize];
                    if let Some(id) = call.get("id").and_then(Value::as_str) {
                        if !id.is_empty() {
                            slot["id"] = json!(id);
                        }
                    }
                    if let Some(name) = call
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(Value::as_str)
                    {
                        if !name.is_empty() {
                            slot["function"]["name"] = json!(name);
                        }
                    }
                    if let Some(args) = call
                        .get("function")
                        .and_then(|f| f.get("arguments"))
                        .and_then(Value::as_str)
                    {
                        let combined = format!(
                            "{}{}",
                            slot["function"]["arguments"].as_str().unwrap_or(""),
                            args
                        );
                        slot["function"]["arguments"] = json!(combined);
                    }
                }
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            finish = reason.to_string();
        }
    }

    let mut message = json!({
        "role": "assistant",
        "content": if content.is_empty() { Value::Null } else { json!(content) },
    });
    if !calls.is_empty() {
        message["tool_calls"] = json!(calls);
    }
    let usage = translator.usage.clone().unwrap_or_else(
        || json!({ "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }),
    );
    let body = json!({
        "id": translator.id(),
        "object": "chat.completion",
        "created": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        "model": translator.model(),
        "choices": [{ "index": 0, "message": message, "finish_reason": finish }],
        "usage": usage,
    });
    let _ = crate::server::respond_json(request, 200, body.to_string());
}
