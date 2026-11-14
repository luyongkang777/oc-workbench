// OpenCode 工作台 —— Rust 桌面外壳（tao + wry / WebView2）
//
// 职责边界：
//   * 开一个无控制台窗口，加载内嵌前端（dist）并通过本地 HTTP 服务代理 opencode API。
//   * 后端不可用时仍然起本地服务（页面可访问，/api 返回 502），界面显示「未连接」，
//     不白屏。后端发现放到后台线程，失败每 5 秒重试一次，页面再轮询就能看到「已连接」；
//     也可以 POST /api/reconnect 立刻重连。
//   * 只有显式设置 OC_WORKBENCH_URL 时才加载外部 dev 地址。
//   * token 不走 HTTP：index.html 里没有任何 token。页面加载后 IPC 发 'oc:auth'，
//     外壳用 evaluate_script 下发 `window.__ocIpc('token:<token>')`；
//     其它 IPC 消息仍回显 `pong:<msg>`。
#![windows_subsystem = "windows"]

mod auth;
mod body;
mod cli;
mod draft;
mod fetch;
mod fsapi;
mod fsdecode;
mod fsindex;
mod fsread;
mod fssearch;
mod fsutil;
mod gitapi;
mod gitbundle;
mod projects;
mod purge;
mod remoteapi;
mod update;
mod winenc;
mod shellprobe;
mod server;
mod single;
mod single_peer;
mod single_guard;
mod win32;
mod proxy;
mod static_files;

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::ffi::OsStr;
use std::io::Write;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tao::dpi::{LogicalSize, PhysicalPosition as TaoPosition, PhysicalSize as TaoSize};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::WindowBuilder;
#[cfg(windows)]
use tao::platform::windows::WindowExtWindows;
use wry::dpi::{PhysicalPosition, PhysicalSize, Position, Size};
use wry::{Rect, WebViewBuilder};
#[cfg(debug_assertions)]
use wry::WebViewBuilderExtWindows;

// 窗口标题同时是「找已有实例」的键，定义在 single.rs 里，这里只做别名。
const APP_TITLE: &str = single::WINDOW_TITLE;
const URL_ENV: &str = "OC_WORKBENCH_URL";
const LOG_NAME: &str = "gui-error.log";

fn main() {
    install_panic_hook();

    // 同一台机器只允许一个工作台在跑。开两个会让在线升级换不成新版本：
    // 升级脚本只重试覆盖一个 exe，另一个实例仍占着旧文件，重试到上限后会照样 start，
    // 结果就是「版本没变 / 两个窗口版本不一致」。
    // 重复启动不算错误：把已经开着的窗口切到前台就退出。
    let _instance = match single::acquire() {
        Some(guard) => {
            append_log("[boot] 单实例凭证已获取\n");
            guard
        }
        None => {
            let focused = single::focus_existing();
            append_log(&format!(
                "[boot] 已有实例在运行，本次启动退出（切到前台：{focused}）\n"
            ));
            // 抢不到前台时**不要弹模态提示框**：那是一问一答，
            // 用户不点确定，这个进程就一直挂着不退出（实测会卡十几秒以上）。
            // 已经在跑的窗口会自己闪任务栏，够提示了。
            if !focused {
                append_log("[boot] 未能把已有窗口切到前台（前台锁），本次启动仍退出\n");
            }
            return;
        }
    };

    init_com_sta();
    adopt_launch_arg();

    if let Err(err) = run() {
        let log = log_path();
        append_log(&format!("[fatal] {err}\n"));
        show_fatal_dialog(&format!(
            "OpenCode 工作台启动失败：\n{err}\n\n详细日志：{}",
            log.display()
        ));
        std::process::exit(1);
    }
}

/// 从资源管理器把文件夹拖到 exe 图标上、「打开方式」、或命令行带路径时，
/// 直接把那个目录当成这次要打开的根目录（落到 root.txt，启动后随 token 下发）。
fn adopt_launch_arg() {
    let Some(arg) = std::env::args_os().nth(1) else {
        return;
    };
    let Some(text) = arg.to_str() else {
        return;
    };
    if text.is_empty() {
        return;
    }
    if std::path::Path::new(text).is_dir() {
        save_root(text);
        append_log(&format!("[start] 按启动参数打开：{text}\n"));
    }
}

