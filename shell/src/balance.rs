//! DeepSeek 官方余额：`/local/balance` 系列接口。
//!
//! | 接口 | 作用 |
//! |---|---|
//! | `GET  /local/balance`          | 查余额（30 秒缓存，`?refresh=1` 绕过） |
//! | `GET  /local/balance/status`   | 当前 key 状态：来源、掩码、magpie 里有没有可读的官方 key |
//! | `POST /local/balance/key`      | `{"key":"sk-..."}` 保存；`{"action":"clear"}` 清除 |
//! | `POST /local/balance/detect`   | 主动从 magpie 读官方 key 并保存（用户点按钮才做） |
//!
//! 默认**不碰 magpie**：密钥只认 `settings.json` 的 `deepseekApiKey` 与环境变量
//! `DEEPSEEK_API_KEY`。只有在面板上点「从 magpie 读取」时，才会去读一次并落盘，
//! 免得换了个中转站就显示别人账号的余额。
//!
//! 响应里**永远不带完整 key**，只有掩码（`sk-9fc…e0ff`）。

use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tiny_http::{Method, Request};

use crate::body::{read_body_with_timeout, BodyRead};

/// 官方余额接口。
const BALANCE_URL: &str = "https://api.deepseek.com/user/balance";
/// 余额缓存时长（毫秒级防抖，不是「省请求」）。
///
/// 界面要的是「花了钱马上能看到」：一次对话会连着发好几次请求（轮询、切回窗口、
/// 每轮模型调用结束），这些几乎同时到达。缓存 4 秒只为了别把同一个查询打三遍，
/// 超过 4 秒一律重新问官方；带 `refresh=1` 的则完全绕过缓存。
const CACHE_TTL: Duration = Duration::from_secs(4);
/// 单次请求上限。官方接口正常几十毫秒，挂住时不能让页面等太久。
const NET_TIMEOUT: Duration = Duration::from_secs(10);
/// 响应体上限：官方就几百字节，给 64KB 足够，防异常响应撑爆内存。
const BODY_LIMIT: u64 = 64 * 1024;
/// 写 key 的请求体上限（一个 key 才几十字节）。
const REQUEST_LIMIT: usize = 8 * 1024;
/// settings.json 里存 key 的字段名。
const SETTING_KEY: &str = "deepseekApiKey";

struct Cached {
    body: String,
    at: Instant,
}

/// 进程内缓存。只缓存成功结果：失败要能立刻重试（换 key、断网恢复）。
static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

pub fn handle(request: Request, path: &str, url: &str) {
    match path {
        "/local/balance" => balance_endpoint(request, url),
        "/local/balance/status" => status_endpoint(request),
        "/local/balance/key" => key_endpoint(request),
        "/local/balance/detect" => detect_endpoint(request),
        _ => {
            let _ = crate::server::json_error(request, 404, "未知的余额接口");
        }
    }
}

// ---------- GET /local/balance ----------

fn balance_endpoint(request: Request, url: &str) {
    if request.method() != &Method::Get {
        let _ = crate::server::json_error(request, 405, "余额只支持 GET");
        return;
    }
    let force = url.contains("refresh=1");

    if !force {
        if let Ok(guard) = CACHE.lock() {
            if let Some(cached) = guard.as_ref() {
                if cached.at.elapsed() < CACHE_TTL {
                    let body = with_cached_flag(&cached.body, true);
                    let _ = crate::server::respond_json(request, 200, body);
                    return;
                }
            }
        }
    }

    let body = match load_balance() {
        Ok(body) => {
            if let Ok(mut guard) = CACHE.lock() {
                *guard = Some(Cached {
                    body: body.clone(),
                    at: Instant::now(),
                });
            }
            with_cached_flag(&body, false)
        }
        Err(err) => json!({ "ok": false, "error": err }).to_string(),
    };
    let _ = crate::server::respond_json(request, 200, body);
}

// ---------- GET /local/balance/status ----------

