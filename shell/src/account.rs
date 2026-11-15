//! 账号会话的本地持久化。
//!
//! 为什么不用 localStorage：那是 WebView2 的数据目录，清缓存/重装 exe/换 profile
//! 都会丢，用户就得一次次重输密码。这里落到 `%LOCALAPPDATA%\oc-workbench\account.json`，
//! 和 projects.json / settings.json 同级，重装 exe 也还在。
//!
//! 接口（都在 /local/ 下，走本地通道，token 已由 server.rs 校验过）：
//!   GET    /local/account/session  → 200 + 文件内容 / 404 表示没有
//!   POST   /local/account/session  → 覆盖写入
//!   DELETE /local/account/session  → 删除（退出登录）

use std::path::PathBuf;

use tiny_http::{Request, Response};

fn session_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    Some(base.join("oc-workbench").join("account.json"))
}

fn respond_json(request: Request, status: u16, body: String) {
    let response = Response::from_string(body)
        .with_status_code(status)
        .with_header(
            tiny_http::Header::from_bytes(&b"content-type"[..], &b"application/json; charset=utf-8"[..])
                .expect("content-type 头构造失败"),
        )
        .with_header(
            tiny_http::Header::from_bytes(&b"cache-control"[..], &b"no-store"[..])
                .expect("cache-control 头构造失败"),
        );
    let _ = request.respond(response);
}

/// 本机身份：设备 ID（remoteBase 里那段）+ 显示名 + remoteToken。
///
/// 给「登录后自动认领本机」用：前端拿它去调网关 /portal/api/claim，
/// 这台电脑就自动出现在该账号的设备列表里，不用再跑 pair.ps1 拿配对码。
fn device_json() -> String {
    let base = crate::remote_auth::remote_base();
    let id = base.trim_start_matches("/u/").trim_end_matches('/').to_string();
    let token = crate::remote_auth::cached_token().to_string();
    let name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "这台电脑".to_string());
    // 简单转义：名字里一般不会有引号，但别让配置把 JSON 弄坏
    let safe = |v: &str| v.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        "{{\"id\":\"{}\",\"name\":\"{}\",\"token\":\"{}\"}}",
        safe(&id),
        safe(&name),
        safe(&token)
    )
}

pub fn handle(mut request: Request, path: &str, _url: &str) {
    // 本机身份（只读）
    if path.ends_with("/device") {
        respond_json(request, 200, device_json());
        return;
    }
    // 隧道：GET 查状态（界面用来显示「为什么没连上」），POST 交回环端口。
    // 端口是登录认领时网关给的，页面转手存到这里，exe 随即重建隧道。
    if path.ends_with("/tunnel") {
        if request.method().as_str() == "GET" {
            respond_json(request, 200, crate::tunnel::status_json());
            return;
        }
        if request.method().as_str() != "POST" {
            respond_json(request, 405, "{\"error\":\"只支持 GET / POST\"}".to_string());
            return;
        }
        let mut body = String::new();
        if let Err(err) = request.as_reader().read_to_string(&mut body) {
            respond_json(request, 400, format!("{{\"error\":\"读取失败：{err}\"}}"));
            return;
        }
        let port = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("relayPort").and_then(|p| p.as_i64()))
            .unwrap_or(0);
        if port <= 0 || port > 65535 {
            respond_json(request, 400, "{\"error\":\"relayPort 不合法\"}".to_string());
            return;
        }
        match crate::update::set_number_setting("relayPort", Some(port)) {
            Ok(()) => {
                // 立即生效：不等下次启动。
                crate::tunnel::apply(0);
                respond_json(request, 200, "{\"ok\":true}".to_string())
            }
            Err(_) => respond_json(request, 500, "{\"error\":\"写入设置失败\"}".to_string()),
        }
        return;
    }
    // 网关地址（前端 setGatewayUrl 时同步过来；导航白名单要用）
    if path.ends_with("/gateway") {
        if request.method().as_str() != "POST" {
            respond_json(request, 405, "{\"error\":\"只支持 POST\"}".to_string());
            return;
        }
        let mut body = String::new();
        if let Err(err) = request.as_reader().read_to_string(&mut body) {
            respond_json(request, 400, format!("{{\"error\":\"读取失败：{err}\"}}"));
            return;
        }
        let url = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(str::to_string))
            .unwrap_or_default();
        match crate::update::save_gateway_url(&url) {
            Ok(()) => respond_json(request, 200, "{\"ok\":true}".to_string()),
            Err(_) => respond_json(request, 500, "{\"error\":\"写入设置失败\"}".to_string()),
        }
        return;
    }
    let Some(path) = session_path() else {
        respond_json(request, 500, "{\"error\":\"找不到 LOCALAPPDATA\"}".to_string());
        return;
    };
    let method = request.method().as_str().to_string();

    match method.as_str() {
        "GET" => match std::fs::read_to_string(&path) {
            Ok(text) => respond_json(request, 200, text),
            Err(_) => respond_json(request, 404, "{}".to_string()),
        },
        "POST" => {
            let mut body = String::new();
            if let Err(err) = request.as_reader().read_to_string(&mut body) {
                respond_json(request, 400, format!("{{\"error\":\"读取失败：{err}\"}}"));
                return;
            }
            // 只接受 JSON 对象，防止把任意内容写进文件
            if !body.trim_start().starts_with('{') {
                respond_json(request, 400, "{\"error\":\"需要 JSON 对象\"}".to_string());
                return;
            }
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            match std::fs::write(&path, body.as_bytes()) {
                Ok(()) => respond_json(request, 200, "{\"ok\":true}".to_string()),
                Err(err) => respond_json(request, 500, format!("{{\"error\":\"写入失败：{err}\"}}")),
            }
        }
        "DELETE" => {
            let _ = std::fs::remove_file(&path);
            respond_json(request, 200, "{\"ok\":true}".to_string());
        }
        _ => respond_json(request, 405, "{\"error\":\"不支持的方法\"}".to_string()),
    }
}