/// COM 必须先初始化成 STA，否则 WebView2 的文件对话框等组件会 0xc0000409 闪退。
#[cfg(windows)]
fn init_com_sta() {
    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(pv: *mut std::ffi::c_void, coinit: u32) -> i32;
    }
    unsafe {
        // COINIT_APARTMENTTHREADED = 0x2；已初始化会返回 RPC_E_CHANGED_MODE，忽略即可。
        let _ = CoInitializeEx(std::ptr::null_mut(), 0x2);
    }
}

#[cfg(not(windows))]
fn init_com_sta() {}

/// 起内嵌前端 + 本地代理。
///
/// **这里不做任何后端发现**：`auth::discover()` 最长会等两条子命令各 5 秒，
/// 放在启动路径上就是十几秒白窗。改成先起本地服务、立刻返回 URL，
/// 由后台线程 [`server::spawn_bootstrap`] 去连接（失败每 5 秒重试）。
fn start_local(token: &str) -> Result<String, String> {
    let backend: Arc<RwLock<Option<auth::Backend>>> = Arc::new(RwLock::new(None));
    // 与 backend 一起共享：后台线程写失败原因，`GET /api/state` 读给页面。
    let last_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let port = server::start(server::Ctx {
        backend: backend.clone(),
        token: token.to_string(),
        port: 0,
        last_error: last_error.clone(),
    })?;
    server::spawn_bootstrap(backend, last_error);
    // 后台确认 opencode CLI 是 v2 且是最新版：缺了就装，旧了就更新。
    // 和 bootstrap 并行：它连不上时每 5 秒重试，装完自然就连上了。
    cli::spawn_auto_update();
    append_log(&format!(
        "[boot] 本地服务端口 {port}（后端连接在后台进行，失败每 5 秒重试）\n"
    ));
    Ok(format!("http://127.0.0.1:{port}/"))
}

/// 决定页面加载的地址。
///
/// 只有显式设置了 OC_WORKBENCH_URL 才用外部地址（给 Vite dev 用）；
/// 否则永远走本地服务，不允许回退到没人监听的 dev 端口（打包机上那是白屏）。
fn resolve_url(token: &str) -> Result<String, String> {
    if let Ok(value) = std::env::var(URL_ENV) {
        let value = value.trim().to_string();
        if !value.is_empty() {
            append_log(&format!("[boot] 使用 {URL_ENV}={value}\n"));
            return Ok(value);
        }
    }
    start_local(token)
}

