//! 在线更新：拉清单 → 比版本 → 下载 + 校验 → 交给替换脚本换掉自己。
//!
//! 为什么必须用「外部脚本换文件」：Windows 上正在运行的 exe 被系统锁着，
//! 自己覆盖自己一定失败（os error 5）。所以流程是：
//!
//!   1. 把新版本下载到 `%LOCALAPPDATA%\oc-workbench\update\`（不动当前 exe）
//!   2. 校验大小 + SHA256 + PE 头，任何一项不符就整个作废
//!   3. 写一个一次性 `.cmd`：反复重试覆盖 → 成功就启动新 exe → 删掉自己
//!   4. 拉起脚本后本进程退出
//!
//! 清单（JSON）由发布脚本生成，放任意静态服务器即可：
//!
//! ```json
//! {
//!   "version": "1.0.1",
//!   "url": "https://example.com/oc-workbench-1.0.1-win64.exe",
//!   "sha256": "373da0e2...",
//!   "size": 3370496,
//!   "notes": "修了什么"
//! }
//! ```
//!
//! 更新源取值优先级：环境变量 `OC_WORKBENCH_UPDATE_URL` → `settings.json` 的 `updateUrl`。
//! 没配置就不联网，也不会偷偷发请求。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tiny_http::{Method, Request};

use crate::body::{read_body_with_timeout, BodyRead};

/// 更新源清单地址（环境变量优先于 settings.json）。
pub const SOURCE_ENV: &str = "OC_WORKBENCH_UPDATE_URL";
/// 当前编译进去的版本；和发布清单里的 version 比大小。
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
/// 内置默认更新源：GitHub Release 的 **固定别名**。
///
/// 用 `releases/latest/download/<asset>` 而不是 api.github.com：
///   * 不需要 token，没有 60 次/小时的匿名限流；
///   * 发新版本只要带上同名 `latest.json`，这个地址会自动指向最新那一份；
///   * 少一次 API 往返，国内网络下对 api.github.com 的通达性也更差。
pub const DEFAULT_SOURCE: &str =
    "https://github.com/luyongkang777/oc-workbench/releases/latest/download/latest.json";

/// 清单请求超时：清单很小，10 秒足够；网络不通时不能让人干等。
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(10);
/// 下载读超时：exe 只有几 MB，但慢网/代理下要留量。
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 兜底上限：清单没给 size 时也不能让一次下载把磁盘写满。
const MAX_DOWNLOAD: u64 = 200 * 1024 * 1024;
/// 覆盖重试次数（每次间隔约 1 秒）：正常情况第一次就成功。
const COPY_RETRIES: u32 = 120;
/// 同一时刻只允许一次更新（页面可能连点）。
static APPLYING: AtomicBool = AtomicBool::new(false);

/// 解析后的发布清单。
#[derive(Clone, Debug, PartialEq)]
pub struct Manifest {
    pub version: String,
    pub url: String,
    pub sha256: String,
    /// 清单没写 size 时为 0（不做大小校验，仍校验哈希）。
    pub size: u64,
    pub notes: String,
}

/// 解析清单。缺字段/格式不对都返回人话错误（会直接显示在界面上）。
pub fn parse_manifest(text: &str) -> Result<Manifest, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|err| format!("清单不是合法 JSON：{err}"))?;
    let field = |name: &str| value.get(name).cloned().unwrap_or(serde_json::Value::Null);

    let version = field("version")
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "清单缺少 version".to_string())?
        .to_string();
    let url = field("url")
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "清单缺少 url".to_string())?
        .to_string();
    if !is_http_url(&url) {
        return Err(format!("清单里的 url 只支持 http/https：{url}"));
    }
    let sha256 = field("sha256")
        .as_str()
        .map(|text| text.trim().to_ascii_lowercase())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "清单缺少 sha256（不校验哈希就不许更新）".to_string())?;
    if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("清单里的 sha256 不是 64 位十六进制：{sha256}"));
    }
    let size = match field("size") {
        serde_json::Value::Number(number) => number.as_u64().unwrap_or(0),
        _ => 0,
    };
    let notes = field("notes").as_str().unwrap_or("").trim().to_string();

    Ok(Manifest {
        version,
        url,
        sha256,
        size,
        notes,
    })
}

fn is_http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// 版本号切成可比较的数字段。
///
/// 规则刻意保守：去掉前缀 `v`，只取每段开头的数字，`1.0.1-beta` 与 `1.0.1` 等价。
/// 更新场景里要的是「是不是新版」，不需要完整的 semver 预发布排序。
fn version_key(version: &str) -> Vec<u64> {
    let trimmed = version.trim().trim_start_matches(['v', 'V']);
    let core = trimmed.split(['-', '+']).next().unwrap_or("");
    core.split('.')
        .map(|part| {
            let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u64>().unwrap_or(0)
        })
        .collect()
}

/// `candidate` 是否比 `current` 新。
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let a = version_key(candidate);
    let b = version_key(current);
    let len = a.len().max(b.len());
    for index in 0..len {
        let left = *a.get(index).unwrap_or(&0);
        let right = *b.get(index).unwrap_or(&0);
        if left != right {
            return left > right;
        }
    }
    false
}

