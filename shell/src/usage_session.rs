//! opencode 会话库里的模型调用（用量页的「本地会话」来源）。
//!
//! 为什么需要它：magpie 的 `usage.jsonl` 只记录**走网关**的请求；opencode
//! 直连某个 provider（或走别的客户端）时不会写进去，只用网关日志会漏掉
//! 相当一部分调用，「今天」甚至可能是空的。
//!
//! 会话库有 9 万多行，而且 opencode 是**先插入消息、流式过程中再更新 tokens**
//! （实测 93,280/93,365 条 `time_updated` 晚于 `time_created`）。所以缓存不能
//! 只按 rowid 追加：正在生成的那条会以空 token 被记住，之后再也不更新。
//!
//! 做法：每次查 `rowid > (last_rowid - REREAD_ROWS)`，
//! 即「上次读到的位置往前退 500 行」——新行和流式更新都在最近插入的行里，
//! 走 rowid 索引很快（不要用 `time_updated >= ?`：那列没索引，全表扫要 600ms）。
//!
//! 库可能被正在运行的 opencode 占着：只读打开 + busy_timeout，拿不到就返回已有
//! 缓存（或空），用量页降级成只统计网关日志，不影响其它功能。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use super::usage_price;
use super::usage_record::Record;
use super::{day_string, local_parts};

/// 每次重读「上次位置往前这么多行」：覆盖流式更新（消息总是追加在尾部）。
const REREAD_ROWS: i64 = 500;

const SQL: &str = "
  select rowid,
         json_extract(data,'$.tokens.input'),
         json_extract(data,'$.tokens.output'),
         json_extract(data,'$.tokens.reasoning'),
         json_extract(data,'$.tokens.cache.read'),
         json_extract(data,'$.tokens.cache.write'),
         json_extract(data,'$.model.providerID'),
         json_extract(data,'$.model.id'),
         time_created
  from session_message
  where type = 'assistant' and rowid > ?
";

struct Cached {
    last_rowid: i64,
    /// rowid → 记录：同一条消息更新后覆盖旧值
    map: BTreeMap<i64, Record>,
    snapshot: Arc<Vec<Record>>,
    /// 上次裁剪时间（UNIX 秒）：删掉的消息要从缓存里清掉
    pruned_at: u64,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

/// 会话库位置：环境变量优先（测试用），否则 opencode 默认目录。
pub(super) fn db_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("OCW_OPENCODE_DB") {
        return Some(PathBuf::from(path));
    }
    crate::provider_store::home().map(|dir| {
        dir.join(".local")
            .join("share")
            .join("opencode")
            .join("opencode.db")
    })
}

/// 全部 assistant 消息（进程内缓存 + 增量）。
pub(super) fn load() -> Result<Arc<Vec<Record>>, String> {
    let Some(path) = db_path() else {
        return Ok(Arc::new(Vec::new()));
    };
    load_at(&path)
}

fn same_usage(left: &Record, right: &Record) -> bool {
    left.input == right.input
        && left.output == right.output
        && left.cache_read == right.cache_read
        && left.cache_write == right.cache_write
}