fn status_endpoint(request: Request) {
    if request.method() != &Method::Get {
        let _ = crate::server::json_error(request, 405, "状态只支持 GET");
        return;
    }
    let _ = crate::server::respond_json(request, 200, status_value().to_string());
}

// ---------- POST /local/balance/key ----------

fn key_endpoint(request: Request) {
    if request.method() != &Method::Post {
        let _ = crate::server::json_error(request, 405, "保存密钥只支持 POST");
        return;
    }
    let Some(body) = read_json(request) else {
        return;
    };
    let (request, value) = body;

    if value.get("action").and_then(Value::as_str) == Some("clear") {
        match crate::update::set_text_setting(SETTING_KEY, None) {
            Ok(()) => {
                invalidate_cache();
                crate::append_log("[balance] 已清除 DeepSeek 密钥\n");
                let _ = crate::server::respond_json(request, 200, status_value().to_string());
            }
            Err(err) => {
                let _ = crate::server::json_error(request, 500, &format!("清除密钥失败：{err}"));
            }
        }
        return;
    }

    let raw = value.get("key").and_then(Value::as_str).unwrap_or_default();
    let key = match normalize_key(raw) {
        Ok(key) => key,
        Err(message) => {
            let _ = crate::server::json_error(request, 400, &message);
            return;
        }
    };
    match crate::update::set_text_setting(SETTING_KEY, Some(&key)) {
        Ok(()) => {
            invalidate_cache();
            crate::append_log(&format!(
                "[balance] 已保存 DeepSeek 密钥 {}（{} 位）\n",
                mask_key(&key),
                key.chars().count()
            ));
            let _ = crate::server::respond_json(request, 200, status_value().to_string());
        }
        Err(err) => {
            let _ = crate::server::json_error(request, 500, &format!("保存密钥失败：{err}"));
        }
    }
}

// ---------- POST /local/balance/detect ----------

fn detect_endpoint(request: Request) {
    if request.method() != &Method::Post {
        let _ = crate::server::json_error(request, 405, "自动读取只支持 POST");
        return;
    }
    // 不需要请求体，但也要把它读完，否则连接会挂着。
    let Some((request, _)) = read_body_with_timeout(request, REQUEST_LIMIT) else {
        return;
    };
    let Some(key) = magpie_key() else {
        let _ = crate::server::json_error(
            request,
            404,
            "magpie 里没有找到 DeepSeek 官方密钥（~/.config/magpie/providers.json 的 id=deepseek）",
        );
        return;
    };
    match crate::update::set_text_setting(SETTING_KEY, Some(&key)) {
        Ok(()) => {
            invalidate_cache();
            crate::append_log(&format!(
                "[balance] 已从 magpie 读取官方密钥 {} 并保存\n",
                mask_key(&key)
            ));
            let _ = crate::server::respond_json(request, 200, status_value().to_string());
        }
        Err(err) => {
            let _ = crate::server::json_error(request, 500, &format!("保存密钥失败：{err}"));
        }
    }
}

/// 读 JSON 请求体；出错时自己回响应并返回 None。
fn read_json(request: Request) -> Option<(Request, Value)> {
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
        Ok(value) => Some((request, value)),
        Err(err) => {
            let _ = crate::server::json_error(request, 400, &format!("请求体不是 JSON：{err}"));
            None
        }
    }
}

/// 当前 key 状态（不含完整 key）。
fn status_value() -> Value {
    let settings_key = key_from_settings();
    let env_key = key_from_env();
    let (source, key) = match (&settings_key, &env_key) {
        (Some(key), _) => ("settings", Some(key.clone())),
        (None, Some(key)) => ("env", Some(key.clone())),
        _ => ("none", None),
    };
    let magpie = magpie_key();
    json!({
        "configured": key.is_some(),
        "source": source,
        "masked": key.as_deref().map(mask_key).unwrap_or_default(),
        "hasMagpie": magpie.is_some(),
        "magpieMasked": magpie.as_deref().map(mask_key).unwrap_or_default(),
    })
}

