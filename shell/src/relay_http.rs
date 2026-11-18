//! relay 的 HTTP 转发本体：把 `/local/relay/<secret>/<key>/*` 经梯子送到上游。
//!
//! 只在 127.0.0.1 上被 `server.rs` 调用（排在 `/local` 令牌校验之前，
//! 因为调用方是 opencode，它只带 provider 自己的 `Authorization`）。
//! 路径里的 `<secret>` 见 [`crate::relay::secret`]，用来挡公网入口滥用。

use std::io::Read;
use std::time::Duration;

use tiny_http::{Header, Request, Response, StatusCode};

use crate::body::{read_body_with_timeout, BodyRead};
use crate::relay::PREFIX;

/// 模型请求动辄几分钟（长上下文 + 推理），别用普通接口的短超时。
const TIMEOUT: Duration = Duration::from_secs(900);
/// 上游请求体上限：1M 上下文的对话可能超过 10MB。
const BODY_LIMIT: usize = 64 * 1024 * 1024;

/// 请求/响应里不能原样透传的头：逐跳头与长度/编码由本层重算。
fn dropped(name: &str) -> bool {
    matches!(
        name,
        "host"
            | "connection"
            | "content-length"
            | "transfer-encoding"
            | "accept-encoding"
            | "content-encoding"
    )
}

/// ureq 2.12 只能按名字取响应头：先拿名字再收集。
fn collect_headers(response: &ureq::Response) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for name in response.headers_names() {
        for value in response.all(&name) {
            out.push((name.clone(), value.to_string()));
        }
    }
    out
}

fn query_of(url: &str) -> String {
    match url.split_once('?') {
        Some((_, query)) => format!("?{query}"),
        None => String::new(),
    }
}

/// `path` 已确认以 [`PREFIX`] 开头（server 已剥掉远程前缀）；`url` 是原始请求 URI。
pub fn handle(request: Request, path: &str, url: &str) {
    let Some(tail) = path.strip_prefix(PREFIX) else {
        let _ = crate::server::json_error(request, 404, "未知的转发路径");
        return;
    };
    let Some((upstream, rest)) = crate::relay::split_target(tail) else {
        let _ = crate::server::json_error(request, 404, "未知的转发目标");
        return;
    };
    let rest = if rest.is_empty() {
        String::new()
    } else {
        format!("/{rest}")
    };
    let target = format!("{upstream}{rest}{}", query_of(url));
    let method = request.method().as_str().to_ascii_uppercase();

    // 头：逐跳与长度交给本层，其余（含 Authorization、Accept: text/event-stream）原样带过去
    let mut headers: Vec<(String, String)> = Vec::new();
    for header in request.headers() {
        let name = header.field.as_str().to_string();
        if dropped(&name.to_ascii_lowercase().as_str()) {
            continue;
        }
        headers.push((name, header.value.as_str().to_string()));
    }

    let body = if method == "GET" || method == "HEAD" {
        Some((request, Vec::new()))
    } else {
        match read_body_with_timeout(request, BODY_LIMIT) {
            Some((request, BodyRead::Ok(bytes))) => Some((request, bytes)),
            Some((request, BodyRead::TooLarge)) => {
                let _ = crate::server::json_error(request, 413, "请求体超过 64MB 上限");
                return;
            }
            Some((request, BodyRead::Failed(err))) => {
                let _ = crate::server::json_error(request, 400, &format!("读请求体失败：{err}"));
                return;
            }
            None => return,
        }
    };
    let Some((request, body)) = body else {
        return;
    };

    let agent = match crate::fetch::agent_with_proxy(
        TIMEOUT,
        Some(TIMEOUT),
        crate::relay::proxy().as_deref(),
    ) {
        Ok(agent) => agent,
        Err(err) => {
            let _ = crate::server::json_error(request, 502, &format!("建不了出站连接：{err}"));
            return;
        }
    };
    let mut call = agent.request(&method, &target);
    for (name, value) in &headers {
        call = call.set(name, value);
    }
    let result = if body.is_empty() {
        call.call()
    } else {
        call.send(&body[..])
    };

    let (status, upstream_headers, reader): (u16, Vec<(String, String)>, Box<dyn Read>) = match result
    {
        Ok(response) => (
            response.status(),
            collect_headers(&response),
            Box::new(response.into_reader()),
        ),
        Err(ureq::Error::Status(code, response)) => {
            (code, collect_headers(&response), Box::new(response.into_reader()))
        }
        Err(err) => {
            let _ = crate::server::json_error(request, 502, &format!("连不上上游：{err}"));
            return;
        }
    };

    let mut out: Vec<Header> = Vec::new();
    for (name, value) in upstream_headers {
        if dropped(&name.to_ascii_lowercase()) {
            continue;
        }
        if let Ok(header) = Header::from_bytes(name.as_bytes(), value.as_bytes()) {
            out.push(header);
        }
    }
    // 长度交给 chunked：SSE 是无限流，算不出 Content-Length
    let response = Response::new(StatusCode(status), out, reader, None, None);
    let _ = request.respond(response);
}
