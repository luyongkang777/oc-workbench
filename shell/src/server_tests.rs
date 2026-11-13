//! `server` 模块的单元测试：token 不外泄、Host 精确匹配、后端不可用时 502 JSON、
//! 大响应保留 Content-Length、重连端点的入口约束。
//!
//! 全部走真实 loopback 端口，不 mock（tiny_http 起在 127.0.0.1:0，测试完进程退出即回收）。
//! 注意：**不要**在测试里真正触发 `auth::discover()`（会执行 opencode 子命令、写真实配对链接）。

use std::io::{Read as _, Write as _};
use std::net::TcpStream;
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::Duration;

use super::{start, Ctx};
use crate::auth::Backend;
use crate::static_files::DIST;

fn start_test_server(base: Option<String>, token: &str) -> u16 {
    let backend = base.map(|base| Backend {
        base,
        cookie: String::new(),
    });
    start(Ctx {
        backend: Arc::new(RwLock::new(backend)),
        token: token.to_string(),
        port: 0,
        last_error: Arc::new(Mutex::new(None)),
    })
    .expect("本地服务应能启动")
}

/// 带「最近一次失败原因」启动：测 `GET /api/state` 的断开态。
fn start_test_server_with_error(token: &str, error: Option<&str>) -> u16 {
    start(Ctx {
        backend: Arc::new(RwLock::new(None)),
        token: token.to_string(),
        port: 0,
        last_error: Arc::new(Mutex::new(error.map(|text| text.to_string()))),
    })
    .expect("本地服务应能启动")
}

/// 原始 TCP 请求：ureq 不允许改 Host / 加任意头，测精确匹配只能自己拼报文。
fn raw_request(
    port: u16,
    method: &str,
    host: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("连本地服务失败");
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).expect("写请求失败");
    let mut out = Vec::new();
    stream.read_to_end(&mut out).expect("读响应失败");
    String::from_utf8_lossy(&out).to_string()
}

fn raw_get(port: u16, host: &str, path: &str) -> String {
    raw_request(port, "GET", host, path, &[])
}

/// 递归找第一个超过 `min` 字节的内嵌文件，返回（相对路径, 长度）。
fn find_large_file(dir: &include_dir::Dir<'_>, min: usize) -> Option<(String, usize)> {
    for file in dir.files() {
        let len = file.contents().len();
        if len > min {
            return Some((file.path().to_string_lossy().replace('\\', "/"), len));
        }
    }
    for sub in dir.dirs() {
        if let Some(found) = find_large_file(sub, min) {
            return Some(found);
        }
    }
    None
}

#[test]
fn index_html_contains_no_token() {
    let file = DIST.get_file("index.html").expect("dist/index.html 必须在构建产物里");
    let text = String::from_utf8_lossy(file.contents());
    assert!(!text.contains("__OC_TOKEN"), "index.html 不许出现 token 注入点");
    let contains_hex32 = text
        .as_bytes()
        .windows(32)
        .any(|window| window.iter().all(|byte| byte.is_ascii_hexdigit()));
    assert!(!contains_hex32, "index.html 里不许出现 32 位 hex token");
}

#[test]
fn api_without_token_is_403() {
    let port = start_test_server(None, "unit-test-token");
    let raw = raw_get(port, &format!("127.0.0.1:{port}"), "/api/info");
    assert!(raw.starts_with("HTTP/1.1 403"), "实际响应：{raw}");

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(5))
        .build();
    let err = agent
        .get(&format!("http://127.0.0.1:{port}/api/info"))
        .set("x-oc-token", "wrong")
        .call()
        .expect_err("错误 token 必须被拒");
    match err {
        ureq::Error::Status(403, _) => {}
        other => panic!("期望 403，实际 {other:?}"),
    }
}

#[test]
fn api_with_token_but_no_backend_is_502_json() {
    let token = "unit-test-token";
    let port = start_test_server(None, token);
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(5))
        .build();
    let err = agent
        .get(&format!("http://127.0.0.1:{port}/api/info"))
        .set("x-oc-token", token)
        .call()
        .expect_err("后端不可用时必须是 502");
    match err {
        ureq::Error::Status(502, resp) => {
            let content_type = resp.header("content-type").unwrap_or("");
            assert!(
                content_type.contains("application/json"),
                "502 必须是 JSON，实际 {content_type}"
            );
            let mut text = String::new();
            resp.into_reader()
                .read_to_string(&mut text)
                .expect("读 502 响应体失败");
            let body: serde_json::Value =
                serde_json::from_str(&text).expect("响应体必须是合法 JSON");
            assert!(body.get("error").is_some(), "JSON 里要有 error 字段：{body}");
        }
        other => panic!("期望 502，实际 {other:?}"),
    }
}

