//! 聊天输入框草稿（`/local/draft/*`）。
//!
//! 输入框的文字和待发送图片以前只活在前端内存里：切标签、切项目、重开工作台
//! 都会被清空。localStorage 顶不住——本地服务端口每次启动都变，页面 origin 跟着变，
//! 按 origin 分区的存储跨不了启动（和 `projects.json` 是同一个原因）。
//!
//! 所以草稿落盘。一个草稿一个文件，键是「项目路径::会话 id」：
//!
//!   * `GET  /local/draft/load?key=...`  → `{"draft": {...}}` 或 `{"draft": null}`
//!   * `PUT  /local/draft/save?key=...`  请求体是 `{ "text": "", "files": [] }`
//!   * `POST /local/draft/clear?key=...` 发送成功后删掉这条
//!
//! 键里带冒号、斜杠、中文都很正常，所以文件名只取哈希，真实键存在 JSON 里，
//! 读回来先比对键名——哈希撞了也不会把别人的草稿当成自己的。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tiny_http::{Method, Request};

use crate::body::{read_body_with_timeout, BodyRead};
use crate::fsutil::{param, parse_query};

/// 图片按 data URL 存（base64 膨胀 4/3），前端允许总量 9MB，这里给足余量。
const BODY_LIMIT: usize = 24 * 1024 * 1024;
/// 盘上最多留多少份草稿：只增不减的话，聊过的每个会话都会留一个文件。
const KEEP_FILES: usize = 200;

/// 每写这么多次才扫一次目录清理：打字时几百毫秒一次写盘，每次都 read_dir + stat
/// 两百个文件纯属浪费，第一次和之后每隔这么多次扫一次就够。
const PRUNE_EVERY: usize = 16;

/// 已经写盘的次数（进程内），配合 PRUNE_EVERY 做节流。
static SAVES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn drafts_dir() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    let dir = base.join("oc-workbench").join("drafts");
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// FNV-1a 64 位：只用来把任意键折成文件名（不要求密码学强度）。
fn hash_key(key: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in key.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn file_for(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("draft-{:016x}.json", hash_key(key)))
}

/// 入口：`/local/draft/<action>`。
pub fn handle(request: Request, path: &str, url: &str) {
    let pairs = parse_query(url);
    let key = param(&pairs, "key").unwrap_or("").trim().to_string();
    if key.is_empty() {
        let _ = crate::server::json_error(request, 400, "缺少 key 参数");
        return;
    }
    match path.rsplit('/').next().unwrap_or("") {
        "load" => load(request, &key),
        "save" => save(request, &key),
        "clear" => clear(request, &key),
        _ => {
            let _ = crate::server::json_error(request, 404, "未知的草稿接口");
        }
    }
}

fn load(request: Request, key: &str) {
    if request.method() != &Method::Get {
        let _ = crate::server::json_error(request, 405, "读取草稿只支持 GET");
        return;
    }
    let draft = drafts_dir()
        .map(|dir| file_for(&dir, key))
        .and_then(|path| read_draft(&path, key))
        .unwrap_or(Value::Null);
    let body = json!({ "key": key, "draft": draft }).to_string();
    let _ = crate::server::respond_json(request, 200, body);
}

fn save(request: Request, key: &str) {
    if request.method() != &Method::Put {
        let _ = crate::server::json_error(request, 405, "保存草稿只支持 PUT");
        return;
    }
    let Some((request, body)) = read_body_with_timeout(request, BODY_LIMIT) else {
        return;
    };
    let text = match body {
        BodyRead::Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
        BodyRead::TooLarge => {
            let _ = crate::server::json_error(request, 413, "草稿过大（超过 24MB）");
            return;
        }
        BodyRead::Failed(err) => {
            let _ = crate::server::json_error(request, 400, &format!("读取请求体失败：{err}"));
            return;
        }
    };
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(err) => {
            let _ = crate::server::json_error(request, 400, &format!("草稿不是 JSON：{err}"));
            return;
        }
    };
    let Some(dir) = drafts_dir() else {
        let _ = crate::server::json_error(request, 500, "找不到 LOCALAPPDATA，无法保存草稿");
        return;
    };
    // 只认形状对的草稿：text 必须是字符串，files 必须是数组。
    // 这里不深入校验每一项，前端是唯一写入方，坏了也只会让它自己读回空。
    //
    // files 缺省 = 「图片没变，别重传」：打字只改文字时前端不带 files，
    // 否则每敲几个字就要把几张截图的 base64 重新发一遍。
    let previous = read_draft(&file_for(&dir, key), key);
    let files = match merge_files(&parsed, previous.as_ref()) {
        Ok(files) => files,
        Err(err) => {
            let _ = crate::server::json_error(request, 400, err);
            return;
        }
    };
    let stored = json!({
        "key": key,
        "text": parsed.get("text").and_then(Value::as_str).unwrap_or(""),
        "files": files,
        "savedAt": now_ms(),
    });
    let bytes = serde_json::to_vec(&stored).unwrap_or_default();
    if let Err(err) = crate::fsapi::write_atomic(&file_for(&dir, key), &bytes) {
        let _ = crate::server::json_error(request, 500, &format!("写草稿失败：{err}"));
        return;
    }
    // 清理按次数节流，别让每次打字都去 stat 整个草稿目录。
    let saves = SAVES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if saves % PRUNE_EVERY == 0 {
        prune(&dir);
    }
    let _ = crate::server::respond_json(request, 200, json!({ "ok": true }).to_string());
}
/// 把这次提交的 files 和盘上旧草稿合并：请求里没带 files 就沿用旧的。
///
/// 单独拆出来是因为它是「打字不重传图片」的关键：写错会让截图凭空消失。
fn merge_files(parsed: &Value, previous: Option<&Value>) -> Result<Value, &'static str> {
    match parsed.get("files") {
        Some(Value::Array(list)) => Ok(Value::Array(list.clone())),
        Some(Value::Null) | None => Ok(previous
            .and_then(|old| old.get("files").cloned())
            .unwrap_or_else(|| Value::Array(Vec::new()))),
        Some(_) => Err("files 必须是数组"),
    }
}

