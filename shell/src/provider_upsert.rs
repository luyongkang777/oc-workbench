//! provider 条目的写入与删除（upsert / remove）。
//!
//! 从 `provider_store.rs` 拆出来：那边只管读写与视图，具体「怎么合并一条」在这里。

use serde_json::{json, Map, Value};

use crate::provider_store::ModelSpec;

pub(crate) fn upsert_provider(
    map: &mut Map<String, Value>,
    id: &str,
    name: &str,
    base_url: &str,
    api_key: &str,
    models: &[ModelSpec],
) -> Result<(), String> {
    // 走梯子的两个上游在磁盘上记成本地转发地址（界面与账号同步仍是真地址）。
    let base_url = crate::relay::to_local(base_url, crate::relay::port());

    let providers = map
        .entry("provider".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(providers) = providers.as_object_mut() else {
        return Err("配置里的 provider 不是对象，已放弃写入".to_string());
    };

    // 覆盖已有条目时：models 按界面勾选，但保留每条模型里手调的字段（limit/variants…）；
    // provider 级别的未知字段（env / blacklist / whitelist / doc…）与自定义 npm 也要留着，
    // 否则用户手写的 provider 点一次保存就被「标准化」成四键，等于悄悄改了人家的配置。
    let previous = providers.get(id).cloned().unwrap_or(Value::Null);
    let previous_models = previous
        .get("models")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut model_map = Map::new();
    for spec in models {
        let key = spec.id.trim();
        if key.is_empty() {
            continue;
        }
        // 保留旧条目里除 name/limit 之外的字段（variants、modalities、cost…）
        let mut fields = match previous_models.get(key).cloned() {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        let display = spec.name.trim();
        if !display.is_empty() {
            fields.insert("name".to_string(), Value::String(display.to_string()));
        } else {
            fields
                .entry("name".to_string())
                .or_insert_with(|| Value::String(key.to_string()));
        }
        // 上下文以调用方给的为准（1M 的模型就写 1M），没给才不写 limit
        if spec.context > 0 {
            // output 未知（0）就不要写：写死 8192 会把 64k 输出的模型截断
            let limit = if spec.output > 0 {
                json!({ "context": spec.context, "output": spec.output })
            } else {
                json!({ "context": spec.context })
            };
            fields.insert("limit".to_string(), limit);
        }
        model_map.insert(key.to_string(), Value::Object(fields));
    }

    // options 里除了 baseURL / apiKey 还可能有 headers、timeout、fetch 之类
    // 用户手调的字段（中转站常要求自定义 header），只覆盖这两个，其余原样带过去。
    let mut options = previous
        .get("options")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    options.insert("baseURL".to_string(), Value::String(base_url.to_string()));
    options.insert("apiKey".to_string(), Value::String(api_key.to_string()));

    // 以旧条目为底，保留 provider 级未知字段（env / blacklist / whitelist / doc…）
    // 与用户自定义的 npm；我们只覆盖 name / options / models 三个键。
    let mut entry = match previous.clone() {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    entry.insert("name".to_string(), Value::String(name.to_string()));
    entry
        .entry("npm".to_string())
        .or_insert_with(|| Value::String("@ai-sdk/openai-compatible".to_string()));
    entry.insert("options".to_string(), Value::Object(options));
    entry.insert("models".to_string(), Value::Object(model_map));

    providers.insert(id.to_string(), Value::Object(entry));
    Ok(())
}

/// 删掉一条 provider。删空后保留 `{}`，不整个删掉 `provider` 键
/// （让它继续出现在文件里，用户一眼能看出「这里配过」）。
pub(crate) fn remove_provider(map: &mut Map<String, Value>, id: &str) -> Result<(), String> {
    let Some(providers) = map.get_mut("provider").and_then(Value::as_object_mut) else {
        return Err("配置里没有 provider，没什么可删".to_string());
    };
    if providers.remove(id).is_none() {
        return Err(format!("没有找到 provider {id}"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "provider_upsert_tests.rs"]
mod tests;
