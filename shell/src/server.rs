//! 本地 HTTP 服务：静态文件（内嵌 dist）+ `/api` 反向代理（自动注入认证 cookie）。
//!
//! 这样 WebView 只需要加载 `http://127.0.0.1:<本地端口>/`，
//! 前端所有 `/api/*` 请求同源，不涉及跨域，也不需要 dev server。
//!
//! 安全约束（只对 loopback 生效，但 loopback 端口任何本机进程都能扫）：
//!   * 所有请求校验 `Host` 头必须是 `127.0.0.1:<本地端口>` 或 `localhost:<本地端口>`；
//!   * `/api/*` 额外校验 `x-oc-token` 头，值等于每次启动随机生成的 token；
//!   * token 通过注入到 index.html 的 `<head>` 里的脚本交给页面，不落盘。

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use include_dir::{include_dir, Dir};
use tiny_http::{Header, Response, Server, StatusCode};

static DIST: Dir = include_dir!("$CARGO_MANIFEST_DIR/../dist");

#[derive(Clone)]
pub struct Ctx {
    pub base: String,
    pub cookie: String,
    /// 每次启动随机生成的本地 API token（32 位 hex）。
    pub token: String,
    /// 本地监听端口，start() 拿到真实端口后回填。
    pub port: u16,
}

/// 生成 32 位 hex token：SystemTime 纳秒 + 进程 pid 走两轮 DefaultHasher。
pub fn new_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();

    let mut first = DefaultHasher::new();
    nanos.hash(&mut first);
    pid.hash(&mut first);
    let a = first.finish();

    let mut second = DefaultHasher::new();
    a.hash(&mut second);
    nanos.hash(&mut second);
    pid.hash(&mut second);
    let b = second.finish();

    format!("{a:016x}{b:016x}")
}

pub fn start(mut ctx: Ctx) -> Result<u16, String> {
    let server = Server::http("127.0.0.1:0").map_err(|e| format!("本地服务启动失败：{e}"))?;
    let addr = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "本地服务没有拿到 IP 地址".to_string())?;
    let port = addr.port();
    ctx.port = port;

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
    let path = url.split('?').next().unwrap_or("").to_string();

    // Host 校验对所有请求生效（含静态资源），失败直接 403。
    if !host_allowed(&request, ctx.port) {
        let _ = request.respond(Response::from_string("403 Host 校验失败").with_status_code(403));
        return;
    }

    if path == "/api" || path.starts_with("/api/") {
        // 先 Host 再 token，任一失败都不转发。
        if !token_allowed(&request, &ctx.token) {
            let _ = request.respond(
                Response::from_string("403 缺少或错误的 x-oc-token").with_status_code(403),
            );
            return;
        }
        proxy(request, ctx, &url);
    } else {
        static_file(request, &path, &ctx.token);
    }
}

fn header_value(request: &tiny_http::Request, name: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str().to_string())
}

fn host_allowed(request: &tiny_http::Request, port: u16) -> bool {
    let Some(host) = header_value(request, "host") else {
        return false;
    };
    let host = host.trim().to_ascii_lowercase();
    host.starts_with(&format!("127.0.0.1:{port}")) || host.starts_with(&format!("localhost:{port}"))
}

fn token_allowed(request: &tiny_http::Request, token: &str) -> bool {
    match header_value(request, "x-oc-token") {
        Some(value) => value.trim() == token,
        None => false,
    }
}

/// 把 token 注入 index.html：替换 `<head>` 为 `<head><script>...</script>`；
/// 找不到 `<head>` 就插到文档最前面。
fn inject_token(html: &[u8], token: &str) -> Vec<u8> {
    let text = String::from_utf8_lossy(html);
    let script = format!("<script>window.__OC_TOKEN=\"{token}\";</script>");
    let output = match text.find("<head>") {
        Some(pos) => {
            let insert_at = pos + "<head>".len();
            format!("{}{}{}", &text[..insert_at], script, &text[insert_at..])
        }
        None => format!("{script}{text}"),
    };
    output.into_bytes()
}

fn static_file(request: tiny_http::Request, path: &str, token: &str) {
    // 空路径（例如 `GET ?a HTTP/1.1`）没有前导斜杠，直接 404，不能切片。
    let Some(rel) = path.strip_prefix('/') else {
        let _ = request.respond(Response::from_string("404 Not Found").with_status_code(404));
        return;
    };
    let rel = if rel.is_empty() { "index.html" } else { rel };
    let Some(file) = DIST.get_file(rel) else {
        let _ = request.respond(Response::from_string("404 Not Found").with_status_code(404));
        return;
    };

    let data = if rel == "index.html" {
        inject_token(file.contents(), token)
    } else {
        file.contents().to_vec()
    };

    let header = Header::from_bytes(&b"content-type"[..], mime_of(rel).as_bytes())
        .expect("content-type 头构造失败");
    let response = Response::from_data(data).with_header(header);
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
        // 读请求体失败（客户端中断等）时必须报 400，不能拿半个 body 去转发写文件。
        if let Err(err) = std::io::Read::read_to_end(&mut request.as_reader(), &mut body) {
            let text = format!("400 读取请求体失败：{err}");
            let _ = request.respond(Response::from_string(text).with_status_code(400));
            return;
        }
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
