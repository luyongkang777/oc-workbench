//! 第三方服务商的额度查询：`GET /local/provider/quota?id=<providerID>`
//!
//! 现状（2026-11-16 实测）：
//!   * **DeepSeek 官方**有公开接口 `GET https://api.deepseek.com/user/balance`，能给金额。
//!   * **OpenCode Go**：控制台前端调的是 `GET https://opencode.ai/console/api/go/status`，
//!     `Authorization: Bearer <oc_sk_...>` 就能读（**不需要登录 cookie**），返回里
//!     `access.meters.{fiveHour,week,month}` 各有 `limitMicroCents` / `usedMicroCents` / `resetsAt`。
//!     1 美元 = 1e8 microCents。
//!   * **Command Code**：CLI（npm `command-code`）的 `/usage` 用的是
//!     `GET https://api.commandcode.ai/alpha/whoami?limits=1`、
//!     `/alpha/billing/credits?orgId=`、`/alpha/billing/subscriptions?orgId=`、
//!     `/alpha/usage/summary?orgId=&since=`，认证就是 `Authorization: Bearer <API key>`
//!     （CLI 从 `~/.commandcode/auth.json` 或环境变量取），**不需要浏览器登录**。
//!     注意它要的是**它自己的 API key**（Studio 里生成），账号 token（`user_...`）会 401。
//!
//! 响应永远不含明文 key。

use serde_json::{json, Value};
use tiny_http::{Method, Request};

use crate::provider_store::{config_path, read_config};
use crate::rules_store::percent_decode;


pub fn handle(request: Request, path: &str, url: &str) {
    if path != "/local/provider/quota" {
        let _ = crate::server::json_error(request, 404, "未知的额度接口");
        return;
    }
    if request.method() != &Method::Get {
        let _ = crate::server::json_error(request, 405, "额度只支持 GET");
        return;
    }
    let id = param(url, "id");
    if id.is_empty() {
        let _ = crate::server::json_error(request, 400, "缺少 id");
        return;
    }
    let Some(path) = config_path(None) else {
        let _ = crate::server::json_error(request, 500, "找不到 opencode.json 的位置");
        return;
    };
    let (config, error) = read_config(&path);
    if let Some(error) = error {
        let _ = crate::server::json_error(request, 409, &error);
        return;
    }
    let Some(entry) = config.get("provider").and_then(|p| p.get(&id)) else {
        let _ = crate::server::json_error(request, 404, &format!("没有找到 provider {id}"));
        return;
    };

    let options = entry.get("options");
    // 磁盘上存的可能是本机梯子转发地址（/local/relay/<secret>/go|cc）：
    // 界面显示时会还原成上游，额度识别也必须还原，否则会被当成「没有公开接口」，
    // 连「到控制台查看」那一行都不显示（实测 OpenCode Go / Command Code 两条空白）。
    let base_url = crate::relay::to_upstream(
        options
            .and_then(|o| o.get("baseURL"))
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let api_key = options
        .and_then(|o| o.get("apiKey"))
        .and_then(Value::as_str)
        .unwrap_or("");

    let body = if is_workbuddy(&base_url) {
        let value = crate::workbuddy_billing::snapshot(true);
        if value.get("ok").and_then(Value::as_bool) == Some(true) {
            json!({
                "ok": true,
                "kind": "points",
                "credits": value.get("credits").cloned().unwrap_or(Value::Null),
                "checkin": value.get("checkin").cloned().unwrap_or(Value::Null),
                "consoleUrl": "https://www.workbuddy.cn",
            })
        } else {
            json!({
                "ok": true,
                "kind": "console",
                "consoleUrl": "https://www.workbuddy.cn",
                "note": value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("没读到 WorkBuddy 积分"),
            })
        }
    } else if is_opencode(&base_url) && !api_key.trim().is_empty() {
        match crate::provider_quota_fetch::fetch_opencode_meters(api_key) {
            Ok(meters) => {
                let mut value = json!({
                    "ok": true,
                    "kind": "meters",
                    "currency": "USD",
                    "consoleUrl": "https://opencode.ai/console",
                });
                if let Some(map) = value.as_object_mut() {
                    map.insert("meters".to_string(), meters);
                }
                value
            }
            // 拿不到（key 过期/不是 GO 套餐）就降级成「去控制台看」，不编数字
            Err(message) => json!({
                "ok": true,
                "kind": "console",
                "consoleUrl": "https://opencode.ai/console",
                "note": format!("没读到套餐额度（{message}），请到控制台查看"),
            }),
        }
    } else if crate::provider_quota_fetch::is_commandcode(&base_url) && !api_key.trim().is_empty() {
        match crate::provider_quota_fetch::fetch_commandcode_usage(api_key) {
            Ok(value) => value,
            Err(message) => json!({
                "ok": true,
                "kind": "console",
                "consoleUrl": "https://commandcode.ai/studio",
                "note": format!("没读到套餐额度（{message}），请到控制台查看"),
            }),
        }
    } else if crate::provider_quota_fetch::is_deepseek(&base_url) && !api_key.trim().is_empty() {
        match crate::provider_quota_fetch::fetch_deepseek_balance(api_key) {
            Ok(balance) => json!({
                "ok": true,
                "kind": "balance",
                "currency": balance.0,
                "total": balance.1,
                "available": balance.2,
                "consoleUrl": "https://platform.deepseek.com/top_up",
            }),
            Err(message) => json!({ "ok": false, "kind": "balance", "error": message }),
        }
    } else {
        json!({
            "ok": true,
            "kind": "console",
            "consoleUrl": console_url(&base_url),
            "note": "该服务商没有公开的额度接口，请到控制台查看",
        })
    };
    let _ = crate::server::respond_json(request, 200, body.to_string());
}

fn param(url: &str, key: &str) -> String {
    let Some((_, query)) = url.split_once('?') else {
        return String::new();
    };
    for pair in query.split('&') {
        if let Some((name, value)) = pair.split_once('=') {
            if name == key {
                return percent_decode(value);
            }
        }
    }
    String::new()
}

/// WorkBuddy 的 provider 地址是本机转发（`/local/workbuddy/v1`）。
fn is_workbuddy(base_url: &str) -> bool {
    base_url.to_ascii_lowercase().contains("/local/workbuddy/v1")
}

fn is_opencode(base_url: &str) -> bool {
    base_url.to_ascii_lowercase().contains("opencode.ai")
}

/// OpenCode GO 套餐的三个计量窗口。
///
/// 返回 `{ fiveHour: {used, limit, resetsAt}, week: {...}, month: {...} }`，
/// 金额单位统一成**美元**（microCents / 1e8），保留 2 位小数。
fn console_url(base_url: &str) -> &'static str {
    let lower = base_url.to_ascii_lowercase();
    if lower.contains("opencode.ai") {
        "https://opencode.ai/console"
    } else if lower.contains("commandcode.ai") {
        "https://commandcode.ai/studio"
    } else if lower.contains("deepseek.com") {
        "https://platform.deepseek.com/top_up"
    } else {
        // 自定义中转站：没有可指的页面，界面据此隐藏「查看额度」链接
        ""
    }
}

#[cfg(test)]
#[path = "provider_quota_tests.rs"]
mod tests;
