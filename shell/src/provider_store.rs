//! 第三方 API（provider）配置的读取与写回。
//!
//! 只碰 `~/.config/opencode/opencode.json` 的 `provider` 一段，外加顶层
//! `model`（默认模型，账号同步要用）：
//!
//! ```json
//! { "provider": { "deepseek": { "name": "...", "npm": "@ai-sdk/openai-compatible",
//!   "options": { "baseURL": "...", "apiKey": "sk-..." },
//!   "models": { "deepseek-chat": { "name": "deepseek-chat" } } } } }
//! ```
//!
//! **红线：绝不整份覆盖**。这份文件里还有 mcp / instructions / agents / 其它
//! provider，全是你手写的。所以写入流程是：
//!
//!   1. 读原文 → 解析成 `Value`
//!   2. 备份成 `opencode.json.bak-<时间戳>`（只保留最近 10 份）
//!   3. 只改 `provider.<id>`（或删掉它），以及顶层 `model`
//!   4. 写临时文件 → 改名（原子）
//!   5. **写前后自检**：除 `provider` 与 `model` 外的顶层键必须全在、类型不变；
//!      丢了就回滚报错，不留下半死状态。
//!
//! 文件本身不是合法 JSON 时直接拒绝写（409）——拿默认值覆盖会把用户手改的
//! 一切冲掉，而这文件被破坏时 opencode 自己也会报错，用户能看出问题在哪。

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// 写 key 的请求体上限：一条 provider 就算几十个模型也就几十 KB。
pub const REQUEST_LIMIT: usize = 512 * 1024;

pub(crate) fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

pub(crate) fn config_path(override_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = override_path {
        return Some(path.to_path_buf());
    }
    home().map(|dir| dir.join(".config").join("opencode").join("opencode.json"))
}

/// 读配置：返回 (值, 错误)。
///
/// **只有「文件不存在」才当空配置**。其它读失败（ACL/EDR 拒绝、被独占、路径是目录）
/// 必须返回错误：把它当成空对象会让后面的保存把整份文件覆盖成只剩 provider
/// （曾经是 🔴，实测 ACL 拒绝读时 model/mcp/instructions 全丢且返回成功）。
pub(crate) fn read_config(path: &Path) -> (Value, Option<String>) {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return (Value::Object(Map::new()), None)
        }
        Err(err) => {
            return (
                Value::Null,
                Some(format!("读不了 opencode.json（{err}），先确认文件可读再保存")),
            )
        }
    };
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return (Value::Object(Map::new()), None);
    }
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(value @ Value::Object(_)) => (value, None),
        Ok(_) => (Value::Null, Some("opencode.json 顶层不是对象".to_string())),
        Err(err) => (Value::Null, Some(format!("opencode.json 不是合法 JSON（{err}）"))),
    }
}

/// 密钥掩码：只露头尾各 4 个字符；太短整串打星。
///
/// 与 `src/api/providerFormat.ts` 的 `maskKey` 口径一致（那边有单测，这里只保持一致）。
pub(crate) fn mask_key(key: &str) -> String {
    let text = key.trim();
    if text.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = text.chars().collect();
    if chars.len() < 12 {
        return "*".repeat(chars.len());
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

/// 保存时提交的一条模型（界面会带上上下文/输出上限与显示名）。
pub struct ModelSpec {
    pub id: String,
    pub name: String,
    pub context: u64,
    pub output: u64,
}

pub(crate) fn limit_of(item: &Value) -> (u64, u64) {
    let limit = item.get("limit");
    let context = limit
        .and_then(|l| l.get("context"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = limit
        .and_then(|l| l.get("output"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    (context, output)
}

/// 一条 provider 的对外视图：**不含明文 key**，只有掩码与「有没有填」。
pub(crate) fn provider_view(id: &str, value: &Value) -> Value {
    let map = value.as_object().cloned().unwrap_or_default();
    let options = map.get("options").and_then(Value::as_object);
    let api_key = options
        .and_then(|options| options.get("apiKey"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let base_url = options
        .and_then(|options| options.get("baseURL"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let models: Vec<String> = map
        .get("models")
        .and_then(Value::as_object)
        .map(|models| models.keys().cloned().collect())
        .unwrap_or_default();
    let model_names: Vec<Value> = map
        .get("models")
        .and_then(Value::as_object)
        .map(|models| {
            models
                .iter()
                .map(|(key, item)| {
                    let (context, output) = limit_of(item);
                    json!({
                        "id": key,
                        "name": item.get("name").and_then(Value::as_str).unwrap_or(key),
                        "context": context,
                        "output": output,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    json!({
        "id": id,
        "name": map.get("name").and_then(Value::as_str).unwrap_or(id),
        "npm": map.get("npm").and_then(Value::as_str).unwrap_or(""),
        "baseURL": base_url,
        "keyMasked": mask_key(api_key),
        "hasKey": !api_key.trim().is_empty(),
        "modelCount": models.len(),
        "models": model_names,
    })
}

/// 备份文件名：`opencode.json.bak-<秒>-<毫秒>`。
pub(crate) fn save_config<F>(path: &Path, mutate: F) -> Result<Value, (u16, String)>
where
    F: FnOnce(&mut Map<String, Value>) -> Result<(), String>,
{
    // 读-改-写必须互斥，否则并发保存会丢更新。
    let _guard = crate::provider_io::lock_save();

    let (current, error) = read_config(path);
    if let Some(error) = error {
        return Err((
            409,
            format!("{error}；先修好 opencode.json 再保存，避免覆盖你手改的内容"),
        ));
    }
    let before = crate::provider_io::top_level_keys(&current);
    let mut map = match current {
        Value::Object(map) => map,
        _ => Map::new(),
    };

    mutate(&mut map).map_err(|message| (400, message))?;

    let next = Value::Object(map);
    let after = crate::provider_io::top_level_keys(&next);
    // 口径见 provider_io::guard_allows：只有顶层 model 允许新增/改值。
    if !crate::provider_io::guard_allows(&before, &after) {
        return Err((
            500,
            "自检失败：写回会改动 provider 以外的配置，已放弃保存".to_string(),
        ));
    }

    let text = serde_json::to_string_pretty(&next)
        .map_err(|err| (500, format!("序列化配置失败：{err}")))?;

    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    if path.exists() {
        if let Some(backup) = crate::provider_io::backup_path(path) {
            // 备份失败就放弃保存：承诺了「写前必留一份」，静默跳过等于骗人。
            fs::copy(path, &backup)
                .map_err(|err| (500, format!("备份 opencode.json 失败，已放弃保存：{err}")))?;
            if let Some(name) = path.file_name() {
                crate::provider_io::rotate_backups(dir, &name.to_string_lossy());
            }
        }
    }
    crate::provider_io::write_atomic(path, format!("{text}\n").as_bytes())
        .map_err(|err| (500, format!("写配置失败：{err}")))?;

    Ok(next)
}

/// 把一条 provider 写进配置（新增或覆盖同 id）。
///
/// `models` 只写"启用的模型"：模型条目里只放 `name`，context/output 这类
/// 上限留给用户在文件里自己调（工作台不猜每个模型的上下文长度）。
#[cfg(test)]
#[path = "provider_store_tests.rs"]
mod tests;
