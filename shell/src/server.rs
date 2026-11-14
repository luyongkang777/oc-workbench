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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock, TryLockError};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tiny_http::{Header, Response, Server, StatusCode};

use crate::auth::Backend;
use crate::body::{read_body_with_timeout, BodyRead, RECONNECT_BODY_LIMIT};

/// 同时处理的请求上限（SSE 长连接也会长期占一个名额）。
const MAX_CONCURRENT: usize = 64;
/// 后台连不上后端时的重试间隔（后端起来后最多这么久就能自动恢复）。
const RETRY_INTERVAL: Duration = Duration::from_secs(5);
/// 判定「上游是否真的死了」时的探活超时：这只是一次确认，不值得等太久。
const ALIVE_TIMEOUT: Duration = Duration::from_secs(3);

/// 串行化 `discover()`：后台重试和 `/api/reconnect` 可能同时触发，
/// 并发跑 `opencode pair` 会一次生成多条一次性链接，没必要也不利于排查。
static DISCOVER_LOCK: Mutex<()> = Mutex::new(());
/// 后台发现线程是否还在跑：`spawn_bootstrap` 可能被多处调用（启动、自愈），
/// 不设这个闸门就会叠出多条线程，每 5 秒各跑一次 `pair`。
static BOOTSTRAP_ACTIVE: AtomicBool = AtomicBool::new(false);
/// 自愈线程是否在跑：proxy 每个失败请求都会触发一次，不能每个都起线程。
static HEALING: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
pub struct Ctx {
    /// 后端连接（base + cookie）；`None` 表示未连接，`/api/*` 直接回 502。
    ///
    /// 后台线程和 `/api/reconnect` 都会写它，所以必须是共享可变状态，
    /// 不能在启动时把 `base` 定死（那样后端晚起来就永远恢复不了）。
    pub backend: Arc<RwLock<Option<Backend>>>,
    /// 每次启动随机生成的本地 API token（32 位 hex），由 main 生成后同时交给本服务和 IPC。
    pub token: String,
    /// 本地监听端口：0 = 随机（默认，保持原有行为），非 0 = 固定端口。
    ///
    /// 固定端口是给 SSH 反向隧道用的：隧道目标写死在服务器上，
    /// 端口一变就指向没人监听的地址（表现为 502 但进程还活着）。
    /// start() 会把真实端口回填到这里。
    pub port: u16,
    /// 路径前缀（如 `/u/abc`）；空表示不启用（默认，行为与旧版一致）。
    ///
    /// 设了前缀后，所有请求都必须带前缀；不带的一律 404，
    /// 避免根路径把界面暴露出去，也避免「以为设了、其实没生效」的误判。
    pub base: String,
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

/// 当前上游地址（用于「只清掉我判定过的那条连接」）。
fn backend_base(state: &Arc<RwLock<Option<Backend>>>) -> Option<String> {
    match state.read() {
        Ok(guard) => guard.as_ref().map(|backend| backend.base.clone()),
        Err(poisoned) => poisoned
            .into_inner()
            .as_ref()
            .map(|backend| backend.base.clone()),
    }
}

/// 读「最近一次连接失败的原因」。
fn last_error_text(slot: &Arc<Mutex<Option<String>>>) -> Option<String> {
    match slot.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

/// 清掉当前连接（上游确定不可用 / cookie 已失效）。只清 `expected` 那一条，避免误伤。
///
/// 传 `None` 表示「不管现在是哪条都清」。
fn clear_backend(state: &Arc<RwLock<Option<Backend>>>, expected: Option<&str>) {
    let write = |slot: &mut Option<Backend>| {
        let same = match (expected, slot.as_ref()) {
            (None, _) => true,
            (Some(base), Some(backend)) => backend.base == base,
            (Some(_), None) => false,
        };
        if same {
            *slot = None;
        }
    };
    match state.write() {
        Ok(mut slot) => write(&mut slot),
        Err(poisoned) => write(&mut poisoned.into_inner()),
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
    // 已经有一次 discover 在跑（后台 bootstrap、自愈、或另一个重连请求）：
    // 等它结束后直接按它的结果回答。**绝不再跑一遍 `opencode pair`**——
    // 并发配对会一次生成多条一次性链接，互相顶掉，正是「点重试反而连不上」的来源。
    let guard = match DISCOVER_LOCK.try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(TryLockError::WouldBlock) => {
            let waited = match DISCOVER_LOCK.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            drop(waited);
            return match backend_base(state) {
                Some(base) => Ok(base),
                None => Err(last_error_text(last_error)
                    .unwrap_or_else(|| "正在连接本地服务，请稍后重试".to_string())),
            };
        }
    };
    let _guard = guard;
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
///
/// 幂等：已经有发现线程在跑时直接返回（[`BOOTSTRAP_ACTIVE`]）。自愈时可能反复调用它。
pub fn spawn_bootstrap(
    state: Arc<RwLock<Option<Backend>>>,
    last_error: Arc<Mutex<Option<String>>>,
) {
    if BOOTSTRAP_ACTIVE.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        // 线程退出时（包括 panic）自动把闸门放开，别让后续重连永远进不来。
        let _active = FlagGuard(&BOOTSTRAP_ACTIVE);
        let mut attempt = 0u32;
        let mut last_message = String::new();
        loop {
            // 手动 /api/reconnect 已经连上了就别再跑一遍 pair（会浪费一次性链接）。
            if has_backend(&state) {
                break;
            }

            attempt += 1;
            match connect_once(&state, &last_error) {
                Ok(base) => {
                    crate::append_log(&format!("[auth] 已连接 {base}（第 {attempt} 次尝试）\n"));
                    break;
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

/// 上游是否还在服务：一次短探活，**有状态码就算活着**（端口在应答，只是不认这个请求）。
///
/// 只在「刚才那个请求真的失败了」之后调用，用来区分「后端死了」和「这一个请求出问题」。
fn upstream_alive(base: &str, state: &Arc<RwLock<Option<Backend>>>) -> bool {
    let cookie = match state.read() {
        Ok(guard) => guard.as_ref().map(|backend| backend.cookie.clone()),
        Err(poisoned) => poisoned
            .into_inner()
            .as_ref()
            .map(|backend| backend.cookie.clone()),
    };
    let Some(cookie) = cookie else {
        return false;
    };
    let agent = ureq::AgentBuilder::new()
        .timeout(ALIVE_TIMEOUT)
        .build();
    match agent
        .get(&format!("{base}/api/info"))
        .set("cookie", &cookie)
        .call()
    {
        Ok(_) => true,
        Err(ureq::Error::Status(_, _)) => true,
        Err(_) => false,
    }
}

/// 上游不可用时的自愈入口：清掉死掉的连接，再把后台发现线程拉起来。
///
/// `suspect` 传 `Some(base)` 表示「这一个请求失败，怀疑这条连接死了」——先在后台
/// 短探活确认，确认不了就只清这一条并重连；
/// 传 `None` 表示已经确定失效（例如上游回了 401，配对 cookie 过期），直接清掉重连。
///
/// 为什么要先确认：单个请求超时、请求体读失败、SSE 被客户端断开，都不代表后端死了。
/// 一有错误就重新配对会让正在用的连接反复抖动，还会白白消耗一次性链接。
pub(crate) fn heal(ctx: &Ctx, suspect: Option<String>) {
    if HEALING.swap(true, Ordering::SeqCst) {
        return;
    }
    let state = ctx.backend.clone();
    let last_error = ctx.last_error.clone();
    thread::spawn(move || {
        // 同样的道理：探活/重连里出任何意外，闸门也要自己放开。
        let _healing = FlagGuard(&HEALING);
        let dead = match suspect.as_deref() {
            None => true,
            Some(base) => !upstream_alive(base, &state),
        };
        if dead {
            clear_backend(&state, suspect.as_deref());
            set_last_error(&last_error, Some("后端连接已失效，正在自动重连".to_string()));
            crate::append_log("[auth] 连接失效，自动重新发现后端\n");
            spawn_bootstrap(state, last_error);
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

/// 「这个后台任务还在跑」的标志，线程退出（含 panic）时自动复位。
///
/// 用 RAII 而不是在末尾手写 store：发现线程里跑的是外部命令，panic 一次就会留下
/// 一个永远为 true 的标志，把后续所有重连都堵死。
struct FlagGuard(&'static AtomicBool);

impl Drop for FlagGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub fn start(mut ctx: Ctx) -> Result<u16, String> {
    // 0 = 操作系统分配（原有行为）；固定端口失败要明确报错，不能静默换端口，
    // 否则隧道会指向一个没人监听的端口，排查时只剩「502」。
    let bind = format!("127.0.0.1:{}", ctx.port);
    let server =
        Server::http(&bind).map_err(|e| format!("本地服务启动失败（{bind}）：{e}"))?;
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
    let raw_path = url.split('?').next().unwrap_or("").to_string();

    // 前缀本身（不带尾斜杠）先跳一次：否则页面里的相对资源会按错基准解析。
    if !ctx.base.is_empty() && raw_path == ctx.base {
        // query 要原样带过去：`/u/<id>?t=xxx` 这种链接如果丢了 t，页面能开但接口全 403。
        let query = url
            .split_once('?')
            .map(|(_, rest)| format!("?{rest}"))
            .unwrap_or_default();
        let location = format!("{}/{query}", ctx.base);
        let header = Header::from_bytes(&b"location"[..], location.as_bytes())
            .expect("location 头构造失败");
        let _ = request.respond(Response::from_string("").with_status_code(302).with_header(header));
        return;
    }

    // 剥前缀；不匹配一律 404（根路径不许露出界面）。
    let Some(path) = strip_base(&raw_path, &ctx.base) else {
        let _ = request.respond(Response::from_string("404 路径不存在").with_status_code(404));
        return;
    };

    // Host 校验对所有请求生效（含静态资源），失败直接 403。
    if !host_allowed(&request, ctx.port) {
        let _ = request.respond(Response::from_string("403 Host 校验失败").with_status_code(403));
        return;
    }

    // 远程入口：`<base>/?t=<remoteToken>` 换一个签名 cookie。
    // 浏览器拿不到 IPC 下发的 token，这条路是给手机/外部浏览器用的。
    if path == "/" || path == "/index.html" {
        match crate::auth_gate::login_from_query(&url, &ctx.base, now_secs()) {
            crate::auth_gate::LoginOutcome::Accepted(value) => {
                // 用 fragment（`#`）而不是 query 传递凭据：浏览器不会把 `#` 后面
                // 发给服务器，否则服务端又看到 `?t=` 再 302 一次，直接死循环
                // （实测 ERR_TOO_MANY_REDIRECTS）。前端读完会清掉它。
                let fragment = url
                    .split_once('?')
                    .map(|(_, rest)| format!("#{rest}"))
                    .unwrap_or_default();
                let location = if ctx.base.is_empty() {
                    format!("/{fragment}")
                } else {
                    format!("{}/{fragment}", ctx.base)
                };
                let header = Header::from_bytes(&b"location"[..], location.as_bytes())
                    .expect("location 头构造失败");
                let response = Response::from_string("")
                    .with_status_code(302)
                    .with_header(crate::auth_gate::cookie_header(&ctx.base, &value))
                    .with_header(crate::auth_gate::no_referrer())
                    .with_header(crate::auth_gate::no_store())
                    .with_header(header);
                let _ = request.respond(response);
                return;
            }
            crate::auth_gate::LoginOutcome::Rejected => {
                let _ = request.respond(
                    Response::from_string("403 token 不正确").with_status_code(403),
                );
                return;
            }
            crate::auth_gate::LoginOutcome::Ignore => {}
        }
    }

    // 本地文件通道：直接读磁盘，不经过 opencode。同样要 token（页面从 IPC 拿）。
    if path == "/local" || path.starts_with("/local/") {
        if !token_allowed(&request, ctx) {
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
        // 项目清单：外壳版本走 IPC，浏览器/远程访问走这条（等价语义）。
        if path == "/local/projects" {
            crate::projects_api::handle(request);
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
        // 输入框草稿（文字 + 待发送图片）：按「项目::会话」落盘，切换标签/项目、
        // 重开工作台都能恢复。localStorage 跨不了启动（端口每次变，origin 跟着变）。
        if path.starts_with("/local/draft/") {
            crate::draft::handle(request, &path, &url);
            return;
        }
        crate::fsapi::handle(request, &path, &url);
        return;
    }

    if path == "/api" || path.starts_with("/api/") {
        // 先 Host 再 token，任一失败都不转发。
        if !token_allowed(&request, ctx) {
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

/// 剥掉路径前缀；不匹配返回 `None`。
///
/// 按「整段」匹配：`/u/abc` 只接受 `/u/abc/...`，不能误匹配 `/u/abcd/`
/// ——否则两个实例的请求会串到一起。
fn strip_base(path: &str, base: &str) -> Option<String> {
    if base.is_empty() {
        return Some(path.to_string());
    }
    let base = base.trim_end_matches('/');
    match path.strip_prefix(base) {
        Some(rest) if rest.starts_with('/') => Some(rest.to_string()),
        _ => None,
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

/// 两种凭据都认：
///   * `x-oc-token` 头 —— WebView2 外壳（token 经 IPC 下发），行为与旧版一致；
///   * cookie —— 外部浏览器，由入口 `?t=` 签发，签名里带实例前缀。
fn token_allowed(request: &tiny_http::Request, ctx: &Ctx) -> bool {
    if let Some(value) = header_value(request, "x-oc-token") {
        let value = value.trim();
        // 外壳：每次启动随机生成的 token（WebView2 经 IPC 下发）。
        if value == ctx.token {
            return true;
        }
        // 远程实例：localStorage 里存的是持久化的 remoteToken，手机存不住 cookie 时靠它。
        // 桌面（base 为空）**不认** remoteToken——不能把「每次启动随机」的门禁降级成持久凭据。
        if !ctx.base.is_empty() && value == crate::remote_auth::cached_token() {
            return true;
        }
    }
    // cookie 同理，只在前缀实例上生效。
    if ctx.base.is_empty() {
        return false;
    }
    let Some(value) = crate::auth_gate::cookie_value(request, crate::auth_gate::COOKIE_NAME)
    else {
        return false;
    };
    crate::remote_auth::verify_session(
        crate::remote_auth::cached_token(),
        &ctx.base,
        &value,
        now_secs(),
    )
}

/// Unix 秒。cookie 的过期判断用它，和签发时保持同一时基。
fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs())
        .unwrap_or(0)
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
