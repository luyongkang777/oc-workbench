//! WorkBuddy 的积分与签到：`/local/workbuddy/billing`、`/local/workbuddy/checkin`。
//!
//! 接口从 WorkBuddy 桌面客户端（app.asar）里扒出来：
//!
//! | 上游 | 作用 |
//! |---|---|
//! | `POST /v2/billing/meter/checkin-activity-status` | 签到活动：`today_checked_in` / `streak_days` / `daily_credit` / `today_credit` / `total_credits` |
//! | `POST /v2/billing/meter/daily-checkin` | 执行签到，返回本次 `credit` 与 `streak_days` |
//!
//! 这个版本（WorkBuddy 桌面版，域名 www.workbuddy.cn）**没有** `get-user-resource-summary`
//! 那一套额度接口（实测 404），积分就是签到活动里的 `total_credits`，所以这里只读它。
//!
//! 认证头：`Authorization: Bearer <access>` + `X-User-Id`（有 domain 时带 `X-Domain`）。
//!
//! 「自动签到」：`billing?auto=1` 时，如果今天还没签到就顺手签一次；
//! 结果缓存 30 秒，两次自动尝试至少间隔 10 分钟（上游每天只认一次）。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tiny_http::{Method, Request};

use crate::workbuddy::load;
use crate::workbuddy_http::raw;
use crate::workbuddy_store::{now_ms, Auth};
use crate::workbuddy_util::{code_of, field_str};

/// 余额缓存：面板打开/轮询时别每次都打腾讯接口。
const CACHE_TTL: Duration = Duration::from_secs(30);
/// 两次自动签到尝试的最小间隔。
const CHECKIN_GAP_MS: i64 = 10 * 60 * 1000;

struct Cached {
    body: String,
    at: Instant,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);
/// 上次自动签到的毫秒时间戳（0 = 从没试过）。
static LAST_AUTO: Mutex<i64> = Mutex::new(0);

pub fn handle(request: Request, path: &str, url: &str) {
    match path {
        "/local/workbuddy/billing" => billing_endpoint(request, url),
        "/local/workbuddy/checkin" => checkin_endpoint(request),
        _ => {
            let _ = crate::server::json_error(request, 404, "未知的 WorkBuddy 额度接口");
        }
    }
}

fn billing_endpoint(request: Request, url: &str) {
    if request.method() != &Method::Get {
        let _ = crate::server::json_error(request, 405, "额度只支持 GET");
        return;
    }
    let auto = url.contains("auto=1");
    let force = url.contains("refresh=1");
    let body = billing_json(auto, force);
    let _ = crate::server::respond_json(request, 200, body.to_string());
}

fn checkin_endpoint(request: Request) {
    if request.method() != &Method::Post {
        let _ = crate::server::json_error(request, 405, "签到只支持 POST");
        return;
    }
    let auth = load();
    if !auth.configured() {
        let _ = crate::server::respond_json(
            request,
            200,
            json!({ "ok": false, "error": "还没登录 WorkBuddy" }).to_string(),
        );
        return;
    }
    let body = match claim(&auth) {
        Ok(claim) => {
            clear_cache();
            let fresh = billing_json(false, true);
            json!({ "ok": true, "claim": claim, "billing": fresh })
        }
        Err(err) => json!({ "ok": false, "error": err }),
    };
    let _ = crate::server::respond_json(request, 200, body.to_string());
}

/// 给「第三方 API 接入」的 provider 额度用：登录了就返回积分+签到状态。
pub(crate) fn snapshot(auto: bool) -> Value {
    billing_json(auto, false)
}

