//! `/api/*` 反向代理：转发到本地 opencode 服务，注入认证 cookie。

use std::io::Read;
use std::time::Duration;

use tiny_http::{Header, Response, StatusCode};

use crate::body::{read_body_with_timeout, BodyRead, MAX_BODY};
use crate::server::{json_error, Ctx};

pub fn proxy(request: tiny_http::Request, ctx: &Ctx, path: &str, url: &str) {
    // 后端不可用（未安装/认证失败）时页面仍要能打开，`/api/*` 统一 502 + JSON。
    let Some((base, cookie)) = ctx.current_backend() else {
        let _ = json_error(
            request,
            502,
            "未连接：本地 opencode 后端不可用（未安装或启动时认证失败）",
        );
        return;
    };

    let method = request.method().as_str().to_string();
    let target = format!("{base}{url}");
    let has_body = method != "GET" && method != "HEAD";

    let mut request = request;
    let body = if has_body {
        // 10MB 上限 + 15 秒超时：超大或发一半就停的请求不能一直占着并发名额。
        let Some((back, result)) = read_body_with_timeout(request, MAX_BODY) else {
            return;
        };
        request = back;
        match result {
            BodyRead::Ok(body) => body,
            BodyRead::TooLarge => {
                let _ = json_error(request, 413, "请求体超过 10MB 上限");
                return;
            }
            BodyRead::Failed(err) => {
                // 读请求体失败（客户端中断等）时必须报 400，不能拿半个 body 去转发写文件。
                let text = format!("400 读取请求体失败：{err}");
                let _ = request.respond(Response::from_string(text).with_status_code(400));
                return;
            }
        }
    } else {
        Vec::new()
    };

    let mut forwarded: Vec<(String, String)> = Vec::new();
    for header in request.headers() {
        let name = header.field.as_str().as_str().to_string();
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "content-type" | "accept" | "accept-language" | "x-opencode-directory" | "last-event-id"
        ) {
            forwarded.push((name, header.value.as_str().to_string()));
        }
    }

    // SSE 是无限长的响应：`.timeout()` 是整请求 deadline，会把长连接在 600 秒时掐断，
    // 所以 /api/event 单独用只设连接超时的 agent。
    let is_sse = path == "/api/event" || path.starts_with("/api/event/");
    let builder = ureq::AgentBuilder::new();
    let agent = if is_sse {
        builder.timeout_connect(Duration::from_secs(10)).build()
    } else {
        builder.timeout(Duration::from_secs(600)).build()
    };

    let mut call = agent.request(&method, &target).set("cookie", &cookie);
    for (name, value) in &forwarded {
        call = call.set(name, value);
    }

    // 用方法而不是 body 长度判断：空 body 的 POST 也要带 Content-Length: 0 发给上游。
    let result = if has_body {
        call.send_bytes(&body)
    } else {
        call.call()
    };

    match result {
        Ok(resp) => relay(request, resp),
        Err(ureq::Error::Status(401, _)) => {
            // 认证过期（配对 token 通常 30 天）：页面可以 POST /api/reconnect 重新配对。
            let _ = request.respond(
                Response::from_string("401 认证失效，请点击「重试连接」或重启工作台")
                    .with_status_code(401),
            );
        }
        Err(ureq::Error::Status(_, resp)) => relay(request, resp),
        Err(err) => {
            let text = format!("未连接：上游服务不可用（{err}）");
            let _ = json_error(request, 502, &text);
        }
    }
}

fn relay(request: tiny_http::Request, resp: ureq::Response) {
    let status = StatusCode(resp.status());
    let content_type = resp.header("content-type").map(|v| v.to_string());
    let cache_control = resp.header("cache-control").map(|v| v.to_string());
    let length: Option<usize> = resp
        .header("content-length")
        .and_then(|v| v.parse::<usize>().ok());
    let is_sse = content_type
        .as_deref()
        .map(|v| v.contains("text/event-stream"))
        .unwrap_or(false);

    if is_sse {
        // tiny_http 的 Response 走 BufWriter + chunked 编码，实测要攒约 8KB 才发出去，
        // 结果「实时流」变成「一阵一阵」。这里直接拿写端手写响应头（Connection: close
        // 作为分隔），每读到一块就 flush，保证 SSE 真的实时。
        relay_sse(request, resp);
        return;
    }

    let reader = resp.into_reader();
    // tiny_http 默认 ≥32KB 就改发 chunked 并**丢掉 Content-Length**，
    // 前端的大文件预检查（读 content-length）会因此失效。上游有明确长度时
    // 把阈值抬到 usize::MAX，按 Identity 原样透传长度。
    let mut out = Response::new(status, Vec::new(), reader, length, None);
    if length.is_some() {
        out = out.with_chunked_threshold(usize::MAX);
    }
    if let Some(value) = content_type {
        if let Ok(header) = Header::from_bytes(&b"content-type"[..], value.as_bytes()) {
            out.add_header(header);
        }
    }
    if let Some(value) = cache_control {
        if let Ok(header) = Header::from_bytes(&b"cache-control"[..], value.as_bytes()) {
            out.add_header(header);
        }
    }
    let _ = request.respond(out);
}

/// SSE 专用转发：不经过 tiny_http 的 Response（它会缓冲），直接写裸响应并逐块 flush。
fn relay_sse(request: tiny_http::Request, resp: ureq::Response) {
    use std::io::Write;

    let mut writer = request.into_writer();
    let head = concat!(
        "HTTP/1.1 200 OK\r\n",
        "Content-Type: text/event-stream; charset=utf-8\r\n",
        "Cache-Control: no-cache, no-transform\r\n",
        "X-Accel-Buffering: no\r\n",
        "Connection: close\r\n",
        "\r\n",
    );
    if writer.write_all(head.as_bytes()).is_err() {
        return;
    }
    if writer.flush().is_err() {
        return;
    }

    let mut reader = resp.into_reader();
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if writer.write_all(&buf[..n]).is_err() {
                    break;
                }
                if writer.flush().is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}
