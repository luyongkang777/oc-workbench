//! 本地 HTTP 服务的入口：路由、并发上限、Host/token 校验、后端连接管理。
//!
//! 静态文件在 [`crate::static_files`]，`/api` 转发在 [`crate::proxy`]，读请求体在 [`crate::body`]。
//!
//! 安全约束（只对 loopback 生效，但 loopback 端口任何本机进程都能扫）：
//!   * 所有请求校验 `Host` 头必须**精确等于** `127.0.0.1:<本地端口>` 或 `localhost:<本地端口>`；
//!   * `/api/*` 额外校验 `x-oc-token` 头，值等于每次启动密码学随机生成的 token；
//!   * token **不经 HTTP 下发**：index.html 里没有 token，页面通过 IPC 向外壳索取；
//!   * 同时转发数上限 [`MAX_CONCURRENT`]，超出直接 503；
//!   * 转发的请求体最多 [`crate::body::MAX_BODY`] 字节、最多等 [`crate::body::BODY_TIMEOUT`]。
//!
//! 后端连接是**共享可变状态**（[`Ctx::backend`]）：启动时先起服务、先开窗口，
//! 由后台线程 [`spawn_bootstrap`] 去 `discover()`，失败每 [`RETRY_INTERVAL`] 重试一次；
//! 页面也可以 `POST /api/reconnect` 立刻触发一次重新认证（同样要过 `x-oc-token` 校验）。

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tiny_http::{Header, Response, Server, StatusCode};

use crate::auth::Backend;
use crate::body::{read_body_with_timeout, BodyRead, RECONNECT_BODY_LIMIT};

/// 同时处理的请求上限（SSE 长连接也会长期占一个名额）。
const MAX_CONCURRENT: usize = 64;
/// 后台连不上后端时的重试间隔（后端起来后最多这么久就能自动恢复）。
const RETRY_INTERVAL: Duration = Duration::from_secs(5);

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
    /// 最近一次连接失败的原因；连上后清空。
    ///
    /// 只读地暴露给页面（`GET /api/state`）：换台机器最常见的问题是
    /// 「opencode 没装 / 不在 PATH」，用户不该非点一次「重试」才知道原因。
    pub last_error: Arc<Mutex<Option<String>>>,
}

