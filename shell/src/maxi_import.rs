//! 从本机「码栖」（Maxi）客户端导入登录态。
//!
//! 码栖把登录凭证存在 `%APPDATA%\Maxi\remote-connection.json` 的 `encryptedToken` 里，
//! 格式是 Chromium 的 OSCrypt：`v10` + 12 字节 nonce + 密文 + 16 字节 tag，
//! AES-256-GCM；而 AES 密钥本身用 Windows DPAPI 保护，存在
//! `%APPDATA%\Maxi\Local State` 的 `os_crypt.encrypted_key`（base64，前缀 `DPAPI`）。
//!
//! 所以导入分两步：DPAPI 解出 32 字节密钥 → AES-GCM 解出登录令牌。
//! 用户只要装过码栖并绑定过微信小程序，这里就能一把读出来，不用手抄凭证。

use std::ffi::c_void;
use std::fs;
use std::path::PathBuf;
use std::ptr;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::Value;

/// DPAPI 的数据块。字段名随意，布局必须与 Win32 的 `DATA_BLOB` 一致。
#[repr(C)]
struct DataBlob {
    cb_data: u32,
    pb_data: *mut u8,
}

// 项目风格：不引 windows-sys，只声明用得到的那两个函数（见 win32.rs 的说明）。
#[link(name = "crypt32")]
extern "system" {
    fn CryptUnprotectData(
        data_in: *const DataBlob,
        descr_out: *mut *mut u16,
        entropy: *const DataBlob,
        reserved: *mut c_void,
        prompt: *mut c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(ptr: *mut c_void) -> *mut c_void;
}

/// 导入结果。
pub struct Imported {
    pub host: String,
    pub login_token: String,
    pub device_id: String,
    pub device_no: String,
    pub device_name: String,
}

fn appdata() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from)
}

fn maxi_dir() -> Option<PathBuf> {
    appdata().map(|dir| dir.join("Maxi"))
}

/// 本机有没有装过码栖（且有登录态文件）。
pub fn available() -> bool {
    let Some(dir) = maxi_dir() else {
        return false;
    };
    dir.join("remote-connection.json").is_file() && dir.join("Local State").is_file()
}

/// DPAPI 解密（当前用户范围）。
fn dpapi_unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.is_empty() {
        return Err("DPAPI 输入为空".to_string());
    }
    let mut input = DataBlob {
        cb_data: blob.len() as u32,
        pb_data: blob.as_ptr() as *mut u8,
    };
    let mut output = DataBlob {
        cb_data: 0,
        pb_data: ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null_mut(),
            ptr::null_mut(),
            0,
            &mut output,
        )
    };
    if ok == 0 || output.pb_data.is_null() {
        return Err("Windows DPAPI 解密失败（码栖可能是在别的用户下装的）".to_string());
    }
    let bytes = unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize) }.to_vec();
    unsafe {
        LocalFree(output.pb_data as *mut c_void);
    }
    Ok(bytes)
}

/// 从 `Local State` 取 Chromium 的 AES-256 密钥。
fn oscrypt_key(dir: &PathBuf) -> Result<Vec<u8>, String> {
    let text = fs::read_to_string(dir.join("Local State"))
        .map_err(|e| format!("读不到码栖的 Local State：{e}"))?;
    let value: Value = serde_json::from_str(&text).map_err(|e| format!("Local State 不是合法 JSON：{e}"))?;
    let encoded = value
        .get("os_crypt")
        .and_then(|item| item.get("encrypted_key"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Local State 里没有 os_crypt.encrypted_key".to_string())?;
    let raw = B64
        .decode(encoded.trim())
        .map_err(|e| format!("encrypted_key 不是合法 base64：{e}"))?;
    // 前缀固定是 5 字节 ASCII "DPAPI"，DPAPI 只认后面那段。
    if raw.len() < 6 || &raw[..5] != b"DPAPI" {
        return Err("encrypted_key 的前缀不是 DPAPI".to_string());
    }
    let key = dpapi_unprotect(&raw[5..])?;
    if key.len() != 32 {
        return Err(format!("解出来的 AES 密钥长度是 {} 而不是 32", key.len()));
    }
    Ok(key)
}

/// 解 Chromium OSCrypt 的 `v10` 密文。
fn decrypt_v10(key: &[u8], encoded: &str) -> Result<String, String> {
    let raw = B64
        .decode(encoded.trim())
        .map_err(|e| format!("encryptedToken 不是合法 base64：{e}"))?;
    if raw.len() < 3 + 12 + 16 || &raw[..3] != b"v10" {
        return Err("encryptedToken 不是 v10 格式".to_string());
    }
    let nonce = &raw[3..15];
    let tag = &raw[raw.len() - 16..];
    let cipher_text = &raw[15..raw.len() - 16];

    let mut sealed = Vec::with_capacity(cipher_text.len() + tag.len());
    sealed.extend_from_slice(cipher_text);
    sealed.extend_from_slice(tag);

    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("初始化 AES-GCM 失败：{e}"))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), sealed.as_slice())
        .map_err(|_| "AES-GCM 解密失败（密钥与密文不匹配）".to_string())?;
    String::from_utf8(plain).map_err(|e| format!("令牌不是 UTF-8：{e}"))
}

