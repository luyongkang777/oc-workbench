//! 本地 HTTP 服务：静态文件（内嵌 dist，见 [`crate::static_files`]）+ `/api` 反向代理
//! （自动注入认证 cookie）。
//!
//! 这样 WebView 只需要加载 `http://127.0.0.1:<本地端口>/`，
//! 前端所有 `/api/*` 请求同源，不涉及跨域，也不需要 dev server。
//!
//! 安全约束（只对 loopback 生效，但 loopback 端口任何本机进程都能扫）：
//!   * 所有请求校验 `Host` 头必须**精确等于** `127.0.0.1:<本地端口>` 或 `localhost:<本地端口>`；
//!   * `/api/*` 额外校验 `x-oc-token` 头，值等于每次启动密码学随机生成的 token；
//!   * token **不经 HTTP 下发**：index.html 里没有 token，页面通过 IPC 向外壳索取；
//!   * 同时转发数上限 [`MAX_CONCURRENT`]，超出直接 503，避免本机进程刷连接把工作台拖死。

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tiny_http::{Header, Response, Server, StatusCode};

/// 同时处理的请求上限（SSE 长连接也会长期占一个名额）。
const MAX_CONCURRENT: usize = 64;

#[derive(Clone)]
pub struct Ctx {
    /// 上游地址；`None` 表示后端不可用（未安装/认证失败），`/api/*` 直接回 502。
    pub base: Option<String>,
    pub cookie: String,
    /// 每次启动随机生成的本地 API token（32 位 hex），由 main 生成后同时交给本服务和 IPC。
    pub token: String,
    /// 本地监听端口，start() 拿到真实端口后回填。
    pub port: u16,
}

/// 生成 32 位 hex token（16 字节密码学随机）。
///
/// 只有 getrandom 不可用的极端情况才退化成时间 + pid 派生（弱，但至少不会起不来）。
pub fn new_token() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let pid = std::process::id();

        let mut first = DefaultHasher::new();
        nanos.hash(&mut first);
        pid.hash(&mut first);
        let a = first.finish();
        bytes[..8].copy_from_slice(&a.to_le_bytes());

        let mut second = DefaultHasher::new();
        a.hash(&mut second);
        pid.hash(&mut second);
        bytes[8..].copy_from_slice(&second.finish().to_le_bytes());
    }
    let mut out = String::with_capacity(32);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

struct ActiveGuard(Arc<AtomicUsize>);

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

pub fn start(mut ctx: Ctx) -> Result<u16, String> {
    let server = Server::http("127.0.0.1:0").map_err(|e| format!("本地服务启动失败：{e}"))?;
    let addr = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "本地服务没有拿到 IP 地址".to_string())?;
    let port = addr.port();
    ctx.port = port;

    let active = Arc::new(AtomicUsize::new(0));
    thread::spawn(move || {
        for request in server.incoming_requests() {
            // 并发上限：超了直接 503，不 spawn 线程（SSE 会长期占名额）。
            if active.load(Ordering::SeqCst) >= MAX_CONCURRENT {
                let _ = json_error(request, 503, "并发请求过多，请稍后重试");
                continue;
            }
            active.fetch_add(1, Ordering::SeqCst);
            let ctx = ctx.clone();
            let guard = ActiveGuard(active.clone());
            thread::spawn(move || {
                let _guard = guard;
                handle(request, &ctx);
            });
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
        proxy(request, ctx, &path, &url);
    } else {
        crate::static_files::serve(request, &path);
    }
}

fn header_value(request: &tiny_http::Request, name: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str().to_string())
}

/// Host 必须精确是 `127.0.0.1:<本地端口>` 或 `localhost:<本地端口>`。
/// 不能用 starts_with：`127.0.0.1:5273.attacker.tld`、`localhost:52730` 都会漏过。
fn host_allowed(request: &tiny_http::Request, port: u16) -> bool {
    let Some(host) = header_value(request, "host") else {
        return false;
    };
    let Some((name, port_text)) = host.trim().rsplit_once(':') else {
        return false;
    };
    let Ok(given) = port_text.parse::<u16>() else {
        return false;
    };
    if given != port {
        return false;
    }
    let name = name.trim_matches(|c| c == '[' || c == ']');
    name.eq_ignore_ascii_case("127.0.0.1") || name.eq_ignore_ascii_case("localhost")
}

fn token_allowed(request: &tiny_http::Request, token: &str) -> bool {
    match header_value(request, "x-oc-token") {
        Some(value) => value.trim() == token,
        None => false,
    }
}

/// 用 JSON 回一个错误（前端会把 body 原样拼进异常信息）。
fn json_error(request: tiny_http::Request, status: u16, message: &str) -> std::io::Result<()> {
    let body = serde_json::json!({ "error": message, "status": status }).to_string();
    let header = Header::from_bytes(&b"content-type"[..], &b"application/json; charset=utf-8"[..])
        .expect("content-type 头构造失败");
    request.respond(
        Response::from_string(body)
            .with_status_code(StatusCode(status))
            .with_header(header),
    )
}

fn proxy(mut request: tiny_http::Request, ctx: &Ctx, path: &str, url: &str) {
    // 后端不可用（未安装/认证失败）时页面仍要能打开，`/api/*` 统一 502 + JSON。
    let Some(base) = ctx.base.as_deref() else {
        let _ = json_error(
            request,
            502,
            "未连接：本地 opencode 后端不可用（未安装或启动时认证失败）",
        );
        return;
    };

    let method = request.method().as_str().to_string();
    let target = format!("{base}{url}");

    let mut body = Vec::new();
    let has_body = method != "GET" && method != "HEAD";
    if has_body {
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

    // SSE 是无限长的响应：`.timeout()` 是整请求 deadline，会把长连接在 600 秒时掐断，
    // 所以 /api/event 单独用只设连接超时的 agent。
    let is_sse = path == "/api/event" || path.starts_with("/api/event/");
    let builder = ureq::AgentBuilder::new();
    let agent = if is_sse {
        builder.timeout_connect(Duration::from_secs(10)).build()
    } else {
        builder.timeout(Duration::from_secs(600)).build()
    };

    let mut call = agent.request(&method, &target).set("cookie", &ctx.cookie);
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
            // 认证过期（配对 token 通常 30 天），提示重启程序
            let _ = request
                .respond(Response::from_string("401 认证失效，请重启工作台").with_status_code(401));
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

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
