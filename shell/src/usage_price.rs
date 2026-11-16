//! 模型价格：把 `usage.jsonl` 里的 token 换算成美元。
//!
//! 数据来自 `models.dev` 的精简表（`usage_prices.json`，由
//! `scripts/build-usage-prices.mjs` 生成）：每项是
//! `[input, output, cache_read, cache_write]`，单位 USD / 1M tokens。
//!
//! 这里只做「尽量认出来」：认不出就返回 None，调用方把这次计入「未计价」，
//! **绝不按 0 元算**（那会让费用看起来比实际低）。

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

impl Price {
    /// 一次调用的费用（三个 token 数 + 缓存读/写）。
    pub fn cost(&self, input: u64, output: u64, cache_read: u64, cache_write: u64) -> f64 {
        (input as f64 * self.input
            + output as f64 * self.output
            + cache_read as f64 * self.cache_read
            + cache_write as f64 * self.cache_write)
            / 1_000_000.0
    }
}

/// 解析后的价格表：模型 id → 单价。
fn table() -> &'static HashMap<String, Price> {
    static TABLE: OnceLock<HashMap<String, Price>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let raw = include_str!("usage_prices.json");
        let mut out = HashMap::new();
        let Ok(value) = serde_json::from_str::<Value>(raw) else {
            return out;
        };
        let Some(models) = value.get("models").and_then(Value::as_object) else {
            return out;
        };
        for (id, item) in models {
            let Some(parts) = item.as_array() else {
                continue;
            };
            if parts.len() < 2 {
                continue;
            }
            let number = |index: usize| -> Option<f64> { parts.get(index).and_then(Value::as_f64) };
            let (Some(input), Some(output)) = (number(0), number(1)) else {
                continue;
            };
            // 0 价条目（免费额度/未定价）不可信：当作「认不出」，走未计价
            if input + output <= 0.0 {
                continue;
            }
            out.insert(
                id.to_ascii_lowercase(),
                Price {
                    input,
                    output,
                    cache_read: number(2).unwrap_or(0.0),
                    cache_write: number(3).unwrap_or(0.0),
                },
            );
        }
        out
    })
}

/// 常见的模型名变体：`claude-3-5-sonnet@20240620`、`gpt-4o-2024-08-06`、
/// `deepseek-chat:free` 这类后缀去掉后再查一次。
fn variants(model: &str) -> Vec<String> {
    let lower = model.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return Vec::new();
    }
    let mut out = vec![lower.clone()];
    if let Some((head, _)) = lower.split_once('@') {
        out.push(head.to_string());
    }
    if let Some((head, _)) = lower.split_once(':') {
        out.push(head.to_string());
    }
    // 末尾的日期后缀：-20240620 / -2024-08-06（必须整段砍，
    // 只砍一位数字会把 `kimi-k3-1` 误当成 `kimi-k3`）
    if let Some(head) = strip_date_suffix(&lower) {
        out.push(head);
    }
    out
}

/// 砍掉末尾的日期后缀（`-YYYYMMDD` / `-YYYY-MM-DD`）。
fn strip_date_suffix(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    if bytes.len() > 9
        && bytes[bytes.len() - 9] == b'-'
        && bytes[bytes.len() - 8..].iter().all(|b| b.is_ascii_digit())
    {
        return Some(text[..text.len() - 9].to_string());
    }
    if bytes.len() > 11 {
        let tail = &bytes[bytes.len() - 11..];
        let ok = tail[0] == b'-'
            && tail[1..5].iter().all(|b| b.is_ascii_digit())
            && tail[5] == b'-'
            && tail[6..8].iter().all(|b| b.is_ascii_digit())
            && tail[8] == b'-'
            && tail[9..11].iter().all(|b| b.is_ascii_digit());
        if ok {
            return Some(text[..text.len() - 11].to_string());
        }
    }
    None
}

/// 查价格。`model` 可以是 `deepseek-flash`、`deepseek/deepseek-flash`
/// 或 `provider/model` 形式（后两种会再试最后一段）。
pub fn lookup(model: &str) -> Option<Price> {
    let table = table();
    for candidate in variants(model) {
        if let Some(price) = table.get(&candidate) {
            return Some(*price);
        }
    }
    // provider/model：取最后一段再试一次
    if let Some((_, tail)) = model.trim().rsplit_once('/') {
        for candidate in variants(tail) {
            if let Some(price) = table.get(&candidate) {
                return Some(*price);
            }
        }
    }
    None
}

