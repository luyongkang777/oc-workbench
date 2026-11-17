//! WorkBuddy 本地转发：`/local/workbuddy/v1/*`。
//!
//! 为什么要有这一层：WorkBuddy 的聊天接口不是标准 OpenAI——它要求
//! `User-Agent: WorkBuddy/<版本>` 和一组 `X-IDE-*` / `X-Agent-*` 头，令牌还每小时过期。
//! opencode 只会发 `Authorization: Bearer <key>`，既加不了头也不会续期。
//! 所以工作台在本地开一段转发：opencode 当作普通 OpenAI 兼容端点，
//! 这里补头、续期、把 SSE 原样流回去。
//!
//! | 接口 | 作用 |
//! |---|---|
//! | `GET  /local/workbuddy/v1/models`              | 内置的 WorkBuddy 模型表 |
//! | `POST /local/workbuddy/v1/chat/completions`    | 转发到 `/v2/chat/completions` |
//!
//! 鉴权用独立密钥（`Authorization: Bearer <settings.json 的 workbuddyKey>`），
//! 不复用页面令牌——调用方是 opencode，它手里没有 `x-oc-token`。

use std::io::Read;
use std::time::Duration;

use serde_json::json;
use tiny_http::{Method, Request};

use crate::body::{read_body_with_timeout, BodyRead};
use crate::workbuddy;
use crate::workbuddy_models::MODELS;

/// 内置模型表（[id, 显示名, 上下文, 输出上限]），取自 WorkBuddy 桌面版 5.9.3 的
/// `/v3/config`（magpie 插件同一份）。输出上限 0 = 上游没给，配置里不写 limit。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(600);

pub fn handle(request: Request, path: &str, _url: &str) {
    if !authorized(&request) {
        let _ = crate::server::respond_json(
            request,
            401,
            json!({ "error": { "message": "WorkBuddy 本地转发密钥不对", "type": "unauthorized" } })
                .to_string(),
        );
        return;
    }
    match path {
        "/local/workbuddy/v1/models" => crate::workbuddy_models::models_endpoint(request),
        "/local/workbuddy/v1/chat/completions" => chat_endpoint(request),
        _ => {
            let _ = crate::server::json_error(request, 404, "未知的 WorkBuddy 转发路径");
        }
    }
}

/// opencode 带的是本机密钥；页面走 `/local/*` 的那套令牌，不会到这来。
fn authorized(request: &Request) -> bool {
    let expected = format!("Bearer {}", workbuddy::local_key());
    request.headers().iter().any(|header| {
        header.field.equiv("authorization") && header.value.as_str().trim() == expected
    })
}