fn run() -> Result<(), String> {
    let event_loop = EventLoop::new();
    // 尺寸按主显示器的物理分辨率 + 缩放率算，不再写死逻辑尺寸：
    // 1080p@150% 只有 1280×720 逻辑像素，固定 1400×900 会超出屏幕，
    // 看起来就像「一开就占满（还被截断）」。
    let initial = initial_window_geometry(&event_loop);
    let initial_logical = initial.logical;
    let auto_logical = initial.auto;

    // 自绘标题栏：去掉系统边框，最小化/最大化/关闭由前端顶栏画。
    // tao 在 Windows 上会保留 WS_THICKFRAME，所以边缘拖拽改大小仍然可用。
    let mut window_builder = WindowBuilder::new()
        .with_title(APP_TITLE)
        .with_decorations(false)
        .with_inner_size(TaoSize::new(initial.physical.0, initial.physical.1))
        .with_min_inner_size(LogicalSize::new(WINDOW_MIN_PX.0, WINDOW_MIN_PX.1));
    if let Some((x, y)) = initial.position {
        window_builder = window_builder.with_position(TaoPosition::new(x, y));
    }
    let window = window_builder
        .build(&event_loop)
        .map_err(|e| format!("创建窗口失败：{e}"))?;
    // 跨版本单实例守护：老版本自己没有互斥体检查，只能由已经在跑的这一份盯着。
    // 一旦出现第二个工作台窗口，就把它请走并把本窗口拉到前台——
    // 用户看到的效果是「双击老图标，还是原来那个窗口」。
    #[cfg(windows)]
    single::guard(window.hwnd() as isize, |line| append_log(line));
    // 无边框窗口补一层系统阴影，不然和桌面糊在一起，看着像没有窗口边界。
    #[cfg(windows)]
    window.set_undecorated_shadow(true);

    // token 由 main 生成，同时给本地服务和 IPC（页面加载后经 'oc:auth' 索取）。
    let token = server::new_token();
    let url = resolve_url(&token)?;

    // IPC 回调里只入队 + 用 proxy 唤醒事件循环，真正的 evaluate_script 在主循环做
    // （WebView2 消息泵没转时脚本会被丢）。
    //
    // 注意：这里**不能**靠 `ControlFlow::WaitUntil` 轮询。tao 0.37 的定时唤醒依赖
    // WM_PAINT 触发 `process_control_flow`，而 WebView2 占满客户区后父窗口不再重绘，
    // 事件循环会永远停在 GetMessageW 上（实测 ResumeTimeReached 一次都不来）。
    let pending: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
    let ipc_queue = pending.clone();
    // 自绘标题栏发来的窗口命令（最小化/最大化/关闭/拖动）。同样只入队，
    // 真正调 tao 窗口 API 的地方在主循环——IPC 回调里拿不到 window 的移动权。
    let win_queue: Rc<RefCell<Vec<WinCmd>>> = Rc::new(RefCell::new(Vec::new()));
    let win_queue_ipc = win_queue.clone();
    // 跨线程回执：打开链接在子线程做，失败消息经这里回主循环下发页面。
    let failures: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    // ipc_handler 和主循环是两个独立 move 闭包，各持一份 Arc。
    let failures_ipc = failures.clone();
    let ipc_token = token.clone();
    let proxy = event_loop.create_proxy();

    let local_origin = url.trim_end_matches('/').to_string();
    let nav_origin = local_origin.clone();
    let ipc_origin = local_origin.clone();
    let token_sent = Arc::new(AtomicBool::new(false));

    let mut builder = WebViewBuilder::new()
        .with_url(&url)
        .with_navigation_handler(move |target: String| {
            // 允许本站、空白页与 data/about 这类内部页；只拦外部导航。
            // 不能拦得太死：F5 刷新、渲染进程崩溃自愈都会触发导航，
            // 拦掉它们等于让整个工作台在重载后不可用。
            let allowed = target.is_empty()
                || target == nav_origin
                || target.starts_with(&format!("{nav_origin}/"))
                || target.starts_with("about:")
                || target.starts_with("data:")
                || target.starts_with("blob:");
            if !allowed {
                append_log(&format!("[nav] 阻止导航 {target}\n"));
            }
            allowed
        })
        .with_ipc_handler(move |request: wry::http::Request<String>| {
            let uri = request.uri().to_string();
            // 只接受本站页面发来的消息；uri 为空时放行（部分平台不提供来源）。
            if !uri.is_empty() && !uri.starts_with(&ipc_origin) {
                append_log(&format!("[ipc] 拒绝来源 {uri}\n"));
                return;
            }
            let body = request.body().trim().to_string();
            if let Some(raw) = body.strip_prefix("oc:win-") {
                let cmd = match raw {
                    "minimize" => Some(WinCmd::Minimize),
                    "toggle-maximize" => Some(WinCmd::ToggleMaximize),
                    "close" => Some(WinCmd::Close),
                    "drag" => Some(WinCmd::Drag),
                    _ => None,
                };
                match cmd {
                    Some(cmd) => {
                        win_queue_ipc.borrow_mut().push(cmd);
                        let _ = proxy.send_event(());
                    }
                    None => append_log(&format!("[ipc] 未知窗口命令 oc:win-{raw}\n")),
                }
                return;
            }
            if let Some(url) = body.strip_prefix("oc:open-url:") {
                // 页面里的链接不直接导航：wry 会取消新窗口请求，导航器又只放行本站。
                // 统一交给系统默认浏览器打开。open::that 在 Windows 上会跑 PowerShell
                // 并等它退出（实测 1 秒级），绝不能在这条 IPC 回调（WebView2 UI 线程）里同步调，
                // 否则整个窗口会卡住；失败消息经 failures 队列回主循环下发给页面。
                if !is_allowed_url(url) {
                    append_log(&format!("[ipc] 忽略不支持的链接协议：{url}\n"));
                    return;
                }
                let url = url.to_string();
                let failures = failures_ipc.clone();
                let proxy = proxy.clone();
                std::thread::spawn(move || {
                    if let Err(err) = open::that(&url) {
                        append_log(&format!("[ipc] 打开链接失败：{err}\n"));
                        if let Ok(mut list) = failures.lock() {
                            list.push(format!("open-url-failed:{url}"));
                        }
                        let _ = proxy.send_event(());
                    }
                });
                return;
            }
            if let Some(root) = body.strip_prefix("oc:save-root:") {
                // 记住这次打开的根目录（exe 同目录 root.txt），下次启动经 root:<path> 恢复。
                // 本地端口每次启动都变，localStorage 按 origin 分区跨不了启动，只能落盘。
                append_log(&format!("[ipc] save-root {root}\n"));
                save_root(root);
                return;
            }
            if body == "oc:projects" {
                // 项目清单：页面启动时来要一次，拿到 `projects:<json>`。
                let json = projects::load();
                append_log(&format!("[ipc] 读项目清单 {} 字节\n", json.len()));
                ipc_queue.borrow_mut().push(format!("projects:{json}"));
                let _ = proxy.send_event(());
                return;
            }
            if let Some(json) = body.strip_prefix("oc:projects-save:") {
                // 清单内容由前端负责（增删/排序/每个项目的界面状态），这里只落盘。
                // 记一条带预览的日志：跨项目路径出问题时能直接看出页面到底发了什么。
                let preview: String = json.chars().take(200).collect();
                append_log(&format!(
                    "[ipc] 存项目清单 {} 字节：{preview}\n",
                    json.len()
                ));
                if let Err(err) = projects::save(json) {
                    append_log(&format!("[ipc] 保存项目清单失败：{err}\n"));
                }
                return;
            }
            let kind = if body == "oc:auth" {
                "oc:auth".to_string()
            } else {
                format!("其它({} 字节)", body.len())
            };
            append_log(&format!("[ipc] 收到 {kind}\n"));
            let payload = if body == "oc:auth" {
                // 页面重载（F5 / 渲染进程自愈）会重新握手，所以允许重复索取；
                // 来源已经过上面 ipc_origin 校验。
                token_sent.store(true, Ordering::SeqCst);
                format!("token:{ipc_token}")
            } else if body == "oc:pick-folder" {
                // 文件对话框是阻塞调用，必须回主循环做（还要 COM STA）。
                body.clone()
            } else {
                format!("pong:{body}")
            };
            ipc_queue.borrow_mut().push(payload);
            if body == "oc:auth" {
                // 上次打开的根目录随令牌一起下发；没有保存过就不发。
                if let Some(root) = saved_root() {
                    ipc_queue.borrow_mut().push(format!("root:{root}"));
                }
            }
            let _ = proxy.send_event(());
        });

    // 只有调试版接受 OC_WORKBENCH_DEBUG_PORT：给界面自动化留 CDP 口子。
    // 发布版编译时 cfg(debug_assertions) 为假，整段（含 with_additional_browser_args）
    // 被裁掉——线上二进制里没有任何调试端口。
    #[cfg(debug_assertions)]
    if let Some(args) = debug_browser_args() {
        append_log(&format!("[debug] 开启远程调试：{args}
"));
        builder = builder.with_additional_browser_args(args);
    }

    let webview = builder
        .build(&window)
        .map_err(|e| {
            format!(
                "创建 WebView 失败：{e}\n\n\
                 这台机器上可能缺少 WebView2 运行时（Windows 11 与较新的 Windows 10 自带）。\n\
                 安装后重开本程序即可：\n\
                 https://go.microsoft.com/fwlink/p/?LinkId=2124703"
            )
        })?;
    let webview = Rc::new(webview);

    // 先按窗口当前尺寸对齐一次，resize 时再持续跟随。
    let size = window.inner_size();
    let _ = webview.set_bounds(view_rect(size.width, size.height));

    // 上一次报给页面的最大化状态：只有变化时才 evaluate，避免 resize 期间刷屏。
    let mut last_maximized = false;
    event_loop.run(move |event, _, control_flow| {
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                // 关窗前把用户拖出来的尺寸写回设置，下次启动沿用。
                remember_window_size(&window, initial_logical, auto_logical);
                *control_flow = ControlFlow::Exit;
                return;
            }
            Event::WindowEvent {
                event: WindowEvent::Resized(size),
                ..
            } => {
                // 窗口大小变化时 WebView 不会自己跟，必须手动 set_bounds。
                let _ = webview.set_bounds(view_rect(size.width, size.height));
                // 最大化/还原也会走到这里：顺手把标题栏按钮图标换过来。
                sync_maximized_state(&webview, &window, &mut last_maximized);
            }
            // IPC handler 用 EventLoopProxy 发来的唤醒信号。
            Event::UserEvent(()) => {
                // 窗口命令先处理：拖动要在用户的鼠标还按着的时候立刻进系统拖动循环。
                for cmd in win_queue.borrow_mut().drain(..) {
                    match cmd {
                        WinCmd::Minimize => window.set_minimized(true),
                        WinCmd::ToggleMaximize => window.set_maximized(!window.is_maximized()),
                        WinCmd::Drag => {
                            if let Err(err) = window.drag_window() {
                                append_log(&format!("[ipc] 拖动窗口失败：{err}\n"));
                            }
                        }
                        WinCmd::Close => {
                            remember_window_size(&window, initial_logical, auto_logical);
                            *control_flow = ControlFlow::Exit;
                            return;
                        }
                    }
                }
                sync_maximized_state(&webview, &window, &mut last_maximized);
                drain_ipc(&webview, &pending);
                if let Ok(mut list) = failures.lock() {
                    let items: Vec<String> = list.drain(..).collect();
                    drop(list);
                    for payload in items {
                        let json =
                            serde_json::to_string(&payload).unwrap_or_else(|_| "\"\"".to_string());
                        // 页面可能正在重载/__ocIpc 还没装：记日志，别静默吞掉
                        if let Err(err) = webview.evaluate_script(&format!(
                            "window.__ocIpc && window.__ocIpc({json});"
                        )) {
                            append_log(&format!("[ipc] 下发失败回执失败：{err}\n"));
                        }
                    }
                }
            }
            _ => {}
        }

        *control_flow = ControlFlow::Wait;
    });

    #[allow(unreachable_code)]
    Ok(())
}

