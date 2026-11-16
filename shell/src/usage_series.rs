//! 图表的桶：按小时或按天补齐空位。

use std::collections::HashMap;

use serde_json::{json, Value};

use super::usage_record::Totals;
use super::{add_days, civil_from_days, day_string, days_from_civil};

fn series_point(label: &str, time: &str, totals: &Totals) -> Value {
    json!({
        "label": label,
        "time": time,
        "input": totals.input,
        "output": totals.output,
        "cacheRead": totals.cache_read,
        "cacheWrite": totals.cache_write,
        "calls": totals.calls,
        "cost": (totals.cost * 10000.0).round() / 10000.0,
    })
}

/// 按小时或按天补齐空桶（图上没有请求的时段也要占位）。
pub(super) fn build_series(
    series: &mut HashMap<String, Totals>,
    hour_buckets: bool,
    start_day: &str,
    today_text: &str,
    earliest: Option<&str>,
) -> Vec<Value> {
    let mut out = Vec::new();
    if hour_buckets {
        for hour in 0..24 {
            let label = format!("{hour:02}");
            let totals = series.remove(&label).unwrap_or_default();
            out.push(series_point(&label, "", &totals));
        }
        return out;
    }

    // 「全部」按天画，但最多画最近 180 天（更早的数据仍计入总计）。
    let (mut year, mut month, mut day) = parse_day(start_day)
        .or_else(|| earliest.and_then(parse_day))
        .or_else(|| parse_day(today_text))
        .unwrap_or((1970, 1, 1));
    let (today_year, today_month, today_day) = parse_day(today_text).unwrap_or((1970, 1, 1));
    let span = days_from_civil(today_year, today_month, today_day)
        - days_from_civil(year, month, day);
    if span > 179 {
        let (y, m, d) = add_days(today_year, today_month, today_day, -179);
        year = y;
        month = m;
        day = d;
    }

    let mut cursor = days_from_civil(year, month, day);
    let end = days_from_civil(today_year, today_month, today_day);
    while cursor <= end {
        let (y, m, d) = civil_from_days(cursor);
        let key = day_string(y, m, d);
        let totals = series.remove(&key).unwrap_or_default();
        let label = format!("{m:02}-{d:02}");
        out.push(series_point(&label, &key, &totals));
        cursor += 1;
    }
    out
}

fn parse_day(text: &str) -> Option<(i32, u32, u32)> {
    let mut parts = text.split('-');
    let year = parts.next()?.parse::<i32>().ok()?;
    let month = parts.next()?.parse::<u32>().ok()?;
    let day = parts.next()?.parse::<u32>().ok()?;
    if year <= 0 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((year, month, day))
}
