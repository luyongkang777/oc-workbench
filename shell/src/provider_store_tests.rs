//! `provider_store.rs` 的单元测试（独立文件，保证主文件不超过 300 行）。

use super::*;
use crate::provider_upsert::upsert_provider;
use std::fs;
use std::path::PathBuf;

    fn spec(id: &str, context: u64, output: u64) -> ModelSpec {
        ModelSpec {
            id: id.to_string(),
            name: format!("{id} (Test)"),
            context,
            output,
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oc-provider-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建目录");
        dir
    }

    fn full_config() -> &'static str {
        r#"{
  "model": "purge/deepseek-flash",
  "provider": {
    "keepme": {
      "name": "Keep",
      "options": { "baseURL": "https://keep.example/v1", "apiKey": "sk-keepkeykeepkey12" },
      "models": { "keep-model": { "name": "keep-model" } }
    }
  },
  "mcp": { "servers": {} },
  "instructions": ["./rules/a.md"]
}"#
    }

    #[test]
    fn mask_key_hides_middle() {
        assert_eq!(mask_key("sk-1234567890abcdef"), "sk-1…cdef");
        assert_eq!(mask_key("short"), "*****");
        assert_eq!(mask_key("  "), "");
    }

    #[test]
    fn provider_view_never_leaks_key() {
        let value: Value =
            serde_json::from_str(r#"{"name":"X","options":{"baseURL":"https://x/v1","apiKey":"sk-1234567890abcdef"}}"#)
                .unwrap();
        let view = provider_view("x", &value);
        let text = view.to_string();
        assert!(!text.contains("sk-1234567890abcdef"), "明文 key 不能出现在视图里");
        assert_eq!(view["keyMasked"], "sk-1…cdef");
        assert_eq!(view["hasKey"], true);
        assert_eq!(view["baseURL"], "https://x/v1");
    }

    #[test]
    fn upsert_keeps_hand_tuned_options() {
        let dir = temp_dir("keeps-options");
        let path = dir.join("opencode.json");
        // 中转站常要求自定义 header / timeout，用户在文件里手调过，工作台覆盖时不能丢
        fs::write(
            &path,
            r#"{"provider":{"x":{"name":"X","options":{"baseURL":"https://old/v1","apiKey":"sk-old1234567890","headers":{"x-token":"abc"},"timeout":60000},"models":{"m":{"name":"m"}}}}}"#,
        )
        .unwrap();
        let saved = save_config(&path, |config| {
            upsert_provider(config, "x", "X", "https://new/v1", "sk-new1234567890", &[spec("m", 0, 0)])
        })
        .unwrap();
        let options = &saved["provider"]["x"]["options"];
        assert_eq!(options["baseURL"], "https://new/v1");
        assert_eq!(options["apiKey"], "sk-new1234567890");
        assert_eq!(options["headers"]["x-token"], "abc", "手调的 headers 不能被冲掉");
        assert_eq!(options["timeout"], 60000);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn top_level_keys_ignores_provider() {
        let value: Value = serde_json::from_str(r#"{"provider":{},"a":1,"b":[]}"#).unwrap();
        let keys = crate::provider_io::top_level_keys(&value);
        assert_eq!(
            keys,
            vec![("a".to_string(), "number".to_string()), ("b".to_string(), "array".to_string())]
        );
    }

