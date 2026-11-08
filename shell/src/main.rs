// OpenCode 工作台 —— Rust 桌面外壳（tao + wry / WebView2）
//
// 职责边界：
//   * 开一个无控制台窗口，加载内嵌前端（dist）并通过本地 HTTP 服务代理 opencode API。
//   * 找不到 opencode 服务时回退到 Vite dev 地址（OC_WORKBENCH_URL 可覆盖），方便开发。
//   * IPC 只做最小验证：页面 window.ipc.postMessage('ping')
//     → 外壳 evaluate_script 回显 window.__ocIpc('pong:ping')。
#![windows_subsystem = "windows"]

mod auth;
mod server;

use std::cell::RefCell;
use std::ffi::OsStr;
use std::io::Write;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tao::dpi::LogicalSize;
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::WindowBuilder;
use wry::dpi::{PhysicalPosition, PhysicalSize, Position, Size};
use wry::{Rect, WebViewBuilder};

const APP_TITLE: &str = "OpenCode 工作台";
const DEV_URL: &str = "http://127.0.0.1:5273";
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

/// 优先自包含启动：内嵌前端 + 本地代理。失败则回退到 dev 地址。
fn resolve_url() -> String {
    if let Ok(url) = start_local() {
        append_log(&format!("[boot] 自包含模式：{url}\n"));
        return url;
    }

    let fallback = std::env::var(URL_ENV).unwrap_or_else(|_| DEV_URL.to_string());
    append_log(&format!("[boot] 回退到 {fallback}\n"));
    fallback
}

fn start_local() -> Result<String, String> {
    // discover 现在返回具体失败原因（命令/退出码/stderr 片段），落盘方便排查。
    let backend = match auth::discover() {
        Ok(backend) => backend,
        Err(err) => {
            append_log(&format!("[auth] {err}\n"));
            return Err(err);
        }
    };
    // token 每次启动随机生成，只注入页面，不落盘、不写日志。
    let token = server::new_token();
    let port = server::start(server::Ctx {
        base: backend.base,
        cookie: backend.cookie,
        token,
        port: 0,
    })?;
    append_log(&format!("[boot] 本地服务端口 {port}，已注入 x-oc-token\n"));
    Ok(format!("http://127.0.0.1:{port}/"))
}

fn run() -> Result<(), String> {
    let event_loop = EventLoop::new();

    let window = WindowBuilder::new()
        .with_title(APP_TITLE)
        .with_inner_size(LogicalSize::new(1400.0, 900.0))
        .with_min_inner_size(LogicalSize::new(800.0, 560.0))
        .build(&event_loop)
        .map_err(|e| format!("创建窗口失败：{e}"))?;

    let url = resolve_url();

    // IPC 回调里只入队，真正回发统一在事件循环主循环做（WebView2 消息泵没转时脚本会被丢）。
    let pending: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
    let ipc_queue = pending.clone();

    let webview = WebViewBuilder::new()
        .with_url(&url)
        .with_ipc_handler(move |request: wry::http::Request<String>| {
            ipc_queue.borrow_mut().push(request.body().clone());
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
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) | Event::MainEventsCleared => {
                drain_ipc(&webview, &pending);
            }
            _ => {}
        }

        // WebView 的 IPC 消息不一定产生 tao 事件，靠定时唤醒保证回显不被饿死。
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(50));
    });

    #[allow(unreachable_code)]
    Ok(())
}

/// 把排队的 IPC 消息回显给页面：window.__ocIpc('pong:<原消息>')。
fn drain_ipc(webview: &wry::WebView, pending: &Rc<RefCell<Vec<String>>>) {
    let messages: Vec<String> = pending.borrow_mut().drain(..).collect();
    for message in messages {
        let payload = format!("pong:{message}");
        let json = serde_json::to_string(&payload).unwrap_or_else(|_| "\"pong:\"".to_string());
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
