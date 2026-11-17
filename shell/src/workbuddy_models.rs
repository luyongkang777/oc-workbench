//! WorkBuddy 内置模型表与 `/models` 端点（从 `workbuddy_proxy.rs` 拆出来）。
//!
//! 这张表是本地转发的「能力声明」：模型 id、显示名、上下文、输出上限。
//! 上游真正的模型列表由它自己的 `/v2/...` 返回，这里只给 opencode 用的静态描述。

use serde_json::{json, Value};
use tiny_http::{Method, Request};

pub(crate) const MODELS: &[(&str, &str, u64, u64)] = &[
    ("auto", "Auto", 168_000, 0),
    ("hy4-preview-f", "Hy4 preview", 1_000_000, 0),
    ("hy3", "Hy3", 192_000, 0),
    ("hy3-x", "Hy3-X", 192_000, 0),
    ("deepseek-v4.1-flash", "Deepseek-V4.1-Flash", 1_000_000, 128_000),
    ("glm-5.3", "GLM-5.3", 1_000_000, 0),
    ("glm-5.3-flash", "GLM-5.3-Flash", 1_000_000, 131_072),
    ("glm-5.2", "GLM-5.2", 1_000_000, 0),
    ("glm-5.1", "GLM-5.1", 200_000, 0),
    ("glm-5v-turbo", "GLM-5v-Turbo", 200_000, 0),
    ("minimax-m3", "MiniMax-M3", 512_000, 0),
    ("kimi-k3-1", "Kimi-K3", 1_000_000, 0),
    ("kimi-k2.7", "Kimi-K2.7-Code", 256_000, 0),
    ("kimi-k2.6", "Kimi-K2.6", 256_000, 0),
    ("deepseek-v4-pro", "Deepseek-V4-Pro", 1_000_000, 128_000),
];

/// 聊天可以跑很久（思考 + 长回答），只限制连接和单次读，不设总时限。

pub(crate) fn models_endpoint(request: Request) {
    if request.method() != &Method::Get {
        let _ = crate::server::json_error(request, 405, "模型列表只支持 GET");
        return;
    }
    let data: Vec<Value> = MODELS
        .iter()
        .map(|(id, name, context, output)| {
            json!({
                "id": id,
                "object": "model",
                "name": name,
                "owned_by": "workbuddy",
                "context_length": context,
                "context_window": context,
                "max_output_tokens": output,
            })
        })
        .collect();
    let body = json!({ "object": "list", "data": data });
    let _ = crate::server::respond_json(request, 200, body.to_string());
}
