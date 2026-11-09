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
mod server;
mod proxy;
mod static_files;

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::ffi::OsStr;
use std::io::Write;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::WindowBuilder;
use wry::dpi::{PhysicalPosition, PhysicalSize, Position, Size};
use wry::{Rect, WebViewBuilder};

const APP_TITLE: &str = "OpenCode 工作台";
const URL_ENV: &str = "OC_WORKBENCH_URL";
const LOG_NAME: &str = "gui-error.log";

fn main() {
    install_panic_hook();
    init_com_sta();

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
    let port = server::start(server::Ctx {
        backend: backend.clone(),
        token: token.to_string(),
        port: 0,
    })?;
    server::spawn_bootstrap(backend);
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

    let window = WindowBuilder::new()
        .with_title(APP_TITLE)
        .with_inner_size(LogicalSize::new(1400.0, 900.0))
        .with_min_inner_size(LogicalSize::new(800.0, 560.0))
        .build(&event_loop)
        .map_err(|e| format!("创建窗口失败：{e}"))?;

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
    let ipc_token = token.clone();
    let proxy = event_loop.create_proxy();

    let local_origin = url.trim_end_matches('/').to_string();
    let nav_origin = local_origin.clone();
    let ipc_origin = local_origin.clone();
    let token_sent = Arc::new(AtomicBool::new(false));

    let webview = WebViewBuilder::new()
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
            if let Some(url) = body.strip_prefix("oc:open-url:") {
                // 页面里的链接不直接导航：wry 会取消新窗口请求，导航器又只放行本站。
                // 统一交给系统默认浏览器打开，协议白名单在 open_external 里。
                open_external(url);
                return;
            }
            if let Some(root) = body.strip_prefix("oc:save-root:") {
                // 记住这次打开的根目录（exe 同目录 root.txt），下次启动经 root:<path> 恢复。
                // 本地端口每次启动都变，localStorage 按 origin 分区跨不了启动，只能落盘。
                save_root(root);
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
        })
        .build(&window)
        .map_err(|e| format!("创建 WebView 失败（确认已安装 WebView2 运行时）：{e}"))?;
    let webview = Rc::new(webview);

    // 先按窗口当前尺寸对齐一次，resize 时再持续跟随。
    let size = window.inner_size();
    let _ = webview.set_bounds(view_rect(size.width, size.height));

    event_loop.run(move |event, _, control_flow| {
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                *control_flow = ControlFlow::Exit;
                return;
            }
            Event::WindowEvent {
                event: WindowEvent::Resized(size),
                ..
            } => {
                // 窗口大小变化时 WebView 不会自己跟，必须手动 set_bounds。
                let _ = webview.set_bounds(view_rect(size.width, size.height));
            }
            // IPC handler 用 EventLoopProxy 发来的唤醒信号。
            Event::UserEvent(()) => drain_ipc(&webview, &pending),
            _ => {}
        }

        *control_flow = ControlFlow::Wait;
    });

    #[allow(unreachable_code)]
    Ok(())
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

/// 用系统默认程序打开 http/https/mailto 链接；其它协议一律忽略（防注入）。
fn open_external(url: &str) {
    let allowed = url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("mailto:");
    if !allowed {
        append_log(&format!("[ipc] 忽略不支持的链接协议：{url}\n"));
        return;
    }
    if let Err(err) = open::that(url) {
        append_log(&format!("[ipc] 打开链接失败：{err}\n"));
    }
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

fn log_path() -> PathBuf {
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