#[cfg(test)]
fn sha256_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|err| format!("读不了已下载的文件：{err}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .map_err(|err| format!("读已下载文件失败：{err}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    let mut out = String::with_capacity(64);
    for byte in hasher.finalize() {
        out.push_str(&format!("{byte:02x}"));
    }
    Ok(out)
}

/// `%LOCALAPPDATA%\oc-workbench`（和 projects.json / 日志同目录）。
pub fn data_dir() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    let dir = base.join("oc-workbench");
    let _ = fs::create_dir_all(&dir);
    Some(dir)
}

fn update_dir() -> Result<PathBuf, String> {
    let dir = data_dir()
        .ok_or_else(|| "没有 LOCALAPPDATA，无法确定下载目录".to_string())?
        .join("update");
    fs::create_dir_all(&dir).map_err(|err| format!("建更新目录失败：{err}"))?;
    Ok(dir)
}

fn settings_path() -> Option<PathBuf> {
    data_dir().map(|dir| dir.join("settings.json"))
}

/// 读 settings.json；坏文件当空对象（不能因为一条配置写坏就起不来）。
fn load_settings() -> serde_json::Map<String, serde_json::Value> {
    let Some(path) = settings_path() else {
        return serde_json::Map::new();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return serde_json::Map::new();
    };
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(serde_json::Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    }
}

/// 落盘 settings.json（保留没见过的键）。
fn save_settings(map: serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let path = settings_path().ok_or_else(|| "没有 LOCALAPPDATA".to_string())?;
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(map))
        .map_err(|err| format!("序列化设置失败：{err}"))?;
    fs::write(&path, text).map_err(|err| format!("写设置失败：{err}"))
}

/// 只改 `updateUrl`，其余键原样保留（以后加别的设置不会互相覆盖）。
fn save_update_source(url: &str) -> Result<(), String> {
    let mut map = load_settings();
    map.insert(
        "updateUrl".to_string(),
        serde_json::Value::String(url.trim().to_string()),
    );
    save_settings(map)
}

/// 读写一个布尔设置，供在线更新之外的模块（如 CLI 自动更新）用同一份 settings.json。
///
/// 键名各管各的，互不覆盖；读不到就当默认值——一条配置写坏不该让功能起不来。
pub fn bool_setting(key: &str, default: bool) -> bool {
    match load_settings().get(key) {
        Some(serde_json::Value::Bool(flag)) => *flag,
        _ => default,
    }
}

/// 写布尔设置：等于默认值时删键，保持设置文件最小（和 autoCheck 的处理一致）。
pub fn set_bool_setting(key: &str, value: bool, default: bool) -> Result<(), String> {
    let mut map = load_settings();
    if value == default {
        map.remove(key);
    } else {
        map.insert(key.to_string(), serde_json::Value::Bool(value));
    }
    save_settings(map)
}

/// 读一个整型设置（毫秒时间戳之类），没有就当 None。
pub fn number_setting(key: &str) -> Option<i64> {
    load_settings().get(key).and_then(|value| value.as_i64())
}

/// 写整型设置；传 None 删键。
pub fn set_number_setting(key: &str, value: Option<i64>) -> Result<(), String> {
    let mut map = load_settings();
    match value {
        Some(number) => {
            map.insert(key.to_string(), serde_json::Value::Number(number.into()));
        }
        None => {
            map.remove(key);
        }
    }
    save_settings(map)
}

