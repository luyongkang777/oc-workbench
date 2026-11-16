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

    fn keys(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(key, kind)| (key.to_string(), kind.to_string()))
            .collect()
    }

    #[test]
    fn guard_allows_default_model_rules() {
        // 其它顶层键完全一致 → 放行（model 改值也算）
        assert!(crate::provider_io::guard_allows(
            &keys(&[("model", "string"), ("a", "number")]),
            &keys(&[("model", "string"), ("a", "number")]),
        ));
        // 首次设置默认模型（新电脑上本来没有这个键）→ 放行
        assert!(crate::provider_io::guard_allows(
            &keys(&[("a", "number")]),
            &keys(&[("model", "string"), ("a", "number")]),
        ));
        // 已存在但不是字符串（`"model": null` 最常见）→ 纠正成字符串要放行
        assert!(crate::provider_io::guard_allows(
            &keys(&[("model", "null")]),
            &keys(&[("model", "string")]),
        ));
        assert!(crate::provider_io::guard_allows(
            &keys(&[("model", "number")]),
            &keys(&[("model", "string")]),
        ));
        // 只保存 provider、model 根本没动（原值就是 null）→ 放行
        assert!(crate::provider_io::guard_allows(
            &keys(&[("model", "null")]),
            &keys(&[("model", "null")]),
        ));
        // 写回成 null / 非字符串 → 拦（不能把默认模型写成空值）
        assert!(!crate::provider_io::guard_allows(
            &keys(&[("model", "string")]),
            &keys(&[("model", "null")]),
        ));
        // 新增的 model 不是字符串 → 拦
        assert!(!crate::provider_io::guard_allows(
            &keys(&[]),
            &keys(&[("model", "object")]),
        ));
        // 删掉顶层 model → 拦
        assert!(!crate::provider_io::guard_allows(
            &keys(&[("model", "string")]),
            &keys(&[]),
        ));
        // 别的顶层键类型变了 → 拦
        assert!(!crate::provider_io::guard_allows(
            &keys(&[("mcp", "object")]),
            &keys(&[("mcp", "string")]),
        ));
        // 别的顶层键多一个 → 拦
        assert!(!crate::provider_io::guard_allows(
            &keys(&[]),
            &keys(&[("agents", "object")]),
        ));
        // 入参没排序也不能误判（比较前会统一排序）
        assert!(crate::provider_io::guard_allows(
            &keys(&[("b", "array"), ("a", "number")]),
            &keys(&[("a", "number"), ("b", "array")]),
        ));
    }

    #[test]
    fn first_default_model_can_be_written() {
        // 另一台电脑的实际现场：opencode.json 没有顶层 model（下拉显示「未设置」），
        // 选默认模型时插入这个键，曾经被自检判成「动了别的配置」直接 500。
        let dir = temp_dir("first-model");
        let path = dir.join("opencode.json");
        fs::write(&path, r#"{"provider":{},"instructions":["./a.md"]}"#).unwrap();
        let saved = save_config(&path, |config| {
            config.insert(
                "model".to_string(),
                Value::String("deepseek/deepseek-chat".to_string()),
            );
            Ok(())
        })
        .unwrap();
        assert_eq!(saved["model"], "deepseek/deepseek-chat");
        assert_eq!(saved["instructions"][0], "./a.md", "其它配置不能被冲掉");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn null_default_model_can_be_fixed() {
        // 读取侧把 null 当「未设置」；写回侧若按「类型不能变」拒绝，
        // 界面显示未设置却怎么也存不进去 —— 同一个 500 换了个入口。
        let dir = temp_dir("null-model");
        let path = dir.join("opencode.json");
        fs::write(&path, r#"{"model":null,"provider":{}}"#).unwrap();
        let saved = save_config(&path, |config| {
            config.insert(
                "model".to_string(),
                Value::String("deepseek/deepseek-chat".to_string()),
            );
            Ok(())
        })
        .unwrap();
        assert_eq!(saved["model"], "deepseek/deepseek-chat");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saving_provider_with_null_model_is_allowed() {
        // model 是 null（读取侧当未设置），但这次保存根本没碰 model。
        // 不能因为「after 不是字符串」就拦 —— 否则保存/删除/账号同步全被一条旧值卡死。
        let dir = temp_dir("null-model-save-provider");
        let path = dir.join("opencode.json");
        fs::write(&path, r#"{"model":null,"provider":{},"mcp":{"servers":{}}}"#).unwrap();
        let saved = save_config(&path, |config| {
            upsert_provider(config, "x", "X", "https://x/v1", "sk-1234567890abcdef", &[])
        })
        .unwrap();
        assert!(saved["provider"]["x"].is_object());
        assert!(saved["model"].is_null(), "没碰的 model 要保持原样");
        assert!(saved["mcp"].is_object(), "其它配置也不能动");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn existing_default_model_can_change() {
        let dir = temp_dir("change-model");
        let path = dir.join("opencode.json");
        fs::write(&path, r#"{"model":"a/b","provider":{},"instructions":[]}"#).unwrap();
        let saved = save_config(&path, |config| {
            config.insert("model".to_string(), Value::String("c/d".to_string()));
            Ok(())
        })
        .unwrap();
        assert_eq!(saved["model"], "c/d");
        assert_eq!(saved["instructions"].as_array().map(Vec::len), Some(0));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_default_model_is_rejected() {
        let dir = temp_dir("del-model");
        let path = dir.join("opencode.json");
        let original = r#"{"model":"a/b","provider":{}}"#;
        fs::write(&path, original).unwrap();
        let result = save_config(&path, |config| {
            config.remove("model");
            Ok(())
        });
        assert_eq!(result.unwrap_err().0, 500, "删顶层 model 不在本工作台职责内");
        assert_eq!(fs::read_to_string(&path).unwrap(), original, "文件不能被改");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn changing_other_top_level_key_is_rejected() {
        let dir = temp_dir("touch-mcp");
        let path = dir.join("opencode.json");
        let original = r#"{"provider":{},"mcp":{"servers":{}}}"#;
        fs::write(&path, original).unwrap();
        let result = save_config(&path, |config| {
            config.insert("mcp".to_string(), Value::String("broken".to_string()));
            Ok(())
        });
        assert_eq!(result.unwrap_err().0, 500, "mcp 这类手写配置一个字都不能动");
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        let _ = fs::remove_dir_all(&dir);
    }