#[test]
fn host_must_match_exactly() {
    let port = start_test_server(None, "unit-test-token");
    let ok = raw_get(port, &format!("127.0.0.1:{port}"), "/");
    assert!(ok.starts_with("HTTP/1.1 200"), "正常 Host 应放行：{ok}");

    let suffix = raw_get(port, &format!("127.0.0.1:{port}.evil.tld"), "/");
    assert!(
        suffix.starts_with("HTTP/1.1 403"),
        "带后缀的 Host 必须拒：{suffix}"
    );

    let port_suffix = raw_get(port, &format!("localhost:{port}0"), "/");
    assert!(
        port_suffix.starts_with("HTTP/1.1 403"),
        "端口后缀必须拒：{port_suffix}"
    );
}

/// 重连端点同样是 `/api/*`：没有 token 必须 403，且不会触发任何 discover。
#[test]
fn reconnect_requires_token() {
    let port = start_test_server(None, "unit-test-token");
    let raw = raw_get(port, &format!("127.0.0.1:{port}"), "/api/reconnect");
    assert!(
        raw.starts_with("HTTP/1.1 403"),
        "无 token 的重连必须 403：{raw}"
    );
}

/// 只接受 POST：GET 直接 405（在校验方法之后才跑 discover，所以测试是快的）。
#[test]
fn reconnect_rejects_non_post() {
    let token = "unit-test-token";
    let port = start_test_server(None, token);
    let raw = raw_request(
        port,
        "GET",
        &format!("127.0.0.1:{port}"),
        "/api/reconnect",
        &[("x-oc-token", token)],
    );
    assert!(
        raw.starts_with("HTTP/1.1 405"),
        "GET /api/reconnect 必须 405：{raw}"
    );
}

/// 上游返回 40KB + 明确 Content-Length 时，代理必须原样保留长度（不能再变 chunked）。
#[test]
fn proxy_keeps_content_length_for_large_response() {
    let upstream = tiny_http::Server::http("127.0.0.1:0").expect("假上游应能启动");
    let upstream_port = upstream
        .server_addr()
        .to_ip()
        .expect("假上游没有 IP")
        .port();
    thread::spawn(move || {
        for request in upstream.incoming_requests() {
            let header = tiny_http::Header::from_bytes(&b"content-type"[..], &b"text/plain"[..])
                .expect("content-type 头构造失败");
            let response = tiny_http::Response::from_data(vec![b'x'; 40_000])
                .with_header(header)
                .with_chunked_threshold(usize::MAX);
            let _ = request.respond(response);
        }
    });

    let token = "unit-test-token";
    let port = start_test_server(Some(format!("http://127.0.0.1:{upstream_port}")), token);
    let raw = raw_request(
        port,
        "GET",
        &format!("127.0.0.1:{port}"),
        "/api/big",
        &[("x-oc-token", token)],
    );
    let lower = raw.to_ascii_lowercase();
    assert!(
        lower.contains("content-length: 40000"),
        "40KB 响应必须带 content-length：{}",
        &lower[..lower.len().min(400)]
    );
    assert!(
        !lower.contains("transfer-encoding: chunked"),
        "有明确长度时不能再改 chunked"
    );
}

/// dist 里的静态大文件（JS 有 100KB+）也必须带 Content-Length。
#[test]
fn large_static_file_keeps_content_length() {
    let Some((rel, len)) = find_large_file(&DIST, 40_000) else {
        // dist 里没有大文件就跳过（不影响其它断言）
        return;
    };
    let port = start_test_server(None, "unit-test-token");
    let raw = raw_get(port, &format!("127.0.0.1:{port}"), &format!("/{rel}"));
    let lower = raw.to_ascii_lowercase();
    assert!(
        lower.contains(&format!("content-length: {len}")),
        "静态文件 {rel} 必须带 content-length: {len}；实际头部：{}",
        &lower[..lower.len().min(400)]
    );
    assert!(
        !lower.contains("transfer-encoding: chunked"),
        "静态文件不应改 chunked"
    );
}

/// `/local/*` 和 `/api/*` 用同一道 token 门禁：没 token 直接 403，不能读盘。
#[test]
fn local_api_requires_token() {
    let token = "unit-test-local-token";
    let port = start_test_server(None, token);
    let host = format!("127.0.0.1:{port}");
    let resp = raw_get(port, &host, "/local/fs/stat?root=C%3A%5C&path=x");
    assert!(
        resp.starts_with("HTTP/1.1 403"),
        "无 token 必须 403：{}",
        &resp[..resp.len().min(200)]
    );
}

