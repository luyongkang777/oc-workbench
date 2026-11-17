//! WorkBuddy 登录态与本地密钥的读写（从 `workbuddy.rs` 拆出来）。
//!
//! 这里只做「磁盘上有什么」，网络刷新在 `workbuddy.rs`。

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// 一份登录态（落盘形状见 `save`）。
#[derive(Debug, Default, Clone)]
pub struct Auth {
    pub access: String,
    pub refresh: String,
    /// 毫秒时间戳；0 表示上游没给
    pub expires: i64,
    pub refresh_expires: i64,
    pub uid: String,
    /// 账号的 domain（企业版是它自己的主机名）；普通账号为空
    pub domain: String,
    pub account: String,
    pub enterprise: String,
}

impl Auth {
    pub fn configured(&self) -> bool {
        !self.access.is_empty() || !self.refresh.is_empty()
    }
}


pub(crate) fn data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join("oc-workbench")
}


pub(crate) fn auth_path() -> PathBuf {
    data_dir().join("workbuddy.json")
}


pub(crate) fn settings_path() -> PathBuf {
    data_dir().join("settings.json")
}


pub(crate) fn save(auth: &Auth) {
    let dir = data_dir();
    let _ = fs::create_dir_all(&dir);
    let body = json!({
        "access": auth.access,
        "refresh": auth.refresh,
        "expires": auth.expires,
        "refreshExpiresAt": auth.refresh_expires,
        "uid": auth.uid,
        "domain": auth.domain,
        "account": auth.account,
        "enterpriseId": auth.enterprise,
    });
    let _ = fs::write(auth_path(), body.to_string());
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}


/// 随机字节 → 小写十六进制（本机密钥、请求 id 用）。

// ---------- 端口校正 ----------

pub fn with_port(base: &str, port: u16) -> Option<String> {
    let rest = base.strip_prefix("http://")?;
    let (host, path) = rest.split_once('/')?;
    let (name, old_port) = host.rsplit_once(':')?;
    if name != "127.0.0.1" && name != "localhost" {
        return None;
    }
    // 远程入口会在前面加 `/u/<id>` 前缀，所以按「结尾」判断而不是开头
    if !(path == "local/workbuddy/v1" || path.ends_with("/local/workbuddy/v1")) {
        return None;
    }
    if old_port.parse::<u16>().ok()? == port {
        return None;
    }
    Some(format!("http://{name}:{port}/{path}"))
}

pub fn heal_provider_port(port: u16) {
    if port == 0 {
        return;
    }
    let Some(path) = crate::provider_store::config_path(None) else {
        return;
    };
    let (value, error) = crate::provider_store::read_config(&path);
    if error.is_some() {
        return;
    }
    let base = value
        .get("provider")
        .and_then(|providers| providers.get("workbuddy"))
        .and_then(|entry| entry.get("options"))
        .and_then(|options| options.get("baseURL"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let Some(next) = with_port(base, port) else {
        return;
    };
    let saved = crate::provider_store::save_config(&path, |map| {
        let entry = map
            .get_mut("provider")
            .and_then(Value::as_object_mut)
            .and_then(|providers| providers.get_mut("workbuddy"))
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "找不到 workbuddy 配置".to_string())?;
        let options = entry
            .entry("options".to_string())
            .or_insert_with(|| json!({}));
        let options = options
            .as_object_mut()
            .ok_or_else(|| "workbuddy 的 options 不是对象".to_string())?;
        options.insert("baseURL".to_string(), Value::String(next));
        Ok(())
    });
    match saved {
        Ok(_) => crate::append_log(&format!(
            "[workbuddy] 已把本地转发地址校正到端口 {port}\n"
        )),
        Err((_, message)) => {
            crate::append_log(&format!("[workbuddy] 校正本地端口失败：{message}\n"))
        }
    }
}