fn field_str(value: &Value, name: &str) -> String {
    value
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// 规范化服务器地址：没写协议就补 https，去掉末尾斜杠。
pub fn normalize_host(text: &str) -> String {
    let text = text.trim().trim_end_matches('/');
    if text.is_empty() {
        return String::new();
    }
    if text.starts_with("http://") || text.starts_with("https://") {
        text.to_string()
    } else {
        format!("https://{text}")
    }
}

/// 读本机码栖的登录态。失败时返回一句能直接给用户看的中文原因。
pub fn import() -> Result<Imported, String> {
    let dir = maxi_dir().ok_or_else(|| "找不到 APPDATA 目录".to_string())?;
    if !dir.is_dir() {
        return Err("这台电脑上没有找到码栖客户端（%APPDATA%\\Maxi 不存在）".to_string());
    }
    let text = fs::read_to_string(dir.join("remote-connection.json"))
        .map_err(|e| format!("读不到码栖的登录文件：{e}"))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("remote-connection.json 不是合法 JSON：{e}"))?;

    let host = normalize_host(&field_str(&value, "serverHost"));
    let device_id = field_str(&value, "deviceId");
    let device_no = field_str(&value, "deviceNo");
    let device_name = field_str(&value, "deviceName");
    let encrypted = field_str(&value, "encryptedToken");

    if host.is_empty() || encrypted.is_empty() {
        return Err("码栖还没登录过（文件里没有 serverHost 或 encryptedToken）".to_string());
    }
    if device_id.is_empty() {
        return Err("码栖还没有完成设备注册（deviceId 是空的），先在客户端里登录一次".to_string());
    }

    let key = oscrypt_key(&dir)?;
    let login_token = decrypt_v10(&key, &encrypted)?;
    if login_token.is_empty() {
        return Err("解出来的登录令牌是空的".to_string());
    }

    Ok(Imported {
        host,
        login_token,
        device_id,
        device_no,
        device_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_host_adds_scheme() {
        assert_eq!(normalize_host("unimateapi.dt2008.cn"), "https://unimateapi.dt2008.cn");
        assert_eq!(normalize_host("https://a.com/"), "https://a.com");
        assert_eq!(normalize_host("  "), "");
    }

    /// 真实环境验证：读本机码栖客户端的登录态，解出令牌。
    /// 手动跑：cargo test imports_real_client_state -- --ignored --nocapture
    #[test]
    #[ignore]
    fn imports_real_client_state() {
        let imported = import().expect("本机应当有可用的码栖登录态");
        println!(
            "host={} device_id={} device_name={} token_len={}",
            imported.host,
            imported.device_id,
            imported.device_name,
            imported.login_token.len()
        );
        assert!(imported.host.starts_with("http"));
        assert!(imported.login_token.len() >= 10);
        assert!(!imported.device_id.is_empty());
    }

    #[test]
    fn decrypt_rejects_bad_input() {
        let key = [0u8; 32];
        assert!(decrypt_v10(&key, "not-base64-@@@").is_err());
        assert!(decrypt_v10(&key, "djEwqv").is_err());
    }
}
