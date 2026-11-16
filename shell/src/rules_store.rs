//! 规则存储：路径、解析、读盘。
//!
//! 与 `rules.rs` 的分工：这里只做「怎么找文件、怎么把文件读成条目」，
//! HTTP 路由与保存流程在 `rules.rs`。拆开是为了守住「单文件 ≤300 行」。
//!
//! 老格式（一整块 markdown）解析口径必须与插件 `core.mts` 的
//! `parseLegacyMarkdown`、dev 的 `parseLegacyMarkdown` 一致。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};

pub(crate) fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

pub(crate) fn opencode_dir() -> Option<PathBuf> {
    home().map(|dir| dir.join(".config").join("opencode"))
}

pub(crate) fn data_dir() -> Option<PathBuf> {
    opencode_dir().map(|dir| dir.join("rules"))
}

pub(crate) fn global_json() -> Option<PathBuf> {
    data_dir().map(|dir| dir.join("workbench-global.json"))
}

pub(crate) fn global_legacy() -> Option<PathBuf> {
    data_dir().map(|dir| dir.join("workbench-global.md"))
}

pub(crate) fn local_json(directory: &str) -> PathBuf {
    Path::new(directory).join(".opencode").join("rules.json")
}

pub(crate) fn local_legacy(directory: &str) -> PathBuf {
    Path::new(directory).join(".opencode").join("rules.md")
}

pub(crate) fn plugin_dir() -> Option<PathBuf> {
    opencode_dir().map(|dir| dir.join("plugins").join("rules"))
}

/// 极简 percent 解码：目录里会有中文和空格，`+` 在 query 里也可能出现。
pub(crate) fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(value) => {
                        out.push(value);
                        index += 3;
                    }
                    Err(_) => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

pub(crate) fn push_item(items: &mut Vec<Value>, title: &str, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    items.push(json!({ "title": title.trim(), "text": text }));
}

/// `#` 标题 + 紧跟的非空行 = 标题/内容两行条目；其余非空行 = 单行条目。
pub(crate) fn parse_legacy(raw: &str) -> Vec<Value> {
    let mut items: Vec<Value> = Vec::new();
    let lines: Vec<&str> = raw.trim_start_matches('\u{feff}').lines().collect();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index].trim();
        if line.is_empty() {
            index += 1;
            continue;
        }
        let heading = line.trim_start_matches('#').trim();
        let is_heading = line.starts_with('#') && !heading.is_empty();
        if is_heading {
            let mut body = "";
            let mut used = index;
            for (offset, next) in lines.iter().enumerate().skip(index + 1) {
                let next = next.trim();
                if next.is_empty() {
                    continue;
                }
                if next.starts_with('#') {
                    break;
                }
                body = next;
                used = offset;
                break;
            }
            let body = body.trim_start_matches(['-', '*']).trim();
            if body.is_empty() {
                push_item(&mut items, "", heading);
            } else {
                push_item(&mut items, heading, body);
                index = used;
            }
            index += 1;
            continue;
        }
        push_item(&mut items, "", line.trim_start_matches(['-', '*']).trim());
        index += 1;
    }
    items
}

pub(crate) fn empty_local() -> Value {
    json!({
        "scope": "local",
        "path": "",
        "exists": false,
        "bytes": 0,
        "mtimeMs": Value::Null,
        "error": Value::Null,
        "items": [],
        "migratedFrom": "",
    })
}

pub(crate) fn count_items(source: &Value) -> usize {
    source.get("items").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0)
}

fn error_source(scope: &str, file: &Path, bytes: u64, mtime_ms: u64, message: String) -> Value {
    json!({
        "scope": scope,
        "path": file.to_string_lossy(),
        "exists": true,
        "bytes": bytes,
        "mtimeMs": mtime_ms,
        "error": message,
        "items": [],
        "migratedFrom": "",
    })
}

