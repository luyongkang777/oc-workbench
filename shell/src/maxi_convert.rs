//! Chat Completions ↔ Responses 协议转换。
//!
//! opencode 只会发标准 `chat/completions`，码栖上游只认 Responses API，
//! 所以请求要翻过去、响应（SSE）要翻回来。参考实现见同仓库的
//! `maxi-gateway`（Node 版），这里是把同一套规则搬进 Rust 外壳。

use serde_json::{json, Map, Value};

fn text_of(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part {
                Value::String(text) => text.clone(),
                Value::Object(map) => map
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                _ => String::new(),
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// chat/completions 请求体 → Responses 请求体。
pub fn to_responses(chat: &Value, model: &str) -> Value {
    let empty = Vec::new();
    let messages = chat
        .get("messages")
        .and_then(Value::as_array)
        .unwrap_or(&empty);

    let mut instructions: Vec<String> = Vec::new();
    let mut input: Vec<Value> = Vec::new();

    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("user");
        let content = message.get("content").cloned().unwrap_or(Value::Null);
        match role {
            "system" | "developer" => {
                let text = text_of(&content);
                if !text.is_empty() {
                    instructions.push(text);
                }
            }
            "tool" => {
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": message.get("tool_call_id").and_then(Value::as_str).unwrap_or(""),
                    "output": text_of(&content),
                }));
            }
            "assistant" => {
                let text = text_of(&content);
                if !text.is_empty() {
                    input.push(json!({
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": text }],
                    }));
                }
                if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                    for call in calls {
                        let function = call.get("function").cloned().unwrap_or(Value::Null);
                        input.push(json!({
                            "type": "function_call",
                            "call_id": call.get("id").and_then(Value::as_str).unwrap_or(""),
                            "name": function.get("name").and_then(Value::as_str).unwrap_or(""),
                            "arguments": function
                                .get("arguments")
                                .and_then(Value::as_str)
                                .unwrap_or("{}"),
                        }));
                    }
                }
            }
            _ => {
                input.push(json!({
                    "role": "user",
                    "content": [{ "type": "input_text", "text": text_of(&content) }],
                }));
            }
        }
    }

    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(model.to_string()));
    body.insert("input".to_string(), Value::Array(input));
    body.insert("stream".to_string(), Value::Bool(true));
    body.insert("store".to_string(), Value::Bool(false));
    if !instructions.is_empty() {
        body.insert("instructions".to_string(), Value::String(instructions.join("\n\n")));
    }

    if let Some(tools) = chat.get("tools").and_then(Value::as_array) {
        let mapped: Vec<Value> = tools
            .iter()
            .filter_map(|tool| {
                let function = tool.get("function")?;
                Some(json!({
                    "type": "function",
                    "name": function.get("name").and_then(Value::as_str).unwrap_or(""),
                    "description": function.get("description").and_then(Value::as_str).unwrap_or(""),
                    "parameters": function
                        .get("parameters")
                        .cloned()
                        .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                    "strict": false,
                }))
            })
            .collect();
        if !mapped.is_empty() {
            body.insert("tools".to_string(), Value::Array(mapped));
            body.insert("tool_choice".to_string(), Value::String("auto".to_string()));
        }
    }

    if let Some(value) = chat.get("temperature").and_then(Value::as_f64) {
        body.insert("temperature".to_string(), json!(value));
    }
    if let Some(value) = chat.get("top_p").and_then(Value::as_f64) {
        body.insert("top_p".to_string(), json!(value));
    }
    if let Some(value) = chat.get("max_tokens").and_then(Value::as_i64) {
        body.insert("max_output_tokens".to_string(), json!(value));
    }

    Value::Object(body)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

/// 把上游 Responses 的 SSE 事件翻成 chat.completion.chunk。
pub struct Translator {
    id: String,
    model: String,
    started: bool,
    tool_index: i64,
    saw_tool: bool,
    pub finished: bool,
    pub usage: Option<Value>,
    buffer: String,
}

impl Translator {
    pub fn new(id: &str, model: &str) -> Self {
        Self {
            id: id.to_string(),
            model: model.to_string(),
            started: false,
            tool_index: -1,
            saw_tool: false,
            finished: false,
            usage: None,
            buffer: String::new(),
        }
    }

    pub fn id(&self) -> String {
        self.id.clone()
    }

    pub fn model(&self) -> String {
        self.model.clone()
    }

    fn chunk(&self, delta: Value, finish: Option<&str>) -> String {
        let body = json!({
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": now_secs(),
            "model": self.model,
            "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }],
        });
        format!("data: {body}\n\n")
    }

    fn start_chunks(&mut self) -> Vec<String> {
        if self.started {
            return Vec::new();
        }
        self.started = true;
        vec![self.chunk(json!({ "role": "assistant", "content": "" }), None)]
    }

    /// 喂一段字节解码后的文本，返回需要写回客户端的 SSE 块。
    pub fn feed(&mut self, text: &str) -> Vec<String> {
        self.buffer.push_str(text);
        let mut out = Vec::new();
        while let Some(index) = self.buffer.find("\n\n") {
            let block: String = self.buffer.drain(..index + 2).collect();
            self.handle_block(&block, &mut out);
        }
        out
    }

