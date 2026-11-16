//! 用量统计：`GET /local/usage?period=today|7d|30d|all`
//!
//! 两个数据源：
//!
//!   1. magpie 的 `~/.config/magpie/usage.jsonl`（走网关的调用）；
//!   2. opencode 的会话库 `~/.local/share/opencode/opencode.db`（本地会话，
//!      不走网关的请求也在这里）。
//!
//! 口径对齐 magpie 自己的用量页：
//!
//!   * token 主数默认含缓存（输入 + 输出 + 缓存读写），可切成不含缓存；
//!   * 缓存命中率 = cache_read / (input + cache_read + cache_write)；
//!   * 费用按 models.dev 的单价估算（`usage_price`，认不出就计入「未计价」）；
//!   * 今天按小时分桶，其它范围按天分桶。
//!
//! 两边会重叠（走网关的请求在两张表里都有）：网关日志里 `agent == opencode`
//! 的记录直接丢掉，由会话库统一代表「本地会话」。

use std::path::PathBuf;

use tiny_http::{Method, Request};

use crate::rules_store::percent_decode;

#[path = "usage_agg.rs"]
mod usage_agg;
#[path = "usage_record.rs"]
mod usage_record;
#[path = "usage_series.rs"]
mod usage_series;
#[path = "usage_session.rs"]
mod usage_session;
#[path = "usage_price.rs"]
mod usage_price;

/// 时间范围。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Period {
    Today,
    Week,
    Month,
    All,
}

impl Period {
    pub fn as_str(self) -> &'static str {
        match self {
            Period::Today => "today",
            Period::Week => "7d",
            Period::Month => "30d",
            Period::All => "all",
        }
    }

    pub fn parse(text: &str) -> Period {
        match text.trim() {
            "today" => Period::Today,
            "7d" => Period::Week,
            "30d" => Period::Month,
            _ => Period::All,
        }
    }

}

/// 一次查询：范围 + 可选的服务商 / 客户端过滤。
pub struct Query {
    pub period: Period,
    pub provider: Option<String>,
    pub agent: Option<String>,
}

/// 日志位置：环境变量优先（测试和自定义安装用），否则 magpie 默认目录。
pub fn log_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("OCW_USAGE_LOG") {
        return Some(PathBuf::from(path));
    }
    crate::provider_store::home()
        .map(|dir| dir.join(".config").join("magpie").join("usage.jsonl"))
}

/// 启动时后台预热：第一次打开用量页不用等（网关日志 50MB、会话库 9 万行）。
pub fn warm() {
    if let Some(path) = log_path() {
        usage_agg::warm_gateway(&path);
    }
    let _ = usage_session::load();
}

pub fn handle(request: Request, path: &str, url: &str) {
    if path != "/local/usage" {
        let _ = crate::server::json_error(request, 404, "未知的用量接口");
        return;
    }
    if request.method() != &Method::Get {
        let _ = crate::server::json_error(request, 405, "用量只支持 GET");
        return;
    }
    let query = Query {
        period: Period::parse(&param(url, "period")),
        provider: non_empty(param(url, "provider")),
        agent: non_empty(param(url, "agent")),
    };
    match usage_agg::summary(&query) {
        Ok(body) => {
            let _ = crate::server::respond_json(request, 200, body);
        }
        Err(message) => {
            let body = serde_json::json!({ "ok": false, "error": message }).to_string();
            let _ = crate::server::respond_json(request, 200, body);
        }
    }
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

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

// ---------------------------------------------------------------------------
// 本地日期与分桶
// ---------------------------------------------------------------------------

/// Win32 的 SYSTEMTIME（字段顺序固定）。
#[cfg(windows)]
#[repr(C)]
pub struct SystemTime {
    pub year: u16,
    pub month: u16,
    pub day_of_week: u16,
    pub day: u16,
    pub hour: u16,
    pub minute: u16,
    pub second: u16,
    pub milliseconds: u16,
}

#[cfg(windows)]
fn blank_time() -> SystemTime {
    SystemTime {
        year: 0,
        month: 0,
        day_of_week: 0,
        day: 0,
        hour: 0,
        minute: 0,
        second: 0,
        milliseconds: 0,
    }
}

/// 今天的本地日期（年, 月, 日）。
///
/// 不用 chrono：整个项目零第三方时间依赖，这里只需要拿到当天日期。
/// 日志里的 `t` 字段本来就是带本地时区的 ISO 字符串，取前 10 位就是本地日期。
#[cfg(windows)]
pub fn today() -> (i32, u32, u32) {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetLocalTime(out: *mut SystemTime);
    }
    let mut now = blank_time();
    unsafe { GetLocalTime(&mut now) };
    if now.year == 0 || now.month == 0 || now.day == 0 {
        return (1970, 1, 1);
    }
    (now.year as i32, now.month as u32, now.day as u32)
}

#[cfg(not(windows))]
pub fn today() -> (i32, u32, u32) {
    // 非 Windows 只用于测试/开发：用系统时间换算 UTC 日期。
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    civil_from_days(secs / 86_400)
}

/// UNIX 毫秒 → 本地的（年, 月, 日, 时）。会话库的时间戳是 UTC，必须转本地。
#[cfg(windows)]
pub fn local_parts(ms: i64) -> Option<(i32, u32, u32, u32)> {
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn FileTimeToSystemTime(file_time: *const FileTime, system_time: *mut SystemTime) -> i32;
        fn SystemTimeToTzSpecificLocalTime(
            zone: *const std::ffi::c_void,
            universal: *const SystemTime,
            local: *mut SystemTime,
        ) -> i32;
    }
    // 1601-01-01 → 1970-01-01 的 100ns 数
    const EPOCH_DIFF: i64 = 116_444_736_000_000_000;
    let ticks = ms.checked_mul(10_000)?.checked_add(EPOCH_DIFF)?;
    let file_time = FileTime {
        low: (ticks & 0xFFFF_FFFF) as u32,
        high: ((ticks >> 32) & 0xFFFF_FFFF) as u32,
    };
    let mut utc = blank_time();
    if unsafe { FileTimeToSystemTime(&file_time, &mut utc) } == 0 {
        return None;
    }
    let mut local = blank_time();
    if unsafe { SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut local) } == 0 {
        return None;
    }
    Some((
        local.year as i32,
        local.month as u32,
        local.day as u32,
        local.hour as u32,
    ))
}

#[cfg(not(windows))]
pub fn local_parts(ms: i64) -> Option<(i32, u32, u32, u32)> {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    Some((y, m, d, (secs.rem_euclid(86_400) / 3600) as u32))
}

/// `YYYY-MM-DD`。
pub fn day_string(year: i32, month: u32, day: u32) -> String {
    format!("{year:04}-{month:02}-{day:02}")
}

/// 日期加减（Howard Hinnant 的 civil calendar 算法）。
pub fn add_days(year: i32, month: u32, day: u32, delta: i64) -> (i32, u32, u32) {
    civil_from_days(days_from_civil(year, month, day) + delta)
}

pub fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = ((month + 9) % 12) as i64;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    // Hinnant 的月份换算：mp ∈ [0,11] → 3..12, 1, 2
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y } as i32;
    (y, m, d)
}

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;