/// `sk-9fc7bba2790c40f19aed3deda883e0ff` → `sk-9fc…e0ff`。
fn mask_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 10 {
        return "•".repeat(chars.len().max(4));
    }
    let head: String = chars.iter().take(6).collect();
    let tail: String = chars.iter().skip(chars.len() - 4).collect();
    format!("{head}…{tail}")
}

/// 校验用户填的 key：官方是 `sk-` + 32 位十六进制（历史上也有更长的）。
fn normalize_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    if key.is_empty() {
        return Err("密钥不能为空".to_string());
    }
    if !key.starts_with("sk-") {
        return Err("DeepSeek 官方密钥以 sk- 开头".to_string());
    }
    if key.chars().count() < 20 {
        return Err("密钥长度不对（官方是 sk- 后 32 位十六进制）".to_string());
    }
    if key.chars().count() > 200 {
        return Err("密钥过长".to_string());
    }
    Ok(key.to_string())
}

fn invalidate_cache() {
    if let Ok(mut guard) = CACHE.lock() {
        *guard = None;
    }
}

/// 把 `cached` 字段补进响应（缓存命中时前端可以知道这是旧值）。
fn with_cached_flag(body: &str, cached: bool) -> String {
    match serde_json::from_str::<Value>(body) {
        Ok(mut value) => {
            if let Some(map) = value.as_object_mut() {
                map.insert("cached".to_string(), Value::Bool(cached));
            }
            value.to_string()
        }
        Err(_) => body.to_string(),
    }
}

/// 真正去拿一次余额：找 key → 请求 → 清洗成页面要的字段。
fn load_balance() -> Result<String, String> {
    let Some((key, source)) = resolve_key() else {
        return Err(
            "没有找到 DeepSeek 官方密钥：点余额胶囊填入 sk，或设置环境变量 DEEPSEEK_API_KEY"
                .to_string(),
        );
    };
    let raw = fetch_balance(&key)?;
    summarize(&raw, source, now_secs())
}

/// 按优先级找一个可用的 key（返回 key 与来源标签）。
fn resolve_key() -> Option<(String, &'static str)> {
    if let Some(key) = key_from_settings() {
        return Some((key, "settings"));
    }
    key_from_env().map(|key| (key, "env"))
}

fn key_from_settings() -> Option<String> {
    crate::update::text_setting(SETTING_KEY)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn key_from_env() -> Option<String> {
    std::env::var("DEEPSEEK_API_KEY")
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// 读 magpie 配置里官方 deepseek 的 key。**只在用户主动点「从 magpie 读取」时调用。**
fn magpie_key() -> Option<String> {
    let path = home()?
        .join(".config")
        .join("magpie")
        .join("providers.json");
    let text = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    pick_magpie_key(&value)
}

/// 从 magpie 的配置里挑出官方 deepseek 的 key。
///
/// 实测结构是 `{"providers":{"0":{...},"1":{"id":"deepseek","key":"sk-..."},...},"deleted":{}}`
/// —— `providers` 是「键为数字序号的对象」（有时是数组），**不是**按 id 命名的字典。
/// 所以只能遍历所有条目按 `id` 找，不能直接 `providers["deepseek"]`。
fn pick_magpie_key(value: &Value) -> Option<String> {
    let list = value.get("providers")?;
    let items: Vec<&Value> = match list {
        Value::Array(items) => items.iter().collect(),
        Value::Object(map) => map.values().collect(),
        _ => return None,
    };
    items
        .into_iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some("deepseek"))
        .and_then(|item| item.get("key"))
        .and_then(Value::as_str)
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
}

fn fetch_balance(key: &str) -> Result<String, String> {
    let agent = crate::fetch::agent(NET_TIMEOUT, Some(NET_TIMEOUT))?;
    let response = agent
        .get(BALANCE_URL)
        .set("authorization", &format!("Bearer {key}"))
        .set("accept", "application/json")
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(401, _) => {
                "DeepSeek 返回 401：密钥无效或已失效（点余额胶囊重新填一个）".to_string()
            }
            ureq::Error::Status(code, _) => format!("余额接口返回 HTTP {code}"),
            other => format!("访问 DeepSeek 余额接口失败：{other}"),
        })?;

    let mut text = String::new();
    response
        .into_reader()
        .take(BODY_LIMIT)
        .read_to_string(&mut text)
        .map_err(|err| format!("读取余额响应失败：{err}"))?;
    Ok(text)
}

