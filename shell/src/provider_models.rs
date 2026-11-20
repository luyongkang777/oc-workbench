//! 拉取上游 `GET {baseURL}/models` 并解析成 `{id,name,context,output}`。
//!
//! 从 `provider.rs` 拆出来：HTTP 层只负责路由，网络与各家字段差异都在这里。

use std::time::Duration;

use serde_json::{json, Value};

const NET_TIMEOUT: Duration = Duration::from_secs(20);
const BODY_LIMIT: u64 = 2 * 1024 * 1024;

pub(crate) fn fetch_models(base_url: &str, api_key: &str) -> Result<Vec<Value>, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let agent = crate::fetch::agent(NET_TIMEOUT, Some(NET_TIMEOUT))?;
    let response = agent
        .get(&url)
        .set("authorization", &format!("Bearer {api_key}"))
        .set("accept", "application/json")
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(code, response) => {
                // 把上游的 error.message 抠出来，比「HTTP 401」有用得多
                let text = response.into_string().unwrap_or_default();
                let detail = extract_error(&text);
                if detail.is_empty() {
                    format!("上游返回 HTTP {code}")
                } else {
                    format!("上游返回 HTTP {code}：{detail}")
                }
            }
            other => format!("连不上 {url}：{other}"),
        })?;

    let mut reader = response.into_reader();
    let mut bytes: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        use std::io::Read;
        let read = reader
            .read(&mut chunk)
            .map_err(|err| format!("读响应失败：{err}"))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() as u64 > BODY_LIMIT {
            return Err("响应体过大（超过 2MB），已放弃".to_string());
        }
    }

    let text = String::from_utf8_lossy(&bytes).to_string();
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|_| format!("上游返回的不是 JSON：{}", truncate(&text, 120)))?;
    let models = collect_models(&parsed);
    if models.is_empty() {
        return Err("上游没有返回任何模型（响应里找不到 id / data / models）".to_string());
    }
    Ok(models)
}

/// 从错误体里抠一句话（OpenAI 风格 `{error:{message}}`，也有直接 `{message}`）。
fn extract_error(text: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return truncate(text, 120);
    };
    for path in [["error", "message"], ["error", "detail"], ["message", "detail"]] {
        let mut node = &value;
        let mut ok = true;
        for key in path {
            match node.get(key) {
                Some(next) => node = next,
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            if let Some(text) = node.as_str() {
                return truncate(text, 200);
            }
        }
    }
    if let Some(text) = value.get("error").and_then(Value::as_str) {
        return truncate(text, 200);
    }
    truncate(text, 120)
}

fn truncate(text: &str, limit: usize) -> String {
    let flat = text.replace(['\r', '\n'], " ");
    let flat = flat.trim();
    if flat.chars().count() <= limit {
        return flat.to_string();
    }
    let head: String = flat.chars().take(limit).collect();
    format!("{head}…")
}

/// 三种形状都认：`{data:[]}` / `[]` / `{models:[]}`，每项可以是字符串或对象。
pub(crate) fn collect_models(payload: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut push = |item: &Value| {
        let value = model_value(item);
        if let Some(id) = value.get("id").and_then(Value::as_str) {
            if id.is_empty() {
                return;
            }
            if out
                .iter()
                .any(|seen| seen.get("id").and_then(Value::as_str) == Some(id))
            {
                return;
            }
            out.push(value);
        }
    };

    if let Some(list) = payload.as_array() {
        for item in list {
            push(item);
        }
        return out;
    }
    for key in ["data", "models"] {
        if let Some(list) = payload.get(key).and_then(Value::as_array) {
            for item in list {
                push(item);
            }
        }
    }
    out
}

/// 单条模型 → `{id, name, context, output, free, type}`（兼容字符串项与各种字段名）。
fn model_value(item: &Value) -> Value {
    if let Some(id) = item.as_str() {
        let id = id.trim();
        return json!({ "id": id, "name": id, "context": 0, "output": 0, "free": false, "type": "chat" });
    }
    let id = ["id", "name", "model"]
        .iter()
        .find_map(|key| item.get(*key).and_then(Value::as_str))
        .unwrap_or("")
        .trim()
        .to_string();
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_string();
    let limit = item.get("limit");
    let context = limit
        .and_then(|value| value.get("context"))
        .and_then(Value::as_u64)
        .or_else(|| item.get("context_length").and_then(Value::as_u64))
        .or_else(|| item.get("context_window").and_then(Value::as_u64))
        .unwrap_or(0);
    let output = limit
        .and_then(|value| value.get("output"))
        .and_then(Value::as_u64)
        .or_else(|| item.get("max_output_tokens").and_then(Value::as_u64))
        .unwrap_or(0);
    let kind = item
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("chat")
        .to_ascii_lowercase();
    json!({
        "id": id,
        "name": name,
        "context": context,
        "output": output,
        "free": is_free(item),
        "type": kind,
    })
}

