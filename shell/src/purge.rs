//! 破甲注入开关（`/local/purge/*`）。
//!
//! 注入本身在 OpenCode 插件里（`%USERPROFILE%\.config\opencode\plugins\purge`），
//! 工作台不碰提示词、不改生成参数，只读写它 `config.json` 里的 `enabled` 一个字段：
//!
//!   * `GET  /local/purge/status`  配置 + 运行状态（只读）
//!   * `POST /local/purge/enabled` `{ "enabled": true|false }`
//!
//! 只暴露开关是刻意的：提示词路径、perModel、temperature 这些继续由插件自己
//! 和用户手改文件维护。接口不做通用文件读写，`/local/*` 就不会变成任意路径写入口。
//!
//! 插件按 `mtime` 缓存配置 5 秒，所以写完最长 5 秒后才真正按新状态工作——状态里的
//! `configMtimeMs` 与 `state.lastAt` 就是给界面提示「写入时间 / 最近一次注入」用的。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{json, Map, Value};
use tiny_http::{Method, Request};

use crate::body::{read_body_with_timeout, BodyRead};

/// 开关请求体只有一个布尔值，64KB 已经是宽容的上限。
const BODY_LIMIT: usize = 64 * 1024;

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn opencode_dir() -> Option<PathBuf> {
    home().map(|dir| dir.join(".config").join("opencode"))
}

/// 插件的数据目录：`config.json` / `state.json` / 用户自建提示词都在这里。
fn data_dir() -> Option<PathBuf> {
    opencode_dir().map(|dir| dir.join("purge"))
}

/// 插件本体目录：`prompts/*.md` 的兜底查找位置。
fn plugin_dir() -> Option<PathBuf> {
    opencode_dir().map(|dir| dir.join("plugins").join("purge"))
}

pub fn handle(request: Request, path: &str, _url: &str) {
    let action = path.rsplit('/').next().unwrap_or("");
    match action {
        "status" => {
            if request.method() != &Method::Get {
                let _ = crate::server::json_error(request, 405, "状态只支持 GET");
                return;
            }
            let _ = crate::server::respond_json(request, 200, status_json().to_string());
        }
        "enabled" => {
            if request.method() != &Method::Post {
                let _ = crate::server::json_error(request, 405, "开关只支持 POST");
                return;
            }
            set_enabled_endpoint(request);
        }
        _ => {
            let _ = crate::server::json_error(request, 404, "未知的破甲接口");
        }
    }
}

fn set_enabled_endpoint(request: Request) {
    let Some((request, body)) = read_body_with_timeout(request, BODY_LIMIT) else {
        return;
    };
    let text = match body {
        BodyRead::Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
        BodyRead::TooLarge => {
            let _ = crate::server::json_error(request, 413, "请求体过大");
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
            let _ = crate::server::json_error(request, 400, &format!("请求体不是 JSON：{err}"));
            return;
        }
    };
    let Some(enabled) = parsed.get("enabled").and_then(Value::as_bool) else {
        let _ = crate::server::json_error(request, 400, "缺少 enabled（true / false）");
        return;
    };
    match write_enabled(enabled) {
        Ok(status) => {
            let _ = crate::server::respond_json(request, 200, status.to_string());
        }
        Err((code, message)) => {
            let _ = crate::server::json_error(request, code, &message);
        }
    }
}

/// 读 JSON：返回 (值, 解析错误, 文件是否存在)。
///
/// 空文件当作 `{}`（插件也这么处理）；顶层不是对象时记错误，避免把数组/标量
/// 当成配置对象去改，写回去会把手改内容整个冲掉。
fn read_json(path: &Path) -> (Value, Option<String>, bool) {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return (Value::Null, None, false),
    };
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return (Value::Object(Map::new()), None, true);
    }
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(value @ Value::Object(_)) => (value, None, true),
        Ok(_) => (
            Value::Null,
            Some("config.json 顶层不是对象".to_string()),
            true,
        ),
        Err(err) => (
            Value::Null,
            Some(format!("config.json 不是合法 JSON（{err}）")),
            true,
        ),
    }
}

