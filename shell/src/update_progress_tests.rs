//! `update_progress` 的单元测试。

use super::*;

#[test]
fn percent_is_clamped_and_unknown_total_is_none() {
    // 总量未知（清单和 Content-Length 都没给）→ None，前端画不确定进度条
    assert_eq!(percent_of(0, 0), None);
    assert_eq!(percent_of(123, 0), None);
    // 正常进度
    assert_eq!(percent_of(0, 100), Some(0));
    assert_eq!(percent_of(50, 100), Some(50));
    assert_eq!(percent_of(100, 100), Some(100));
    // 超出总量（清单写小了）不能显示 120%
    assert_eq!(percent_of(150, 100), Some(100));
    // 除不尽向下取整，不会因为舍入提前显示 100%
    assert_eq!(percent_of(99, 100), Some(99));
    assert_eq!(percent_of(2, 3), Some(66));
}

/// 全局状态只有一个，断言集中在这一个用例里顺序执行，避免并行测试互相踩。
#[test]
fn state_machine_walks_download_verify_restart_fail() {
    reset();
    let idle: serde_json::Value = serde_json::from_str(&to_json()).unwrap();
    assert_eq!(idle["active"], false);
    assert_eq!(idle["stage"], "idle");
    assert_eq!(idle["percent"], serde_json::Value::Null);

    // checking（apply 收到请求那一刻）
    set(Stage::Checking, 0, 0);
    let checking: serde_json::Value = serde_json::from_str(&to_json()).unwrap();
    assert_eq!(checking["active"], true);
    assert_eq!(checking["stage"], "checking");

    // 下载中：只用 bump 推进，不会把阶段改成别的
    bump(1024, 4096);
    let downloading: serde_json::Value = serde_json::from_str(&to_json()).unwrap();
    assert_eq!(downloading["stage"], "downloading");
    assert_eq!(downloading["done"], 1024);
    assert_eq!(downloading["total"], 4096);
    assert_eq!(downloading["percent"], 25);

    // 校验阶段保留已下载字节
    set(Stage::Verifying, 4096, 4096);
    let verifying: serde_json::Value = serde_json::from_str(&to_json()).unwrap();
    assert_eq!(verifying["stage"], "verifying");
    assert_eq!(verifying["done"], 4096);

    // 就绪：进度条拉满，阶段是 restarting
    finish();
    let restarting: serde_json::Value = serde_json::from_str(&to_json()).unwrap();
    assert_eq!(restarting["stage"], "restarting");
    assert_eq!(restarting["percent"], 100);
    assert_eq!(restarting["active"], true);

    // 失败：带上原因，active 归位
    fail("SHA256 不符");
    let failed: serde_json::Value = serde_json::from_str(&to_json()).unwrap();
    assert_eq!(failed["stage"], "failed");
    assert_eq!(failed["active"], false);
    assert_eq!(failed["error"], "SHA256 不符");

    // total 已知时传 0 也不能把 total 冲成 0（同一个用例里顺序跑：
    // 全局状态只允许这里碰，否则并行测试会互踩）
    set(Stage::Downloading, 0, 8192);
    bump(100, 0);
    let keep_total: serde_json::Value = serde_json::from_str(&to_json()).unwrap();
    assert_eq!(keep_total["total"], 8192);
    assert_eq!(keep_total["done"], 100);

    // 下一轮开始要清干净（不能残留上一轮的错误与进度）
    reset();
    let again: serde_json::Value = serde_json::from_str(&to_json()).unwrap();
    assert_eq!(again["stage"], "idle");
    assert_eq!(again["error"], serde_json::Value::Null);
    assert_eq!(again["done"], 0);
}

