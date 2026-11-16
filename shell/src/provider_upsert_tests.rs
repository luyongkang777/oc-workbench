//! provider 写入相关的测试（从 provider_store_tests.rs 拆出来，保持单文件 ≤300 行）。

use super::*;
use crate::provider_store::save_config;
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
    fn upsert_keeps_other_providers_and_top_level_keys() {
        let dir = temp_dir("upsert");
        let path = dir.join("opencode.json");
        fs::write(&path, full_config()).unwrap();

        let saved = save_config(&path, |config| {
            upsert_provider(
                config,
                "deepseek",
                "DeepSeek 官方",
                "https://api.deepseek.com/v1",
                "sk-newkey1234567890",
                &[spec("deepseek-chat", 0, 0)],
            )
        })
        .expect("应该保存成功");

        // 顶层键没丢
        assert_eq!(saved["model"], "purge/deepseek-flash");
        assert!(saved["mcp"].is_object());
        assert!(saved["instructions"].is_array());
        // 原 provider 原样还在
        assert_eq!(saved["provider"]["keepme"]["options"]["apiKey"], "sk-keepkeykeepkey12");
        // 新 provider 写对了
        assert_eq!(saved["provider"]["deepseek"]["options"]["baseURL"], "https://api.deepseek.com/v1");
        assert_eq!(
            saved["provider"]["deepseek"]["models"]["deepseek-chat"]["name"],
            "deepseek-chat (Test)"
        );
        assert_eq!(saved["provider"]["deepseek"]["npm"], "@ai-sdk/openai-compatible");

        // 磁盘上也真的写进去了，且 JSON 合法
        let text = fs::read_to_string(&path).unwrap();
        let disk: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(disk["provider"]["deepseek"]["name"], "DeepSeek 官方");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn upsert_keeps_hand_tuned_model_fields() {
        let dir = temp_dir("keeps-fields");
        let path = dir.join("opencode.json");
        fs::write(
            &path,
            r#"{"provider":{"x":{"name":"X","models":{"m":{"name":"My Name","limit":{"context":123}}}}}}"#,
        )
        .unwrap();
        let saved = save_config(&path, |config| {
            upsert_provider(config, "x", "X", "https://x/v1", "sk-1234567890abcdef", &[spec("m", 0, 0)])
        })
        .unwrap();
        // 名字现在是「模型名 (商家名)」由界面写，保留 limit 等手调字段
        assert_eq!(saved["provider"]["x"]["models"]["m"]["name"], "m (Test)");
        assert_eq!(saved["provider"]["x"]["models"]["m"]["limit"]["context"], 123);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_only_touches_that_provider() {
        let dir = temp_dir("remove");
        let path = dir.join("opencode.json");
        fs::write(&path, full_config()).unwrap();
        let saved = save_config(&path, |config| remove_provider(config, "keepme")).unwrap();
        assert!(saved["provider"].as_object().unwrap().is_empty());
        assert!(saved["provider"].is_object(), "删空后仍要保留 provider 键");
        assert_eq!(saved["model"], "purge/deepseek-flash");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_json_refuses_to_write() {
        let dir = temp_dir("broken");
        let path = dir.join("opencode.json");
        fs::write(&path, r#"{"provider": {"x": tru"#).unwrap();
        let result = save_config(&path, |config| {
            upsert_provider(config, "y", "Y", "https://y/v1", "sk-1234567890abcdef", &[])
        });
        assert!(result.is_err());
        let (code, _) = result.unwrap_err();
        assert_eq!(code, 409);
        // 原文件一个字节都没变
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"provider": {"x": tru"#);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_creates_backup() {
        let dir = temp_dir("backup");
        let path = dir.join("opencode.json");
        fs::write(&path, full_config()).unwrap();
        save_config(&path, |config| {
            upsert_provider(config, "z", "Z", "https://z/v1", "sk-1234567890abcdef", &[])
        })
        .unwrap();
        let backups: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("opencode.json.bak-"))
            .collect();
        assert_eq!(backups.len(), 1, "应该有一份备份：{backups:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn writes_explicit_context() {
        let dir = temp_dir("ctx");
        let path = dir.join("opencode.json");
        fs::write(&path, "{}").unwrap();
        let saved = save_config(&path, |config| {
            upsert_provider(
                config,
                "d",
                "D",
                "https://d/v1",
                "sk-1234567890abcdef",
                &[spec("m", 1_000_000, 393_216)],
            )
        })
        .unwrap();
        // 1M 的模型必须写 1M（不能退回 128k）
        assert_eq!(saved["provider"]["d"]["models"]["m"]["limit"]["context"], 1_000_000);
        assert_eq!(saved["provider"]["d"]["models"]["m"]["limit"]["output"], 393_216);
        assert_eq!(saved["provider"]["d"]["models"]["m"]["name"], "m (Test)");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn omits_limit_when_unknown() {
        let dir = temp_dir("no-limit");
        let path = dir.join("opencode.json");
        fs::write(&path, "{}").unwrap();
        let saved = save_config(&path, |config| {
            upsert_provider(
                config,
                "d",
                "D",
                "https://d/v1",
                "sk-1234567890abcdef",
                &[spec("m", 0, 0)],
            )
        })
        .unwrap();
        assert!(saved["provider"]["d"]["models"]["m"].get("limit").is_none());
        let _ = fs::remove_dir_all(&dir);
    }


    #[test]
    fn read_failure_refuses_to_write() {
        // 把一个目录当成 opencode.json：读它一定失败（不是 NotFound）。
        // 这种失败必须拒写——曾经被当成「空配置」，结果整份文件被覆盖成只剩 provider。
        let dir = temp_dir("unreadable");
        let path = dir.join("opencode.json");
        fs::create_dir_all(&path).unwrap();
        let result = save_config(&path, |config| {
            upsert_provider(config, "x", "X", "https://x/v1", "sk-1234567890abcdef", &[])
        });
        assert!(result.is_err(), "读失败时必须拒写");
        assert!(path.is_dir(), "原路径不能被改掉");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn upsert_keeps_unknown_provider_fields_and_custom_npm() {
        let dir = temp_dir("extra-fields");
        let path = dir.join("opencode.json");
        fs::write(
            &path,
            r#"{"provider":{"x":{"name":"X","npm":"@ai-sdk/openai","env":["A=1"],"blacklist":["b"],"whitelist":["w"],"options":{"baseURL":"https://x/v1","apiKey":"sk-1234567890abcdef","headers":{"x-k":"v"}},"models":{"m":{"name":"m"}}}}}"#,
        )
        .unwrap();
        let saved = save_config(&path, |config| {
            upsert_provider(config, "x", "X2", "https://x/v1", "sk-1234567890abcdef", &[spec("m", 0, 0)])
        })
        .unwrap();
        let entry = &saved["provider"]["x"];
        assert_eq!(entry["npm"], "@ai-sdk/openai", "自定义 npm 不能被改写");
        assert_eq!(entry["env"][0], "A=1");
        assert_eq!(entry["blacklist"][0], "b");
        assert_eq!(entry["whitelist"][0], "w");
        assert_eq!(entry["options"]["headers"]["x-k"], "v", "options 手调字段要保留");
        assert_eq!(entry["name"], "X2", "name 归界面管");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_saves_do_not_lose_updates() {
        let dir = temp_dir("concurrent");
        let path = dir.join("opencode.json");
        fs::write(&path, "{}").unwrap();
        let mut handles = Vec::new();
        for index in 0..8 {
            let path = path.clone();
            handles.push(std::thread::spawn(move || {
                let id = format!("p{index}");
                save_config(&path, |config| {
                    upsert_provider(
                        config,
                        &id,
                        &id,
                        "https://x/v1",
                        "sk-1234567890abcdef",
                        &[],
                    )
                })
            }));
        }
        for handle in handles {
            handle.join().unwrap().expect("并发保存都应该成功");
        }
        let text = fs::read_to_string(&path).unwrap();
        let disk: Value = serde_json::from_str(&text).unwrap();
        for index in 0..8 {
            assert!(
                disk["provider"][format!("p{index}")].is_object(),
                "第 {index} 条被并发写丢了"
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_original_key_order() {
        // 顶层键顺序必须保持原样：否则每次保存都会重排整个文件，
        // 用户看 git diff 会以为被改了一大片。
        let dir = temp_dir("order");
        let path = dir.join("opencode.json");
        fs::write(&path, r#"{"model":"m","provider":{},"agents":{},"instructions":[]}"#).unwrap();
        save_config(&path, |config| {
            upsert_provider(config, "x", "X", "https://x/v1", "sk-1234567890abcdef", &[])
        })
        .unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let model = text.find("\"model\"").unwrap();
        let provider = text.find("\"provider\"").unwrap();
        let agents = text.find("\"agents\"").unwrap();
        let instructions = text.find("\"instructions\"").unwrap();
        assert!(model < provider && provider < agents && agents < instructions, "{text}");
        let _ = fs::remove_dir_all(&dir);
    }
