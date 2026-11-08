//! 本地 HTTP 服务：静态文件（内嵌 dist）+ `/api` 反向代理（自动注入认证 cookie）。
//!
//! 这样 WebView 只需要加载 `http://127.0.0.1:<本地端口>/`，
//! 前端所有 `/api/*` 请求同源，不涉及跨域，也不需要 dev server。

use std::thread;
use std::time::Duration;

use include_dir::{include_dir, Dir};
use tiny_http::{Header, Response, Server, StatusCode};

static DIST: Dir = include_dir!("$CARGO_MANIFEST_DIR/../dist");

#[derive(Clone)]
pub struct Ctx {
    pub base: String,
    pub cookie: String,
}

pub fn start(ctx: Ctx) -> Result<u16, String> {
    let server = Server::http("127.0.0.1:0").map_err(|e| format!("本地服务启动失败：{e}"))?;
    let addr = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "本地服务没有拿到 IP 地址".to_string())?;
    let port = addr.port();

    thread::spawn(move || {
        for request in server.incoming_requests() {
            let ctx = ctx.clone();
            thread::spawn(move || handle(request, &ctx));
        }
    });

    Ok(port)
}

fn handle(request: tiny_http::Request, ctx: &Ctx) {
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("/").to_string();

    if path == "/api" || path.starts_with("/api/") {
        proxy(request, ctx, &url);
    } else {
        static_file(request, &path);
    }
}

fn static_file(request: tiny_http::Request, path: &str) {
    let rel = if path == "/" { "index.html" } else { &path[1..] };
    let Some(file) = DIST.get_file(rel) else {
        let _ = request.respond(Response::from_string("404 Not Found").with_status_code(404));
        return;
    };

    let header = Header::from_bytes(&b"content-type"[..], mime_of(rel).as_bytes())
        .expect("content-type 头构造失败");
    let response = Response::from_data(file.contents().to_vec()).with_header(header);
    let _ = request.respond(response);
}

fn mime_of(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if lower.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if lower.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if lower.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".ico") {
        "image/x-icon"
    } else if lower.ends_with(".woff2") {
        "font/woff2"
    } else {
        "application/octet-stream"
    }
}

fn proxy(mut request: tiny_http::Request, ctx: &Ctx, url: &str) {
    let method = request.method().as_str().to_string();
    let target = format!("{}{}", ctx.base, url);

    let mut body = Vec::new();
    if method != "GET" && method != "HEAD" {
        let _ = std::io::Read::read_to_end(&mut request.as_reader(), &mut body);
    }

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

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(600))
        .build();
    let mut call = agent.request(&method, &target).set("cookie", &ctx.cookie);
    for (name, value) in &forwarded {
        call = call.set(name, value);
    }

    let result = if body.is_empty() {
        call.call()
    } else {
        call.send_bytes(&body)
    };

    match result {
        Ok(resp) => relay(request, resp),
        Err(ureq::Error::Status(code, resp)) => {
            if code == 401 {
                // 认证过期（配对 token 通常 30 天），提示重启程序
                let _ = request.respond(
                    Response::from_string("401 认证失效，请重启工作台").with_status_code(401),
                );
            } else {
                relay(request, resp);
            }
        }
        Err(err) => {
            let text = format!("上游服务不可用：{err}");
            let _ = request.respond(Response::from_string(text).with_status_code(502));
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

    let reader = resp.into_reader();
    // SSE 没有 content-length，交给 tiny_http 走 chunked 逐块转发。
    let mut out = Response::new(status, Vec::new(), reader, length, None);
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
    if is_sse {
        if let Ok(header) = Header::from_bytes(&b"x-accel-buffering"[..], &b"no"[..]) {
            out.add_header(header);
        }
    }
    let _ = request.respond(out);
}