/// 读一个字符串设置（窗口尺寸这类「两个数拼成一行」的值），没有就当 None。
pub fn text_setting(key: &str) -> Option<String> {
    match load_settings().get(key) {
        Some(serde_json::Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

/// 写字符串设置；传 None 删键。
pub fn set_text_setting(key: &str, value: Option<&str>) -> Result<(), String> {
    let mut map = load_settings();
    match value {
        Some(text) => {
            map.insert(
                key.to_string(),
                serde_json::Value::String(text.trim().to_string()),
            );
        }
        None => {
            map.remove(key);
        }
    }
    save_settings(map)
}

/// settings.json 的键：启动时是否自动检查更新（默认开）。
const AUTO_KEY: &str = "autoCheckUpdate";
/// settings.json 的键：用户主动跳过的版本号。
const SKIP_KEY: &str = "skipVersion";

/// 启动时要不要自动检查：没配过就是开。
pub fn auto_check() -> bool {
    match load_settings().get(AUTO_KEY) {
        Some(serde_json::Value::Bool(flag)) => *flag,
        _ => true,
    }
}

/// 写/清「自动检查」。开着是默认值，所以 true 时直接把键删掉，让设置文件保持最小。
fn with_auto(
    mut map: serde_json::Map<String, serde_json::Value>,
    enabled: bool,
) -> serde_json::Map<String, serde_json::Value> {
    if enabled {
        map.remove(AUTO_KEY);
    } else {
        map.insert(AUTO_KEY.to_string(), serde_json::Value::Bool(false));
    }
    map
}

fn save_auto(enabled: bool) -> Result<(), String> {
    save_settings(with_auto(load_settings(), enabled))
}

/// 被跳过的版本（没有就是 None）。
///
/// 只记「哪一个版本」，不记「不更新」：发下一个版本时它自然不再匹配，
/// 用户不用记得回来关掉。
pub fn skipped_version() -> Option<String> {
    load_settings()
        .get(SKIP_KEY)
        .and_then(|value| value.as_str())
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// 在设置表里写入/清除 skipVersion（纯函数，单测不碰环境变量）。
fn with_skip(
    mut map: serde_json::Map<String, serde_json::Value>,
    version: Option<&str>,
) -> serde_json::Map<String, serde_json::Value> {
    match version.map(str::trim).filter(|text| !text.is_empty()) {
        Some(value) => {
            map.insert(
                SKIP_KEY.to_string(),
                serde_json::Value::String(value.to_string()),
            );
        }
        None => {
            map.remove(SKIP_KEY);
        }
    }
    map
}

/// 设置/清除「跳过这个版本」；传 None 表示取消跳过。
fn save_skip(version: Option<&str>) -> Result<(), String> {
    save_settings(with_skip(load_settings(), version))
}

/// 解析更新源的三层优先级（纯函数，方便单测）：
///
///   1. 环境变量非空 → 用它
///   2. settings.json 里有 `updateUrl` → 用它的值；**空串表示主动关闭**（不发任何请求）
///   3. 两者都没有 → 内置默认源（GitHub Release）
pub fn resolve_source(
    env_value: Option<&str>,
    settings: &serde_json::Map<String, serde_json::Value>,
) -> Option<String> {
    if let Some(value) = env_value {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    match settings.get("updateUrl").and_then(|value| value.as_str()) {
        Some(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None // 显式关闭
            } else {
                Some(trimmed.to_string())
            }
        }
        None => Some(DEFAULT_SOURCE.to_string()),
    }
}

/// 当前的更新源（清单地址）。
pub fn source() -> Option<String> {
    let env = std::env::var(SOURCE_ENV).ok();
    resolve_source(env.as_deref(), &load_settings())
}

/// 建一个带 TLS 的 agent。
///
/// ureq 的 `native-tls` feature 只是提供了 `impl TlsConnector for native_tls::TlsConnector`，
/// **不会自动装进 Agent**：不显式传，HTTPS 一律报 "cannot make HTTPS request because
/// no TLS backend is configured"（这个问题只有在第一次访问 https 时才会暴露）。
fn build_agent(overall: Duration, read: Option<Duration>) -> Result<ureq::Agent, String> {
    let connector = native_tls::TlsConnector::new()
        .map_err(|err| format!("初始化 TLS 连接器失败：{err}"))?;
    let mut builder = ureq::AgentBuilder::new()
        .tls_connector(std::sync::Arc::new(connector))
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout(overall);
    if let Some(read) = read {
        builder = builder.timeout_read(read);
    }
    Ok(builder.build())
}

/// 拉清单。只接受 http/https，避免被 settings 里塞进 file:// 之类的路径。
pub fn fetch_manifest(source_url: &str) -> Result<Manifest, String> {
    if !is_http_url(source_url) {
        return Err(format!("更新源只支持 http/https：{source_url}"));
    }
    let agent = build_agent(MANIFEST_TIMEOUT, None)?;
    let response = agent
        .get(source_url)
        .set("cache-control", "no-cache")
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(code, _) => format!("更新源返回 HTTP {code}"),
            other => format!("连不上更新源：{other}"),
        })?;
    let mut text = String::new();
    response
        .into_reader()
        .take(256 * 1024)
        .read_to_string(&mut text)
        .map_err(|err| format!("读清单失败：{err}"))?;
    parse_manifest(&text)
}

/// 一次完整的检查结果，直接序列化给页面。
pub struct CheckResult {
    pub configured: bool,
    pub current: &'static str,
    pub source: Option<String>,
    pub latest: Option<String>,
    pub newer: bool,
    /// 用户跳过了这个版本（顶栏不再提示，但点开面板还能更新）。
    pub skipped: bool,
    /// 启动时是否自动检查（面板里的开关状态）。
    pub auto_check: bool,
    pub notes: String,
    pub size: u64,
    pub url: Option<String>,
    pub error: Option<String>,
}

impl CheckResult {
    fn to_json(&self) -> String {
        serde_json::json!({
            "configured": self.configured,
            "current": self.current,
            "source": self.source,
            "latest": self.latest,
            "newer": self.newer,
            "skipped": self.skipped,
            "autoCheck": self.auto_check,
            "notes": self.notes,
            "size": self.size,
            "url": self.url,
            "error": self.error,
        })
        .to_string()
    }
}

/// 检查更新：没配更新源就立刻返回（不发任何请求）。
pub fn check() -> CheckResult {
    let Some(source) = source() else {
        return CheckResult {
            configured: false,
            current: CURRENT_VERSION,
            source: None,
            latest: None,
            newer: false,
            skipped: false,
            auto_check: auto_check(),
            notes: String::new(),
            size: 0,
            url: None,
            error: None,
        };
    };
    match fetch_manifest(&source) {
        Ok(manifest) => {
            let newer = is_newer(&manifest.version, CURRENT_VERSION);
            let skipped = newer && skipped_version().as_deref() == Some(manifest.version.as_str());
            CheckResult {
                configured: true,
                current: CURRENT_VERSION,
                source: Some(source),
                latest: Some(manifest.version),
                newer,
                skipped,
                auto_check: auto_check(),
                notes: manifest.notes,
                size: manifest.size,
                url: Some(manifest.url),
                error: None,
            }
        }
        Err(err) => CheckResult {
            configured: true,
            current: CURRENT_VERSION,
            source: Some(source),
            latest: None,
            newer: false,
            skipped: false,
            auto_check: auto_check(),
            notes: String::new(),
            size: 0,
            url: None,
            error: Some(err),
        },
    }
}

/// 下载 + 校验，产物落在更新目录，返回可执行文件的路径。
///
/// 先写 `.part` 再改名：中途断网/被拦不会留下一个「看起来能用」的半截 exe。
pub fn download(manifest: &Manifest, dir: &Path) -> Result<PathBuf, String> {
    let safe_version: String = manifest
        .version
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let final_path = dir.join(format!("oc-workbench-{safe_version}.exe"));
    let part_path = dir.join(format!("oc-workbench-{safe_version}.exe.part"));
    let _ = fs::remove_file(&part_path);

    let agent = build_agent(Duration::from_secs(300), Some(READ_TIMEOUT))?;
    let response = agent.get(&manifest.url).call().map_err(|err| match err {
        ureq::Error::Status(code, _) => format!("下载失败：HTTP {code}"),
        other => format!("下载失败：{other}"),
    })?;

    let limit = if manifest.size > 0 {
        manifest.size
    } else {
        MAX_DOWNLOAD
    }
    .min(MAX_DOWNLOAD);

    let mut reader = response.into_reader().take(limit + 1);
    let mut file = fs::File::create(&part_path).map_err(|err| format!("建临时文件失败：{err}"))?;
    let copied = std::io::copy(&mut reader, &mut file).map_err(|err| format!("写文件失败：{err}"))?;
    drop(file);

    if copied > limit {
        let _ = fs::remove_file(&part_path);
        return Err(format!("下载体积超过清单声明（>{limit} 字节），已丢弃"));
    }
    if manifest.size > 0 && copied != manifest.size {
        let _ = fs::remove_file(&part_path);
        return Err(format!(
            "下载体积不对：期望 {} 字节，实际 {copied} 字节，已丢弃",
            manifest.size
        ));
    }

    let actual = sha256_file(&part_path)?;
    if actual != manifest.sha256 {
        let _ = fs::remove_file(&part_path);
        return Err(format!(
            "SHA256 不符，已丢弃：期望 {}，实际 {actual}",
            manifest.sha256
        ));
    }

    // 头两个字节必须是 MZ，避免把一段 HTML 错误页当成 exe 换上去。
    let mut head = [0u8; 2];
    {
        let mut probe = fs::File::open(&part_path).map_err(|err| format!("回读失败：{err}"))?;
        probe
            .read_exact(&mut head)
            .map_err(|err| format!("回读失败：{err}"))?;
    }
    if &head != b"MZ" {
        let _ = fs::remove_file(&part_path);
        return Err("下载到的不是 PE 可执行文件（缺少 MZ 头），已丢弃".to_string());
    }

    let _ = fs::remove_file(&final_path);
    fs::rename(&part_path, &final_path).map_err(|err| format!("改名失败：{err}"))?;
    Ok(final_path)
}

/// batch 里 `%` 是变量前缀，路径里出现就得写两次才能当字面量。
fn batch_path(path: &Path) -> Result<String, String> {
    let text = path.to_string_lossy().to_string();
    if text.contains('"') {
        return Err(format!("路径里有引号，无法写进更新脚本：{text}"));
    }
    Ok(text.replace('%', "%%"))
}

/// 生成替换脚本。
///
/// 为什么不用「等 PID 退出」：Windows 上两条现成路子都有坑——PowerShell 的
/// `WaitForExit` 实测会在目标进程已经退出后继续挂着（更新就这么卡住），
/// `tasklist` 的输出又被本地化文案干扰，没法可靠判断。换成最直接的办法：
/// **反复重试覆盖**。能写进去就说明旧进程已释放文件；写不进去就等一秒再来。
///
/// 内容刻意只用 ASCII：中文在 GBK/UTF-8 混用的 cmd 里会乱码，甚至把行拆坏。
pub fn build_script(
    target_exe: &Path,
    source_exe: &Path,
    pid: u32,
    log_path: &Path,
) -> Result<String, String> {
    let target = batch_path(target_exe)?;
    let source = batch_path(source_exe)?;
    let log = batch_path(log_path)?;
    let retries = COPY_RETRIES;

    let lines = vec![
        "@echo off".to_string(),
        "setlocal".to_string(),
        format!("set \"TARGET={target}\""),
        format!("set \"SOURCE={source}\""),
        format!("set \"LOG={log}\""),
        format!("echo [%DATE% %TIME%] update start (old pid {pid}) >>\"%LOG%\""),
        "if exist \"%TARGET%.bak\" del /f /q \"%TARGET%.bak\" >nul 2>&1".to_string(),
        "copy /Y \"%TARGET%\" \"%TARGET%.bak\" >nul 2>&1".to_string(),
        "set /a TRIES=0".to_string(),
        ":wait".to_string(),
        "copy /Y \"%SOURCE%\" \"%TARGET%\" >nul 2>&1".to_string(),
        "if not errorlevel 1 goto done".to_string(),
        "set /a TRIES+=1".to_string(),
        format!("if %TRIES% GEQ {retries} goto giveup"),
        "ping -n 2 127.0.0.1 >nul 2>&1".to_string(),
        "goto wait".to_string(),
        ":done".to_string(),
        "echo [%DATE% %TIME%] replaced after %TRIES% retries, restarting >>\"%LOG%\"".to_string(),
        "start \"\" \"%TARGET%\"".to_string(),
        "(goto) 2>nul & del \"%~f0\" & exit /b 0".to_string(),
        ":giveup".to_string(),
        "echo [%DATE% %TIME%] copy failed after %TRIES% retries >>\"%LOG%\"".to_string(),
        "start \"\" \"%TARGET%\"".to_string(),
        "(goto) 2>nul & del \"%~f0\" & exit /b 1".to_string(),
    ];
    Ok(format!("{}\r\n", lines.join("\r\n")))
}

/// 准备更新：下载 + 校验 + 写脚本。返回脚本路径。
pub fn prepare(manifest: &Manifest, target_exe: &Path, pid: u32) -> Result<PathBuf, String> {
    let dir = update_dir()?;
    // 目标目录必须可写：只读目录（Program Files、只读盘）里装了也换不掉，
    // 与其下完再失败，不如现在就告诉用户。
    let probe = target_exe
        .parent()
        .map(|parent| parent.join(".oc-workbench-write-test"))
        .ok_or_else(|| "拿不到程序所在目录".to_string())?;
    match fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
        }
        Err(err) => {
            return Err(format!(
                "程序所在目录不可写（{err}）：把 exe 放到有写权限的目录再更新"
            ))
        }
    }

    let downloaded = download(manifest, &dir)?;
    let script = dir.join(format!("apply-{pid}.cmd"));
    let body = build_script(target_exe, &downloaded, pid, &dir.join("update.log"))?;
    fs::write(&script, body.as_bytes()).map_err(|err| format!("写更新脚本失败：{err}"))?;
    Ok(script)
}

