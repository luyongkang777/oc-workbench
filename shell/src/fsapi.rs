//! 本地文件 API（`/local/fs/*`）：不经 opencode 后端，直接读磁盘。
//!
//! 这样三个问题一起解决：
//!   * 不再受上游 `/api/fs/read` 「整份返回」的限制，任意大小文件都能按行分页看；
//!   * 读文件不再占用 `MAX_CONCURRENT` 的转发名额，快速连点也不会把上游压出 503；
//!   * 目录列表带上文件大小，文件树不用再等后端在途请求排队。
//!
//! 安全边界：和 `/api/*` 一样先过 Host + `x-oc-token`；
//! 路径只允许落在 `root` 之内（逐段拒绝 `..`，canonicalize 后做前缀校验）。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::json;
use tiny_http::{Header, Response, StatusCode};

use crate::fsdecode::hex_dump;
use crate::fsindex;
use crate::fsread;
use crate::fsutil::{mime_of, param, param_u64, parse_query};
use crate::server::{json_error, respond_json};

const READ_LINES_DEFAULT: u64 = 200;
const READ_LINES_MAX: u64 = 1000;
const TEXT_DEFAULT_MAX: u64 = 1024 * 1024;
const TEXT_HARD_MAX: u64 = 4 * 1024 * 1024;
const HEX_DEFAULT: usize = 4096;
const HEX_HARD_MAX: usize = 64 * 1024;

#[derive(Debug)]
struct PathError {
    code: u16,
    message: String,
}

impl PathError {
    fn new(code: u16, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub fn handle(request: tiny_http::Request, path: &str, url: &str) {
    let pairs = parse_query(url);
    let action = path.rsplit('/').next().unwrap_or("");
    let root = param(&pairs, "root").unwrap_or("").trim().to_string();
    let rel = param(&pairs, "path").unwrap_or("").to_string();
    if root.is_empty() {
        let _ = json_error(request, 400, "缺少 root 参数");
        return;
    }

    let target = match resolve(&root, &rel) {
        Ok(target) => target,
        Err(err) => {
            let _ = json_error(request, err.code, &err.message);
            return;
        }
    };

    // 目录/文件类型先分清：否则 list 一个文件、read 一个目录都会变成 500。
    if action == "list" {
        if !target.is_dir() {
            let _ = json_error(request, 400, "这不是目录");
            return;
        }
    } else if target.is_dir() {
        let _ = json_error(request, 400, "这是目录，不是文件");
        return;
    }

    match action {
        "list" => list(request, &target, &rel),
        "stat" => stat(request, &target),
        "read" => read(request, &target, &pairs),
        "text" => text(request, &target, &pairs),
        "raw" => raw(request, &target),
        "hex" => hex(request, &target, &pairs),
        "search" => crate::fssearch::handle(request, &target, &pairs),
        _ => {
            let _ = json_error(request, 404, "未知的本地文件接口");
        }
    }
}

fn resolve(root: &str, rel: &str) -> Result<PathBuf, PathError> {
    let root_canon = Path::new(root)
        .canonicalize()
        .map_err(|_| PathError::new(404, format!("目录不存在：{root}")))?;
    if !root_canon.is_dir() {
        return Err(PathError::new(400, "root 不是目录"));
    }

    let mut joined = root_canon.clone();
    for part in rel.split(['\\', '/']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(PathError::new(400, "路径不允许包含 .."));
        }
        if part.contains(':') {
            return Err(PathError::new(400, "路径不允许包含盘符"));
        }
        joined.push(part);
    }

    let target = joined
        .canonicalize()
        .map_err(|_| PathError::new(404, format!("文件不存在：{rel}")))?;
    if !target.starts_with(&root_canon) {
        return Err(PathError::new(403, "路径越界"));
    }
    Ok(target)
}

fn list(request: tiny_http::Request, dir: &Path, rel: &str) {
    let reader = match fs::read_dir(dir) {
        Ok(reader) => reader,
        Err(err) => {
            let _ = json_error(request, 500, &format!("列目录失败：{err}"));
            return;
        }
    };

    let mut rows: Vec<(bool, String, serde_json::Value)> = Vec::new();
    for item in reader.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        let meta = item.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{}\\{}", rel.trim_end_matches(['\\', '/']), name)
        };
        let path = if is_dir { format!("{path}\\") } else { path };
        let size = if is_dir { None } else { meta.as_ref().map(|m| m.len()) };
        rows.push((
            is_dir,
            name.to_lowercase(),
            json!({
                "path": path,
                "type": if is_dir { "directory" } else { "file" },
                "size": size,
            }),
        ));
    }
    // 目录在前，其次按名字不区分大小写排序
    rows.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let entries: Vec<serde_json::Value> = rows.into_iter().map(|row| row.2).collect();
    let _ = respond_json(request, 200, json!({ "entries": entries }).to_string());
}

