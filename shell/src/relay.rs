//! 第三方 provider 转发：让 OpenCode Go / Command Code 的模型请求走梯子。
//!
//! 为什么要有这一层：opencode 的模型请求不读 `HTTP_PROXY`（实测 MCP 请求会读，
//! 模型请求不读），只能把上游地址换成本地转发口。
//!
//! 磁盘上的 `baseURL` 记成
//! `http://127.0.0.1:<port><base>/local/relay/<secret>/<key>`；
//! 界面与账号同步看到的仍是上游真地址（[`to_upstream`] 还原），
//! 所以云端配置存的是上游，换电脑不会带上本机端口。
//!
//! 两个细节都是踩出来的：
//!   * `base` 是远程入口前缀（`/u/<id>`），漏了会被 `server::strip_base` 判 404；
//!   * `secret` 是本机随机串——转发路由排在鉴权之前（opencode 不带页面令牌），
//!     没有它公网入口也能当免费代理用。
//!
//! 单机模式的端口每次随机（`server::start` 的 `ctx.port == 0`），
//! 启动时用 [`heal_provider_ports`] 校正一次（workbuddy 同款做法）。
//! HTTP 转发本体在 [`crate::relay_http`]。

use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::OnceLock;

use serde_json::Value;

use crate::provider_store::{config_path, read_config, save_config};

/// 转发路由前缀。必须排在 `/local` 的令牌校验之前（opencode 不带页面令牌）。
pub const PREFIX: &str = "/local/relay/";

/// 默认梯子：和「版本与更新」用的是同一台中继。
///
/// 默认走 socks5：ureq 发 HTTP 代理认证时用的是小写 `basic`，xray 不认（实测 407）。
/// socks5 会本地解析域名——这两个上游在国内都能解析，够用。
pub const DEFAULT_PROXY: &str =
    "socks5://ocw:0bef7126f6d85e3164bddc3a@192.220.50.95:18088";

/// 允许代理的两个上游：key → 真实地址。
const TARGETS: [(&str, &str); 2] = [
    ("go", "https://opencode.ai/inference/go/openai/v1"),
    ("cc", "https://api.commandcode.ai/provider/v1"),
];

/// 本次启动实际监听的端口。0 = 还不知道（此时一律不改写，保持原样最安全）。
static PORT: AtomicU16 = AtomicU16::new(0);
/// 远程入口前缀（`/u/<id>` 或空串）。启动时设置一次。
static BASE: OnceLock<String> = OnceLock::new();
/// 本机随机密钥（放进转发路径，挡掉公网入口的滥用）。
static SECRET: OnceLock<String> = OnceLock::new();

pub fn set_port(port: u16) {
    PORT.store(port, Ordering::Relaxed);
}

pub fn port() -> u16 {
    PORT.load(Ordering::Relaxed)
}

pub fn set_base(base: &str) {
    let _ = BASE.set(base.trim_end_matches('/').to_string());
}

pub fn base() -> &'static str {
    BASE.get().map(|text| text.as_str()).unwrap_or("")
}

/// 32 位十六进制随机串（用 `RandomState` 的 OS 随机种子，不引入新依赖）。
fn random_hex() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos() as u64)
        .unwrap_or(0);
    let mut text = String::new();
    for round in 0..2u64 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(now ^ (round << 32));
        hasher.write_u32(std::process::id());
        text.push_str(&format!("{:016x}", hasher.finish()));
    }
    text
}

/// 本机随机密钥：settings 里有就沿用，没有就生成并落盘。
pub fn secret() -> &'static str {
    SECRET.get_or_init(|| {
        if let Some(text) = crate::update::load_settings()
            .get("relaySecret")
            .and_then(Value::as_str)
        {
            let text = text.trim();
            if text.len() >= 16 {
                return text.to_string();
            }
        }
        let fresh = random_hex();
        let mut map = crate::update::load_settings();
        map.insert("relaySecret".to_string(), Value::String(fresh.clone()));
        let _ = crate::update::save_settings(map);
        fresh
    })
}

pub fn upstream_of(key: &str) -> Option<&'static str> {
    TARGETS.iter().find(|(id, _)| *id == key).map(|(_, url)| *url)
}

/// 上游地址 → key。只认整段前缀，别把用户自填的中转站也改写。
pub fn key_of_upstream(url: &str) -> Option<&'static str> {
    let text = url.trim().trim_end_matches('/');
    TARGETS
        .iter()
        .find(|(_, base)| text == *base)
        .map(|(key, _)| *key)
}