/// 调试版的远程调试参数（发布版不编译这段）。
#[cfg(debug_assertions)]
fn debug_browser_args() -> Option<String> {
    let port = std::env::var("OC_WORKBENCH_DEBUG_PORT").ok()?;
    let port = port.trim();
    if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(format!("--remote-debugging-port={port}"))
}

/// 把排队好的 IPC 响应发给页面：`window.__ocIpc('<payload>')`。
/// payload 已经是最终内容（`token:<token>` 或 `pong:<原消息>`）。
fn drain_ipc(webview: &wry::WebView, pending: &Rc<RefCell<Vec<String>>>) {
    let messages: Vec<String> = pending.borrow_mut().drain(..).collect();
    for payload in messages {
        if payload == "oc:pick-folder" {
            // 选文件夹：取消时回 "folder:"，页面据此保持原路径。
            let picked = rfd::FileDialog::new()
                .set_title("选择要打开的文件夹")
                .pick_folder();
            let text = match picked {
                Some(path) => format!("folder:{}", path.display()),
                None => "folder:".to_string(),
            };
            let json = serde_json::to_string(&text).unwrap_or_else(|_| "\"folder:\"".to_string());
            let _ = webview
                .evaluate_script(&format!("window.__ocIpc && window.__ocIpc({json});"));
            continue;
        }
        let json = serde_json::to_string(&payload).unwrap_or_else(|_| "\"\"".to_string());
        let script = format!("window.__ocIpc && window.__ocIpc({json});");
        if let Err(err) = webview.evaluate_script(&script) {
            append_log(&format!("[ipc] evaluate_script 失败：{err}\n"));
        }
    }
}

