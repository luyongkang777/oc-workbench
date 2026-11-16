//! 账号同步用的两个接口：`GET /local/provider/export` 与 `POST /local/provider/apply`。
//!
//! 从 `provider.rs` 拆出来：导出/批量写入是「整份账号配置」的事，和单条 provider 的增删改分开。

use serde_json::{json, Value};
use tiny_http::Request;

use crate::provider_store::{config_path, read_config, save_config};
use crate::provider_upsert::upsert_provider;
use crate::provider::{parse_models, read_json};

pub(crate) fn export_json() -> Value {
    let Some(path) = config_path(None) else {
        return json!({ "ok": false, "error": "找不到用户目录" });
    };
    let (config, error) = read_config(&path);
    if let Some(error) = error {
        return json!({ "ok": false, "error": error });
    }
    let mut providers: Vec<Value> = Vec::new();
    if let Some(map) = config.get("provider").and_then(Value::as_object) {
        for (id, entry) in map {
            let options = entry.get("options");
            let base_url = options
                .and_then(|o| o.get("baseURL"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let api_key = options
                .and_then(|o| o.get("apiKey"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if base_url.is_empty() || api_key.trim().is_empty() {
                continue;
            }
            let models: Vec<Value> = entry
                .get("models")
                .and_then(Value::as_object)
                .map(|models| {
                    models
                        .iter()
                        .map(|(key, item)| {
                            let (context, output) =
                                crate::provider_store::limit_of(item);
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
            providers.push(json!({
                "id": id,
                "name": entry.get("name").and_then(Value::as_str).unwrap_or(id),
                "baseURL": base_url,
                "apiKey": api_key,
                "models": models,
            }));
        }
    }
    json!({
        "ok": true,
        "model": config.get("model").and_then(Value::as_str).unwrap_or(""),
        "providers": providers,
    })
}

// ---------- POST /local/provider/apply ----------

/// 整份应用账号同步下来的配置：一次写入多个 provider + 可选默认模型。
///
/// 为什么不是「循环调 save」：那会产生 N 份备份、N 次读改写；这里一次改完再落盘，
/// 只会留一份备份，也不会出现「写到一半失败」的半死状态（UPSERT 全在同一事务里）。
pub(crate) fn apply_endpoint(request: Request) {
    let Some((request, map)) = read_json(request) else {
        return;
    };
    let providers = map
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let model = map
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();

    if providers.is_empty() && model.is_empty() {
        let _ = crate::server::json_error(request, 400, "providers 与 model 至少要有一个");
        return;
    }

    // 先整体校验，再动磁盘：任何一条不合法就一条都不写
    let mut prepared: Vec<(String, String, String, String, Vec<crate::provider_store::ModelSpec>)> =
        Vec::new();
    for item in &providers {
        let Some(entry) = item.as_object() else {
            let _ = crate::server::json_error(request, 400, "providers 里每项必须是对象");
            return;
        };
        let id = entry.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        {
            let _ = crate::server::json_error(request, 400, "provider id 不合法");
            return;
        }
        let base_url = entry
            .get("baseURL")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let lower = base_url.to_ascii_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://")) {
            let _ = crate::server::json_error(request, 400, "provider 的 baseURL 不合法");
            return;
        }
        let api_key = entry
            .get("apiKey")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if api_key.is_empty() {
            let _ = crate::server::json_error(request, 400, "provider 缺少 apiKey");
            return;
        }
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .trim()
            .to_string();
        prepared.push((
            id,
            name,
            base_url,
            api_key,
            parse_models(entry.get("models")),
        ));
    }

    let Some(path) = config_path(None) else {
        let _ = crate::server::json_error(request, 500, "找不到 opencode.json 的位置");
        return;
    };
    let result = save_config(&path, |config| {
        for (id, name, base_url, api_key, models) in &prepared {
            upsert_provider(config, id, name, base_url, api_key, models)?;
        }
        if !model.is_empty() {
            // 换一台电脑时，云端默认模型可能指向本机没有的 provider（比如只在那台机器上配的）。
            // 这时候保留本机原默认模型，别把它改成一个解析不出来的值。
            let provider_id = model.split('/').next().unwrap_or("");
            let exists = config
                .get("provider")
                .and_then(Value::as_object)
                .map(|map| map.contains_key(provider_id))
                .unwrap_or(false);
            if exists {
                config.insert("model".to_string(), Value::String(model.clone()));
            }
        }
        Ok(())
    });

    match result {
        Ok(_) => {
            crate::append_log(&format!(
                "[provider] 已应用账号配置：{} 个 provider，默认模型 {}
",
                prepared.len(),
                if model.is_empty() { "未变" } else { &model }
            ));
            let mut body = crate::provider::status_json();
            if let Some(map) = body.as_object_mut() {
                map.insert("applied".to_string(), Value::from(prepared.len() as u64));
            }
            let _ = crate::server::respond_json(request, 200, body.to_string());
        }
        Err((code, message)) => {
            let _ = crate::server::json_error(request, code, &message);
        }
    }
}

// ---------- POST /local/provider/remove ----------