/// 拉起替换脚本。脚本独立于本进程运行，所以本进程可以立刻退出。
pub fn spawn_script(script: &Path) -> Result<(), String> {
    let mut cmd = Command::new("cmd");
    cmd.arg("/C")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|err| format!("拉起更新脚本失败：{err}"))
}

/// 完整执行一次更新：检查 → 下载 → 拉起脚本 → 由调用方安排退出。
pub fn apply_now(target_exe: &Path) -> Result<String, String> {
    if APPLYING.swap(true, Ordering::SeqCst) {
        return Err("已经有一个更新在进行中".to_string());
    }
    let result = (|| {
        let source = source().ok_or_else(|| "还没有配置更新源".to_string())?;
        let manifest = fetch_manifest(&source)?;
        if !is_newer(&manifest.version, CURRENT_VERSION) {
            return Err(format!(
                "当前已是最新版本（{CURRENT_VERSION}），没有可更新的内容"
            ));
        }
        let script = prepare(&manifest, target_exe, std::process::id())?;
        spawn_script(&script)?;
        Ok(manifest.version)
    })();
    if result.is_err() {
        APPLYING.store(false, Ordering::SeqCst);
    }
    result
}

// ---------------------------------------------------------------------------
// HTTP 端点：`/local/update/{check,apply,source}`
// ---------------------------------------------------------------------------