/// 窗口占显示器宽高的目标比例：四周留白，不顶满屏幕。
const WINDOW_WIDTH_RATIO: f64 = 0.72;
const WINDOW_HEIGHT_RATIO: f64 = 0.74;
/// 逻辑尺寸的舒适区间（按 100% 缩放算）：再小挤成一条，再大看着就像全屏。
/// 1280 宽是这种「侧栏 + 会话 + 编辑区」三栏界面的舒服值，再宽只是空跑。
const WINDOW_MIN_LOGICAL: (f64, f64) = (960.0, 620.0);
const WINDOW_MAX_LOGICAL: (f64, f64) = (1280.0, 840.0);
/// 小屏兜底：算出来多少都不超过显示器逻辑尺寸的这个比例，给任务栏留位置。
const WINDOW_CAP_RATIO: (f64, f64) = (0.90, 0.86);
/// 窗口能缩到的最小逻辑尺寸，和 `with_min_inner_size` 共用一份。
const WINDOW_MIN_PX: (f64, f64) = (800.0, 560.0);
/// settings.json 里记窗口尺寸的键，值形如 `1280x840`（逻辑像素）。
const WINDOW_SIZE_KEY: &str = "windowSize";

/// 首次启动用哪套几何。
struct InitialWindow {
    /// 客户区物理尺寸 / 位置，直接喂给 WindowBuilder。
    physical: (u32, u32),
    position: Option<(i32, i32)>,
    /// 实际采用的逻辑尺寸：关窗时拿它判断用户这次有没有手动拖过。
    logical: (f64, f64),
    /// 当前屏幕下「按分辨率自动」会得到多大：用户拖回这个大小就恢复自动。
    auto: (f64, f64),
}