fn chat_endpoint(request: Request) {
    if request.method() != &Method::Post {
        let _ = crate::server::json_error(request, 405, "聊天只支持 POST");
        return;
    }

    // 先读 body：后面要用它重试一次（续期后用同一份请求体重发）
    let Some((request, read)) = read_body_with_timeout(request, crate::body::MAX_BODY) else {
        return;
    };
    let body = match read {
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

    let mut auth = workbuddy::load();
    if let Err(err) = workbuddy::ensure_fresh(&mut auth) {
        let _ = crate::server::respond_json(
            request,
            401,
            json!({ "error": { "message": err, "type": "unauthorized" } }).to_string(),
        );
        return;
    }

    let first = send(&auth, &body, true);
    let response = match first {
        Ok(response) => response,
        Err(ForwardError::Unauthorized) => {
            // 令牌被服务端提前作废：续期一次再重发（body 还在手里）
            if let Err(err) = workbuddy::refresh(&mut auth) {
                let _ = crate::server::respond_json(
                    request,
                    401,
                    json!({ "error": { "message": err, "type": "unauthorized" } }).to_string(),
                );
                return;
            }
            match send(&auth, &body, true) {
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

    // 复用页面代理的转发逻辑：SSE 逐块 flush，普通响应带长度原样回
    crate::proxy::relay(request, response);
}

enum ForwardError {
    Unauthorized,
    Message(String),
}

fn fail(request: Request, err: ForwardError) -> std::io::Result<()> {
    let (status, message, kind) = match err {
        ForwardError::Unauthorized => (
            401,
            "WorkBuddy 令牌无效，请在工作台里重新登录".to_string(),
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

fn send(auth: &workbuddy::Auth, body: &[u8], fresh: bool) -> Result<ureq::Response, ForwardError> {
    let url = format!("{}/v2/chat/completions", workbuddy::ENDPOINT);
    let agent = ureq::AgentBuilder::new()
        .tls_connector(std::sync::Arc::new(
            native_tls::TlsConnector::new().map_err(|err| {
                ForwardError::Message(format!("初始化 TLS 连接器失败：{err}"))
            })?,
        ))
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .build();

    let mut call = agent.post(&url).set("content-type", "application/json");
    for (name, value) in chat_headers(auth) {
        call = call.set(&name, &value);
    }

    match call.send_bytes(body) {
        Ok(response) => Ok(response),
        Err(ureq::Error::Status(401, _)) if fresh => Err(ForwardError::Unauthorized),
        Err(ureq::Error::Status(status, response)) => {
            // 上游的 4xx/5xx 有 JSON 说明，原样交给 opencode 呈现
            let text = read_all(response);
            Err(ForwardError::Message(format!("WorkBuddy 返回 HTTP {status}：{text}")))
        }
        Err(other) => Err(ForwardError::Message(format!("连不上 WorkBuddy：{other}"))),
    }
}

/// WorkBuddy 桌面客户端 5.9.3 发聊天时带的全套头。
///
/// 少任何一组都可能被拒或不计入用量：UA 不是 `WorkBuddy/<版本>` 直接 10085；
/// 没有 `X-IDE-*` 会在「使用端」里显示为空。
fn chat_headers(auth: &workbuddy::Auth) -> Vec<(String, String)> {
    let mut headers = vec![
        ("authorization".to_string(), format!("Bearer {}", auth.access)),
        ("x-user-id".to_string(), auth.uid.clone()),
        ("x-domain".to_string(), workbuddy::domain_of(auth)),
        ("x-product".to_string(), "SaaS".to_string()),
        ("x-ide-type".to_string(), "WorkBuddy".to_string()),
        (
            "user-agent".to_string(),
            format!(
                "WorkBuddy/{app} WorkBuddy/{app} CLI/{cli}",
                app = workbuddy::APP,
                cli = workbuddy::CLI
            ),
        ),
        ("x-requested-with".to_string(), "XMLHttpRequest".to_string()),
        ("x-agent-intent".to_string(), "craft".to_string()),
        ("x-agent-purpose".to_string(), "conversation".to_string()),
        ("x-agent-type".to_string(), "main".to_string()),
        ("x-agent-runtime".to_string(), "local-agent".to_string()),
        ("x-ide-name".to_string(), "WorkBuddy".to_string()),
        ("x-ide-version".to_string(), workbuddy::APP.to_string()),
        ("accept".to_string(), "text/event-stream, application/json".to_string()),
        ("x-stainless-retry-count".to_string(), "0".to_string()),
        ("x-stainless-timeout".to_string(), "1200".to_string()),
        ("x-stainless-lang".to_string(), "js".to_string()),
        ("x-stainless-package-version".to_string(), "6.25.0".to_string()),
        ("x-stainless-os".to_string(), "Windows".to_string()),
        ("x-stainless-arch".to_string(), sdk_arch().to_string()),
        ("x-stainless-runtime".to_string(), "node".to_string()),
        ("x-stainless-runtime-version".to_string(), "v22.21.1".to_string()),
        ("x-request-id".to_string(), crate::workbuddy::hex(16)),
        (
            "x-conversation-request-id".to_string(),
            crate::workbuddy::hex(16),
        ),
    ];
    if !auth.enterprise.is_empty() {
        headers.push(("x-enterprise-id".to_string(), auth.enterprise.clone()));
        headers.push(("x-tenant-id".to_string(), auth.enterprise.clone()));
    }
    headers
}

fn sdk_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "x32",
        other => other,
    }
}

fn read_all(response: ureq::Response) -> String {
    let mut reader = response.into_reader();
    let mut text = String::new();
    let _ = reader.by_ref().take(64 * 1024).read_to_string(&mut text);
    text.replace(['\r', '\n'], " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_table_covers_the_flash_model_with_full_context() {
        let flash = MODELS
            .iter()
            .find(|(id, ..)| *id == "deepseek-v4.1-flash")
            .expect("必须有 deepseek-v4.1-flash");
        assert_eq!(flash.2, 1_000_000, "上下文不能写成 10 万");
        assert_eq!(flash.3, 128_000);
        assert!(MODELS.iter().filter(|(id, ..)| *id == "auto").count() == 1);
    }

    #[test]
    fn chat_headers_carry_the_client_identity() {
        let auth = workbuddy::Auth {
            access: "tok".to_string(),
            uid: "u1".to_string(),
            ..Default::default()
        };
        let headers = chat_headers(&auth);
        let get = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
                .unwrap_or_default()
        };
        assert_eq!(get("authorization"), "Bearer tok");
        assert!(get("user-agent").starts_with("WorkBuddy/5.9.3"));
        assert_eq!(get("x-domain"), "copilot.tencent.com");
        assert!(get("x-conversation-request-id").len() == 32);
    }

    #[test]
    fn enterprise_headers_only_when_present() {
        let personal = workbuddy::Auth::default();
        assert!(chat_headers(&personal)
            .iter()
            .all(|(name, _)| name != "x-enterprise-id"));

        let team = workbuddy::Auth {
            enterprise: "ent-1".to_string(),
            ..Default::default()
        };
        assert!(chat_headers(&team)
            .iter()
            .any(|(name, value)| name == "x-enterprise-id" && value == "ent-1"));
    }
}
