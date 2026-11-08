//! 内嵌前端静态文件（编译期塞进 exe 的 dist 目录）。
//!
//! 注意：这里**不做任何 token 注入**，index.html 原样返回；
//! token 由外壳通过 WebView 的 IPC 交给页面，不经过 HTTP。

use include_dir::{include_dir, Dir};
use tiny_http::{Header, Response};

pub static DIST: Dir = include_dir!("$CARGO_MANIFEST_DIR/../dist");

pub fn serve(request: tiny_http::Request, path: &str) {
    // 空路径（例如 `GET ?a HTTP/1.1`）没有前导斜杠，直接 404，不能切片。
    let Some(rel) = path.strip_prefix('/') else {
        let _ = request.respond(Response::from_string("404 Not Found").with_status_code(404));
        return;
    };
    let rel = if rel.is_empty() { "index.html" } else { rel };
    // include_dir 只在编译期内嵌的目录树里查表，URL 未做百分号解码，
    // `..` / `%2e%2e` 都不会命中真实条目，只会 404。
    let Some(file) = DIST.get_file(rel) else {
        let _ = request.respond(Response::from_string("404 Not Found").with_status_code(404));
        return;
    };

    let header = Header::from_bytes(&b"content-type"[..], mime_of(rel).as_bytes())
        .expect("content-type 头构造失败");
    // tiny_http 默认 ≥32KB 会改发 chunked 并丢掉 Content-Length（dist 里的 JS 有 100KB+）。
    // 静态文件长度是已知的，抬到 usize::MAX 让它按 Identity 带 Content-Length 返回。
    let response = Response::from_data(file.contents().to_vec())
        .with_header(header)
        .with_chunked_threshold(usize::MAX);
    let _ = request.respond(response);
}

fn mime_of(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if lower.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if lower.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if lower.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".ico") {
        "image/x-icon"
    } else if lower.ends_with(".woff2") {
        "font/woff2"
    } else {
        "application/octet-stream"
    }
}