/// 首次启动的窗口几何：尺寸跟「分辨率 × 缩放率」走，并优先沿用上次拖过的尺寸。
///
/// 尺寸必须跟着显示器变，不能写死逻辑像素：同一块 1080p 屏，100% 时有
/// 1920×1080 逻辑像素，150% 时只剩 1280×720。写死 1400×900 在后者上会超出
/// 屏幕，表现就是一开就占满、底部还被任务栏截掉。
fn initial_window_geometry(event_loop: &EventLoop<()>) -> InitialWindow {
    let Some(monitor) = event_loop.primary_monitor() else {
        // 读不到显示器（远程会话 / 无人值守）：给一档中等尺寸，别沿用大屏尺寸。
        append_log("[boot] 读不到主显示器，窗口用 1200×800\n");
        return InitialWindow {
            physical: (1200, 800),
            position: None,
            logical: (1200.0, 800.0),
            auto: (1200.0, 800.0),
        };
    };
    let monitor_size = monitor.size();
    let scale = normalize_scale(monitor.scale_factor());
    let avail_w = monitor_size.width as f64 / scale;
    let avail_h = monitor_size.height as f64 / scale;

    let auto = comfort_window_logical(avail_w, avail_h);
    let saved = update::text_setting(WINDOW_SIZE_KEY).and_then(|text| parse_window_size(&text));
    let (logical_w, logical_h, source) = match saved {
        // 上次拖过的尺寸优先，但先按当前屏幕夹一次：换小屏 / 调高缩放后不会溢出。
        Some(saved) => {
            let (w, h) = clamp_saved_window(saved, avail_w, avail_h);
            (w, h, "沿用上次拖过的尺寸")
        }
        None => (auto.0, auto.1, "按分辨率自动"),
    };

    let size = (
        (logical_w * scale).round().max(1.0) as u32,
        (logical_h * scale).round().max(1.0) as u32,
    );
    let origin = monitor.position();
    let position = centered_window_position(
        (origin.x, origin.y),
        (monitor_size.width, monitor_size.height),
        size,
    );
    append_log(&format!(
        "[boot] 主显示器 {}×{} @{scale:.2}x（可用 {avail_w:.0}×{avail_h:.0} 逻辑像素）\
         → 窗口 {}×{} 物理像素，位置 {},{}\n",
        monitor_size.width, monitor_size.height, size.0, size.1, position.0, position.1
    ));
    append_log(&format!(
        "[boot] 窗口尺寸来源：{source}（{logical_w:.0}×{logical_h:.0} 逻辑像素）\n"
    ));
    InitialWindow {
        physical: size,
        position: Some(position),
        logical: (logical_w, logical_h),
        auto,
    }
}

/// 缩放率异常（0、NaN、离谱值）时按 1.0 处理，避免除出天文数字。
fn normalize_scale(scale: f64) -> f64 {
    if scale.is_finite() && (0.5..=8.0).contains(&scale) {
        scale
    } else {
        1.0
    }
}

/// 可用逻辑宽高 → 首次启动的窗口逻辑宽高。
///
/// 两步：先按比例取，再夹到舒适区间；最后用小屏上限兜一次，
/// 保证 1366×768、1024×600 这类屏幕不会算出比屏幕还大的窗口。
fn comfort_window_logical(avail_w: f64, avail_h: f64) -> (f64, f64) {
    let avail_w = avail_w.max(1.0);
    let avail_h = avail_h.max(1.0);
    let width = (avail_w * WINDOW_WIDTH_RATIO)
        .clamp(WINDOW_MIN_LOGICAL.0, WINDOW_MAX_LOGICAL.0)
        .min(avail_w * WINDOW_CAP_RATIO.0);
    let height = (avail_h * WINDOW_HEIGHT_RATIO)
        .clamp(WINDOW_MIN_LOGICAL.1, WINDOW_MAX_LOGICAL.1)
        .min(avail_h * WINDOW_CAP_RATIO.1);
    (width, height)
}

/// 在显示器范围内居中；窗口比屏幕还大时贴左上角，不出现负坐标。
fn centered_window_position(
    monitor: (i32, i32),
    monitor_size: (u32, u32),
    window: (u32, u32),
) -> (i32, i32) {
    let dx = (monitor_size.0 as i32 - window.0 as i32) / 2;
    let dy = (monitor_size.1 as i32 - window.1 as i32) / 2;
    (monitor.0 + dx.max(0), monitor.1 + dy.max(0))
}

