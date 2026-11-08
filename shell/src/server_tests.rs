//! `server` 模块的单元测试：token 不外泄、Host 精确匹配、后端不可用时 502 JSON。
//!
//! 全部走真实 loopback 端口，不 mock（tiny_http 起在 127.0.0.1:0，测试完进程退出即回收）。

use std::io::{Read as _, Write as _};
use std::net::TcpStream;
use std::time::Duration;

use super::{start, Ctx};
use crate::static_files::DIST;

fn start_test_server(base: Option<String>, token: &str) -> u16 {
    start(Ctx {
        base,
        cookie: String::new(),
        token: token.to_string(),
        port: 0,
    })
    .expect("本地服务应能启动")
}

/// 原始 TCP 请求：ureq 不允许改 Host，测精确匹配只能自己拼报文。
fn raw_get(port: u16, host: &str, path: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("连本地服务失败");
    let request = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).expect("写请求失败");
    let mut out = Vec::new();
    stream.read_to_end(&mut out).expect("读响应失败");
    String::from_utf8_lossy(&out).to_string()
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