impl Ctx {
    /// 读当前后端（base, cookie）。锁中毒也照常取数据，不能因为某次 panic 丢掉连接。
    pub(crate) fn current_backend(&self) -> Option<(String, String)> {
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

/// 记录「最近一次连接失败的原因」；成功时传 None 清空。
fn set_last_error(slot: &Arc<Mutex<Option<String>>>, error: Option<String>) {
    match slot.lock() {
        Ok(mut guard) => *guard = error,
        Err(poisoned) => *poisoned.into_inner() = error,
    }
}

/// 串行地跑一次 `auth::discover()`，并把结果原子地写进共享状态
/// （后台重试和手动重连共用这个入口）。
///
/// 写状态必须发生在锁内：否则两个并发 discover 的结果可能以相反顺序落盘，
/// 留下一个已经被后一次 pair 顶掉的旧 cookie。
fn connect_once(
    state: &Arc<RwLock<Option<Backend>>>,
    last_error: &Arc<Mutex<Option<String>>>,
) -> Result<String, String> {
    let _guard = match DISCOVER_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    match crate::auth::discover() {
        Ok(backend) => {
            let base = backend.base.clone();
            store_backend(state, backend);
            set_last_error(last_error, None);
            Ok(base)
        }
        Err(err) => {
            // 给页面看的版本：不截断（本地接口，几十字），配对链接已在 auth 里打码。
            set_last_error(last_error, Some(err.clone()));
            Err(err)
        }
    }
}

/// 后台连接后端：立即尝试一次，失败每 [`RETRY_INTERVAL`] 重试，成功后线程退出。
///
/// 这样 `opencode service status` / `pair` 的超时不会卡在主线程上把窗口拖成白屏；
/// 后端晚起来也能自己恢复。
///
/// 同一个失败原因只记一次日志：每 5 秒重试一次，原样刷屏会把日志撑爆。
pub fn spawn_bootstrap(
    state: Arc<RwLock<Option<Backend>>>,
    last_error: Arc<Mutex<Option<String>>>,
) {
    thread::spawn(move || {
        let mut attempt = 0u32;
        let mut last_message = String::new();
        loop {
            // 手动 /api/reconnect 已经连上了就别再跑一遍 pair（会浪费一次性链接）。
            if has_backend(&state) {
                return;
            }

            attempt += 1;
            match connect_once(&state, &last_error) {
                Ok(base) => {
                    crate::append_log(&format!("[auth] 已连接 {base}（第 {attempt} 次尝试）\n"));
                    return;
                }
                Err(err) => {
                    if err != last_message {
                        crate::append_log(&format!(
                            "[auth] 第 {attempt} 次连接失败：{err}；之后每 {} 秒重试一次（同一原因不再重复记）\n",
                            RETRY_INTERVAL.as_secs()
                        ));
                        last_message = err;
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

    // 本地文件通道：直接读磁盘，不经过 opencode。同样要 token（页面从 IPC 拿）。
    if path == "/local" || path.starts_with("/local/") {
        if !token_allowed(&request, &ctx.token) {
            let _ = request.respond(
                Response::from_string("403 缺少或错误的 x-oc-token").with_status_code(403),
            );
            return;
        }
        // Git 面板：同样走本地通道，token 上面已经校验过。
        if path.starts_with("/local/git/") {
            crate::gitapi::handle(request, &path, &url);
            return;
        }
        // 远程账号与仓库托管：同样走本地通道。
        if path.starts_with("/local/remote/") {
            crate::remoteapi::handle(request, &path, &url);
            return;
        }
        // 在线更新：检查 / 下载并重启 / 设置更新源。必须排在 fsapi 前面，
        // 否则会被「未知的本地文件接口」吃掉。
        if path.starts_with("/local/update/") {
            crate::update::handle(request, &path, &url);
            return;
        }
        // OpenCode CLI 版本 / 安装 / 自动更新：同样排在 fsapi 前面。
        if path.starts_with("/local/cli/") {
            crate::cli::handle(request, &path, &url);
            return;
        }
        // 破甲注入开关：只读写插件 config.json 的 enabled，必须排在 fsapi 前面。
        if path.starts_with("/local/purge/") {
            crate::purge::handle(request, &path, &url);
            return;
        }
        crate::fsapi::handle(request, &path, &url);
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
        // 只读状态：页面据此直接显示「为什么没连上」，不用用户先点一次「重试」。
        if path == "/api/state" {
            shell_state(request, ctx);
            return;
        }
        // 重连是外壳自己的端点，不转发到上游。
        if path == "/api/reconnect" {
            reconnect(request, ctx);
            return;
        }
        crate::proxy::proxy(request, ctx, &path, &url);
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

/// 用 JSON 回一个响应（前端会把 body 拼进异常信息）。
pub(crate) fn respond_json(
    request: tiny_http::Request,
    status: u16,
    body: String,
) -> std::io::Result<()> {
    let header = Header::from_bytes(&b"content-type"[..], &b"application/json; charset=utf-8"[..])
        .expect("content-type 头构造失败");
    request.respond(
        Response::from_string(body)
            .with_status_code(StatusCode(status))
            .with_header(header),
    )
}

/// 用 JSON 回一个错误。
pub(crate) fn json_error(
    request: tiny_http::Request,
    status: u16,
    message: &str,
) -> std::io::Result<()> {
    let body = serde_json::json!({ "error": message, "status": status }).to_string();
    respond_json(request, status, body)
}

/// `GET /api/state`：外壳自己的只读状态。
///
/// 和 `/api/reconnect` 的区别：这里**不做任何认证**，只把后台线程已经算出来的结果
/// 回给页面，所以断开态下每秒轮询也不会额外生成配对链接。
fn shell_state(request: tiny_http::Request, ctx: &Ctx) {
    if !request.method().as_str().eq_ignore_ascii_case("GET") {
        let _ = json_error(request, 405, "只支持 GET /api/state");
        return;
    }
    let base = ctx.current_backend().map(|(base, _)| base);
    let error = match ctx.last_error.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    let body = serde_json::json!({
        "connected": base.is_some(),
        "base": base,
        "error": error,
    })
    .to_string();
    let _ = respond_json(request, 200, body);
}

/// `POST /api/reconnect`：立刻跑一次 `discover()`，把结果直接回给页面。
///
/// 成功 200 `{"ok":true,"base":"..."}`；失败 502 `{"ok":false,"error":"..."}`。
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

    match connect_once(&ctx.backend, &ctx.last_error) {
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

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