/// 官方返回：
/// `{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"12.24",
///   "granted_balance":"0.00","topped_up_balance":"12.24"}]}`
///
/// 有多个币种时优先人民币（用户看的是自己充的那个），没有就取第一条。
fn summarize(raw: &str, source: &str, now: u64) -> Result<String, String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|err| format!("余额响应不是 JSON：{err}"))?;
    let infos = value
        .get("balance_infos")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let Some(pick) = pick_info(&infos) else {
        return Err("余额响应里没有 balance_infos（账号可能还没开通）".to_string());
    };
    // 官方现在给的是字符串（"12.24"）。万一哪天改成数字，不能静默变成 0.00，
    // 否则低余额/不可用的判断会跟着错。
    let field = |name: &str| -> String {
        match pick.get(name) {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Number(num)) => num
                .as_f64()
                .map(|value| format!("{value:.2}"))
                .unwrap_or_else(|| num.to_string()),
            _ => "0.00".to_string(),
        }
    };
    Ok(json!({
        "ok": true,
        "source": source,
        "currency": pick.get("currency").and_then(Value::as_str).unwrap_or("CNY"),
        "total": field("total_balance"),
        "granted": field("granted_balance"),
        "toppedUp": field("topped_up_balance"),
        "available": value.get("is_available").and_then(Value::as_bool).unwrap_or(false),
        "fetchedAt": now,
    })
    .to_string())
}

