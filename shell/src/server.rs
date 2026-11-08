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
//!   * 同时转发数上限 [`MAX_CONCURRENT`]，超出直接 503，避免本机进程刷连接把工作台拖死；
//!   * 转发的请求体最多 [`MAX_BODY`] 字节、最多等 [`BODY_TIMEOUT`] 秒，超限/超时都不占着线程。
//!
//! 后端连接是**共享可变状态**（[`Ctx::backend`]）：启动时先起服务、先开窗口，
//! 由后台线程 [`spawn_bootstrap`] 去 `discover()`，失败每 [`RETRY_INTERVAL`] 重试一次；
//! 页面也可以 `POST /api/reconnect` 立刻触发一次重新认证（同样要过 `x-oc-token` 校验）。

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tiny_http::{Header, Response, Server, StatusCode};

use crate::auth::Backend;

/// 同时处理的请求上限（SSE 长连接也会长期占一个名额）。
const MAX_CONCURRENT: usize = 64;
/// 后台连不上后端时的重试间隔（后端起来后最多这么久就能自动恢复）。
const RETRY_INTERVAL: Duration = Duration::from_secs(5);
/// 转发给上游的请求体上限：工作台只有小的 JSON 写操作，10MB 足够，超过直接 413。
const MAX_BODY: usize = 10 * 1024 * 1024;
/// 读请求体的最长等待：客户端声明了长度却发不完时，不能让它一直占着请求线程。
const BODY_TIMEOUT: Duration = Duration::from_secs(15);
/// `/api/reconnect` 只需要一个占位 body（前端可能发 `{}`），给个更小的上限。
const RECONNECT_BODY_LIMIT: usize = 64 * 1024;

/// 串行化 `discover()`：后台重试和 `/api/reconnect` 可能同时触发，
/// 并发跑 `opencode pair` 会一次生成多条一次性链接，没必要也不利于排查。
static DISCOVER_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone)]
pub struct Ctx {
    /// 后端连接（base + cookie）；`None` 表示未连接，`/api/*` 直接回 502。
    ///
    /// 后台线程和 `/api/reconnect` 都会写它，所以必须是共享可变状态，
    /// 不能在启动时把 `base` 定死（那样后端晚起来就永远恢复不了）。
    pub backend: Arc<RwLock<Option<Backend>>>,
    /// 每次启动随机生成的本地 API token（32 位 hex），由 main 生成后同时交给本服务和 IPC。
    pub token: String,
    /// 本地监听端口，start() 拿到真实端口后回填。
    pub port: u16,
}

impl Ctx {
    /// 读当前后端（base, cookie）。锁中毒也照常取数据，不能因为某次 panic 丢掉连接。
    fn current_backend(&self) -> Option<(String, String)> {
        let guard = match self.backend.read() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard
            .as_ref()
            .map(|backend| (backend.base.clone(), backend.cookie.clone()))
    }
}

/// 把新连接写进共享状态。
fn store_backend(state: &Arc<RwLock<Option<Backend>>>, backend: Backend) {
    match state.write() {
        Ok(mut slot) => *slot = Some(backend),
        Err(poisoned) => *poisoned.into_inner() = Some(backend),
    }
}

/// 当前是否已经连上（后台线程据此在手动重连成功后提前退出）。
fn has_backend(state: &Arc<RwLock<Option<Backend>>>) -> bool {
    match state.read() {
        Ok(guard) => guard.is_some(),
        Err(poisoned) => poisoned.into_inner().is_some(),
    }
}

/// 串行地跑一次 `auth::discover()`，并把结果原子地写进共享状态
/// （后台重试和手动重连共用这个入口）。
///
/// 写状态必须发生在锁内：否则两个并发 discover 的结果可能以相反顺序落盘，
/// 留下一个已经被后一次 pair 顶掉的旧 cookie。
fn connect_once(state: &Arc<RwLock<Option<Backend>>>) -> Result<String, String> {
    let _guard = match DISCOVER_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let backend = crate::auth::discover()?;
    let base = backend.base.clone();
    store_backend(state, backend);
    Ok(base)
}