pub(super) fn load_at(path: &Path) -> Result<Arc<Vec<Record>>, String> {
    if !path.exists() {
        return Ok(Arc::new(Vec::new()));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| format!("打不开 opencode 会话库（{err}）：{}", path.display()))?;
    let _ = conn.busy_timeout(Duration::from_millis(1500));

    // 库被重建/清空时 rowid 会回到小值：发现就丢掉缓存重新全量读
    let max_rowid: i64 = conn
        .query_row("select coalesce(max(rowid), 0) from session_message", [], |row| {
            row.get(0)
        })
        .unwrap_or(0);

    let mut cached = CACHE.lock().ok().and_then(|mut guard| guard.take());
    let last_rowid = match &cached {
        Some(cache) if cache.last_rowid <= max_rowid => cache.last_rowid,
        _ => 0,
    };
    // 每 60 秒对齐一次「库里还在的 rowid」：删掉的会话不能一直算进用量
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut pruned = false;
    if let Some(cache) = cached.as_mut() {
        if now.saturating_sub(cache.pruned_at) > 60 {
            if let Ok(mut stmt) = conn.prepare("select rowid from session_message where type='assistant'") {
                if let Ok(rows) = stmt.query_map([], |row| row.get::<_, i64>(0)) {
                    let keep: std::collections::BTreeSet<i64> = rows.flatten().collect();
                    if !keep.is_empty() {
                        let before = cache.map.len();
                        cache.map.retain(|rowid, _| keep.contains(rowid));
                        pruned = cache.map.len() != before;
                    }
                }
            }
            cache.pruned_at = now;
        }
    }
    let since_rowid = if last_rowid > REREAD_ROWS {
        last_rowid - REREAD_ROWS
    } else {
        0
    };

    let mut stmt = conn
        .prepare(SQL)
        .map_err(|err| format!("查询会话库失败：{err}"))?;
    let rows = stmt
        .query_map([since_rowid], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(|err| format!("读会话库失败：{err}"))?;

    let mut fresh: Vec<(i64, Record)> = Vec::new();
    let mut new_rowid = last_rowid;
    for row in rows {
        let Ok((rowid, input, output, reasoning, cache_read, cache_write, provider, model, created)) =
            row
        else {
            continue;
        };
        if rowid > new_rowid {
            new_rowid = rowid;
        }
        let Some(model_name) = model.filter(|value| !value.trim().is_empty()) else {
            continue;
        };
        let Some((year, month, day, hour)) = local_parts(created) else {
            continue;
        };
        let to_count = |value: Option<i64>| value.unwrap_or(0).max(0) as u64;
        let input = to_count(input);
        // 网关的 out 是含 reasoning 的（同一条请求实测 250 = 135 output + 115 reasoning），
        // 会话库把 reasoning 单列，这里并进去，两个来源才同口径。
        let reasoning = to_count(reasoning);
        let output = to_count(output) + reasoning;
        let cache_read = to_count(cache_read);
        let cache_write = to_count(cache_write);
        let price = usage_price::lookup(&model_name);
        let cost = price
            .map(|price| price.cost(input, output, cache_read, cache_write))
            .unwrap_or(0.0);
        fresh.push((
            rowid,
            Record {
                day: day_string(year, month, day),
                hour: format!("{hour:02}"),
                agent: "opencode".to_string(),
                provider: provider.unwrap_or_default(),
                model: model_name,
                input,
                output,
                cache_read,
                cache_write,
                reasoning,
                status: 200,
                tries: 1,
                cost,
                priced: price.is_some(),
            },
        ));
    }

    // 变化检测：重读的旧行里 token 没变就不用重建 9 万条快照
    let mut changed = new_rowid > last_rowid || pruned;
    if !changed {
        if let Some(cache) = &cached {
            changed = fresh.iter().any(|(rowid, record)| match cache.map.get(rowid) {
                Some(old) => !same_usage(old, record),
                None => true,
            });
        }
    }
    if !changed {
        if let Some(mut cache) = cached {
            cache.pruned_at = now;
            let snapshot = Arc::clone(&cache.snapshot);
            if let Ok(mut guard) = CACHE.lock() {
                *guard = Some(cache);
            }
            return Ok(snapshot);
        }
        return Ok(Arc::new(Vec::new()));
    }

    let mut map = match cached {
        Some(cache) => cache.map,
        None => BTreeMap::new(),
    };
    for (rowid, record) in fresh {
        map.insert(rowid, record);
    }
    let snapshot = Arc::new(map.values().cloned().collect::<Vec<Record>>());
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(Cached {
            last_rowid: new_rowid,
            map,
            snapshot: Arc::clone(&snapshot),
            pruned_at: now,
        });
    }
    Ok(snapshot)
}
