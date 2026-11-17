//! WorkBuddy 的单元测试（独立文件，保证主文件 ≤300 行）。

use super::*;


    #[test]
    fn expiry_prefers_absolute_time() {
        let data: Value = serde_json::from_str(r#"{"expiresAt":1790000000000,"expiresIn":3600}"#)
            .unwrap();
        assert_eq!(expiry_of(&data, "expiresAt", "expiresIn"), 1_790_000_000_000);
    }

    #[test]
    fn expiry_turns_seconds_into_ms() {
        let data: Value = serde_json::from_str(r#"{"expiresIn":3600}"#).unwrap();
        let got = expiry_of(&data, "expiresAt", "expiresIn");
        assert!(got > now_ms() + 3_000_000);
    }

    #[test]
    fn query_and_encode_round_trip() {
        assert_eq!(
            query_value("/local/workbuddy/login/poll?state=82b2e733-e84a", "state").as_deref(),
            Some("82b2e733-e84a")
        );
        assert_eq!(encode("a b"), "a%20b");
        assert_eq!(decode("a%20b"), "a b");
    }

    #[test]
    fn with_port_only_touches_our_endpoint() {
        assert_eq!(
            with_port("http://127.0.0.1:1234/local/workbuddy/v1", 5000).as_deref(),
            Some("http://127.0.0.1:5000/local/workbuddy/v1")
        );
        assert_eq!(
            with_port("http://localhost:1234/local/workbuddy/v1", 5000).as_deref(),
            Some("http://localhost:5000/local/workbuddy/v1")
        );
        // 远程入口带 /u/<id> 前缀也要认
        assert_eq!(
            with_port("http://127.0.0.1:1234/u/645a6a9ede23f047/local/workbuddy/v1", 5000)
                .as_deref(),
            Some("http://127.0.0.1:5000/u/645a6a9ede23f047/local/workbuddy/v1")
        );
        // 端口没变 → 不用写盘
        assert_eq!(with_port("http://127.0.0.1:5000/local/workbuddy/v1", 5000), None);
        // 别家端点、别家路径、https 一律不动
        assert_eq!(with_port("https://api.deepseek.com/v1", 5000), None);
        assert_eq!(with_port("http://127.0.0.1:1234/local/provider/v1", 5000), None);
        assert_eq!(with_port("http://127.0.0.1:1234/other", 5000), None);
    }

    #[test]
    fn code_and_msg_read_upstream_shape() {
        let pending: Value = serde_json::from_str(r#"{"code":11217,"msg":"login ing..."}"#).unwrap();
        assert_eq!(code_of(&pending), 11217);
        assert_eq!(msg_of(&pending), "login ing...");
    }

