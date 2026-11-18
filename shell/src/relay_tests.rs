//! relay 的地址映射（纯函数），不碰网络。

use super::{key_of_upstream, split_target_at, to_local_full, to_upstream};

const GO: &str = "https://opencode.ai/inference/go/openai/v1";
const CC: &str = "https://api.commandcode.ai/provider/v1";
const KEY: &str = "0123456789abcdef0123456789abcdef";

#[test]
fn to_local_maps_known_upstreams() {
    assert_eq!(
        to_local_full(GO, 17800, "", KEY),
        format!("http://127.0.0.1:17800/local/relay/{KEY}/go")
    );
    assert_eq!(
        to_local_full(CC, 17800, "", KEY),
        format!("http://127.0.0.1:17800/local/relay/{KEY}/cc")
    );
}

#[test]
fn to_local_keeps_remote_base_prefix() {
    // 远程模式下漏了 /u/<id> 前缀会被 strip_base 判 404（实测踩过）
    assert_eq!(
        to_local_full(GO, 17800, "/u/645a6a9ede23f047", KEY),
        format!("http://127.0.0.1:17800/u/645a6a9ede23f047/local/relay/{KEY}/go")
    );
    // 尾斜杠不该产生双斜杠
    assert_eq!(
        to_local_full(CC, 5273, "/u/abc/", KEY),
        format!("http://127.0.0.1:5273/u/abc/local/relay/{KEY}/cc")
    );
}

#[test]
fn to_local_ignores_trailing_slash() {
    assert_eq!(
        to_local_full("https://opencode.ai/inference/go/openai/v1/", 5273, "", KEY),
        format!("http://127.0.0.1:5273/local/relay/{KEY}/go")
    );
}

#[test]
fn to_local_keeps_other_urls() {
    assert_eq!(
        to_local_full("https://api.deepseek.com/v1", 17800, "", KEY),
        "https://api.deepseek.com/v1"
    );
    // 同域不同路径：那是按量付费网关，不能当套餐上游改写
    assert_eq!(
        to_local_full("https://opencode.ai/zen/v1", 17800, "", KEY),
        "https://opencode.ai/zen/v1"
    );
}

#[test]
fn to_local_without_port_is_noop() {
    assert_eq!(to_local_full(GO, 0, "", KEY), GO);
}

#[test]
fn to_upstream_maps_any_port_and_prefix() {
    assert_eq!(
        to_upstream(&format!("http://127.0.0.1:1234/local/relay/{KEY}/go")),
        GO
    );
    assert_eq!(
        to_upstream(&format!("http://127.0.0.1:9/local/relay/{KEY}/cc/")),
        CC
    );
    assert_eq!(
        to_upstream(&format!("http://127.0.0.1:17800/u/abc/local/relay/{KEY}/cc")),
        CC
    );
    // 旧格式（没有密钥段）也要能还原
    assert_eq!(to_upstream("http://127.0.0.1:17800/local/relay/go"), GO);
    // 换过密钥的旧地址同样要认（否则 heal 修不回来）
    assert_eq!(
        to_upstream("http://127.0.0.1:17800/local/relay/feedface00/cc"),
        CC
    );
}

#[test]
fn to_upstream_keeps_other_urls() {
    assert_eq!(
        to_upstream("http://127.0.0.1:3425/v1"),
        "http://127.0.0.1:3425/v1"
    );
    assert_eq!(
        to_upstream("https://api.deepseek.com/v1"),
        "https://api.deepseek.com/v1"
    );
    assert_eq!(
        to_upstream("http://127.0.0.1:17800/local/relay/nope"),
        "http://127.0.0.1:17800/local/relay/nope"
    );
    // 外站不该被当成转发地址还原
    assert_eq!(
        to_upstream("https://evil.example/local/relay/go"),
        "https://evil.example/local/relay/go"
    );
}

#[test]
fn roundtrip_keeps_upstream() {
    for url in [GO, CC] {
        for base in ["", "/u/abc"] {
            let local = to_local_full(url, 6000, base, KEY);
            assert_eq!(to_upstream(&local), url);
            assert_eq!(
                to_local_full(&to_upstream(&local), 7000, base, KEY),
                to_local_full(url, 7000, base, KEY)
            );
        }
    }
}

#[test]
fn key_of_upstream_is_exact() {
    assert_eq!(key_of_upstream(GO), Some("go"));
    assert_eq!(key_of_upstream(CC), Some("cc"));
    // 带子路径的不是这个上游
    assert_eq!(
        key_of_upstream("https://opencode.ai/inference/go/openai/v1/other"),
        None
    );
}

#[test]
fn split_target_requires_secret() {
    // 入口不认「无密钥」的旧形态（那正是公网能当代理的口子）
    assert_eq!(split_target_at("go/models", KEY), None);
    assert_eq!(split_target_at("go", KEY), None);

    // 带密钥：密钥必须对得上
    let text = format!("{KEY}/cc/chat/completions");
    assert_eq!(
        split_target_at(&text, KEY),
        Some((CC, "chat/completions".to_string()))
    );
    assert_eq!(
        split_target_at(&format!("{KEY}/go"), KEY),
        Some((GO, String::new()))
    );
}

#[test]
fn split_target_rejects_wrong_secret() {
    // 公网入口靠这条挡住
    assert_eq!(split_target_at("wrongsecret/cc/models", KEY), None);
    assert_eq!(split_target_at("unknown", KEY), None);
    assert_eq!(split_target_at("", KEY), None);
}