fn stat(request: tiny_http::Request, file: &Path) {
    let meta = match fs::metadata(file) {
        Ok(meta) => meta,
        Err(err) => {
            let _ = json_error(request, 404, &format!("读文件信息失败：{err}"));
            return;
        }
    };
    if meta.is_dir() {
        let _ = json_error(request, 400, "这是目录，不是文件");
        return;
    }
    let index = match fsindex::index_for(file) {
        Ok(index) => index,
        Err(err) => {
            let _ = json_error(request, 500, &format!("建立行索引失败：{err}"));
            return;
        }
    };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or(0);
    let body = json!({
        "size": index.size,
        "mtimeMs": mtime_ms,
        "lineCount": index.line_count,
        "encoding": index.enc.name(),
        "binary": index.binary,
    });
    let _ = respond_json(request, 200, body.to_string());
}

fn read(request: tiny_http::Request, file: &Path, pairs: &[(String, String)]) {
    let start = param_u64(pairs, "start").unwrap_or(0);
    let lines = param_u64(pairs, "lines")
        .unwrap_or(READ_LINES_DEFAULT)
        .clamp(1, READ_LINES_MAX);
    let index = match fsindex::index_for(file) {
        Ok(index) => index,
        Err(err) => {
            let _ = json_error(request, 500, &format!("建立行索引失败：{err}"));
            return;
        }
    };
    if index.binary {
        let _ = json_error(request, 415, "二进制文件，无法按文本预览");
        return;
    }
    match fsread::read_window(file, &index, start, lines) {
        Ok(window) => {
            let body = json!({
                "start": window.start,
                "text": window.text,
                "next": window.next,
                "eof": window.eof,
                "lineCount": index.line_count,
            });
            let _ = respond_json(request, 200, body.to_string());
        }
        Err(err) => {
            let _ = json_error(request, 500, &format!("读取失败：{err}"));
        }
    }
}

fn text(request: tiny_http::Request, file: &Path, pairs: &[(String, String)]) {
    let max = param_u64(pairs, "maxBytes")
        .unwrap_or(TEXT_DEFAULT_MAX)
        .clamp(64 * 1024, TEXT_HARD_MAX);
    match fsindex::index_for(file) {
        Ok(index) if index.binary => {
            let _ = json_error(request, 415, "二进制文件，无法按文本预览");
            return;
        }
        Ok(_) => {}
        Err(err) => {
            let _ = json_error(request, 500, &format!("建立行索引失败：{err}"));
            return;
        }
    }
    match crate::fsdecode::read_whole(file, max) {
        Ok(Some(text)) => {
            let _ = respond_json(request, 200, json!({ "text": text }).to_string());
        }
        Ok(None) => {
            let _ = json_error(request, 413, "文件太大，全文预览请改用分页阅读");
        }
        Err(err) => {
            let _ = json_error(request, 500, &format!("读取失败：{err}"));
        }
    }
}

fn raw(request: tiny_http::Request, file: &Path) {
    let handle = match fs::File::open(file) {
        Ok(handle) => handle,
        Err(err) => {
            let _ = json_error(request, 404, &format!("打开文件失败：{err}"));
            return;
        }
    };
    let len = match handle.metadata() {
        Ok(meta) => meta.len(),
        Err(err) => {
            let _ = json_error(request, 500, &format!("读文件信息失败：{err}"));
            return;
        }
    };
    let content_type =
        Header::from_bytes(&b"content-type"[..], mime_of(file).as_bytes()).expect("content-type");
    let no_store =
        Header::from_bytes(&b"cache-control"[..], &b"no-store"[..]).expect("cache-control");
    let mut response = Response::new(StatusCode(200), vec![content_type, no_store], handle, Some(len as usize), None);
    response = response.with_chunked_threshold(usize::MAX);
    let _ = request.respond(response);
}

fn hex(request: tiny_http::Request, file: &Path, pairs: &[(String, String)]) {
    let offset = param_u64(pairs, "offset").unwrap_or(0);
    let bytes = param_u64(pairs, "bytes")
        .map(|value| value as usize)
        .unwrap_or(HEX_DEFAULT)
        .clamp(16, HEX_HARD_MAX);
    match hex_dump(file, offset, bytes) {
        Ok(text) => {
            let _ = respond_json(request, 200, json!({ "text": text }).to_string());
        }
        Err(err) => {
            let _ = json_error(request, 500, &format!("转储失败：{err}"));
        }
    }
}

#[cfg(test)]
#[path = "fsapi_tests.rs"]
mod tests;