fn clear(request: Request, key: &str) {
    if request.method() != &Method::Post && request.method() != &Method::Delete {
        let _ = crate::server::json_error(request, 405, "清除草稿只支持 POST / DELETE");
        return;
    }
    if let Some(dir) = drafts_dir() {
        let _ = fs::remove_file(file_for(&dir, key));
    }
    let _ = crate::server::respond_json(request, 200, json!({ "ok": true }).to_string());
}

/// 读一份草稿；键不匹配（哈希撞了）或文件坏了都当作没有。
fn read_draft(path: &Path, key: &str) -> Option<Value> {
    let bytes = fs::read(path).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    if value.get("key").and_then(Value::as_str) != Some(key) {
        return None;
    }
    Some(value)
}

/// 超过上限就按修改时间删最旧的，避免每个聊过的会话都留一份文件。
fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(u64, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy().to_string();
            if !name.starts_with("draft-") || !name.ends_with(".json") {
                return None;
            }
            let modified = fs::metadata(&path).ok()?.modified().ok()?;
            Some((modified_ms(modified), path))
        })
        .collect();
    if files.len() <= KEEP_FILES {
        return;
    }
    files.sort_by_key(|(time, _)| *time);
    for (_, path) in files.iter().take(files.len() - KEEP_FILES) {
        let _ = fs::remove_file(path);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_millis() as u64)
        .unwrap_or(0)
}

fn modified_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 键名折叠成稳定且不同的文件名() {
        assert_eq!(hash_key("F:\\a::ses_1"), hash_key("F:\\a::ses_1"));
        assert_ne!(hash_key("F:\\a::ses_1"), hash_key("F:\\a::ses_2"));
        assert_ne!(hash_key("F:\\a::new"), hash_key("F:\\b::new"));
    }

    #[test]
    fn 键不匹配的草稿当作没有() {
        let dir = std::env::temp_dir().join(format!("oc-draft-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("draft-0000000000000000.json");
        fs::write(&path, r#"{"key":"别的键","text":"x"}"#).unwrap();
        assert!(read_draft(&path, "我的键").is_none());
        fs::write(&path, r#"{"key":"我的键","text":"x"}"#).unwrap();
        assert!(read_draft(&path, "我的键").is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 不带_files_时沿用旧草稿里的图片() {
        let previous = serde_json::json!({
            "files": [{ "name": "a.png", "mime": "image/png", "dataUrl": "data:x", "bytes": 1 }]
        });
        let text_only = serde_json::json!({ "text": "改了文字" });
        let merged = merge_files(&text_only, Some(&previous)).unwrap();
        assert_eq!(merged.as_array().unwrap().len(), 1);
    }

    #[test]
    fn 显式带_files_时以新的为准_空数组就是删光() {
        let previous = serde_json::json!({ "files": [{ "name": "a.png" }] });
        let replaced = serde_json::json!({ "text": "x", "files": [{ "name": "b.png" }] });
        let merged = merge_files(&replaced, Some(&previous)).unwrap();
        assert_eq!(merged[0]["name"], "b.png");

        let cleared = serde_json::json!({ "text": "x", "files": [] });
        let merged = merge_files(&cleared, Some(&previous)).unwrap();
        assert_eq!(merged.as_array().unwrap().len(), 0);
    }

    #[test]
    fn 第一次保存没有旧草稿时图片为空数组() {
        let fresh = serde_json::json!({ "text": "你好" });
        let merged = merge_files(&fresh, None).unwrap();
        assert_eq!(merged.as_array().unwrap().len(), 0);
    }

    #[test]
    fn files_类型不对要报错而不是静默丢掉截图() {
        let bad = serde_json::json!({ "text": "x", "files": "oops" });
        assert!(merge_files(&bad, None).is_err());
    }
}
