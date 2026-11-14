//! 项目清单的 HTTP 通道（远程访问 / 浏览器用）。
//!
//! 外壳版本走 IPC（`oc:projects` / `oc:projects-save:`），但浏览器里没有 IPC 桥，
//! 所以给一条等价的路由。鉴权已经在 `server.rs` 的 `/local/*` 分支统一做过
//! （`x-oc-token` 或登录 cookie）。
//!
//! 读写规则与 IPC 完全一致：外壳只当存储，前端负责去重/排序/界面状态。

use tiny_http::{Method, Request};

use crate::body::{read_body_with_timeout, BodyRead};
use crate::projects;

/// 处理 `/local/projects`：GET 读、POST 写。
pub fn handle(request: Request) {
    match request.method() {
        Method::Get => {
            let body = projects::load();
            let _ = crate::server::respond_json(request, 200, body);
        }
        Method::Post => write(request),
        _ => {
            let _ = crate::server::respond_json(
                request,
                405,
                "{\"error\":\"只支持 GET 和 POST\"}".to_string(),
            );
        }
    }
}

fn write(request: Request) {
    // 必须带超时：裸 read 会让慢速客户端长期占住一个并发名额。
    // 其它 handler 都走这个 helper，行为保持一致。
    let Some((request, result)) = read_body_with_timeout(request, projects::MAX_BYTES) else {
        // 超时：Request 还留在读线程里，这里直接放弃（连接不复用）。
        return;
    };

    let body = match result {
        BodyRead::Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => {
                let _ = crate::server::respond_json(
                    request,
                    400,
                    "{\"error\":\"清单必须是 UTF-8 文本\"}".to_string(),
                );
                return;
            }
        },
        BodyRead::TooLarge => {
            let _ = crate::server::respond_json(
                request,
                413,
                "{\"error\":\"清单太大（超过 1 MB）\"}".to_string(),
            );
            return;
        }
        BodyRead::Failed(err) => {
            let _ = crate::server::respond_json(
                request,
                400,
                format!("{{\"error\":\"读取请求体失败：{err}\"}}"),
            );
            return;
        }
    };

    match projects::save(&body) {
        Ok(()) => {
            let _ = crate::server::respond_json(request, 200, "{\"ok\":true}".to_string());
        }
        Err(err) => {
            let escaped = err.replace('\\', "\\\\").replace('"', "\\\"");
            let _ = crate::server::respond_json(
                request,
                500,
                format!("{{\"error\":\"{escaped}\"}}"),
            );
        }
    }
}
