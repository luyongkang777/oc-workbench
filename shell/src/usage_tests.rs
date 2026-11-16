//! `usage` / `usage_agg` / `usage_price` 的单元测试。

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use super::usage_agg;
use super::usage_price;
use super::{add_days, civil_from_days, day_string, days_from_civil, today, Period, Query};

fn temp_log(tag: &str, lines: &[String]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ocw-usage-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("usage.jsonl");
    fs::write(&path, lines.join("\n")).unwrap();
    path
}

fn row(day: &str, hour: &str, provider: &str, model: &str, input: u64, output: u64, cache_read: u64, status: u64, tries: u64) -> String {
    format!(
        r#"{{"t":"{day}T{hour}:05:00.123+08:00","agent":"opencode","provider":"{provider}","model":"{model}","served":"{model}","in":{input},"out":{output},"cache_read":{cache_read},"cache_write":0,"status":{status},"tries":{tries}}}"#
    )
}

#[test]
fn civil_date_round_trip() {
    for (year, month, day) in [(2026, 11, 16), (2024, 2, 29), (2025, 1, 1), (2026, 3, 1)] {
        let days = days_from_civil(year, month, day);
        assert_eq!(civil_from_days(days), (year, month, day));
    }
    // 跨月、跨年
    assert_eq!(add_days(2026, 3, 1, -1), (2026, 2, 28));
    assert_eq!(add_days(2026, 1, 1, -1), (2025, 12, 31));
    assert_eq!(add_days(2024, 2, 28, 1), (2024, 2, 29));
}

#[test]
fn price_lookup_handles_variants() {
    // 官方价：deepseek-flash = 0.15 / 0.6 / 0.003
    let price = usage_price::lookup("deepseek-flash").expect("deepseek-flash 应该能查到价");
    assert!((price.input - 0.15).abs() < 1e-9);
    assert!((price.output - 0.6).abs() < 1e-9);
    assert!((price.cache_read - 0.003).abs() < 1e-9);
    // provider/model 形式
    assert!(usage_price::lookup("deepseek/deepseek-flash").is_some());
    // 不认识的模型：必须返回 None（调用方计入未计价，不能按 0 元算）
    assert!(usage_price::lookup("no-such-model-xyz").is_none());
    // 一次调用的费用：1M input + 1M output
    let cost = price.cost(1_000_000, 1_000_000, 0, 0);
    assert!((cost - 0.75).abs() < 1e-9);
}