/// 宽松解析：`go/...` 与 `<任意密钥>/go/...` 都认。
///
/// 这里**不校验密钥**——配置里的密钥可能来自别的机器/上一版（换机、重装），
/// 严校验会让 [`heal_provider_ports`] 修不回来。真正挡人的是 [`split_target_at`]。
fn loose_target(tail: &str) -> Option<&'static str> {
    let (first, rest) = match tail.split_once('/') {
        Some((first, rest)) => (first, rest),
        None => (tail, ""),
    };
    if let Some(url) = upstream_of(first) {
        return Some(url);
    }
    let key = match rest.split_once('/') {
        Some((key, _)) => key,
        None => rest,
    };
    upstream_of(key)
}

/// 严格解析（HTTP 入口用）：必须有本机密钥，且第一段就得对上。
///
/// 不兼容「无密钥」的旧形态——那正是公网入口能当免费代理的口子。
/// 旧配置不需要兼容：启动时 heal_provider_ports 会按当前密钥重写。
pub fn split_target_at(tail: &str, secret: &str) -> Option<(&'static str, String)> {
    let (first, rest) = tail.split_once('/')?;
    if first != secret {
        return None;
    }
    let (key, rest) = match rest.split_once('/') {
        Some((key, rest)) => (key, rest),
        None => (rest, ""),
    };
    Some((upstream_of(key)?, rest.to_string()))
}

pub fn split_target(tail: &str) -> Option<(&'static str, String)> {
    split_target_at(tail, secret())
}

/// 上游地址 → 本地转发地址（显式给端口/前缀/密钥，便于单测）。
pub fn to_local_full(url: &str, port: u16, base: &str, secret: &str) -> String {
    if port == 0 {
        return url.to_string();
    }
    match key_of_upstream(url) {
        Some(key) => format!(
            "http://127.0.0.1:{port}{}/local/relay/{secret}/{key}",
            base.trim_end_matches('/')
        ),
        None => url.to_string(),
    }
}

/// 上游地址 → 本地转发地址（用本次启动的端口、前缀与密钥）。
pub fn to_local(url: &str, port: u16) -> String {
    to_local_full(url, port, base(), secret())
}

/// 本地转发地址（任意端口、带不带前缀/密钥都行）→ 上游地址；不是转发地址就原样返回。
pub fn to_upstream(url: &str) -> String {
    let text = url.trim().trim_end_matches('/');
    let Some(index) = text.find(PREFIX) else {
        return url.to_string();
    };
    let head = &text[..index];
    if !(head.starts_with("http://127.0.0.1:") || head.starts_with("http://localhost:")) {
        return url.to_string();
    }
    match loose_target(&text[index + PREFIX.len()..]) {
        Some(upstream) => upstream.to_string(),
        None => url.to_string(),
    }
}

/// 当前代理：settings 的 `relayProxy` 优先（空串 = 直连），没有就用内置中继。
pub fn proxy() -> Option<String> {
    let settings = crate::update::load_settings();
    match settings.get("relayProxy").and_then(Value::as_str) {
        Some(text) if text.trim().is_empty() => None,
        Some(text) => Some(text.trim().to_string()),
        None => Some(DEFAULT_PROXY.to_string()),
    }
}

/// 启动时把两个 provider 的本地转发地址校正成本次端口（与前缀）。
///
/// 单机模式端口每次随机、远程模式前缀固定，不校正就会指向上一轮的地址；
/// 没有需要改的直接返回，避免每次启动都留一份配置备份。
pub fn heal_provider_ports(port: u16) {
    if port == 0 || port >= 65_535 {
        return;
    }
    let Some(path) = config_path(None) else {
        return;
    };
    let (value, error) = read_config(&path);
    if error.is_some() {
        return;
    }
    let needs = value
        .get("provider")
        .and_then(Value::as_object)
        .map(|providers| {
            providers.values().any(|entry| {
                entry
                    .get("options")
                    .and_then(|options| options.get("baseURL"))
                    .and_then(Value::as_str)
                    .map(|current| to_local(&to_upstream(current), port) != current)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    if !needs {
        return;
    }
    let saved = save_config(&path, |map| {
        let Some(providers) = map.get_mut("provider").and_then(Value::as_object_mut) else {
            return Ok(());
        };
        for entry in providers.values_mut() {
            let Some(options) = entry.get_mut("options").and_then(Value::as_object_mut) else {
                continue;
            };
            let Some(current) = options.get("baseURL").and_then(Value::as_str) else {
                continue;
            };
            let next = to_local(&to_upstream(current), port);
            if next != current {
                options.insert("baseURL".to_string(), Value::String(next));
            }
        }
        Ok(())
    });
    if saved.is_ok() {
        crate::append_log(&format!(
            "[relay] 已把 provider 转发地址校正到端口 {port}{}\n",
            base()
        ));
    }
}

#[cfg(test)]
#[path = "relay_tests.rs"]
mod tests;
