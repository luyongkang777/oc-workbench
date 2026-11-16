//! 额度相关纯函数的测试（独立文件，保证主文件 ≤300 行）。

use crate::provider_quota::{console_url, is_opencode};
use crate::provider_quota_fetch::{is_commandcode, is_deepseek, micro_cents_to_usd};
    use super::*;

    #[test]
    fn recognizes_deepseek_host() {
        assert!(is_deepseek("https://api.deepseek.com/v1"));
        assert!(is_deepseek("https://API.DeepSeek.com"));
        assert!(!is_deepseek("https://opencode.ai/zen/v1"));
    }

    #[test]
    fn micro_cents_to_dollars() {
        // 1 美元 = 1e8 microCents；月限额 6000000000 = $60
        assert_eq!(micro_cents_to_usd(Some(&json!("6000000000"))), 60.0);
        assert_eq!(micro_cents_to_usd(Some(&json!("1062937656"))), 10.63);
        assert_eq!(micro_cents_to_usd(Some(&json!(0))), 0.0);
        assert_eq!(micro_cents_to_usd(None), 0.0);
    }

    #[test]
    fn recognizes_opencode_host() {
        assert!(is_opencode("https://opencode.ai/zen/v1"));
        assert!(!is_opencode("https://api.commandcode.ai/provider/v1"));
    }

    #[test]
    fn recognizes_commandcode_host() {
        assert!(is_commandcode("https://api.commandcode.ai/provider/v1"));
        assert!(!is_commandcode("https://opencode.ai/zen/v1"));
    }

    #[test]
    fn console_links_per_host() {
        assert!(console_url("https://opencode.ai/zen/v1").contains("console"));
        assert!(console_url("https://api.commandcode.ai/provider/v1").contains("studio"));
        assert!(console_url("https://api.deepseek.com/v1").contains("top_up"));
    }