fn json_respond(request: Request, status: u16, body: String) {
    let _ = crate::server::respond_json(request, status, body);
}

fn method_is(request: &Request, want: Method) -> bool {
    request.method() == &want
}

pub fn handle(request: Request, path: &str, _url: &str) {
    match path {
        "/local/update/check" => check_endpoint(request),
        "/local/update/apply" => apply_endpoint(request),
        "/local/update/source" => source_endpoint(request),
        "/local/update/skip" => skip_endpoint(request),
        "/local/update/config" => config_endpoint(request),
        "/local/update/auto" => auto_endpoint(request),
        other => json_respond(
            request,
            404,
            serde_json::json!({ "error": format!("未知的更新接口：{other}") }).to_string(),
        ),
    }
}

fn check_endpoint(request: Request) {
    if !method_is(&request, Method::Get) {
        json_respond(
            request,
            405,
            serde_json::json!({ "error": "只支持 GET" }).to_string(),
        );
        return;
    }
    let body = check().to_json();
    json_respond(request, 200, body);
}

fn apply_endpoint(request: Request) {
    if !method_is(&request, Method::Post) {
        json_respond(
            request,
            405,
            serde_json::json!({ "error": "只支持 POST" }).to_string(),
        );
        return;
    }
    // 前端可能带 `{}`：读完丢掉，别让连接里留半截 body。
    let Some((request, body)) = read_body_with_timeout(request, 64 * 1024) else {
        return;
    };
    match body {
        BodyRead::Ok(_) => {}
        BodyRead::TooLarge => {
            json_respond(
                request,
                413,
                serde_json::json!({ "error": "请求体过大" }).to_string(),
            );
            return;
        }
        BodyRead::Failed(err) => {
            json_respond(
                request,
                400,
                serde_json::json!({ "error": format!("读取请求体失败：{err}") }).to_string(),
            );
            return;
        }
    }

    let exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(err) => {
            json_respond(
                request,
                500,
                serde_json::json!({ "error": format!("拿不到当前 exe 路径：{err}") }).to_string(),
            );
            return;
        }
    };

    match apply_now(&exe) {
        Ok(version) => {
            crate::append_log(&format!("[update] 已准备 {version}，即将重启\n"));
            json_respond(
                request,
                200,
                serde_json::json!({ "ok": true, "version": version }).to_string(),
            );
            // 先把响应发出去再退出：顺序反了页面就只会看到「请求失败」。
            std::thread::spawn(|| {
                std::thread::sleep(Duration::from_millis(900));
                std::process::exit(0);
            });
        }
        Err(err) => {
            crate::append_log(&format!("[update] 更新失败：{err}\n"));
            json_respond(
                request,
                400,
                serde_json::json!({ "ok": false, "error": err }).to_string(),
            );
        }
    }
}