#[test]
fn summary_filters_period_and_groups() {
    let (y, m, d) = today();
    let today_text = day_string(y, m, d);
    let (yy, mm, dd) = add_days(y, m, d, -1);
    let yesterday = day_string(yy, mm, dd);
    let (oy, om, od) = add_days(y, m, d, -40);
    let old_day = day_string(oy, om, od);

    let path = temp_log(
        "agg",
        &[
            row(&today_text, "10", "deepseek", "deepseek-flash", 1_000_000, 1_000_000, 2_000_000, 200, 1),
            row(&today_text, "11", "deepseek", "deepseek-flash", 500_000, 0, 0, 500, 1),
            row(&yesterday, "09", "commandcode", "command-code", 100, 50, 0, 200, 3),
            row(&old_day, "09", "deepseek", "deepseek-flash", 10_000_000, 0, 0, 200, 1),
        ],
    );

    // 今天：只有两条；一条失败、一条成功
    let body: Value = serde_json::from_str(
        &usage_agg::summary_gateway_only(
            &Query {
                period: Period::Today,
                provider: None,
                agent: None,
            },
            &path,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(body["ok"], true);
    assert_eq!(body["bucket"], "hour");
    assert_eq!(body["totals"]["calls"], 2);
    assert_eq!(body["totals"]["errors"], 1);
    assert_eq!(body["totals"]["input"], 1_500_000);
    assert_eq!(body["totals"]["output"], 1_000_000);
    assert_eq!(body["totals"]["cacheRead"], 2_000_000);
    // 命中率 = 2M / (1.5M + 2M) ≈ 0.5714
    let hit = body["hitRate"].as_f64().unwrap();
    assert!((hit - (2_000_000.0 / 3_500_000.0)).abs() < 1e-6);
    // 24 个小时桶，10 点和 11 点各有数据
    assert_eq!(body["series"].as_array().unwrap().len(), 24);
    assert_eq!(body["series"][10]["calls"], 1);
    assert_eq!(body["series"][11]["calls"], 1);
    // 分组
    assert_eq!(body["agents"][0]["id"], "opencode");
    assert_eq!(body["providers"][0]["id"], "deepseek");
    // 费用：成功那条 1M*0.15 + 1M*0.6 + 2M*0.003 = 0.756，
    // 再加失败那条已消耗的 500k input = 0.075 → 0.831
    let cost = body["totals"]["cost"].as_f64().unwrap();
    assert!((cost - 0.831).abs() < 1e-6, "cost = {cost}");

    // 7 天：加上昨天那条（重试后成功 → retried=1）
    let week: Value = serde_json::from_str(
        &usage_agg::summary_gateway_only(
            &Query {
                period: Period::Week,
                provider: None,
                agent: None,
            },
            &path,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(week["totals"]["calls"], 3);
    assert_eq!(week["totals"]["retried"], 1);
    assert_eq!(week["series"].as_array().unwrap().len(), 7);

    // 全部：40 天前那条也算进来
    let all: Value = serde_json::from_str(
        &usage_agg::summary_gateway_only(
            &Query {
                period: Period::All,
                provider: None,
                agent: None,
            },
            &path,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(all["totals"]["calls"], 4);

    // 按服务商过滤
    let filtered: Value = serde_json::from_str(
        &usage_agg::summary_gateway_only(
            &Query {
                period: Period::All,
                provider: Some("commandcode".to_string()),
                agent: None,
            },
            &path,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(filtered["totals"]["calls"], 1);
    // 服务商分组保持全量（它是筛选下拉的选项来源），只过滤 totals/series/agents
    assert_eq!(filtered["providers"].as_array().unwrap().len(), 2);

    let _ = fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn unknown_model_counts_as_unpriced() {
    let (y, m, d) = today();
    let day = day_string(y, m, d);
    let path = temp_log(
        "unpriced",
        &[row(&day, "12", "xx", "mystery-model-2099", 1000, 1000, 0, 200, 1)],
    );
    let body: Value = serde_json::from_str(
        &usage_agg::summary_gateway_only(
            &Query {
                period: Period::Today,
                provider: None,
                agent: None,
            },
            &path,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(body["totals"]["unpriced"], 1);
    assert_eq!(body["totals"]["cost"], 0.0);
    let _ = fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn missing_log_reports_error() {
    let path = std::env::temp_dir().join(format!("ocw-usage-missing-{}.jsonl", std::process::id()));
    let _ = fs::remove_file(&path);
    let err = usage_agg::summary_gateway_only(
        &Query {
            period: Period::Today,
            provider: None,
            agent: None,
        },
        &path,
    )
    .unwrap_err();
    assert!(err.contains("没有找到 magpie 的用量日志"), "{err}");
}

#[test]
fn gateway_opencode_rows_are_skipped_only_when_session_loaded() {
    // 会话库读到了数据：网关里的 opencode 行由会话库代表
    assert!(super::usage_agg::skip_gateway_row("opencode", true, true));
    // 会话库读不到：必须保留网关的，否则 85% 的记录会静默消失（本轮审核的 🔴）
    assert!(!super::usage_agg::skip_gateway_row("opencode", true, false));
    // 只读网关的入口（测试）不做去重
    assert!(!super::usage_agg::skip_gateway_row("opencode", false, true));
    // 别的客户端不受影响
    assert!(!super::usage_agg::skip_gateway_row("curl", true, true));
}

#[test]
fn session_log_maps_tokens_and_model() {
    // 临时建一个最小的 opencode.db：只验证「消息 → Record」的映射，
    // 包括 tokens/缓存、provider/model 和费用估算。
    let dir = std::env::temp_dir().join(format!("ocw-usage-db-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("opencode.db");
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)",
        )
        .unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let data = r#"{"tokens":{"input":100,"output":50,"reasoning":10,"cache":{"read":1000,"write":0}},"model":{"providerID":"deepseek","id":"deepseek-flash"}}"#;
        conn.execute(
            "insert into session_message values ('m1','s1','assistant',0,?1,?1,?2)",
            rusqlite::params![now, data],
        )
        .unwrap();
    }

    let records = super::usage_session::load_at(&db_path).expect("读会话库");
    assert_eq!(records.len(), 1);
    let record = &records[0];
    assert_eq!(record.agent, "opencode");
    assert_eq!(record.provider, "deepseek");
    assert_eq!(record.model, "deepseek-flash");
    assert_eq!(record.input, 100);
    // output 并入 reasoning（与网关口径一致）：50 + 10
    assert_eq!(record.output, 60);
    assert_eq!(record.cache_read, 1000);
    assert_eq!(record.reasoning, 10);
    // 0.15/0.6/0.003 每 1M：100*0.15 + 60*0.6 + 1000*0.003 = 54 → 0.000054
    assert!((record.cost - 0.000054).abs() < 1e-9, "cost = {}", record.cost);
    assert!(record.priced);
    assert_eq!(record.day.len(), 10);
    assert_eq!(record.hour.len(), 2);

    let _ = fs::remove_dir_all(&dir);
}