/// 上次记住的尺寸按当前屏幕夹一次。
///
/// 只做「保命」夹取，不动舒适区间：用户明明拖了一个 1500 宽的窗口，只要屏幕
/// 放得下就继续用；换到小屏或调高缩放后，才收到可用区的 90% / 86%。
fn clamp_saved_window(saved: (f64, f64), avail_w: f64, avail_h: f64) -> (f64, f64) {
    let cap_w = (avail_w.max(1.0) * WINDOW_CAP_RATIO.0).max(1.0);
    let cap_h = (avail_h.max(1.0) * WINDOW_CAP_RATIO.1).max(1.0);
    (
        saved.0.clamp(WINDOW_MIN_PX.0.min(cap_w), cap_w),
        saved.1.clamp(WINDOW_MIN_PX.1.min(cap_h), cap_h),
    )
}

/// 解析 `1280x840`（逻辑像素）。坏值、离谱值一律当没存：
/// 手改坏设置不该让窗口飞到屏幕外面去。
fn parse_window_size(text: &str) -> Option<(f64, f64)> {
    let (w, h) = text.trim().split_once(['x', 'X'])?;
    let w: f64 = w.trim().parse().ok()?;
    let h: f64 = h.trim().parse().ok()?;
    if !(w.is_finite() && h.is_finite()) || w <= 0.0 || h <= 0.0 || w > 10000.0 || h > 10000.0 {
        return None;
    }
    Some((w, h))
}

fn format_window_size(logical: (f64, f64)) -> String {
    format!("{}x{}", logical.0.round() as i64, logical.1.round() as i64)
}

/// 用户这次到底有没有手动拖过窗口？
///
/// 和启动时采用的尺寸差 4px 以内就算没动（贴边吸附、DPI 取整都会抖几像素）。
fn should_remember_window(current: (f64, f64), initial: (f64, f64)) -> bool {
    (current.0 - initial.0).abs() > 4.0 || (current.1 - initial.1).abs() > 4.0
}

/// 关窗时对窗口尺寸记忆做什么。
#[derive(Debug, PartialEq)]
enum WindowMemory {
    /// 不写盘：用户没拖过。
    Skip,
    /// 用户把窗口拖回了「自动尺寸」：删掉记忆，下次继续按屏幕算。
    Clear,
    /// 记住这次的尺寸。
    Save,
}

fn window_memory_decision(
    current: (f64, f64),
    initial: (f64, f64),
    auto: (f64, f64),
) -> WindowMemory {
    if !should_remember_window(current, initial) {
        return WindowMemory::Skip;
    }
    if !should_remember_window(current, auto) {
        return WindowMemory::Clear;
    }
    WindowMemory::Save
}

/// 前端自绘标题栏发来的窗口命令。只允许这四件事，页面拿不到任意窗口操作。
#[derive(Clone, Copy)]
enum WinCmd {
    Minimize,
    ToggleMaximize,
    Close,
    Drag,
}

/// 最大化状态变化时告诉页面，前端据此在「最大化」和「还原」图标之间切换。
fn sync_maximized_state(
    webview: &wry::WebView,
    window: &tao::window::Window,
    last: &mut bool,
) {
    let maxed = window.is_maximized();
    if maxed == *last {
        return;
    }
    *last = maxed;
    let _ = webview.evaluate_script(&format!(
        "window.__ocWinState && window.__ocWinState({maxed});"
    ));
}

