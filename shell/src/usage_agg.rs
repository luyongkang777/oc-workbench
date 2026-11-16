//! 把网关日志和 opencode 会话库聚合成用量页要的结构。

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde_json::{json, Value};

use super::usage_record::{parse_record, Record, Totals};
use super::usage_series::build_series;
use super::usage_session;
use super::{add_days, day_string, today, Period, Query};

struct Cached {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
    records: Arc<Vec<Record>>,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

/// 读网关日志（按 文件长度 + 修改时间 缓存；文件追加后自动重读）。
fn load(path: &Path) -> Result<Arc<Vec<Record>>, String> {
    let meta = fs::metadata(path).map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => format!(
            "没有找到 magpie 的用量日志（{}）：装了 magpie 并跑过请求后才有数据",
            path.display()
        ),
        _ => format!("读不了用量日志（{err}）：{}", path.display()),
    })?;
    let len = meta.len();
    let modified = meta.modified().ok();

    if let Ok(guard) = CACHE.lock() {
        if let Some(cache) = guard.as_ref() {
            if cache.path == path && cache.len == len && cache.modified == modified {
                return Ok(Arc::clone(&cache.records));
            }
        }
    }

    let file = fs::File::open(path).map_err(|err| format!("打开用量日志失败：{err}"))?;
    let reader = BufReader::with_capacity(1 << 20, file);
    let mut records = Vec::with_capacity(4096);
    for line in reader.lines() {
        let Ok(line) = line else {
            continue;
        };
        if line.is_empty() {
            continue;
        }
        if let Some(record) = parse_record(&line) {
            records.push(record);
        }
    }
    let records = Arc::new(records);
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(Cached {
            path: path.to_path_buf(),
            len,
            modified,
            records: Arc::clone(&records),
        });
    }
    Ok(records)
}

/// 聚合器：一遍扫记录，同时出总计 / 时间序列 / 三个分组。
struct Accumulator<'a> {
    query: &'a Query,
    hour_buckets: bool,
    start_day: &'a str,
    totals: Totals,
    series: HashMap<String, Totals>,
    agents: HashMap<String, Totals>,
    providers: HashMap<String, Totals>,
    models: HashMap<String, Totals>,
    earliest: Option<String>,
}

impl<'a> Accumulator<'a> {
    fn new(query: &'a Query, hour_buckets: bool, start_day: &'a str) -> Self {
        Self {
            query,
            hour_buckets,
            start_day,
            totals: Totals::default(),
            series: HashMap::new(),
            agents: HashMap::new(),
            providers: HashMap::new(),
            models: HashMap::new(),
            earliest: None,
        }
    }

    fn push(&mut self, record: &Record) {
        if record.day.as_str() < self.start_day {
            return;
        }
        // 服务商分组统计全量：它是筛选下拉的选项来源，
        // 选中某一家后列表不能只剩这一家。
        self.providers
            .entry(record.provider.clone())
            .or_default()
            .add(record);
        if let Some(want) = &self.query.provider {
            if &record.provider != want {
                return;
            }
        }
        if let Some(want) = &self.query.agent {
            if &record.agent != want {
                return;
            }
        }
        self.totals.add(record);
        let key = if self.hour_buckets {
            record.hour.clone()
        } else {
            record.day.clone()
        };
        self.series.entry(key).or_default().add(record);
        self.agents.entry(record.agent.clone()).or_default().add(record);
        if !record.model.is_empty() {
            self.models
                .entry(record.model.clone())
                .or_default()
                .add(record);
        }
        if self
            .earliest
            .as_deref()
            .map(|day| record.day.as_str() < day)
            .unwrap_or(true)
        {
            self.earliest = Some(record.day.clone());
        }
    }
}

/// 网关里的这条记录要不要跳过。
///
/// 走网关的 opencode 请求在会话库里也有同一条，只保留会话库那份；
/// 但会话库读不到（空表）时必须保留网关的，否则数据会静默少一大截。
pub(super) fn skip_gateway_row(agent: &str, include_session: bool, session_ok: bool) -> bool {
    include_session && session_ok && agent == "opencode"
}

