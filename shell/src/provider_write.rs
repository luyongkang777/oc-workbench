//! 单条 provider 的写入：save / remove。
//!
//! 从 `provider.rs` 拆出来：路由层只分发，校验 + 落盘在这里。

use serde_json::Value;
use tiny_http::Request;

use crate::provider::{is_masked, read_json, read_key_for, status_json};
use crate::provider_store::{config_path, save_config};
use crate::provider_upsert::{remove_provider, upsert_provider};

pub(crate) fn save_endpoint(request: Request) {
    let Some((request, map)) = read_json(request) else {
        return;
    };
    let id = map.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if id.is_empty() {
        let _ = crate::server::json_error(request, 400, "缺少 id");
        return;
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        let _ = crate::server::json_error(request, 400, "id 只能用字母、数字、点、下划线、短横线");
        return;
    }
    if id.chars().count() > 64 {
        let _ = crate::server::json_error(request, 400, "id 太长（最多 64 个字符）");
        return;
    }
    let name = map
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or(&id)
        .to_string();
    let base_url = map
        .get("baseURL")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let lower = base_url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        let _ = crate::server::json_error(request, 400, "接口地址必须是完整的 http(s) 地址");
        return;
    }
    let mut api_key = map.get("apiKey").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if is_masked(&api_key) {
        // 用户没改 key（传回来的是掩码）：沿用磁盘上的真 key。
        // 只按同一个 id 查——以前没有 id 时会遍历所有 provider 按掩码匹配，
        // 那等于「知道掩码就能取走任意 provider 的真 key」。
        api_key = read_key_for(&api_key, Some(&id)).unwrap_or_default();
    }
    if api_key.is_empty() {
        let _ = crate::server::json_error(request, 400, "缺少 apiKey");
        return;
    }
    if api_key.chars().any(char::is_whitespace) {
        let _ = crate::server::json_error(request, 400, "API Key 里不能有空格或换行");
        return;
    }

    let models = parse_models(map.get("models"));

    let Some(path) = config_path(None) else {
        let _ = crate::server::json_error(request, 500, "找不到 opencode.json 的位置");
        return;
    };
    let result = save_config(&path, |config| {
        upsert_provider(config, &id, &name, &base_url, &api_key, &models)
    });

    match result {
        Ok(_) => {
            crate::append_log(&format!(
                "[provider] 已写入 provider {id}（{} 个模型）\n",
                models.len()
            ));
            let mut body = status_json();
            if let Some(map) = body.as_object_mut() {
                map.insert("saved".to_string(), Value::String(id));
            }
            let _ = crate::server::respond_json(request, 200, body.to_string());
        }
        Err((code, message)) => {
            let _ = crate::server::json_error(request, code, &message);
        }
    }
}

/// 解析 `models` 数组（纯字符串与对象两种写法都认）。
pub(crate) fn parse_models(value: Option<&Value>) -> Vec<crate::provider_store::ModelSpec> {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let id = item
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| {
                            item.get("id")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                        .unwrap_or_default();
                    let id = id.trim().to_string();
                    if id.is_empty() {
                        return None;
                    }
                    Some(crate::provider_store::ModelSpec {
                        name: item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim()
                            .to_string(),
                        context: item.get("context").and_then(Value::as_u64).unwrap_or(0),
                        output: item.get("output").and_then(Value::as_u64).unwrap_or(0),
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 导出（**带真 key**）：账号同步推送时要用。
///
/// 权限级别与 `/local/fs/read` 一致——都已经能读这个文件，不算新增暴露面；
/// 但绝不能放进 `status`（面板/远程页面会展示 status）。
pub(crate) fn remove_endpoint(request: Request) {
    let Some((request, map)) = read_json(request) else {
        return;
    };
    let id = map.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if id.is_empty() {
        let _ = crate::server::json_error(request, 400, "缺少 id");
        return;
    }
    let Some(path) = config_path(None) else {
        let _ = crate::server::json_error(request, 500, "找不到 opencode.json 的位置");
        return;
    };
    match save_config(&path, |config| remove_provider(config, &id)) {
        Ok(_) => {
            crate::append_log(&format!("[provider] 已删除 provider {id}\n"));
            let _ = crate::server::respond_json(request, 200, status_json().to_string());
        }
        Err((code, message)) => {
            let _ = crate::server::json_error(request, code, &message);
        }
    }
}

// ---------- 共用：读 JSON 请求体 ----------