/// 关窗时记住用户拖出来的尺寸，下次启动沿用（再按当时屏幕夹一次）。
///
/// 三个分支：
///   * 和启动尺寸一样 → 没拖过，不写：否则自动算出来的值会被固化成选择，
///     换了分辨率也永远不会再自动适配；
///   * 拖回了当前屏幕的自动尺寸 → 视作「恢复自动」，删掉记忆；
///   * 其它 → 记住。
///
/// 最大化 / 全屏直接跳过：记下来等于屏幕尺寸，下次启动又会「一开就占满」。
fn remember_window_size(window: &tao::window::Window, initial: (f64, f64), auto: (f64, f64)) {
    if window.is_maximized() || window.fullscreen().is_some() {
        return;
    }
    let scale = normalize_scale(window.scale_factor());
    let size = window.inner_size();
    let logical = (size.width as f64 / scale, size.height as f64 / scale);
    match window_memory_decision(logical, initial, auto) {
        WindowMemory::Skip => {}
        WindowMemory::Clear => match update::set_text_setting(WINDOW_SIZE_KEY, None) {
            Ok(()) => append_log("[boot] 窗口拖回自动尺寸，清掉记忆\n"),
            Err(err) => append_log(&format!("[boot] 清除窗口尺寸记忆失败：{err}\n")),
        },
        WindowMemory::Save => {
            let text = format_window_size(logical);
            match update::set_text_setting(WINDOW_SIZE_KEY, Some(&text)) {
                Ok(()) => append_log(&format!("[boot] 记住窗口尺寸 {text}（逻辑像素）\n")),
                Err(err) => append_log(&format!("[boot] 记住窗口尺寸失败：{err}\n")),
            }
        }
    }
}

fn view_rect(width: u32, height: u32) -> Rect {
    Rect {
        position: Position::Physical(PhysicalPosition::new(0, 0)),
        size: Size::Physical(PhysicalSize::new(width.max(1), height.max(1))),
    }
}

const ROOT_NAME: &str = "root.txt";

/// 主存储位置：%LOCALAPPDATA%\\oc-workbench\\root.txt。
/// exe 可能装在 Program Files 等只读目录，所以主位置不放 exe 旁边。
fn root_file() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    let dir = base.join("oc-workbench");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join(ROOT_NAME))
}

/// 上次打开的根目录：先读 %LOCALAPPDATA%，再回退 exe 同目录（老版本留下的）。
/// 目录已不存在时返回 None，页面就不会被拉到一个失效路径。
fn saved_root() -> Option<String> {
    let mut candidates = Vec::new();
    if let Some(path) = root_file() {
        candidates.push(path);
    }
    if let Some(path) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(ROOT_NAME)))
    {
        candidates.push(path);
    }
    for path in candidates {
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        let trimmed = text.trim().to_string();
        if !trimmed.is_empty() && std::path::Path::new(&trimmed).is_dir() {
            return Some(trimmed);
        }
    }
    None
}

/// 协议白名单（大小写不敏感：页面传来 HTTPS:// 也要认）。
fn is_allowed_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
}

fn save_root(root: &str) {
    let mut saved = false;
    if let Some(path) = root_file() {
        saved = std::fs::write(&path, root).is_ok();
    }
    if !saved {
        if let Some(dir) = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|d| d.to_path_buf()))
        {
            saved = std::fs::write(dir.join(ROOT_NAME), root).is_ok();
        }
    }
    if !saved {
        append_log(&format!("[ipc] 保存根目录失败（root.txt 不可写）：{root}\n"));
    }
}

/// 日志落点：优先 `%LOCALAPPDATA%\oc-workbench\gui-error.log`。
///
/// 不能只写 exe 同目录：装到 Program Files、或从只读盘/U 盘运行时写不进去，
/// 出问题就一条线索都没有。exe 同目录只作兜底（绿色版、LOCALAPPDATA 不可用时）。
fn log_path() -> PathBuf {
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        let dir = PathBuf::from(base).join("oc-workbench");
        if std::fs::create_dir_all(&dir).is_ok() {
            return dir.join(LOG_NAME);
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(LOG_NAME)))
        .unwrap_or_else(|| PathBuf::from(LOG_NAME))
}

fn append_log(text: &str) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = file.write_all(format!("[{stamp}] {text}").as_bytes());
        let _ = file.flush();
    }
}

/// panic=abort 时崩溃没有任何痕迹，钩子必须在 abort 之前把现场写盘。
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let message = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "<非字符串 panic>".to_string()
        };
        append_log(&format!("[panic] {location}\n{message}\n"));
        show_fatal_dialog(&format!(
            "OpenCode 工作台发生崩溃：\n{message}\n位置：{location}\n\n日志：{}",
            log_path().display()
        ));
    }));
}

#[cfg(windows)]
fn show_fatal_dialog(message: &str) {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut std::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            utype: u32,
        ) -> i32;
    }
    let text = wide(message);
    let caption = wide(APP_TITLE);
    unsafe {
        // MB_OK | MB_ICONERROR
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), 0x10);
    }
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

#[cfg(not(windows))]
fn show_fatal_dialog(message: &str) {
    eprintln!("{message}");
}

#[cfg(test)]
#[path = "window_tests.rs"]
mod window_tests;
