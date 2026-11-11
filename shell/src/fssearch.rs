//! `/local/fs/search`：整文件按行搜索（大小写不敏感），给编辑器的 Ctrl+F 用。
//!
//! 复用 fsread 的分页窗口，不把整份文件读进内存；命中上限由请求方指定（默认 200），
//! 达到上限就返回 `truncated: true`，前端显示「N+」。

use std::path::Path;

use serde_json::json;
use tiny_http::Request;

use crate::fsindex;
use crate::fsread;
use crate::fsutil::{param, param_u64};
use crate::server::{json_error, respond_json};

const DEFAULT_LIMIT: u64 = 200;
const MAX_LIMIT: u64 = 1000;
const WINDOW_LINES: u64 = 1000;
const MAX_QUERY_CHARS: usize = 256;
const SNIPPET_CHARS: usize = 240;

/// 搜索核心：返回 `(行号, 截断后的行文本)` 与是否因 limit 截断。
///
/// `needle` 已经按调用方的 `case_sensitive` 归一化（不敏感时传小写）。
pub fn find_matches(
    file: &Path,
    index: &fsindex::Index,
    needle: &str,
    case_sensitive: bool,
    limit: u64,
    from: u64,
) -> std::io::Result<(Vec<(u64, String)>, bool)> {
    let mut start = from;
    let mut matches: Vec<(u64, String)> = Vec::new();
    let mut truncated = false;

    while start < index.line_count {
        let window = fsread::read_window(file, index, start, WINDOW_LINES)?;
        let count = window.next.saturating_sub(start);
        if count == 0 {
            break;
        }
        let mut lines: Vec<&str> = window.text.split(char::from(10)).collect();
        while (lines.len() as u64) < count {
            lines.push("");
        }

        for (offset, line) in lines.iter().enumerate() {
            let line_no = start + offset as u64;
            let hit = if case_sensitive {
                line.contains(needle)
            } else {
                line.to_lowercase().contains(needle)
            };
            if !hit {
                continue;
            }
            matches.push((line_no, clip(line, SNIPPET_CHARS)));
            if matches.len() as u64 >= limit {
                truncated = true;
                break;
            }
        }

        if truncated || window.eof {
            break;
        }
        let next = window.next.max(start + 1);
        if next <= start {
            break;
        }
        start = next;
    }

    Ok((matches, truncated))
}

pub fn handle(request: Request, file: &Path, pairs: &[(String, String)]) {
    let query = param(pairs, "q").unwrap_or("").trim().to_string();
    if query.is_empty() {
        let _ = json_error(request, 400, "缺少搜索关键词 q");
        return;
    }
    if query.chars().count() > MAX_QUERY_CHARS {
        let _ = json_error(request, 400, "搜索关键词过长");
        return;
    }

    let limit = param_u64(pairs, "limit")
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT);
    let from = param_u64(pairs, "from").unwrap_or(0);
    let case_sensitive = param(pairs, "case") == Some("1");
    let needle = if case_sensitive {
        query.clone()
    } else {
        query.to_lowercase()
    };

    let forced = match param(pairs, "encoding").filter(|value| !value.is_empty()) {
        Some(name) => match fsindex::Enc::from_name(name) {
            Some(enc) => Some(enc),
            None => {
                let _ = json_error(request, 400, &format!("不认识的编码：{name}"));
                return;
            }
        },
        None => None,
    };
    let index = match fsindex::index_for_encoding(file, forced) {
        Ok(index) => index,
        Err(err) => {
            let _ = json_error(request, 500, &format!("建立行索引失败：{err}"));
            return;
        }
    };
    if index.binary {
        let _ = json_error(request, 415, "二进制文件不支持文本搜索");
        return;
    }

    let (found, truncated) = match find_matches(file, &index, &needle, case_sensitive, limit, from) {
        Ok(result) => result,
        Err(err) => {
            let _ = json_error(request, 500, &format!("搜索读取失败：{err}"));
            return;
        }
    };
    let matches: Vec<serde_json::Value> = found
        .into_iter()
        .map(|(line, text)| json!({ "line": line, "text": text }))
        .collect();

    let body = json!({
        "matches": matches,
        "truncated": truncated,
        "lineCount": index.line_count,
    });
    let _ = respond_json(request, 200, body.to_string());
}

fn clip(line: &str, max: usize) -> String {
    let trimmed = line.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max).collect();
    out.push('…');
    out
}