/// 后台连接后端：立即尝试一次，失败每 [`RETRY_INTERVAL`] 重试，成功后线程退出。
///
/// 这样 `opencode service status` / `pair` 的 5 秒超时（最坏两次）不会卡在
/// 主线程上把窗口拖成白屏；后端晚起来也能自己恢复。
///
/// 同一个失败原因只记一次日志：每 5 秒重试一次，原样刷屏会把日志撑爆。
pub fn spawn_bootstrap(state: Arc<RwLock<Option<Backend>>>) {
    thread::spawn(move || {
        let mut attempt = 0u32;
        let mut last_error = String::new();
        loop {
            // 手动 /api/reconnect 已经连上了就别再跑一遍 pair（会浪费一次性链接）。
            let already = has_backend(&state);
            if already {
                return;
            }

            attempt += 1;
            match connect_once(&state) {
                Ok(base) => {
                    crate::append_log(&format!("[auth] 已连接 {base}（第 {attempt} 次尝试）\n"));
                    return;
                }
                Err(err) => {
                    if err != last_error {
                        crate::append_log(&format!(
                            "[auth] 第 {attempt} 次连接失败：{err}；之后每 {} 秒重试一次（同一原因不再重复记）\n",
                            RETRY_INTERVAL.as_secs()
                        ));
                        last_error = err;
                    }
                }
            }
            thread::sleep(RETRY_INTERVAL);
        }
    });
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

/// 读请求体的结果：超限和读失败要回不同的状态码。
enum BodyRead {
    Ok(Vec<u8>),
    TooLarge,
    Failed(std::io::Error),
}

/// 带超时和上限地读请求体。
///
/// `tiny_http::Request` 的 reader 阻塞在 socket 上，没有公开的读超时或主动关连接的入口，
/// 所以只能把 `Request` 搬进子线程去读，主线程用 `recv_timeout` 计时：
///   * 声明了 `Content-Length` 且超过 `limit` → 不用读，直接判超限；
///   * 读完 → 把 `Request` 还回来（还要用它 respond）；
///   * 超时 → 返回 `None`。此时 `Request` 还留在卡住的读线程里，连接不会被复用，
///     主线程立刻释放并发名额；读线程等客户端断开后自己结束。
fn read_body_with_timeout(
    request: tiny_http::Request,
    limit: usize,
) -> Option<(tiny_http::Request, BodyRead)> {
    if let Some(length) = request.body_length() {
        if length > limit {
            return Some((request, BodyRead::TooLarge));
        }
    }

    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut request = request;
        let mut request = request;
        let mut body = Vec::new();
        // 多读 1 字节用来区分「正好等于上限」和「超过上限」。
        let mut reader = std::io::Read::take(request.as_reader(), (limit + 1) as u64);
        let result = match std::io::Read::read_to_end(&mut reader, &mut body) {
            Ok(_) if body.len() > limit => BodyRead::TooLarge,
            Ok(_) => BodyRead::Ok(body),
            Err(err) => BodyRead::Failed(err),
        };
        drop(reader);
        // 主线程已经超时放弃时 send 会失败，Request 随线程结束被丢弃（连接关闭）。
        let _ = sender.send((request, result));
    });

    match receiver.recv_timeout(BODY_TIMEOUT) {
        Ok(pair) => Some(pair),
        Err(RecvTimeoutError::Timeout) => {
            crate::append_log(&format!(
                "[proxy] 读请求体超过 {} 秒仍未结束，放弃该连接\n",
                BODY_TIMEOUT.as_secs()
            ));
            None
        }
        Err(RecvTimeoutError::Disconnected) => {
            crate::append_log("[proxy] 读请求体的线程异常退出，放弃该连接\n");
            None
        }
    }
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
        // 重连是外壳自己的端点，不转发到上游。
        if path == "/api/reconnect" {
            reconnect(request, ctx);
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

/// 用 JSON 回一个响应（前端会把 body 原样拼进异常信息）。
fn respond_json(request: tiny_http::Request, status: u16, body: String) -> std::io::Result<()> {
    let header = Header::from_bytes(&b"content-type"[..], &b"application/json; charset=utf-8"[..])
        .expect("content-type 头构造失败");
    request.respond(
        Response::from_string(body)
            .with_status_code(StatusCode(status))
            .with_header(header),
    )
}

/// 用 JSON 回一个错误（前端会把 body 原样拼进异常信息）。
fn json_error(request: tiny_http::Request, status: u16, message: &str) -> std::io::Result<()> {
    let body = serde_json::json!({ "error": message, "status": status }).to_string();
    respond_json(request, status, body)
}

/// `POST /api/reconnect`：立刻跑一次 `discover()`，把结果直接回给页面。
///
/// 成功 200 `{"ok":true,"base":"http://127.0.0.1:<port>"}`；
/// 失败 502 `{"ok":false,"error":"..."}`（原因照抄 discover 的错误串）。
///
/// 这个端点本身不转发上游，所以后端没连上时也能用；token 校验和其它 `/api/*` 一样。
fn reconnect(request: tiny_http::Request, ctx: &Ctx) {
    if !request.method().as_str().eq_ignore_ascii_case("POST") {
        let _ = json_error(request, 405, "只支持 POST /api/reconnect");
        return;
    }

    // 前端可能带 `{}` 之类的占位体：照样按上限/超时读完丢掉，别让连接里残留半截 body。
    let Some((request, body)) = read_body_with_timeout(request, RECONNECT_BODY_LIMIT) else {
        return;
    };
    match body {
        BodyRead::Ok(_) => {}
        BodyRead::TooLarge => {
            let _ = json_error(request, 413, "请求体过大");
            return;
        }
        BodyRead::Failed(err) => {
            let _ = json_error(request, 400, &format!("读取请求体失败：{err}"));
            return;
        }
    }

    match connect_once(&ctx.backend) {
        Ok(base) => {
            crate::append_log(&format!("[auth] 手动重连成功：{base}\n"));
            let body = serde_json::json!({ "ok": true, "base": base }).to_string();
            let _ = respond_json(request, 200, body);
        }
        Err(err) => {
            // 错误串由 auth::discover 拼好（命令、退出码、stderr 片段），不含 cookie。
            crate::append_log(&format!("[auth] 手动重连失败：{err}\n"));
            let body = serde_json::json!({ "ok": false, "error": err }).to_string();
            let _ = respond_json(request, 502, body);
        }
    }
}

fn proxy(request: tiny_http::Request, ctx: &Ctx, path: &str, url: &str) {
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

    let reader = resp.into_reader();
    // SSE 没有 content-length，交给 tiny_http 走 chunked 逐块转发。
    let mut out = Response::new(status, Vec::new(), reader, length, None);
    // tiny_http 默认 ≥32KB 就改发 chunked 并**丢掉 Content-Length**，
    // 前端的 2MB 预检查（读 content-length）会因此失效。上游有明确长度时
    // 把阈值抬到 usize::MAX，按 Identity 原样透传长度；SSE 无长度仍走 chunked。
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