/// 优先 CNY；否则第一条。
fn pick_info(infos: &[Value]) -> Option<&Value> {
    infos
        .iter()
        .find(|info| info.get("currency").and_then(Value::as_str) == Some("CNY"))
        .or_else(|| infos.first())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{mask_key, normalize_key, pick_info, pick_magpie_key, summarize};
    use serde_json::json;

    const CNY_ONLY: &str = r#"{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"12.24","granted_balance":"0.00","topped_up_balance":"12.24"}]}"#;

    #[test]
    fn summarize_keeps_official_fields() {
        let out = summarize(CNY_ONLY, "settings", 1794770000).expect("应解析成功");
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value["ok"], json!(true));
        assert_eq!(value["source"], json!("settings"));
        assert_eq!(value["currency"], json!("CNY"));
        assert_eq!(value["total"], json!("12.24"));
        assert_eq!(value["granted"], json!("0.00"));
        assert_eq!(value["toppedUp"], json!("12.24"));
        assert_eq!(value["available"], json!(true));
        assert_eq!(value["fetchedAt"], json!(1794770000u64));
    }

    #[test]
    fn summarize_prefers_cny_when_multiple_currencies() {
        let raw = r#"{"is_available":true,"balance_infos":[
            {"currency":"USD","total_balance":"1.00","granted_balance":"0.00","topped_up_balance":"1.00"},
            {"currency":"CNY","total_balance":"12.24","granted_balance":"0.50","topped_up_balance":"11.74"}
        ]}"#;
        let value: serde_json::Value =
            serde_json::from_str(&summarize(raw, "env", 1).unwrap()).unwrap();
        assert_eq!(value["currency"], json!("CNY"));
        assert_eq!(value["total"], json!("12.24"));
        assert_eq!(value["granted"], json!("0.50"));
    }

    #[test]
    fn summarize_falls_back_to_first_when_no_cny() {
        let raw =
            r#"{"is_available":false,"balance_infos":[{"currency":"USD","total_balance":"3.50"}]}"#;
        let value: serde_json::Value =
            serde_json::from_str(&summarize(raw, "env", 1).unwrap()).unwrap();
        assert_eq!(value["currency"], json!("USD"));
        assert_eq!(value["total"], json!("3.50"));
        // 缺的字段补 0.00，界面不用做空值判断
        assert_eq!(value["granted"], json!("0.00"));
        assert_eq!(value["available"], json!(false));
    }

    #[test]
    fn summarize_rejects_broken_payloads() {
        assert!(summarize("not json", "env", 1).is_err());
        assert!(summarize("{}", "env", 1).is_err());
        assert!(summarize(r#"{"is_available":true,"balance_infos":[]}"#, "env", 1).is_err());
    }

    #[test]
    fn pick_info_handles_missing_currency() {
        let infos = vec![json!({"total_balance":"1.00"})];
        assert!(pick_info(&infos).is_some());
        assert!(pick_info(&[]).is_none());
    }

    #[test]
    fn cached_flag_is_added_without_touching_fields() {
        let out = super::with_cached_flag(CNY_ONLY, true);
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value["cached"], json!(true));
        assert_eq!(value["balance_infos"][0]["total_balance"], json!("12.24"));
        // 非 JSON 原样返回，不要让坏响应变成 500
        assert_eq!(super::with_cached_flag("oops", true), "oops");
    }

    #[test]
    fn mask_never_leaks_the_middle() {
        let masked = mask_key("sk-9fc7bba2790c40f19aed3deda883e0ff");
        assert_eq!(masked, "sk-9fc…e0ff");
        assert!(!masked.contains("bba2790c"));
        // 太短的 key 整体打码，不留前缀
        assert_eq!(mask_key("sk-abc"), "••••••");
        assert_eq!(mask_key(""), "••••");
    }

    #[test]
    fn normalize_key_accepts_official_shape_and_rejects_junk() {
        assert_eq!(
            normalize_key("  sk-9fc7bba2790c40f19aed3deda883e0ff  ").unwrap(),
            "sk-9fc7bba2790c40f19aed3deda883e0ff"
        );
        assert!(normalize_key("").is_err());
        assert!(normalize_key("   ").is_err());
        assert!(normalize_key("9fc7bba2790c40f19aed3deda883e0ff").is_err());
        assert!(normalize_key("sk-short").is_err());
        assert!(normalize_key(&format!("sk-{}", "a".repeat(300))).is_err());
    }

    #[test]
    fn pick_magpie_key_reads_indexed_object() {
        // 本机 magpie 的真实形状：providers 是键为数字序号的对象
        let value: serde_json::Value = serde_json::from_str(
            r#"{"providers":{
                "0":{"id":"openai","key":"sk-other"},
                "1":{"id":"deepseek","key":"sk-0123456789abcdef0123456789abcdef"},
                "2":{"id":"mimo","key":"sk-third"}
            },"deleted":{}}"#,
        )
        .unwrap();
        assert_eq!(
            pick_magpie_key(&value).as_deref(),
            Some("sk-0123456789abcdef0123456789abcdef")
        );
    }

    #[test]
    fn pick_magpie_key_reads_array_and_guards_empty() {
        let array: serde_json::Value =
            serde_json::from_str(r#"{"providers":[{"id":"deepseek","key":"  sk-abc  "}]}"#).unwrap();
        assert_eq!(pick_magpie_key(&array).as_deref(), Some("sk-abc"));

        let empty: serde_json::Value =
            serde_json::from_str(r#"{"providers":[{"id":"deepseek","key":"   "}]}"#).unwrap();
        assert_eq!(pick_magpie_key(&empty), None);

        let missing: serde_json::Value =
            serde_json::from_str(r#"{"providers":[{"id":"openai","key":"sk-x"}]}"#).unwrap();
        assert_eq!(pick_magpie_key(&missing), None);

        let no_list: serde_json::Value = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(pick_magpie_key(&no_list), None);
    }
}
