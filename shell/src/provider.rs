//! 第三方 API 接入接口：`/local/provider/*`
//!
//! | 接口 | 作用 |
//! |---|---|
//! | `GET  /local/provider/status`  | `opencode.json` 里已有的 provider 列表（key 只有掩码） |
//! | `POST /local/provider/models`  | `{baseURL, apiKey}` → 拉 `{baseURL}/models`，回模型 id 列表 |
//! | `POST /local/provider/save`    | `{id, name, baseURL, apiKey, models[]}` 精确写一条 |
//! | `POST /local/provider/remove`  | `{id}` 只删一条 |
//! | `POST /local/provider/test`    | `{baseURL, apiKey}` → 真发一次 `/models`，只回能不能通 |
//!
//! 密钥永不回显：`status` 只给掩码；`save` 时若前端传回的是掩码原样（用户没改 key），
//! 就从磁盘读回真 key 用，不会把 `sk-1…cdef` 写进配置文件。
//!
//! 全部路由都必须排在 server.rs 的 fsapi 之前，否则会被「未知的本地文件接口」吃掉。


use serde_json::{json, Map, Value};
use tiny_http::{Method, Request};

use crate::body::{read_body_with_timeout, BodyRead};
use crate::provider_store::{config_path, provider_view, read_config, REQUEST_LIMIT};

/// 拉 `/models` 的总超时。中转站慢的时候 10 秒都不够，给足 20 秒。

pub fn handle(request: Request, path: &str, _url: &str) {
    match path.rsplit('/').next().unwrap_or("") {
        "status" => {
            if request.method() != &Method::Get {
                let _ = crate::server::json_error(request, 405, "状态只支持 GET");
                return;
            }
            let _ = crate::server::respond_json(request, 200, status_json().to_string());
        }
        "models" | "test" => {
            if request.method() != &Method::Post {
                let _ = crate::server::json_error(request, 405, "拉模型只支持 POST");
                return;
            }
            models_endpoint(request, path.ends_with("test"));
        }
        "save" => {
            if request.method() != &Method::Post {
                let _ = crate::server::json_error(request, 405, "保存只支持 POST");
                return;
            }
            crate::provider_write::save_endpoint(request);
        }
        "export" => {
            if request.method() != &Method::Get {
                let _ = crate::server::json_error(request, 405, "导出只支持 GET");
                return;
            }
            let _ = crate::server::respond_json(request, 200, crate::provider_apply::export_json().to_string());
        }
        "apply" => {
            if request.method() != &Method::Post {
                let _ = crate::server::json_error(request, 405, "应用配置只支持 POST");
                return;
            }
            crate::provider_apply::apply_endpoint(request);
        }
        "remove" => {
            if request.method() != &Method::Post {
                let _ = crate::server::json_error(request, 405, "删除只支持 POST");
                return;
            }
            crate::provider_write::remove_endpoint(request);
        }
        _ => {
            let _ = crate::server::json_error(request, 404, "未知的 provider 接口");
        }
    }
}

/// 传回来的 key 是不是「掩码」（用户没改 key）。
///
/// **空串不算掩码**：空串曾经被 all('*') 判成 true，于是「删掉 key 再保存」
/// 会走「沿用磁盘 key」分支，表现为 key 怎么也清不掉。
pub(crate) fn is_masked(key: &str) -> bool {
    let text = key.trim();
    !text.is_empty() && (text.contains('…') || text.chars().all(|c| c == '*'))
}

// ---------- GET /local/provider/status ----------

pub(crate) fn status_json() -> Value {
    let Some(path) = config_path(None) else {
        return json!({ "ok": false, "error": "找不到用户目录（USERPROFILE / HOME 都为空）" });
    };
    let (config, error) = read_config(&path);
    let providers = config
        .get("provider")
        .and_then(Value::as_object)
        .map(|map| {
            let mut list: Vec<Value> = map
                .iter()
                .map(|(id, value)| provider_view(id, value))
                .collect();
            list.sort_by(|left, right| {
                left["id"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(right["id"].as_str().unwrap_or(""))
            });
            list
        })
        .unwrap_or_default();

    json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "exists": path.exists(),
        "error": error.unwrap_or_default(),
        // 默认模型（opencode.json 顶层 model）：账号同步时要一起带过去
        "model": config.get("model").and_then(Value::as_str).unwrap_or(""),
        "providers": providers,
    })
}

