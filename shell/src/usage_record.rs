//! 用量日志的一行：解析成 Record，以及聚合用的 Totals。

use serde_json::{json, Value};

use super::usage_price;

/// 一条请求里聚合要用的字段。
#[derive(Clone)]
pub(super) struct Record {
    /// 本地日期 `YYYY-MM-DD`（日志里的 `t` 前 10 位）
    pub(super) day: String,
    /// 本地小时 `00`..`23`
    pub(super) hour: String,
    pub(super) agent: String,
    pub(super) provider: String,
    pub(super) model: String,
    pub(super) input: u64,
    pub(super) output: u64,
    pub(super) cache_read: u64,
    pub(super) cache_write: u64,
    pub(super) reasoning: u64,
    pub(super) status: u16,
    pub(super) tries: u32,
    pub(super) cost: f64,
    pub(super) priced: bool,
}

#[derive(Default, Clone, Debug)]
pub(super) struct Totals {
    pub(super) calls: u64,
    pub(super) errors: u64,
    pub(super) retried: u64,
    pub(super) canceled: u64,
    pub(super) input: u64,
    pub(super) output: u64,
    pub(super) cache_read: u64,
    pub(super) cache_write: u64,
    pub(super) reasoning: u64,
    pub(super) cost: f64,
    pub(super) unpriced: u64,
}

impl Totals {
    pub(super) fn add(&mut self, record: &Record) {
        self.calls += 1;
        if record.status == 499 {
            self.canceled += 1;
        } else if record.status >= 400 {
            self.errors += 1;
        } else if record.tries > 1 {
            self.retried += 1;
        }
        self.input += record.input;
        self.output += record.output;
        self.cache_read += record.cache_read;
        self.cache_write += record.cache_write;
        self.reasoning += record.reasoning;
        self.cost += record.cost;
        if !record.priced
            && record.input + record.output + record.cache_read + record.cache_write > 0
        {
            self.unpriced += 1;
        }
    }

    /// 缓存命中率：读到的缓存 / 整个提示词（写入也算进提示词）。
    /// 与 magpie 自己的口径一致；没有提示词 token 时给 null。
    pub(super) fn hit_rate(&self) -> Option<f64> {
        let prompt = self.input + self.cache_read + self.cache_write;
        if prompt == 0 {
            None
        } else {
            Some(self.cache_read as f64 / prompt as f64)
        }
    }

    pub(super) fn to_json(&self) -> Value {
        json!({
            "calls": self.calls,
            "errors": self.errors,
            "retried": self.retried,
            "canceled": self.canceled,
            "input": self.input,
            "output": self.output,
            "cacheRead": self.cache_read,
            "cacheWrite": self.cache_write,
            "reasoning": self.reasoning,
            "cost": (self.cost * 10000.0).round() / 10000.0,
            "unpriced": self.unpriced,
        })
    }
}

fn number(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

fn text<'a>(value: Option<&'a Value>) -> &'a str {
    value.and_then(Value::as_str).unwrap_or("")
}

pub(super) fn parse_record(line: &str) -> Option<Record> {
    let row: Value = serde_json::from_str(line).ok()?;
    let stamp = text(row.get("t"));
    // 用 get() 而不是字节切片：日志损坏时 stamp 可能是非 ASCII，
    // `&stamp[..10]` 会按 UTF-8 边界 panic，整条请求就没了。
    let (Some(day), Some(hour)) = (stamp.get(..10), stamp.get(11..13)) else {
        return None;
    };
    // magpie 自检（探测供应商/列模型/探测 API）不算用户请求，与 magpie 用量页一致
    if text(row.get("source")) == "probe" {
        return None;
    }
    if matches!(
        text(row.get("kind")),
        "provider_test" | "model_list" | "api_detect"
    ) {
        return None;
    }
    let served = text(row.get("served"));
    let model = if !served.is_empty() {
        served
    } else {
        text(row.get("model"))
    };
    let requested = text(row.get("req"));
    let input = number(row.get("in"));
    let output = number(row.get("out"));
    let cache_read = number(row.get("cache_read"));
    let cache_write = number(row.get("cache_write"));
    // served 可能是别名：依次试 model 与 req，最后才判未计价
    let price = usage_price::lookup(model)
        .or_else(|| usage_price::lookup(text(row.get("model"))))
        .or_else(|| usage_price::lookup(requested));
    let cost = price
        .map(|price| price.cost(input, output, cache_read, cache_write))
        .unwrap_or(0.0);
    Some(Record {
        day: day.to_string(),
        hour: hour.to_string(),
        agent: text(row.get("agent")).to_string(),
        provider: text(row.get("provider")).to_string(),
        model: model.to_string(),
        input,
        output,
        cache_read,
        cache_write,
        reasoning: number(row.get("reasoning")),
        // 截断到 999：as u16 直接转会回绕（65536 → 0，失败被当成成功）
        status: row.get("status").and_then(Value::as_u64).unwrap_or(0).min(999) as u16,
        tries: row.get("tries").and_then(Value::as_u64).unwrap_or(1) as u32,
        cost,
        priced: price.is_some(),
    })
}
