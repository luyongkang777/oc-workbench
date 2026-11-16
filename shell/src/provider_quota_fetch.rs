//! 各家额度接口的取数与金额换算（从 `provider_quota.rs` 拆出）。
//!
//! 路由与「拿到什么就显示什么」的判定在 `provider_quota.rs`；这里只管发请求、解析字段。

use std::time::Duration;

use serde_json::{json, Value};

/// 官方余额接口（与顶栏余额胶囊用的是同一个）。
const DEEPSEEK_BALANCE: &str = "https://api.deepseek.com/user/balance";
/// OpenCode 控制台的 GO 套餐状态（Bearer 就能读）。
const OPENCODE_GO_STATUS: &str = "https://opencode.ai/console/api/go/status";
/// Command Code 的用量接口根（与 CLI 一致）。
const COMMANDCODE_API: &str = "https://api.commandcode.ai";
const NET_TIMEOUT: Duration = Duration::from_secs(10);
const BODY_LIMIT: u64 = 64 * 1024;

pub(crate) fn fetch_opencode_meters(api_key: &str) -> Result<Value, String> {
    let value = get_json(OPENCODE_GO_STATUS, api_key)?;
    let meters = value
        .get("access")
        .and_then(|access| access.get("meters"))
        .ok_or_else(|| "响应里没有 access.meters".to_string())?;

    let mut out = serde_json::Map::new();
    for (key, label) in [
        ("fiveHour", "fiveHour"),
        ("week", "week"),
        ("month", "month"),
    ] {
        let Some(meter) = meters.get(key) else {
            continue;
        };
        let used = micro_cents_to_usd(meter.get("usedMicroCents"));
        let limit = micro_cents_to_usd(meter.get("limitMicroCents"));
        out.insert(
            label.to_string(),
            json!({
                "used": used,
                "limit": limit,
                "resetsAt": meter.get("resetsAt").and_then(Value::as_str).unwrap_or(""),
            }),
        );
    }
    if out.is_empty() {
        return Err("响应里没有可用的计量窗口".to_string());
    }
    Ok(Value::Object(out))
}

/// `"1062937656"` → `10.63`（1 美元 = 1e8 microCents）。
pub(crate) fn micro_cents_to_usd(raw: Option<&Value>) -> f64 {
    let text = match raw {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        _ => return 0.0,
    };
    let value: f64 = text.parse().unwrap_or(0.0);
    (value / 100_000_000.0 * 100.0).round() / 100.0
}

/// 带 Bearer 的 GET，返回解析后的 JSON（限制 64KB）。
fn get_json(url: &str, api_key: &str) -> Result<Value, String> {
    let agent = crate::fetch::agent(NET_TIMEOUT, Some(NET_TIMEOUT))?;
    let response = agent
        .get(url)
        .set("authorization", &format!("Bearer {}", api_key.trim()))
        .set("accept", "application/json")
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(code, _) => format!("HTTP {code}"),
            other => format!("连不上：{other}"),
        })?;
    let mut reader = response.into_reader();
    let mut bytes: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 8 * 1024];
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
            return Err("响应体过大".to_string());
        }
    }
    serde_json::from_slice(&bytes).map_err(|err| format!("响应不是 JSON：{err}"))
}

pub(crate) fn is_commandcode(base_url: &str) -> bool {
    base_url.to_ascii_lowercase().contains("commandcode.ai")
}