fn sorted_groups(map: HashMap<String, Totals>, limit: usize) -> Vec<Value> {
    let mut items: Vec<(String, Totals)> = map.into_iter().collect();
    items.sort_by(|left, right| {
        let a = left.1.input + left.1.output + left.1.cache_read;
        let b = right.1.input + right.1.output + right.1.cache_read;
        b.cmp(&a).then_with(|| left.0.cmp(&right.0))
    });
    items
        .into_iter()
        .take(limit)
        .map(|(id, totals)| {
            let mut value = totals.to_json();
            if let Some(obj) = value.as_object_mut() {
                obj.insert("id".to_string(), json!(id));
            }
            value
        })
        .collect()
}

/// 启动时后台预热网关日志（解析一次后走缓存）。
pub fn warm_gateway(path: &Path) {
    let _ = load(path);
}

/// 一次查询的完整结果（直接序列化成响应体）。
pub fn summary(query: &Query) -> Result<String, String> {
    let path = super::log_path().ok_or_else(|| "找不到用户目录".to_string())?;
    summary_at(query, &path)
}

/// 同 [`summary`]，但明确指定日志路径（测试不必碰环境变量）。
pub fn summary_at(query: &Query, path: &Path) -> Result<String, String> {
    summary_inner(query, path, true)
}

/// 只统计网关日志（测试用：不去读本机的 opencode 会话库）。
#[cfg(test)]
pub fn summary_gateway_only(query: &Query, path: &Path) -> Result<String, String> {
    summary_inner(query, path, false)
}

fn summary_inner(query: &Query, path: &Path, include_session: bool) -> Result<String, String> {
    let (today_year, today_month, today_day) = today();
    let today_text = day_string(today_year, today_month, today_day);
    let start_day = match query.period {
        Period::Today => today_text.clone(),
        Period::Week => {
            let (y, m, d) = add_days(today_year, today_month, today_day, -6);
            day_string(y, m, d)
        }
        Period::Month => {
            let (y, m, d) = add_days(today_year, today_month, today_day, -29);
            day_string(y, m, d)
        }
        Period::All => "0000-00-00".to_string(),
    };
    let hour_buckets = query.period == Period::Today;

    // 两个来源并行读：网关日志要解析 50MB+，会话库要扫 9 万行，串行要翻倍
    let (gateway, session) = std::thread::scope(|scope| {
        let gateway_job = scope.spawn(|| load(path));
        let session_job = scope.spawn(|| {
            if include_session {
                usage_session::load()
            } else {
                Ok(Arc::new(Vec::new()))
            }
        });
        (
            gateway_job
                .join()
                .unwrap_or_else(|_| Err("读取网关日志失败".to_string())),
            session_job
                .join()
                .unwrap_or_else(|_| Ok(Arc::new(Vec::new()))),
        )
    });
    let session = session.unwrap_or_default();
    if gateway.is_err() && session.is_empty() {
        return Err(gateway.err().unwrap_or_else(|| "没有可用的用量数据".to_string()));
    }

    let mut acc = Accumulator::new(query, hour_buckets, &start_day);
    // 只有会话库真的读到了数据，才丢弃网关里的 opencode 行：
    // 库被占/损坏时 session 是空表，无条件丢弃会让 85% 的记录静默消失。
    let session_ok = !session.is_empty();
    if let Ok(records) = &gateway {
        for record in records.iter() {
            if skip_gateway_row(&record.agent, include_session, session_ok) {
                continue;
            }
            acc.push(record);
        }
    }
    for record in session.iter() {
        acc.push(record);
    }

    let series_json = build_series(
        &mut acc.series,
        hour_buckets,
        &start_day,
        &today_text,
        acc.earliest.as_deref(),
    );
    let gateway_used = gateway.is_ok();
    let session_used = session_ok;
    let source = match (gateway_used, session_used) {
        (true, true) => "magpie 网关日志 + opencode 会话库",
        (true, false) => "magpie 网关日志",
        (false, true) => "opencode 会话库",
        (false, false) => "没有数据源",
    };

    let body = json!({
        "ok": true,
        "period": query.period.as_str(),
        "bucket": if hour_buckets { "hour" } else { "day" },
        "source": source,
        "generatedAt": today_text,
        "totals": acc.totals.to_json(),
        "hitRate": acc.totals.hit_rate(),
        "series": series_json,
        "agents": sorted_groups(acc.agents, 20),
        "providers": sorted_groups(acc.providers, 20),
        "models": sorted_groups(acc.models, 20),
    });
    Ok(body.to_string())
}
