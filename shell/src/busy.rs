//! 本机有没有「工作台会话正在生成」。
//!
//! 网关探测每台设备时读 `/api/state` 的 `busy` 字段，手机顶部的设备条据此显示
//! 黄灯（在跑）/ 绿灯（空闲）。判定口径必须和前端 `components/projectStatus.ts`
//! 完全一致，否则会出现「电脑上灯是黄的、手机上却是绿的」这种对不上的情况：
//!
//! * `time.busy > time.idle` —— 正在生成；
//! * `metadata.source == "oc-workbench"` —— 只算工作台的对话会话；
//! * `metadata.kind != "terminal"` —— 底部命令栏在干活不算「AI 在跑」。
//!
//! 为什么要后台线程而不是在 `/api/state` 里现查：`/api/state` 是前端 4~15 秒
//! 一次的轻量轮询（断线时更密），同步去查上游会话列表会把这条路径拖慢，
//! 还容易在 backend 抖动时连锁超时。这里 4 秒采一次、只写两个原子变量，
//! 轮询读到的永远是「最近一次采样结果」，代价恒定。

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use crate::auth::Backend;

/// 采样间隔。请求走本机回环（几十毫秒），4 秒一次的开销可以忽略。
const POLL: Duration = Duration::from_secs(4);
/// 会话列表最多看这么多条：正在生成的会话一定在最前面（按时间倒序）。
const LIMIT: usize = 40;
const TIMEOUT: Duration = Duration::from_secs(3);

static BUSY: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicU32 = AtomicU32::new(0);

/// 最近一次采样结果：(是否有会话在跑, 正在跑的会话数)。
pub fn snapshot() -> (bool, u32) {
    (BUSY.load(Ordering::SeqCst), RUNNING.load(Ordering::SeqCst))
}

/// 起后台采样线程。只起一次（main 启动时调用）。
pub fn spawn(backend: Arc<RwLock<Option<Backend>>>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL);
        let count = match read_backend(&backend) {
            Some((base, cookie)) => count_running(&base, &cookie).unwrap_or(0),
            // 后端没连上：不可能是「正在跑」，否则断线后黄灯会一直亮着。
            None => 0,
        };
        store(count);
    });
}

fn read_backend(backend: &Arc<RwLock<Option<Backend>>>) -> Option<(String, String)> {
    let guard = match backend.read() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard
        .as_ref()
        .map(|item| (item.base.clone(), item.cookie.clone()))
}

fn store(count: u32) {
    RUNNING.store(count, Ordering::SeqCst);
    BUSY.store(count > 0, Ordering::SeqCst);
}

/// 拉一次会话列表并数出「正在生成」的条数。
///
/// 任何失败都返回 `None`（调用方按 0 处理）：黄灯亮错比不亮更烦人，
/// 拿不到状态就当空闲。
fn count_running(base: &str, cookie: &str) -> Option<u32> {
    let url = format!(
        "{base}/api/session?limit={LIMIT}&order=desc&parentID=null"
    );
    let agent = ureq::AgentBuilder::new()
        .timeout(TIMEOUT)
        .timeout_connect(Duration::from_secs(2))
        .build();
    let resp = agent
        .get(&url)
        .set("cookie", cookie)
        .call()
        .ok()?;
    let value: serde_json::Value = resp.into_json().ok()?;
    Some(count_in(&value))
}

/// 纯函数版：从会话列表响应里数「正在生成」的条数（单测直接喂 JSON）。
pub(crate) fn count_in(value: &serde_json::Value) -> u32 {
    let list = value
        .get("data")
        .and_then(|v| v.as_array())
        .or_else(|| value.as_array());
    let Some(list) = list else {
        return 0;
    };
    let mut count = 0u32;
    for item in list {
        if !is_running(item) || !counts_for_light(item) {
            continue;
        }
        count += 1;
    }
    count
}

/// `time.busy > time.idle`：和前端 `isSessionRunning` 同一个判据。
fn is_running(item: &serde_json::Value) -> bool {
    let busy = item
        .get("time")
        .and_then(|t| t.get("busy"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let idle = item
        .get("time")
        .and_then(|t| t.get("idle"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    busy > idle
}

/// 只认工作台的对话会话：别的客户端/终端在跑不该让灯变黄。
fn counts_for_light(item: &serde_json::Value) -> bool {
    let meta = item.get("metadata");
    let source = meta
        .and_then(|m| m.get("source"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let kind = meta
        .and_then(|m| m.get("kind"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    source == "oc-workbench" && kind != "terminal"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(busy: i64, idle: i64, source: &str, kind: &str) -> serde_json::Value {
        serde_json::json!({
            "time": { "busy": busy, "idle": idle },
            "metadata": { "source": source, "kind": kind },
        })
    }

    #[test]
    fn 数正在生成的工作台会话() {
        let value = serde_json::json!({
            "data": [
                session(200, 100, "oc-workbench", "chat"),
                session(100, 200, "oc-workbench", "chat"),
                session(300, 100, "oc-workbench", "terminal"),
                session(400, 100, "other", "chat"),
            ]
        });
        assert_eq!(count_in(&value), 1);
    }

    #[test]
    fn 也能吃裸数组和空值() {
        let bare = serde_json::json!([session(200, 100, "oc-workbench", "chat")]);
        assert_eq!(count_in(&bare), 1);
        assert_eq!(count_in(&serde_json::json!({})), 0);
        assert_eq!(count_in(&serde_json::json!(null)), 0);
        assert_eq!(count_in(&serde_json::json!({ "data": [] })), 0);
    }

    #[test]
    fn 缺字段按空闲处理() {
        let value = serde_json::json!({ "data": [ { "id": "ses_1" } ] });
        assert_eq!(count_in(&value), 0);
    }
}