fn source_endpoint(request: Request) {
    if !method_is(&request, Method::Post) {
        json_respond(
            request,
            405,
            serde_json::json!({ "error": "只支持 POST" }).to_string(),
        );
        return;
    }
    let Some((request, body)) = read_body_with_timeout(request, 16 * 1024) else {
        return;
    };
    let bytes = match body {
        BodyRead::Ok(bytes) => bytes,
        BodyRead::TooLarge => {
            json_respond(
                request,
                413,
                serde_json::json!({ "error": "请求体过大" }).to_string(),
            );
            return;
        }
        BodyRead::Failed(err) => {
            json_respond(
                request,
                400,
                serde_json::json!({ "error": format!("读取请求体失败：{err}") }).to_string(),
            );
            return;
        }
    };
    let text = String::from_utf8_lossy(&bytes);
    let parsed: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(err) => {
            json_respond(
                request,
                400,
                serde_json::json!({ "error": format!("请求体不是 JSON：{err}") }).to_string(),
            );
            return;
        }
    };
    // 空串 = 清除更新源
    let url = parsed
        .get("url")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !url.is_empty() && !is_http_url(&url) {
        json_respond(
            request,
            400,
            serde_json::json!({ "error": "更新源只支持 http/https 地址" }).to_string(),
        );
        return;
    }
    match save_update_source(&url) {
        Ok(()) => {
            crate::append_log(&format!("[update] 更新源已设为 {url}\n"));
            json_respond(
                request,
                200,
                serde_json::json!({ "ok": true, "source": url }).to_string(),
            );
        }
        Err(err) => json_respond(request, 500, serde_json::json!({ "error": err }).to_string()),
    }
}

/// `GET /local/update/config`：页面启动时要的那几项设置。
///
/// 单独一个轻量端点：自动检查关掉时，页面不该为了「要不要检查」而先做一次检查。
fn config_endpoint(request: Request) {
    if !method_is(&request, Method::Get) {
        json_respond(
            request,
            405,
            serde_json::json!({ "error": "只支持 GET" }).to_string(),
        );
        return;
    }
    let body = serde_json::json!({
        "autoCheck": auto_check(),
        "source": source(),
        "skipped": skipped_version(),
    })
    .to_string();
    json_respond(request, 200, body);
}