fn billing_json(auto: bool, force: bool) -> Value {
    let auth = load();
    if !auth.configured() {
        return json!({ "ok": false, "error": "还没登录 WorkBuddy" });
    }
    if !force {
        if let Ok(guard) = CACHE.lock() {
            if let Some(cached) = guard.as_ref() {
                if cached.at.elapsed() < CACHE_TTL {
                    let mut value: Value =
                        serde_json::from_str(&cached.body).unwrap_or_else(|_| json!({}));
                    if let Some(map) = value.as_object_mut() {
                        map.insert("cached".to_string(), Value::Bool(true));
                    }
                    return value;
                }
            }
        }
    }

    let mut status = match checkin_status(&auth) {
        Ok(value) => value,
        Err(err) => return json!({ "ok": false, "error": err }),
    };
    let mut checked_in_now = false;

    // 自动签到：今天还没签、且离上次尝试够久
    if auto && status.get("todayCheckedIn").and_then(Value::as_bool) == Some(false) {
        if let Ok(mut last) = LAST_AUTO.lock() {
            if now_ms() - *last >= CHECKIN_GAP_MS {
                *last = now_ms();
                if claim(&auth).is_ok() {
                    checked_in_now = true;
                    if let Ok(fresh) = checkin_status(&auth) {
                        status = fresh;
                    }
                }
            }
        }
    }

    let body = json!({
        "ok": true,
        "credits": {
            "total": status.get("totalCredits").cloned().unwrap_or(json!(0)),
            "today": status.get("todayCredit").cloned().unwrap_or(json!(0)),
            "daily": status.get("dailyCredit").cloned().unwrap_or(json!(0)),
        },
        "checkin": status,
        "checkedInNow": checked_in_now,
        "updatedAt": now_ms(),
    });
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(Cached {
            body: body.to_string(),
            at: Instant::now(),
        });
    }
    body
}

fn clear_cache() {
    if let Ok(mut guard) = CACHE.lock() {
        *guard = None;
    }
}

/// 认证头（与桌面端 `buildHeaders` 一致）。
fn headers(auth: &Auth) -> Vec<(&'static str, String)> {
    let mut list: Vec<(&'static str, String)> = vec![
        ("Authorization", format!("Bearer {}", auth.access)),
        ("X-User-Id", auth.uid.clone()),
    ];
    if !auth.enterprise.is_empty() {
        list.push(("X-Enterprise-Id", auth.enterprise.clone()));
        list.push(("X-Tenant-Id", auth.enterprise.clone()));
    }
    if !auth.domain.is_empty() {
        list.push(("X-Domain", auth.domain.clone()));
    }
    list
}

/// 签到状态。
fn checkin_status(auth: &Auth) -> Result<Value, String> {
    let head = headers(auth);
    let (status, value) = raw(
        "POST",
        "/v2/billing/meter/checkin-activity-status",
        &head,
        Some(&json!({})),
    )?;
    if status != 200 {
        return Err(format!("WorkBuddy 返回 HTTP {status}"));
    }
    if code_of(&value) != 0 {
        return Err(format!(
            "WorkBuddy 返回 code {} {}",
            code_of(&value),
            field_str(&value, "msg")
        ));
    }
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    if data.is_null() {
        return Err("WorkBuddy 没有返回签到数据".to_string());
    }
    Ok(json!({
        "active": data.get("active").and_then(Value::as_bool).unwrap_or(false),
        "todayCheckedIn": data.get("today_checked_in").and_then(Value::as_bool).unwrap_or(false),
        "streakDays": data.get("streak_days").and_then(Value::as_i64).unwrap_or(0),
        "dailyCredit": data.get("daily_credit").and_then(Value::as_f64).unwrap_or(0.0),
        "todayCredit": data.get("today_credit").and_then(Value::as_f64).unwrap_or(0.0),
        "totalCredits": data.get("total_credits").and_then(Value::as_f64).unwrap_or(0.0),
    }))
}

/// 执行签到，返回本次获得多少积分。
fn claim(auth: &Auth) -> Result<Value, String> {
    let head = headers(auth);
    let (status, value) = raw(
        "POST",
        "/v2/billing/meter/daily-checkin",
        &head,
        Some(&json!({})),
    )?;
    if status != 200 {
        return Err(format!("签到失败：HTTP {status}"));
    }
    let code = code_of(&value);
    if code != 0 {
        return Err(format!("签到失败：code {code} {}", field_str(&value, "msg")));
    }
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    Ok(json!({
        "credit": data.get("credit").and_then(Value::as_f64).unwrap_or(0.0),
        "streakDays": data.get("streak_days").and_then(Value::as_i64).unwrap_or(0),
        "isStreakDay": data.get("is_streak_day").and_then(Value::as_bool).unwrap_or(false),
    }))
}