// ---------- POST /local/provider/models ----------

fn models_endpoint(request: Request, probe_only: bool) {
    let Some((request, map)) = read_json(request) else {
        return;
    };
    let base_url = map.get("baseURL").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let mut api_key = map.get("apiKey").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if base_url.is_empty() {
        let _ = crate::server::json_error(request, 400, "缺少 baseURL");
        return;
    }

    // 前端把掩码原样传回来（用户没改 key）：从磁盘读回真 key。
    if is_masked(&api_key) {
        api_key = read_key_for(&api_key, map.get("id").and_then(Value::as_str)).unwrap_or_default();
    }
    if api_key.is_empty() {
        let _ = crate::server::json_error(request, 400, "缺少 apiKey");
        return;
    }

    match crate::provider_models::fetch_models(&base_url, &api_key) {
        Ok(models) => {
            let body = if probe_only {
                json!({ "ok": true, "count": models.len(), "models": models })
            } else {
                json!({ "ok": true, "models": models })
            };
            let _ = crate::server::respond_json(request, 200, body.to_string());
        }
        Err(message) => {
            let _ = crate::server::json_error(request, 502, &message);
        }
    }
}

/// 真发一次 `GET {baseURL}/models`。
///
/// 返回 `[{id, name, context, output}]`，字段来源（各家叫法不同，实测）：
///   * 名称：`name`
///   * 上下文：`limit.context`（opencode zen）/ `context_length`（Command Code）/
///     `context_window`（DeepSeek）
///   * 输出：`limit.output` / `max_output_tokens`
pub(crate) fn read_key_for(masked: &str, id: Option<&str>) -> Option<String> {
    let path = config_path(None)?;
    let (config, _) = read_config(&path);
    let providers = config.get("provider")?.as_object()?;
    // 只认同一个 id：没有 id 或 id 对不上就返回 None（调用方回 400「缺少 apiKey」），
    // 不做「按掩码在其它 provider 里找」——那是把别人的 key 借出来的口子。
    let id = id?;
    let entry = providers.get(id)?;
    let real = entry
        .get("options")
        .and_then(|options| options.get("apiKey"))
        .and_then(Value::as_str)?;
    // 传进来的掩码必须和这条 provider 的真 key 对得上，否则不给
    if !masked.trim().is_empty() && crate::provider_store::mask_key(real) != masked.trim() {
        return None;
    }
    Some(real.to_string())
}

// ---------- POST /local/provider/save ----------

// parse_models 在 provider_write.rs 里实现，这里转出给 provider_apply 用
pub(crate) use crate::provider_write::parse_models;

pub(crate) fn read_json(request: Request) -> Option<(Request, Map<String, Value>)> {
    let (request, body) = read_body_with_timeout(request, REQUEST_LIMIT)?;
    let text = match body {
        BodyRead::Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
        BodyRead::TooLarge => {
            let _ = crate::server::json_error(request, 413, "请求体过大");
            return None;
        }
        BodyRead::Failed(err) => {
            let _ = crate::server::json_error(request, 400, &format!("读取请求体失败：{err}"));
            return None;
        }
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Some((request, map)),
        Ok(_) => {
            let _ = crate::server::json_error(request, 400, "请求体必须是 JSON 对象");
            None
        }
        Err(err) => {
            let _ = crate::server::json_error(request, 400, &format!("请求体不是 JSON：{err}"));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_masked_treats_empty_as_real_key() {
        // 空串必须是「真 key 为空」而不是掩码，否则 key 永远清不掉。
        assert!(!is_masked(""));
        assert!(!is_masked("   "));
        assert!(is_masked("sk-1…cdef"));
        assert!(is_masked("********"));
        assert!(!is_masked("sk-1234567890abcdef"));
    }
}

