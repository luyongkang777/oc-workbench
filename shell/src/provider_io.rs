//! provider 配置的落盘细节：备份、原子写、串行化、顶层键快照。
//!
//! 从 `provider_store.rs` 拆出来：那里只关心「改什么」，这里只关心「怎么安全写下去」。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

/// 备份最多保留几份（再多就把目录堆满）。
const BACKUP_KEEP: usize = 10;

pub(crate) fn backup_path(path: &Path) -> Option<PathBuf> {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
    let name = format!(
        "{}.bak-{}-{:03}",
        path.file_name()?.to_string_lossy(),
        stamp.as_secs(),
        stamp.subsec_millis()
    );
    Some(path.with_file_name(name))
}

/// 只轮转自己造的备份（`opencode.json.bak-*`），不碰运维手放的快照。
pub(crate) fn rotate_backups(dir: &Path, base_name: &str) {
    let prefix = format!("{base_name}.bak-");
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut found: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().starts_with(&prefix))
                .unwrap_or(false)
        })
        .collect();
    if found.len() <= BACKUP_KEEP {
        return;
    }
    // 按修改时间排序：Rust 与 dev 的备份命名不同（秒+毫秒 vs ISO），
    // 按文件名字符串排会删错对象。
    found.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|meta| meta.modified())
            .unwrap_or(UNIX_EPOCH)
    });
    let excess = found.len() - BACKUP_KEEP;
    for path in found.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
}

/// 保存串行化：外壳是「每请求一线程」，两个保存同时进来会互相踩临时文件、
/// 也会在「读 → 改 → 写」之间丢掉对方刚写的内容（实测 300 轮并发丢 1 次更新）。
/// 这把锁只保护本进程；跨进程靠 rename 的原子性兜底。
/// 临时文件序号：同一进程内并发时保证名字不撞。
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 原子写：临时文件 → 改名。
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".opencode.json.tmp-{}-{seq}", std::process::id()));
    fs::write(&tmp, bytes)?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(&tmp);
            Err(err)
        }
    }
}

/// 完整写盘流程（备份 + 自检 + 原子写）。
///
/// `mutate` 拿到可写的配置对象，改它；返回 Err 就整体放弃（不落盘）。
/// 保存串行化：外壳是「每请求一线程」，两个保存同时进来会互相踩临时文件、
/// 也会在「读 → 改 → 写」之间丢掉对方刚写的内容（实测 300 轮并发丢 1 次更新）。
pub(crate) fn lock_save() -> MutexGuard<'static, ()> {
    static SAVE_LOCK: Mutex<()> = Mutex::new(());
    SAVE_LOCK.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// 顶层键快照：用来做「写前后除 provider / 默认模型外一字未动」的自检。
pub(crate) fn top_level_keys(value: &Value) -> Vec<(String, String)> {
    let Some(map) = value.as_object() else {
        return Vec::new();
    };
    let mut keys: Vec<(String, String)> = map
        .iter()
        .filter(|(key, _)| key.as_str() != "provider")
        .map(|(key, item)| (key.clone(), type_of(item)))
        .collect();
    keys.sort_by(|left, right| left.0.cmp(&right.0));
    keys
}

/// 写回自检口径：除 `provider` 外，顶层键必须一字未动。
///
/// 顶层 `model`（默认模型）是唯一允许动的键：
///
/// - 账号同步 / 面板「默认模型」本来就要写它；
/// - 新电脑上这个键通常**不存在**，一律判「动了别人的配置」会让首次设默认模型永远 500；
/// - 已经存在但**不是字符串**（`"model": null` 最常见）也要能纠正 ——
///   读取侧把 null 当「未设置」，若这里拒绝，界面显示未设置却怎么也存不进去。
///
/// 但**「没碰它」必须放行**：只保存一条 provider 时 model 根本没被改，
/// 哪怕磁盘上写的是 `null`/对象这种坏值也不能拦 —— 否则保存/删除/账号同步
/// 整条主流程全被一条没动的旧值卡死（第一版就踩了这个回归）。
///
/// 所以：类型原样返回 → 放行；真要改 → 必须是字符串；删掉 → 拦。
/// 其余任何顶层键多一个、少一个、类型变了都不行。
pub(crate) fn guard_allows(before: &[(String, String)], after: &[(String, String)]) -> bool {
    // 入参按约定来自 top_level_keys（已排序），这里再排一次：将来若有调用点
    // 直接传 map 的迭代结果，顺序不同也会被误判成「改了配置」。
    let rest = |keys: &[(String, String)]| -> Vec<(String, String)> {
        let mut rest: Vec<(String, String)> = keys
            .iter()
            .filter(|(key, _)| key != "model")
            .cloned()
            .collect();
        rest.sort_by(|left, right| left.0.cmp(&right.0));
        rest
    };
    if rest(before) != rest(after) {
        return false;
    }
    let model_type = |keys: &[(String, String)]| -> Option<String> {
        keys.iter()
            .find(|(key, _)| key == "model")
            .map(|(_, kind)| kind.clone())
    };
    match (model_type(before), model_type(after)) {
        (None, None) => true,
        // 类型没变 → 没碰它（哪怕原值是 null/object 这种坏形态）
        (Some(old), Some(new)) if old == new => true,
        // 要改 → 只能是字符串（新建，或从 null/number/object 纠正过来）
        (Some(_), Some(new)) => new == "string",
        (None, Some(new)) => new == "string",
        // 删掉顶层 model 不该由这里做
        (Some(_), None) => false,
    }
}

pub(crate) fn type_of(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(_) => "bool".to_string(),
        Value::Number(_) => "number".to_string(),
        Value::String(_) => "string".to_string(),
        Value::Array(_) => "array".to_string(),
        Value::Object(_) => "object".to_string(),
    }
}