/// 与插件 `normalize()` 一致：缺省算开，只有显式 `false` / `"false"` 才算关。
fn enabled_of(map: &Map<String, Value>) -> bool {
    match map.get("enabled") {
        None => true,
        Some(Value::Bool(false)) => false,
        Some(Value::String(text)) if text == "false" => false,
        Some(_) => true,
    }
}

/// 提示词路径解析，规则与 `core.mts` 的 `promptPathFor` 对齐：
/// 绝对路径原样；相对路径先找插件目录（`prompts/xxx.md`），没有再落到数据目录。
fn resolve_prompt(data: &Path, plugin: &Path, raw: &str) -> PathBuf {
    let path = Path::new(raw);
    if path.is_absolute() {
        return path.to_path_buf();
    }
    let bundled = plugin.join(path);
    if bundled.exists() {
        bundled
    } else {
        data.join(path)
    }
}

fn file_info(path: &Path) -> (bool, u64) {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => (true, meta.len()),
        _ => (false, 0),
    }
}

fn mtime_ms(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|delta| delta.as_millis() as u64)
}

fn status_json() -> Value {
    let Some(data) = data_dir() else {
        return json!({
            "ok": false,
            "error": "找不到用户目录（USERPROFILE / HOME 都为空）",
        });
    };
    let plugin = plugin_dir().unwrap_or_else(|| data.clone());
    let config_path = data.join("config.json");
    let (config, config_error, config_exists) = read_json(&config_path);
    let map = config.as_object().cloned().unwrap_or_default();

    let prompt_file = map
        .get("promptFile")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .unwrap_or("prompt-inject.md")
        .to_string();
    let prompt_path = data.join(&prompt_file);
    let (prompt_exists, prompt_bytes) = file_info(&prompt_path);

    let mut models: Vec<Value> = Vec::new();
    if let Some(per_model) = map.get("perModel").and_then(Value::as_object) {
        for (key, value) in per_model {
            let Some(file) = value.as_str().filter(|text| !text.trim().is_empty()) else {
                continue;
            };
            let path = resolve_prompt(&data, &plugin, file);
            let (exists, bytes) = file_info(&path);
            models.push(json!({
                "key": key,
                "file": file,
                "path": path.to_string_lossy(),
                "exists": exists,
                "bytes": bytes,
            }));
        }
    }
    // 界面按 key 顺序展示，避免每次刷新顺序抖动
    models.sort_by(|left, right| {
        left["key"]
            .as_str()
            .unwrap_or("")
            .cmp(right["key"].as_str().unwrap_or(""))
    });

    let tools_deny: Vec<Value> = map
        .get("tools")
        .and_then(|tools| tools.get("deny"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let (state, _, state_exists) = read_json(&data.join("state.json"));

    json!({
        "ok": true,
        "dataDir": data.to_string_lossy(),
        "pluginDir": plugin.to_string_lossy(),
        "pluginInstalled": plugin.join("index.ts").exists(),
        "configPath": config_path.to_string_lossy(),
        "configExists": config_exists,
        "configError": config_error.unwrap_or_default(),
        "configMtimeMs": mtime_ms(&config_path),
        "enabled": enabled_of(&map),
        "injectDefault": map
            .get("injectDefault")
            .map(|value| value.as_bool().unwrap_or(value.as_str() != Some("false")))
            .unwrap_or(true),
        "promptFile": prompt_file,
        "promptPath": prompt_path.to_string_lossy(),
        "promptExists": prompt_exists,
        "promptBytes": prompt_bytes,
        "perModel": models,
        "temperature": map.get("temperature").cloned().unwrap_or(Value::Null),
        "maxTokens": map.get("maxTokens").cloned().unwrap_or(Value::Null),
        "toolsDeny": tools_deny,
        "verbose": map.get("verbose").and_then(Value::as_bool).unwrap_or(false),
        "state": if state_exists { state } else { Value::Null },
    })
}

/// 只改 `enabled`，其余字段按磁盘原文保留。
///
/// 配置文件坏了就拒绝写（409），不拿默认值覆盖——那会把用户手改的 perModel
/// 和提示词路径一起冲掉，而插件本身此时会按默认值（开）继续跑。
fn write_enabled(enabled: bool) -> Result<Value, (u16, String)> {
    let data = data_dir().ok_or((500, "找不到用户目录".to_string()))?;
    let path = data.join("config.json");
    let (config, error, _) = read_json(&path);
    if let Some(error) = error {
        return Err((
            409,
            format!("{error}；先修好 config.json 再切换，避免覆盖手改内容"),
        ));
    }
    let mut map = match config {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    map.insert("enabled".to_string(), Value::Bool(enabled));
    let text = serde_json::to_string_pretty(&Value::Object(map))
        .map_err(|err| (500, format!("序列化配置失败：{err}")))?;
    fs::create_dir_all(&data).map_err(|err| (500, format!("建目录失败：{err}")))?;
    write_atomic(&path, text.as_bytes()).map_err(|err| (500, format!("写配置失败：{err}")))?;
    Ok(status_json())
}

/// 先写临时文件再改名：插件随时可能读这个文件，不能让它读到半截 JSON。
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "配置路径没有父目录"))?;
    let tmp = dir.join(format!(".config.json.tmp-{}", std::process::id()));
    fs::write(&tmp, bytes)?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(&tmp);
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(source: &str) -> Map<String, Value> {
        serde_json::from_str::<Value>(source)
            .expect("测试 JSON 应该合法")
            .as_object()
            .cloned()
            .expect("测试 JSON 应该是对象")
    }

    #[test]
    fn enabled_defaults_to_on() {
        assert!(enabled_of(&object("{}")));
        assert!(enabled_of(&object("{\"enabled\": true}")));
        assert!(enabled_of(&object("{\"enabled\": \"true\"}")));
    }

    #[test]
    fn enabled_reads_both_bool_and_string_false() {
        assert!(!enabled_of(&object("{\"enabled\": false}")));
        assert!(!enabled_of(&object("{\"enabled\": \"false\"}")));
    }

    #[test]
    fn empty_file_is_treated_as_empty_object() {
        let dir = std::env::temp_dir().join(format!("oc-purge-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        fs::write(&path, "  \n").unwrap();
        let (value, error, exists) = read_json(&path);
        assert!(exists);
        assert!(error.is_none());
        assert!(value.as_object().unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_json_reports_error_instead_of_empty_config() {
        let dir = std::env::temp_dir().join(format!("oc-purge-broken-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        fs::write(&path, "{\"enabled\": tru").unwrap();
        let (value, error, exists) = read_json(&path);
        assert!(exists);
        assert!(value.is_null());
        assert!(error.unwrap().contains("不是合法 JSON"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prompt_resolution_prefers_plugin_prompts_dir() {
        let root = std::env::temp_dir().join(format!("oc-purge-prompt-{}", std::process::id()));
        let data = root.join("data");
        let plugin = root.join("plugin");
        fs::create_dir_all(plugin.join("prompts")).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(plugin.join("prompts").join("glm.md"), "x").unwrap();

        let found = resolve_prompt(&data, &plugin, "prompts/glm.md");
        assert_eq!(found, plugin.join("prompts").join("glm.md"));

        let missing = resolve_prompt(&data, &plugin, "prompts/nope.md");
        assert_eq!(missing, data.join("prompts").join("nope.md"));

        let absolute = root.join("abs.md");
        assert_eq!(resolve_prompt(&data, &plugin, &absolute.to_string_lossy()), absolute);
        let _ = fs::remove_dir_all(&root);
    }
}