    fn handle_block(&mut self, block: &str, out: &mut Vec<String>) {
        let data = block
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim)
            .collect::<Vec<_>>()
            .join("");
        if data.is_empty() || data == "[DONE]" {
            return;
        }
        let Ok(event) = serde_json::from_str::<Value>(&data) else {
            return;
        };
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");

        match kind {
            "response.created" | "response.in_progress" => {
                out.extend(self.start_chunks());
            }
            "response.output_text.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    out.extend(self.start_chunks());
                    out.push(self.chunk(json!({ "content": delta }), None));
                }
            }
            "response.output_item.added" => {
                let Some(item) = event.get("item") else {
                    return;
                };
                if item.get("type").and_then(Value::as_str) != Some("function_call") {
                    return;
                }
                out.extend(self.start_chunks());
                self.saw_tool = true;
                self.tool_index += 1;
                let id = item
                    .get("call_id")
                    .or_else(|| item.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let name = item.get("name").and_then(Value::as_str).unwrap_or("");
                out.push(self.chunk(
                    json!({
                        "tool_calls": [{
                            "index": self.tool_index,
                            "id": id,
                            "type": "function",
                            "function": { "name": name, "arguments": "" },
                        }],
                    }),
                    None,
                ));
            }
            "response.function_call_arguments.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    out.push(self.chunk(
                        json!({
                            "tool_calls": [{
                                "index": self.tool_index.max(0),
                                "function": { "arguments": delta },
                            }],
                        }),
                        None,
                    ));
                }
            }
            "response.completed" => {
                if let Some(usage) = event.get("response").and_then(|r| r.get("usage")) {
                    self.usage = Some(json!({
                        "prompt_tokens": usage.get("input_tokens").and_then(Value::as_i64).unwrap_or(0),
                        "completion_tokens": usage.get("output_tokens").and_then(Value::as_i64).unwrap_or(0),
                        "total_tokens": usage.get("total_tokens").and_then(Value::as_i64).unwrap_or(0),
                    }));
                }
                out.extend(self.start_chunks());
                let finish = if self.saw_tool { "tool_calls" } else { "stop" };
                out.push(self.chunk(json!({}), Some(finish)));
                self.finished = true;
            }
            "response.failed" | "error" => {
                let message = event
                    .get("response")
                    .and_then(|r| r.get("error"))
                    .and_then(|e| e.get("message"))
                    .or_else(|| event.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("上游失败");
                out.push(format!(
                    "data: {}\n\n",
                    json!({ "error": { "message": message, "type": "upstream_error" } })
                ));
                self.finished = true;
            }
            _ => {}
        }
    }

    /// 流结束时补齐收尾块。
    pub fn finish(&mut self) -> Vec<String> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        let mut out = self.start_chunks();
        let finish = if self.saw_tool { "tool_calls" } else { "stop" };
        out.push(self.chunk(json!({}), Some(finish)));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_messages_and_tools() {
        let chat = json!({
            "messages": [
                { "role": "system", "content": "你是助手" },
                { "role": "user", "content": "查天气" },
                { "role": "assistant", "content": "", "tool_calls": [
                    { "id": "c1", "type": "function", "function": { "name": "w", "arguments": "{}" } }
                ] },
                { "role": "tool", "tool_call_id": "c1", "content": "晴" }
            ],
            "tools": [{ "type": "function", "function": { "name": "w", "parameters": { "type": "object" } } }]
        });
        let body = to_responses(&chat, "gpt-6.2-sol");
        assert_eq!(body["model"], "gpt-6.2-sol");
        assert_eq!(body["instructions"], "你是助手");
        assert_eq!(body["input"][1]["type"], "function_call");
        assert_eq!(body["input"][2]["type"], "function_call_output");
        assert_eq!(body["tools"][0]["name"], "w");
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn translates_text_and_finish() {
        let mut t = Translator::new("x", "m");
        let mut out = t.feed("data: {\"type\":\"response.created\"}\n\n");
        out.extend(t.feed("data: {\"type\":\"response.output_text.delta\",\"delta\":\"你好\"}\n\n"));
        out.extend(t.feed("data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"total_tokens\":5}}}\n\n"));
        let joined = out.join("");
        assert!(joined.contains("你好"));
        assert!(joined.contains("\"finish_reason\":\"stop\""));
        assert!(t.finished);
        assert_eq!(t.usage.unwrap()["total_tokens"], 5);
    }

    #[test]
    fn translates_tool_call() {
        let mut t = Translator::new("x", "m");
        let mut out = t.feed("data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"call_id\":\"c9\",\"name\":\"w\"}}\n\n");
        out.extend(t.feed("data: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"{\\\"a\\\":1}\"}\n\n"));
        out.extend(t.feed("data: {\"type\":\"response.completed\",\"response\":{}}\n\n"));
        let joined = out.join("");
        assert!(joined.contains("\"name\":\"w\""));
        assert!(joined.contains("\"finish_reason\":\"tool_calls\""));
    }
}