/// 带 token 走一遍真实的 list/stat/read：验证路由、参数解析与 JSON 形状。
#[test]
fn local_api_list_and_read_roundtrip() {
    let token = "unit-test-local-token";
    let dir = std::env::temp_dir().join(format!("ocwb-route-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("建临时目录");
    std::fs::write(dir.join("hello.txt"), b"first\nsecond\n").expect("写文件");

    let port = start_test_server(None, token);
    let host = format!("127.0.0.1:{port}");
    let slash = char::from(92u8);
    let root = dir.to_string_lossy().replace(slash, "%5C").replace(':', "%3A");
    let headers = [("x-oc-token", token)];

    let list = raw_request(
        port,
        "GET",
        &host,
        &format!("/local/fs/list?root={root}&path="),
        &headers,
    );
    assert!(list.starts_with("HTTP/1.1 200"), "list 应 200：{}", &list[..list.len().min(200)]);
    assert!(list.contains("hello.txt"), "list 里应有 hello.txt");

    let stat = raw_request(
        port,
        "GET",
        &host,
        &format!("/local/fs/stat?root={root}&path=hello.txt"),
        &headers,
    );
    assert!(stat.contains("\"lineCount\":2"), "stat 行数应为 2：{}", &stat[..stat.len().min(300)]);

    let read = raw_request(
        port,
        "GET",
        &host,
        &format!("/local/fs/read?root={root}&path=hello.txt&start=1&lines=1"),
        &headers,
    );
    assert!(read.contains("second"), "read 应返回第二行：{}", &read[..read.len().min(300)]);

    // 越界路径必须 400，且不能真的读到 C:\ 上的东西
    let escape = raw_request(
        port,
        "GET",
        &host,
        &format!("/local/fs/read?root={root}&path=..%5C%5Cwindows%5Cwin.ini&start=0&lines=1"),
        &headers,
    );
    assert!(escape.starts_with("HTTP/1.1 400"), "越界必须 400：{}", &escape[..escape.len().min(200)]);

    let _ = std::fs::remove_dir_all(&dir);
}

/// `/local/git/*` 必须由 gitapi 接管（不是 fsapi），并且 token / 方法 / 参数校验都在。
#[test]
fn local_git_status_routes_to_gitapi() {
    let token = "unit-test-local-token";
    let dir = std::env::temp_dir().join(format!("ocwb-git-route-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("建临时目录");

    let port = start_test_server(None, token);
    let host = format!("127.0.0.1:{port}");
    let slash = char::from(92u8);
    let root = dir.to_string_lossy().replace(slash, "%5C").replace(':', "%3A");
    let headers = [("x-oc-token", token)];

    // 没初始化也要 200，且给的是 status 结构（不是 fsapi 的「未知接口」）
    let status = raw_request(
        port,
        "GET",
        &host,
        &format!("/local/git/status?root={root}"),
        &headers,
    );
    assert!(
        status.starts_with("HTTP/1.1 200"),
        "未初始化也应 200：{}",
        &status[..status.len().min(200)]
    );
    assert!(status.contains("\"initialized\":"), "应是 status 结构：{}", &status[..status.len().min(300)]);
    assert!(!status.contains("未知的本地文件接口"), "不能被 fsapi 吃掉");

    // 缺 root → 400
    let missing = raw_request(port, "GET", &host, "/local/git/status", &headers);
    assert!(missing.starts_with("HTTP/1.1 400"), "缺 root 必须 400");

    // 方法不对 → 405
    let wrong_method = raw_request(port, "POST", &host, &format!("/local/git/status?root={root}"), &headers);
    assert!(wrong_method.starts_with("HTTP/1.1 405"), "GET 接口不收 POST");

    // 没有 token → 403（沿用 /local 的统一校验）
    let no_token = raw_get(port, &host, &format!("/local/git/status?root={root}"));
    assert!(no_token.starts_with("HTTP/1.1 403"), "缺 token 必须 403");

    let _ = std::fs::remove_dir_all(&dir);
}

/// `GET /api/state`：断开态把「为什么没连上」直接给页面；不需要用户先点重试。
#[test]
fn state_endpoint_reports_error_without_auth_attempt() {
    let token = "t-state";
    let port = start_test_server_with_error(token, Some("找不到 `opencode` 命令。"));
    let host = format!("127.0.0.1:{port}");
    let headers = [("x-oc-token", token)];

    let body = raw_request(port, "GET", &host, "/api/state", &headers);
    assert!(body.starts_with("HTTP/1.1 200"), "应 200：{}", &body[..body.len().min(200)]);
    assert!(body.contains("\"connected\":false"), "断开态应报 connected=false：{body}");
    assert!(body.contains("找不到"), "要把失败原因带给页面：{body}");
    assert!(body.contains("opencode"));

    // 连上后既没有 error，也带 base
    let port2 = start_test_server(Some("http://127.0.0.1:28894".to_string()), token);
    let host2 = format!("127.0.0.1:{port2}");
    let body2 = raw_request(port2, "GET", &host2, "/api/state", &[("x-oc-token", token)]);
    assert!(body2.contains("\"connected\":true"), "{body2}");
    assert!(body2.contains("28894"), "{body2}");

    // 没有 token → 403（和 /api/* 同一道门禁）
    let denied = raw_get(port, &host, "/api/state");
    assert!(denied.starts_with("HTTP/1.1 403"), "缺 token 必须 403");

    // 只读接口不收 POST
    let wrong = raw_request(port, "POST", &host, "/api/state", &headers);
    assert!(wrong.starts_with("HTTP/1.1 405"), "GET 接口不收 POST");
}