/// `POST /local/update/auto`：开/关启动时自动检查。
fn auto_endpoint(request: Request) {
    if !method_is(&request, Method::Post) {
        json_respond(
            request,
            405,
            serde_json::json!({ "error": "只支持 POST" }).to_string(),
        );
        return;
    }
    let Some((request, body)) = read_body_with_timeout(request, 16 * 1024) else {
        return;
    };
    let bytes = match body {
        BodyRead::Ok(bytes) => bytes,
        BodyRead::TooLarge => {
            json_respond(
                request,
                413,
                serde_json::json!({ "error": "请求体过大" }).to_string(),
            );
            return;
        }
        BodyRead::Failed(err) => {
            json_respond(
                request,
                400,
                serde_json::json!({ "error": format!("读取请求体失败：{err}") }).to_string(),
            );
            return;
        }
    };
    let text = String::from_utf8_lossy(&bytes);
    let parsed: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(err) => {
            json_respond(
                request,
                400,
                serde_json::json!({ "error": format!("请求体不是 JSON：{err}") }).to_string(),
            );
            return;
        }
    };
    let enabled = parsed
        .get("enabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    match save_auto(enabled) {
        Ok(()) => {
            crate::append_log(&format!("[update] 启动时自动检查：{}
", if enabled { "开" } else { "关" }));
            json_respond(
                request,
                200,
                serde_json::json!({ "ok": true, "autoCheck": enabled }).to_string(),
            );
        }
        Err(err) => json_respond(request, 500, serde_json::json!({ "error": err }).to_string()),
    }
}

/// `POST /local/update/skip`：记下「跳过这个版本」。
///
/// 只记版本号而不是「关闭更新」：发下一个版本时自然不再匹配，
/// 用户不需要记得回来关掉；传空版本号表示取消跳过。
fn skip_endpoint(request: Request) {
    if !method_is(&request, Method::Post) {
        json_respond(
            request,
            405,
            serde_json::json!({ "error": "只支持 POST" }).to_string(),
        );
        return;
    }
    let Some((request, body)) = read_body_with_timeout(request, 16 * 1024) else {
        return;
    };
    let bytes = match body {
        BodyRead::Ok(bytes) => bytes,
        BodyRead::TooLarge => {
            json_respond(
                request,
                413,
                serde_json::json!({ "error": "请求体过大" }).to_string(),
            );
            return;
        }
        BodyRead::Failed(err) => {
            json_respond(
                request,
                400,
                serde_json::json!({ "error": format!("读取请求体失败：{err}") }).to_string(),
            );
            return;
        }
    };
    let text = String::from_utf8_lossy(&bytes);
    let parsed: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(err) => {
            json_respond(
                request,
                400,
                serde_json::json!({ "error": format!("请求体不是 JSON：{err}") }).to_string(),
            );
            return;
        }
    };
    let version = parsed
        .get("version")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let saved = if version.is_empty() { None } else { Some(version.as_str()) };
    match save_skip(saved) {
        Ok(()) => {
            crate::append_log(&format!(
                "[update] 跳过版本：{}",
                saved.unwrap_or("（已取消）")
            ));
            crate::append_log("
");
            json_respond(
                request,
                200,
                serde_json::json!({ "ok": true, "skipped": saved }).to_string(),
            );
        }
        Err(err) => json_respond(request, 500, serde_json::json!({ "error": err }).to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_manifest() {
        let short_hash =
            parse_manifest(r#"{"version":"1.2.3","url":"https://x/y.exe","sha256":"aa"}"#);
        assert!(short_hash.is_err(), "sha256 长度不够必须拒绝");

        let ok = parse_manifest(&format!(
            r#"{{"version":"1.2.3","url":"https://x/y.exe","sha256":"{}","size":10,"notes":"hi"}}"#,
            "a".repeat(64)
        ))
        .expect("应能解析");
        assert_eq!(ok.version, "1.2.3");
        assert_eq!(ok.size, 10);
        assert_eq!(ok.notes, "hi");
    }

    #[test]
    fn rejects_non_http_and_bad_hash() {
        let bad_url = parse_manifest(&format!(
            r#"{{"version":"2.0.0","url":"file:///c:/x.exe","sha256":"{}"}}"#,
            "a".repeat(64)
        ));
        assert!(bad_url.is_err());

        let bad_hash =
            parse_manifest(r#"{"version":"2.0.0","url":"https://a/b.exe","sha256":"zz"}"#);
        assert!(bad_hash.is_err());
    }

    #[test]
    fn source_prefers_env_then_settings_then_default() {
        let empty = serde_json::Map::new();
        assert_eq!(
            resolve_source(Some("https://env/latest.json"), &empty).as_deref(),
            Some("https://env/latest.json")
        );
        assert_eq!(
            resolve_source(None, &empty).as_deref(),
            Some(DEFAULT_SOURCE),
            "都没配时用内置 GitHub 源"
        );

        let mut map = serde_json::Map::new();
        map.insert(
            "updateUrl".into(),
            serde_json::Value::String("https://settings/latest.json".into()),
        );
        assert_eq!(
            resolve_source(None, &map).as_deref(),
            Some("https://settings/latest.json")
        );

        // 空串 = 主动关闭：既不用 settings，也不回落到默认源
        map.insert("updateUrl".into(), serde_json::Value::String("  ".into()));
        assert_eq!(resolve_source(None, &map), None);
        // 环境变量优先于 settings
        assert_eq!(
            resolve_source(Some("https://env/x.json"), &map).as_deref(),
            Some("https://env/x.json")
        );
    }

    #[test]
    fn skip_keeps_other_settings_and_can_be_cleared() {
        let mut map = serde_json::Map::new();
        map.insert(
            "updateUrl".into(),
            serde_json::Value::String("https://x/latest.json".into()),
        );

        let with = with_skip(map, Some("1.1.3"));
        assert_eq!(
            with.get("skipVersion").and_then(|v| v.as_str()),
            Some("1.1.3")
        );
        assert_eq!(
            with.get("updateUrl").and_then(|v| v.as_str()),
            Some("https://x/latest.json"),
            "不能把更新源改掉"
        );

        // 空串等价于取消跳过
        let cleared = with_skip(with.clone(), None);
        assert!(cleared.get("skipVersion").is_none());
        assert_eq!(
            cleared.get("updateUrl").and_then(|v| v.as_str()),
            Some("https://x/latest.json")
        );
        let blank = with_skip(with, Some("  "));
        assert!(blank.get("skipVersion").is_none(), "空白也算取消");
    }

    #[test]
    fn auto_check_defaults_on_and_clears_to_default() {
        let empty = serde_json::Map::new();
        // 关掉写 false 键；开回来就把键删掉（默认即开）
        let off = with_auto(empty, false);
        assert_eq!(
            off.get(AUTO_KEY).and_then(|v| v.as_bool()),
            Some(false),
            "关掉要落一个显式 false"
        );

        let mut with_source = off.clone();
        with_source.insert(
            "updateUrl".into(),
            serde_json::Value::String("https://x/latest.json".into()),
        );
        let back_on = with_auto(with_source, true);
        assert!(back_on.get(AUTO_KEY).is_none(), "开回来等同默认，不该留键");
        assert_eq!(
            back_on.get("updateUrl").and_then(|v| v.as_str()),
            Some("https://x/latest.json"),
            "不能顺手把更新源删掉"
        );
    }

    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("1.0.1", "1.0.0"));
        assert!(is_newer("1.10.0", "1.9.9"), "按数字比，不是按字符串");
        assert!(is_newer("2.0", "1.99.99"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.0.1"));
        assert!(is_newer("v1.1.0", "1.0.9"), "允许 v 前缀");
        assert!(!is_newer("1.0.1-beta", "1.0.1"), "预发布不当作更新");
    }

    #[test]
    fn sha256_matches_known_vector() {
        // FIPS 180-2 官方测试向量
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn script_retries_until_copy_succeeds() {
        let script = build_script(
            Path::new(r"C:\Tools\oc-workbench.exe"),
            Path::new(r"C:\Users\me\AppData\Local\oc-workbench\update\oc-workbench-1.0.1.exe"),
            4321,
            Path::new(r"C:\Users\me\AppData\Local\oc-workbench\update\update.log"),
        )
        .expect("应能生成脚本");

        assert!(script.contains("copy /Y \"%SOURCE%\" \"%TARGET%\""), "{script}");
        assert!(script.contains("goto wait"), "失败要重试：{script}");
        assert!(script.contains("if %TRIES% GEQ 120 goto giveup"), "{script}");
        assert!(script.contains(".bak"), "覆盖前要留备份");
        assert!(script.contains("start \"\" \"%TARGET%\""), "更新完要重启");
        assert!(script.contains("4321"), "日志里要有旧 pid 便于排查");
        assert!(script.contains(">nul 2>&1"), "批处理重定向要写 nul");
        assert!(!script.contains("/dev/null"), "这是 Windows 批处理");
        assert!(script.is_ascii(), "脚本必须纯 ASCII");
        assert!(script.contains("\r\n"), "批处理要 CRLF");
    }

    #[test]
    fn script_escapes_percent_in_paths() {
        let script = build_script(
            Path::new(r"C:\100%\oc-workbench.exe"),
            Path::new(r"C:\tmp\new.exe"),
            7,
            Path::new(r"C:\tmp\update.log"),
        )
        .expect("应能生成脚本");
        assert!(script.contains(r"C:\100%%\oc-workbench.exe"), "{script}");
    }

    #[test]
    fn script_rejects_quote_in_path() {
        let err = build_script(
            Path::new("C:\\bad\"path\\x.exe"),
            Path::new("C:\\tmp\\new.exe"),
            1,
            Path::new("C:\\tmp\\update.log"),
        );
        assert!(err.is_err());
    }

    #[test]
    fn download_verifies_hash_and_leaves_no_partial_file() {
        // 起一个只会回固定字节的最小 HTTP 服务
        let server = tiny_http::Server::http("127.0.0.1:0").expect("起测试服务");
        let port = server.server_addr().to_ip().expect("有 IP").port();
        let payload = b"MZ-fake-binary".to_vec();
        let body = payload.clone();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let response = tiny_http::Response::from_data(body.clone());
                let _ = request.respond(response);
            }
        });

        let dir = std::env::temp_dir().join(format!("ocwb-update-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");

        let good = Manifest {
            version: "9.9.9".to_string(),
            url: format!("http://127.0.0.1:{port}/app.exe"),
            sha256: sha256_hex(&payload),
            size: payload.len() as u64,
            notes: String::new(),
        };
        let path = download(&good, &dir).expect("正常下载应成功");
        assert_eq!(std::fs::read(&path).unwrap(), payload);

        let mut bad = good.clone();
        bad.sha256 = "0".repeat(64);
        let err = download(&bad, &dir).expect_err("哈希不符必须失败");
        assert!(err.contains("SHA256"), "{err}");

        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            !leftovers.iter().any(|name| name.ends_with(".part")),
            "不该留半截文件：{leftovers:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