/// 读一份规则：JSON 优先，其次老 md，再次空。
pub(crate) fn read_rule(scope: &str, file: &Path, legacy: Option<&Path>) -> Value {
    let meta = fs::metadata(file).ok();
    let exists = meta.as_ref().map(|m| m.is_file()).unwrap_or(false);
    let bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime_ms = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|delta| delta.as_millis() as u64)
        .unwrap_or(0);

    if exists {
        let raw = match fs::read(file) {
            Ok(raw) => raw,
            Err(err) => return error_source(scope, file, bytes, mtime_ms, err.to_string()),
        };
        let text = String::from_utf8_lossy(&raw).to_string();
        let parsed: Value = match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(err) => {
                return error_source(scope, file, bytes, mtime_ms, format!("不是合法 JSON：{err}"))
            }
        };
        let mut items: Vec<Value> = Vec::new();
        if let Some(list) = parsed.get("items").and_then(Value::as_array) {
            for entry in list {
                push_item(
                    &mut items,
                    entry.get("title").and_then(Value::as_str).unwrap_or(""),
                    entry.get("text").and_then(Value::as_str).unwrap_or(""),
                );
            }
        }
        return json!({
            "scope": scope,
            "path": file.to_string_lossy(),
            "exists": true,
            "bytes": bytes,
            "mtimeMs": mtime_ms,
            "error": Value::Null,
            "items": items,
            "migratedFrom": "",
        });
    }

    // JSON 不存在：尝试老 md
    if let Some(old) = legacy {
        if let Ok(raw) = fs::read(old) {
            let text = String::from_utf8_lossy(&raw).to_string();
            if !text.trim().is_empty() {
                let info = fs::metadata(old).ok();
                return json!({
                    "scope": scope,
                    "path": file.to_string_lossy(),
                    "exists": true,
                    "bytes": info.as_ref().map(|m| m.len()).unwrap_or(0),
                    "mtimeMs": info
                        .as_ref()
                        .and_then(|m| m.modified().ok())
                        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                        .map(|delta| delta.as_millis() as u64)
                        .unwrap_or(0),
                    "error": Value::Null,
                    "items": parse_legacy(&text),
                    "migratedFrom": old.to_string_lossy(),
                });
            }
        }
    }

    json!({
        "scope": scope,
        "path": file.to_string_lossy(),
        "exists": false,
        "bytes": 0,
        "mtimeMs": Value::Null,
        "error": Value::Null,
        "items": [],
        "migratedFrom": "",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_percent_and_plus() {
        assert_eq!(percent_decode("F%3A%5Cwork%20dir"), "F:\\work dir");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("100%ZZ"), "100%ZZ");
    }

    #[test]
    fn legacy_heading_plus_list_becomes_title_and_text() {
        let items = parse_legacy("# 临时验证规则\n- 每次回答最后一行写 X\n");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].get("title").and_then(Value::as_str), Some("临时验证规则"));
        assert_eq!(items[0].get("text").and_then(Value::as_str), Some("每次回答最后一行写 X"));
    }

    #[test]
    fn legacy_plain_lines_become_single_row_items() {
        let items = parse_legacy("- 第一条\n第二条\n\n- 第三条\n");
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].get("text").and_then(Value::as_str), Some("第一条"));
        assert_eq!(items[1].get("title").and_then(Value::as_str), Some(""));
        assert_eq!(items[2].get("text").and_then(Value::as_str), Some("第三条"));
    }

    #[test]
    fn reads_json_items_and_skips_empty_text() {
        let dir = std::env::temp_dir().join(format!("oc-rules-json-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("rules.json");
        fs::write(
            &file,
            r#"{ "version": 1, "items": [ { "title": "标题", "text": "内容" }, { "title": "", "text": "  " } ] }"#,
        )
        .expect("写测试规则失败");
        let value = read_rule("local", &file, None);
        let items = value.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        assert_eq!(items.len(), 1, "空内容条目应被丢掉");
        assert_eq!(items[0].get("title").and_then(Value::as_str), Some("标题"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_paths_are_under_dot_opencode() {
        let json = local_json("F:\\\\work");
        assert!(json.ends_with("rules.json"));
        assert!(json.to_string_lossy().contains(".opencode"));
        let legacy = local_legacy("F:\\\\work");
        assert!(legacy.ends_with("rules.md"));
    }
}