/// Command Code 的额度。
///
/// 实测（2026-11-16，个人账号）：
///   * `/alpha/whoami` → `org` 为 null 时**不要传 orgId**；传了会 400/403。
///   * `/alpha/billing/credits` → `credits.{monthlyCredits,purchasedCredits,freeCredits}` +
///     `windowLimits.{fiveHour,weekly}`（每个是 `{used, cap, resetAt(毫秒)}`）。
///   * `/alpha/billing/subscriptions` → `data.{planId,status,currentPeriodStart,currentPeriodEnd}`。
///   * `/alpha/usage/summary` → `totalCost`（本计费周期已花）。
pub(crate) fn fetch_commandcode_usage(api_key: &str) -> Result<Value, String> {
    let whoami = get_json(&format!("{COMMANDCODE_API}/alpha/whoami?limits=1"), api_key)?;
    // 个人账号 org 为 null：此时不能带 orgId（带了会 400 Invalid UUID / 403）
    let org_id = whoami
        .get("org")
        .and_then(|org| org.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let suffix = if org_id.is_empty() {
        String::new()
    } else {
        format!("?orgId={org_id}")
    };

    let credits = get_json(
        &format!("{COMMANDCODE_API}/alpha/billing/credits{suffix}"),
        api_key,
    )?;
    let subscription = get_json(
        &format!("{COMMANDCODE_API}/alpha/billing/subscriptions{suffix}"),
        api_key,
    )
    .unwrap_or(Value::Null);
    let summary = get_json(
        &format!("{COMMANDCODE_API}/alpha/usage/summary{suffix}"),
        api_key,
    )
    .unwrap_or(Value::Null);

    let take = |field: &str| -> f64 {
        credits
            .get("credits")
            .and_then(|c| c.get(field))
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .max(0.0)
    };
    let monthly = take("monthlyCredits");
    let purchased = take("purchasedCredits");
    let free = take("freeCredits");
    let remaining = monthly + purchased + free;

    let plan_id = subscription
        .get("data")
        .and_then(|d| d.get("planId"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let status = subscription
        .get("data")
        .and_then(|d| d.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let period_start = subscription
        .get("data")
        .and_then(|d| d.get("currentPeriodStart"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let period_end = subscription
        .get("data")
        .and_then(|d| d.get("currentPeriodEnd"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let spent = summary
        .get("totalCost")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .max(0.0);

    // 滚动窗口是**对象**不是数组：windowLimits.{fiveHour, weekly}
    let mut windows: Vec<Value> = Vec::new();
    if let Some(limits) = credits.get("windowLimits") {
        for (key, label) in [("fiveHour", "5 小时"), ("weekly", "本周")] {
            let Some(window) = limits.get(key) else {
                continue;
            };
            windows.push(json!({
                "label": label,
                "used": round2(window.get("used").and_then(Value::as_f64).unwrap_or(0.0)),
                "cap": round2(window.get("cap").and_then(Value::as_f64).unwrap_or(0.0)),
                "resetAt": window.get("resetAt").cloned().unwrap_or(Value::Null),
            }));
        }
    }

    Ok(json!({
        "ok": true,
        "kind": "credits",
        "currency": "USD",
        "plan": plan_label(plan_id),
        "status": status,
        "remaining": round2(remaining),
        "spent": round2(spent),
        "periodStart": period_start,
        "periodEnd": period_end,
        "windows": windows,
        "consoleUrl": "https://commandcode.ai/studio",
    }))
}

/// `individual-goat` → `GOAT`；未知的原样返回。
fn plan_label(plan_id: &str) -> String {
    let lower = plan_id.to_ascii_lowercase();
    let tail = lower.rsplit('-').next().unwrap_or("");
    match tail {
        "go" => "Go".to_string(),
        "goat" => "GOAT".to_string(),
        "pro" => "Pro".to_string(),
        "max" => "Max".to_string(),
        "ultra" => "Ultra".to_string(),
        "provider" => "Provider".to_string(),
        _ => plan_id.to_string(),
    }
}

/// 保留两位小数。
fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

pub(crate) fn is_deepseek(base_url: &str) -> bool {
    let lower = base_url.to_ascii_lowercase();
    lower.contains("api.deepseek.com")
}

/// 官方余额：`(币种, 金额, 是否可用)`。
pub(crate) fn fetch_deepseek_balance(api_key: &str) -> Result<(String, String, bool), String> {
    let agent = crate::fetch::agent(NET_TIMEOUT, Some(NET_TIMEOUT))?;
    let response = agent
        .get(DEEPSEEK_BALANCE)
        .set("authorization", &format!("Bearer {}", api_key.trim()))
        .set("accept", "application/json")
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(code, _) => format!("余额接口返回 HTTP {code}"),
            other => format!("连不上余额接口：{other}"),
        })?;

    let mut reader = response.into_reader();
    let mut bytes: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 8 * 1024];
    loop {
        use std::io::Read;
        let read = reader
            .read(&mut chunk)
            .map_err(|err| format!("读余额响应失败：{err}"))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() as u64 > BODY_LIMIT {
            return Err("余额响应体过大".to_string());
        }
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|err| format!("余额响应不是 JSON：{err}"))?;
    let info = value
        .get("balance_infos")
        .and_then(Value::as_array)
        .and_then(|list| list.first())
        .ok_or_else(|| "余额响应里没有 balance_infos".to_string())?;
    let currency = info
        .get("currency")
        .and_then(Value::as_str)
        .unwrap_or("CNY")
        .to_string();
    let total = info
        .get("total_balance")
        .and_then(Value::as_str)
        .unwrap_or("0.00")
        .to_string();
    let available = value
        .get("is_available")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    Ok((currency, total, available))
}

