//! 强制规则接口：`/local/rules/*`
//!
//! 规则是**条目**（单行 / 标题+内容两行），存 JSON：
//!   全局 `%USERPROFILE%\.config\opencode\rules\workbench-global.json`
//!   目录 `<项目目录>\.opencode\rules.json`
//!
//! 判定（注入 / 拦截）在 `~/.config/opencode/plugins/rules` 插件里，外壳只读写文件。
//! 老版本的整块 `.md` 会被解析成条目（只读兼容），第一次保存时改名留档。
//!
//!   * `GET  /local/rules/status?directory=`  两级条目 + 状态
//!   * `POST /local/rules/save`              整份覆盖 `{ scope, directory?, items }`
//!
//! 没有「关闭」接口：清空全部条目才是取消约束。

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};
use tiny_http::{Method, Request};

use crate::body::{read_body_with_timeout, BodyRead};
use crate::rules_store::{
    count_items, data_dir, empty_local, global_json, global_legacy, local_json, local_legacy,
    percent_decode, plugin_dir, push_item, read_rule,
};

/// 与 core.mts 的 MAX_RULE_BYTES 必须一致。
const MAX_RULE_BYTES: usize = 64 * 1024;
const BODY_LIMIT: usize = MAX_RULE_BYTES + 8 * 1024;
/// 条目数上限：防止一次粘贴几万条把界面和注入撑爆。
const MAX_ITEMS: usize = 500;

pub fn handle(request: Request, path: &str, url: &str) {
    match path.rsplit('/').next().unwrap_or("") {
        "status" => {
            if request.method() != &Method::Get {
                let _ = crate::server::json_error(request, 405, "状态只支持 GET");
                return;
            }
            let directory = directory_param(url);
            let _ = crate::server::respond_json(request, 200, status_json(&directory).to_string());
        }
        "save" => {
            if request.method() != &Method::Post {
                let _ = crate::server::json_error(request, 405, "保存只支持 POST");
                return;
            }
            save_endpoint(request);
        }
        _ => {
            let _ = crate::server::json_error(request, 404, "未知的规则接口");
        }
    }
}

fn directory_param(url: &str) -> String {
    let Some((_, query)) = url.split_once('?') else {
        return String::new();
    };
    for pair in query.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            if key == "directory" {
                return percent_decode(value);
            }
        }
    }
    String::new()
}

fn status_json(directory: &str) -> Value {
    let global = match global_json() {
        Some(file) => read_rule("global", &file, global_legacy().as_deref()),
        None => read_rule("global", Path::new(""), None),
    };
    let local = if directory.trim().is_empty() {
        empty_local()
    } else {
        let file = local_json(directory);
        let legacy = local_legacy(directory);
        read_rule("local", &file, Some(&legacy))
    };

    let total = count_items(&global) + count_items(&local);
    let read_errors = [&global, &local]
        .iter()
        .filter(|item| item.get("error").map(|v| !v.is_null()).unwrap_or(false))
        .count();
    let plugin_installed = plugin_dir().map(|dir| dir.join("index.ts").is_file()).unwrap_or(false);

    json!({
        "ok": true,
        "directory": directory,
        "global": global,
        "local": local,
        "active": total > 0,
        "totalItems": total,
        "readErrors": read_errors,
        "pluginInstalled": plugin_installed,
        "pluginDir": plugin_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        "dataDir": data_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        "maxBytes": MAX_RULE_BYTES,
        "maxItems": MAX_ITEMS,
    })
}

fn save_endpoint(request: Request) {
    let Some((request, body)) = read_body_with_timeout(request, BODY_LIMIT) else {
        return;
    };
    let text = match body {
        BodyRead::Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
        BodyRead::TooLarge => {
            let _ = crate::server::json_error(request, 413, "请求体过大");
            return;
        }
        BodyRead::Failed(err) => {
            let _ = crate::server::json_error(request, 400, &format!("读取请求体失败：{err}"));
            return;
        }
    };
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(err) => {
            let _ = crate::server::json_error(request, 400, &format!("请求体不是 JSON：{err}"));
            return;
        }
    };

    let scope = parsed.get("scope").and_then(Value::as_str).unwrap_or("");
    let directory = parsed
        .get("directory")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();

    // items 必须显式给出：缺字段当成「清空」太危险（一个畸形请求就能抹掉强制规则）
    let Some(list) = parsed.get("items").and_then(Value::as_array) else {
        let _ = crate::server::json_error(request, 400, "缺少 items 数组（清空请显式传 []）");
        return;
    };
    let mut items: Vec<Value> = Vec::new();
    for entry in list {
        push_item(
            &mut items,
            entry.get("title").and_then(Value::as_str).unwrap_or(""),
            entry.get("text").and_then(Value::as_str).unwrap_or(""),
        );
    }
    if items.len() > MAX_ITEMS {
        let _ = crate::server::json_error(request, 413, &format!("条目数超过 {MAX_ITEMS} 条上限"));
        return;
    }

    let (file, legacy) = match scope {
        "global" => match global_json() {
            Some(file) => (file, global_legacy()),
            None => {
                let _ = crate::server::json_error(request, 500, "找不到用户目录");
                return;
            }
        },
        "local" => {
            if directory.is_empty() {
                let _ = crate::server::json_error(request, 400, "缺少 directory（当前项目目录）");
                return;
            }
            if !Path::new(&directory).is_absolute() {
                let _ = crate::server::json_error(request, 400, "directory 必须是绝对路径");
                return;
            }
            (local_json(&directory), Some(local_legacy(&directory)))
        }
        _ => {
            let _ = crate::server::json_error(request, 400, "scope 只能是 global 或 local");
            return;
        }
    };

    let payload = json!({ "version": 1, "items": items }).to_string();
    if payload.len() > MAX_RULE_BYTES {
        let _ = crate::server::json_error(request, 413, "规则体积超过上限");
        return;
    }
    if let Some(parent) = file.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            let _ = crate::server::json_error(request, 500, &format!("建目录失败：{err}"));
            return;
        }
    }

    // 先写临时文件再 rename：面板连续保存时不会读到半截 JSON。
    // 文件名带 pid + 纳秒：两次保存撞同一个临时文件会互相截断。
    let stamp = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = file.with_extension(format!("json.tmp-{}-{stamp}", std::process::id()));
    if let Err(err) = fs::write(&tmp, format!("{payload}\n")) {
        let _ = crate::server::json_error(request, 500, &format!("写临时文件失败：{err}"));
        return;
    }
    if let Err(err) = fs::rename(&tmp, &file) {
        let _ = fs::remove_file(&tmp);
        let _ = crate::server::json_error(request, 500, &format!("替换规则文件失败：{err}"));
        return;
    }

    // 迁移：老 md 已并入 JSON，改名留档，避免两处内容并存
    if let Some(old) = legacy {
        if old.is_file() && fs::metadata(&old).map(|m| m.len() > 0).unwrap_or(false) {
            let _ = fs::rename(&old, old.with_extension(format!("md.migrated-{stamp}")));
        }
    }

    let _ = crate::server::respond_json(request, 200, status_json(&directory).to_string());
}