/// 上游是否声明这条模型免费：输入与输出单价都是 0。
///
/// **没有 `cost` 字段一律算不免费**。DeepSeek / Command Code 不报价格，
/// 把「没说价格」当免费会让整个清单被误判成免费池。
/// 价格既可能是数字（`0`）也可能是对象包一层，两种都认——实测 opencode 免费池是
/// `cost.text.input.price = 0`，别的地方可能直接给 `cost.input = 0`。
fn is_free(item: &Value) -> bool {
    let Some(cost) = item.get("cost") else {
        return false;
    };
    let price_of = |node: Option<&Value>| -> Option<f64> {
        let node = node?;
        if let Some(value) = node.as_f64() {
            return Some(value);
        }
        node.get("price").and_then(Value::as_f64)
    };
    let text = cost.get("text");
    let input = price_of(text.and_then(|node| node.get("input")))
        .or_else(|| price_of(cost.get("input")));
    let output = price_of(text.and_then(|node| node.get("output")))
        .or_else(|| price_of(cost.get("output")));
    match (input, output) {
        (Some(input), Some(output)) => input == 0.0 && output == 0.0,
        _ => false,
    }
}

/// 从磁盘读回某个 provider 的真实 key（只给同一个 id 用）。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_three_payload_shapes() {
        let standard: Value = serde_json::from_str(
            r#"{"data":[{"id":"a","name":"A","context_length":1000000},{"id":"b"}]}"#,
        )
        .unwrap();
        let list = collect_models(&standard);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["id"], "a");
        assert_eq!(list[0]["name"], "A");
        assert_eq!(list[0]["context"], 1000000);

        let array: Value = serde_json::from_str(r#"[{"id":"c"}]"#).unwrap();
        assert_eq!(collect_models(&array)[0]["id"], "c");

        let named: Value = serde_json::from_str(
            r#"{"models":[{"id":"d","limit":{"context":200000,"output":32000}}]}"#,
        )
        .unwrap();
        let list = collect_models(&named);
        assert_eq!(list[0]["context"], 200000);
        assert_eq!(list[0]["output"], 32000);

        assert!(collect_models(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn extract_error_reads_openai_style_message() {
        let text = r#"{"error":{"message":"Incorrect API key provided"}}"#;
        assert_eq!(extract_error(text), "Incorrect API key provided");
        assert_eq!(extract_error("plain text"), "plain text");
    }
    #[test]
    fn marks_only_zero_cost_as_free() {
        // 免费池真实形状：cost.text.input.price / cost.text.output.price
        let free: Value = serde_json::from_str(
            r#"{"data":[{"id":"deepseek-v4.1-flash-free","type":"chat","limit":{"context":200000,"output":32000},
               "cost":{"text":{"input":{"price":0},"output":{"price":0}}}}]}"#,
        )
        .unwrap();
        let list = collect_models(&free);
        assert_eq!(list[0]["free"], true);
        assert_eq!(list[0]["type"], "chat");

        // 付费：任一单价非 0 就不算免费
        let paid: Value = serde_json::from_str(
            r#"{"data":[{"id":"claude-fable-5","cost":{"text":{"input":{"price":10},"output":{"price":50}}}}]}"#,
        )
        .unwrap();
        assert_eq!(collect_models(&paid)[0]["free"], false);

        // 只有一半价格为 0 也不算免费
        let half: Value = serde_json::from_str(
            r#"{"data":[{"id":"jev","cost":{"text":{"input":{"price":0.042},"output":{"price":0}}}}]}"#,
        )
        .unwrap();
        assert_eq!(collect_models(&half)[0]["free"], false);

        // **没有 cost 字段一律不免费**（DeepSeek / Command Code 不报价格）
        let no_cost: Value = serde_json::from_str(r#"{"data":[{"id":"deepseek-chat"}]}"#).unwrap();
        assert_eq!(collect_models(&no_cost)[0]["free"], false);

        // 字符串项：不是免费，类型按 chat
        let plain: Value = serde_json::from_str(r#"["x-model"]"#).unwrap();
        let list = collect_models(&plain);
        assert_eq!(list[0]["free"], false);
        assert_eq!(list[0]["type"], "chat");
    }

    #[test]
    fn keeps_upstream_model_type() {
        let payload: Value = serde_json::from_str(
            r#"{"data":[{"id":"img","type":"image"},{"id":"rt","type":"realtime"},{"id":"plain"}]}"#,
        )
        .unwrap();
        let list = collect_models(&payload);
        assert_eq!(list[0]["type"], "image");
        assert_eq!(list[1]["type"], "realtime");
        // 缺省按 chat：多数 OpenAI 兼容接口不给这个字段
        assert_eq!(list[2]["type"], "chat");
    }

    #[test]
    fn truncate_flattens_newlines() {
        assert_eq!(truncate("a\nb", 10), "a b");
        assert_eq!(truncate("abcdefgh", 4), "abcd…");
    }
}
