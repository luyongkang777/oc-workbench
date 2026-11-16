//! 工作台自身更新的进度（给页面的进度条用）。
//!
//! 单独成文件：`update.rs` 已经很长，这里只关心「现在到哪一步了」，
//! 以及把这份状态序列化成前端认识的 JSON。
//!
//! **刻意与 check 分离**：检查更新是另一条请求，随时可能被再次触发；
//! 下载进度只由 apply 写，读它的轮询不会因为有人重新点「检查更新」而清零。

use std::sync::{Mutex, MutexGuard, OnceLock};

use serde_json::json;

/// 更新进行到哪一步。字符串与 `src/api/update.ts` 的 `UpdateProgress.stage` 对齐。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Idle,
    Checking,
    Downloading,
    Verifying,
    Restarting,
    Failed,
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Idle => "idle",
            Stage::Checking => "checking",
            Stage::Downloading => "downloading",
            Stage::Verifying => "verifying",
            Stage::Restarting => "restarting",
            Stage::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug)]
pub struct UpdateProgress {
    pub active: bool,
    pub stage: Stage,
    pub done: u64,
    pub total: u64,
    pub error: Option<String>,
}

impl Default for UpdateProgress {
    fn default() -> Self {
        Self {
            active: false,
            stage: Stage::Idle,
            done: 0,
            total: 0,
            error: None,
        }
    }
}

/// 百分比：总量未知时给 `None`（前端用不确定进度条），**不编数字**。
pub fn percent_of(done: u64, total: u64) -> Option<u64> {
    if total == 0 {
        return None;
    }
    Some(done.saturating_mul(100) / total).map(|value| value.min(100))
}

fn cell() -> &'static Mutex<UpdateProgress> {
    static CELL: OnceLock<Mutex<UpdateProgress>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(UpdateProgress::default()))
}

fn lock() -> MutexGuard<'static, UpdateProgress> {
    cell().lock().unwrap_or_else(|poison| poison.into_inner())
}

/// 开始一次新的更新：清掉上一轮的残留（含错误）。
pub fn reset() {
    *lock() = UpdateProgress::default();
}

pub fn set(stage: Stage, done: u64, total: u64) {
    let mut progress = lock();
    progress.active = !matches!(stage, Stage::Idle);
    progress.stage = stage;
    progress.done = done;
    if total > 0 {
        progress.total = total;
    }
    progress.error = None;
}

/// 下载每读一块调用一次：只推进 done/total，阶段固定成 downloading。
pub fn bump(done: u64, total: u64) {
    let mut progress = lock();
    progress.active = true;
    progress.stage = Stage::Downloading;
    progress.done = done;
    if total > 0 {
        progress.total = total;
    }
}

/// 更新包已就绪、即将重启：进度条拉满并停在这一步。
pub fn finish() {
    let mut progress = lock();
    progress.active = true;
    progress.stage = Stage::Restarting;
    if progress.total > 0 {
        progress.done = progress.total;
    }
    progress.error = None;
}

pub fn fail(message: impl Into<String>) {
    let mut progress = lock();
    progress.active = false;
    progress.stage = Stage::Failed;
    progress.error = Some(message.into());
}

pub fn to_json() -> String {
    let progress = lock().clone();
    json!({
        "active": progress.active,
        "stage": progress.stage.as_str(),
        "done": progress.done,
        "total": progress.total,
        "percent": percent_of(progress.done, progress.total),
        "error": progress.error,
    })
    .to_string()
}

#[cfg(test)]
#[path = "update_progress_tests.rs"]
mod tests;
