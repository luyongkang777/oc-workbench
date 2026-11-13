//! 远程仓库账号与托管接口（`/local/remote/*`）。
//!
//! 为什么必须走后端代理：Gitea 默认关 CORS、托管站会拒非 https 的 Referer、
//! token 不该落到页面内存里被 XSS 拿走。前端只认这里的 JSON。
//!
//! 存储位置 `%LOCALAPPDATA%\oc-workbench\remotes.json`（与 `projects.json` 同目录）。
//! 写入是「临时文件 + rename」：写到一半断电/崩溃最多留下一个 `.tmp`，已有账号不会丢。
//!
//! 三条安全约定：
//!   * 读接口**永不回传 token**，只回 `hasToken`；
//!   * 所有上游请求带 `Authorization: token <token>`（GitHub 和 Gitea 都认这个前缀）；
//!   * 网络失败翻译成人话（连不上 / 证书错 / 401 / 404 / 其它状态码）。
//!
//! 行为与 dev 侧的 `scripts/dev-local-remote.mjs` 保持一致（契约 §0 要求两边同语义）：
//! 地址归一化、精确去重、账号按创建时间倒序、空仓库优先排序、仓库字段回退。
//!
//! 一键登录（`/login`）额外一条硬约定：密码只在本次请求的内存里活到函数返回，
//! 不落盘、不进日志、不出现在任何响应里；Basic 头构造完就把明文缓冲抹掉。
//!
//! `Host` 与 `x-oc-token` 已经在 [`crate::server`] 统一校验，这里不重复做。

use std::cmp::Ordering;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tiny_http::Request;

use crate::body::{read_body_with_timeout, BodyRead};
use crate::fsutil::{param, param_u64, parse_query};
use crate::server::{json_error, respond_json};

/// POST 请求体上限（契约 §0）。
const BODY_LIMIT: usize = 256 * 1024;
/// 走网络的接口超时（probe / repos / create）。
const NET_TIMEOUT: Duration = Duration::from_secs(25);
/// 上游要认的 User-Agent：GitHub API 对缺 UA 的请求会直接 403。
const USER_AGENT: &str = "oc-workbench";
/// 仓库名长度上限（契约 §2 create）。
const REPO_NAME_MAX: usize = 100;
/// 列出仓库的默认条数与上限。
const REPO_LIMIT_DEFAULT: u64 = 100;
const REPO_LIMIT_MAX: u64 = 500;
/// 上游错误原文保留长度。
const DETAIL_LIMIT: usize = 300;
/// 账号文件大小保护：正常也就几 KB。
const STORE_LIMIT: usize = 4 * 1024 * 1024;
/// `open-url` 的长度上限（契约 §7.2，按字节算）。
const OPEN_URL_MAX: usize = 2048;
/// 令牌名长度上限：Gitea 侧本来就限制到 255，这里给用户输入留的余量足够。
const TOKEN_NAME_MAX: usize = 100;

// ---------- 错误形状 ----------

/// 与 `gitapi` 一致：HTTP 状态码 + 中文文案。文案里通常已经带上下游原文。
#[derive(Debug)]
struct RemoteError {
    code: u16,
    message: String,
}

impl RemoteError {
    fn new(code: u16, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

// ---------- 入口与分派 ----------

pub fn handle(request: Request, path: &str, url: &str) {
    let pairs = parse_query(url);
    let action = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let method = request.method().as_str().to_ascii_uppercase();

    match action {
        "accounts" => match method.as_str() {
            "GET" => accounts_get(request),
            "POST" => accounts_post(request),
            "DELETE" => accounts_delete(request, &pairs),
            _ => {
                let _ = json_error(request, 405, "accounts 只支持 GET / POST / DELETE");
            }
        },
        "probe" => {
            if method != "POST" {
                let _ = json_error(request, 405, "probe 只支持 POST");
                return;
            }
            probe_request(request);
        }
        "repos" => {
            if method != "GET" {
                let _ = json_error(request, 405, "repos 只支持 GET");
                return;
            }
            repos_request(request, &pairs);
        }
        "create" => {
            if method != "POST" {
                let _ = json_error(request, 405, "create 只支持 POST");
                return;
            }
            create_request(request);
        }
        "login" => {
            if method != "POST" {
                let _ = json_error(request, 405, "login 只支持 POST");
                return;
            }
            login_request(request);
        }
        "open-url" => {
            if method != "POST" {
                let _ = json_error(request, 405, "open-url 只支持 POST");
                return;
            }
            open_url_request(request);
        }
        _ => {
            let _ = json_error(request, 404, "未知的远程仓库接口");
        }
    }
}

// ---------- 通用小工具 ----------

fn respond_value(request: Request, value: Value) {
    let _ = respond_json(request, 200, value.to_string());
}

fn respond_error(request: Request, err: RemoteError) {
    let _ = json_error(request, err.code, &err.message);
}

/// 读 JSON 请求体（上限 256KB）。`None` = 已经回过错误。
fn read_json_body(request: Request) -> Option<(Request, Value)> {
    let (request, body) = read_body_with_timeout(request, BODY_LIMIT)?;
    let bytes = match body {
        BodyRead::Ok(bytes) => bytes,
        BodyRead::TooLarge => {
            let _ = json_error(request, 413, "请求体太大，上限 256KB");
            return None;
        }
        BodyRead::Failed(err) => {
            let _ = json_error(request, 400, &format!("读取请求体失败：{err}"));
            return None;
        }
    };
    if bytes.is_empty() {
        return Some((request, Value::Object(serde_json::Map::new())));
    }
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(value) => Some((request, value)),
        Err(err) => {
            let _ = json_error(request, 400, &format!("请求体不是合法的 JSON：{err}"));
            None
        }
    }
}

/// 取字符串字段并去首尾空白。缺失/类型不对都给空串。
fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// 取原始字符串（不去空白）——token、描述这类不能擅自裁剪。
fn raw_text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn first_text(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        let found = text(value, key);
        if !found.is_empty() {
            return found;
        }
    }
    String::new()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_millis() as i64)
        .unwrap_or(0)
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    if getrandom::getrandom(&mut buffer).is_err() {
        // 极端情况下退回时间 + pid，仍然要求非空。
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|delta| delta.as_nanos())
            .unwrap_or(0);
        for (index, slot) in buffer.iter_mut().enumerate() {
            let shift = (index % 16) * 8;
            *slot = ((nanos >> shift) & 0xff) as u8 ^ (std::process::id() as u8);
        }
    }
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out: String = text.chars().take(limit).collect();
    out.push_str("...");
    out
}

// ---------- 存储 ----------

/// `%LOCALAPPDATA%\oc-workbench\remotes.json`。
fn accounts_file() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    let dir = base.join("oc-workbench");
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("remotes.json"))
}

/// 读账号文件。文件不存在 = 空数组；内容坏掉报 500（不静默清空用户数据）。
fn load_accounts() -> Result<Vec<Value>, RemoteError> {
    let Some(path) = accounts_file() else {
        return Ok(Vec::new());
    };
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => {
            return Err(RemoteError::new(
                500,
                format!("读取账号文件失败：{err}"),
            ))
        }
    };
    let content = String::from_utf8_lossy(&bytes);
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let value: Value = serde_json::from_str(trimmed).map_err(|err| {
        RemoteError::new(
            500,
            format!("账号文件格式坏了（{}），请手动检查或删除后重试：{err}", path.display()),
        )
    })?;
    match value {
        Value::Array(items) => Ok(items
            .into_iter()
            .filter(|item| item.is_object() && !text(item, "id").is_empty())
            .collect()),
        _ => Err(RemoteError::new(
            500,
            format!("账号文件格式不对（{}），请手动检查或删除后重试", path.display()),
        )),
    }
}

/// 原子写：同目录临时文件 → rename 覆盖。Windows 上 `fs::rename` 会替换已存在的目标。
fn save_accounts(list: &[Value]) -> Result<(), RemoteError> {
    let Some(path) = accounts_file() else {
        return Err(RemoteError::new(
            500,
            "找不到 LOCALAPPDATA，无法保存账号",
        ));
    };
    let body = serde_json::to_string_pretty(&Value::Array(list.to_vec()))
        .map_err(|err| RemoteError::new(500, format!("序列化账号失败：{err}")))?;
    if body.len() > STORE_LIMIT {
        return Err(RemoteError::new(500, "账号文件过大，已经超出保护上限"));
    }
    let tmp = path.with_file_name(format!(
        "remotes.json.tmp-{}-{}",
        std::process::id(),
        random_hex(4)
    ));
    if let Err(err) = fs::write(&tmp, &body) {
        let _ = fs::remove_file(&tmp);
        return Err(RemoteError::new(
            500,
            format!("写入账号文件失败：{err}"),
        ));
    }
    if let Err(err) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(RemoteError::new(
            500,
            format!("替换账号文件失败：{err}"),
        ));
    }
    Ok(())
}

/// 对外的账号形状：**没有 token**，只有 `hasToken`。
fn account_json(account: &Value) -> Value {
    let base_url = text(account, "baseUrl");
    let web_url = {
        let web = text(account, "webUrl");
        if web.is_empty() {
            base_url.clone()
        } else {
            web
        }
    };
    json!({
        "id": text(account, "id"),
        "kind": text(account, "kind"),
        "baseUrl": base_url,
        "webUrl": web_url,
        "username": text(account, "username"),
        "hasToken": !raw_text(account, "token").trim().is_empty(),
        "createdAt": account.get("createdAt").and_then(Value::as_i64).unwrap_or(0),
    })
}

fn created_at(account: &Value) -> i64 {
    account
        .get("createdAt")
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

fn find_account(list: &[Value], id: &str) -> Option<Value> {
    list.iter().find(|item| text(item, "id") == id).cloned()
}

/// 同名判定：kind + apiBase + username，**精确比较**（与 dev 侧一致）。
fn same_identity(a: &Value, b: &Value) -> bool {
    text(a, "kind") == text(b, "kind")
        && text(a, "apiBase") == text(b, "apiBase")
        && text(a, "username") == text(b, "username")
}

/// 合并写入：同身份只更新（保留原 id），否则追加。返回最后存放的下标。
fn upsert_account(list: &mut Vec<Value>, next: Value) -> usize {
    for (index, item) in list.iter_mut().enumerate() {
        if same_identity(item, &next) {
            let mut merged = next;
            merged["id"] = item.get("id").cloned().unwrap_or_else(|| json!(""));
            *item = merged;
            return index;
        }
    }
    list.push(next);
    list.len() - 1
}

// ---------- 地址 / 仓库名 ----------

/// 从站点根地址里抠出主机名（忽略协议、路径、端口）。
fn site_host(base_url: &str) -> String {
    let lower = base_url.trim_end_matches('/').to_lowercase();
    let stripped = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .unwrap_or(&lower);
    stripped
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_string()
}

/// 只有官方 github.com（含 www）才走 api.github.com。
fn is_public_github(base_url: &str) -> bool {
    matches!(site_host(base_url).as_str(), "github.com" | "www.github.com")
}

fn derive_api_base(kind: &str, base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if kind.eq_ignore_ascii_case("github") {
        if is_public_github(base) {
            "https://api.github.com".to_string()
        } else {
            format!("{base}/api/v3")
        }
    } else {
        format!("{base}/api/v1")
    }
}

/// 站点根地址归一化：去空白/尾 `/`；没写协议补 `http://`（局域网 Gitea 很少写）；
/// 误粘进来的 `/api/v1`、`/api/v3` 剥掉——那是接口地址，不是站点根。
fn normalize_base(raw: &str) -> Result<String, RemoteError> {
    let mut text = raw.trim().to_string();
    if text.is_empty() {
        return Err(RemoteError::new(400, "缺少服务器地址"));
    }
    let lower = text.to_lowercase();
    if !lower.contains("://") {
        text = format!("http://{text}");
    } else if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err(RemoteError::new(400, "服务器地址只支持 http / https"));
    }

    let mut trimmed = text.trim_end_matches('/').to_string();
    let lower = trimmed.to_lowercase();
    for suffix in ["/api/v1", "/api/v3"] {
        if lower.ends_with(suffix) {
            let cut = trimmed.len() - suffix.len();
            trimmed.truncate(cut);
            break;
        }
    }
    let trimmed = trimmed.trim_end_matches('/').to_string();

    let scheme_len = if trimmed.to_lowercase().starts_with("https://") {
        "https://".len()
    } else {
        "http://".len()
    };
    if trimmed.len() <= scheme_len {
        return Err(RemoteError::new(
            400,
            format!("服务器地址看起来不对：{text}"),
        ));
    }
    Ok(trimmed)
}

/// 显式传进来的 apiBase：去尾 `/`，没协议补 `http://`；不剥 `/api/vN`（它本来就是接口根）。
fn normalize_api_base(raw: &str) -> String {
    let mut text = raw.trim().trim_end_matches('/').to_string();
    if !text.to_lowercase().contains("://") {
        text = format!("http://{text}");
    }
    text
}

fn valid_repo_name(name: &str) -> bool {
    let length = name.chars().count();
    (1..=REPO_NAME_MAX).contains(&length)
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

// ---------- 上游 JSON → RemoteRepo ----------

fn map_repo(kind: &str, repo: &Value) -> Value {
    let owner = repo
        .pointer("/owner/login")
        .and_then(Value::as_str)
        .or_else(|| repo.pointer("/owner/username").and_then(Value::as_str))
        .or_else(|| repo.pointer("/owner/name").and_then(Value::as_str))
        .map(str::trim)
        .filter(|owner| !owner.is_empty())
        .unwrap_or("")
        .to_string();

    let name = text(repo, "name");
    let full_name = {
        let given = text(repo, "full_name");
        if !given.is_empty() {
            given
        } else if !owner.is_empty() && !name.is_empty() {
            format!("{owner}/{name}")
        } else {
            name.clone()
        }
    };

    let private = repo.get("private").and_then(Value::as_bool).unwrap_or(false)
        || repo
            .get("visibility")
            .and_then(Value::as_str)
            .map(|value| value.eq_ignore_ascii_case("private"))
            .unwrap_or(false);

    let clone_url = {
        let given = text(repo, "clone_url");
        if given.is_empty() {
            text(repo, "html_url")
        } else {
            given
        }
    };

    json!({
        "fullName": full_name,
        "name": name,
        "owner": owner,
        "private": private,
        "cloneUrl": clone_url,
        "sshUrl": text(repo, "ssh_url"),
        "defaultBranch": text(repo, "default_branch"),
        "updatedAt": repo_updated_at(repo),
        "empty": repo_is_empty(kind, repo),
    })
}

fn repo_is_empty(kind: &str, repo: &Value) -> bool {
    if kind.eq_ignore_ascii_case("gitea") {
        return repo
            .get("empty")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| {
                repo.get("size")
                    .and_then(Value::as_i64)
                    .map(|size| size == 0)
                    .unwrap_or(false)
            });
    }
    repo.get("size")
        .and_then(Value::as_i64)
        .map(|size| size == 0)
        .unwrap_or(false)
}

fn repo_updated_at(repo: &Value) -> i64 {
    for key in ["updatedAt", "updated_at"] {
        if let Some(value) = repo.get(key) {
            if let Some(stamp) = parse_timestamp(value) {
                return stamp;
            }
        }
    }
    0
}

/// 上游给的是 ISO 8601 字符串（GitHub/Gitea 都是），统一换成 Unix 秒。
fn parse_timestamp(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        // 偶尔有站点直接给毫秒，按量级归一
        return Some(if number > 1_000_000_000_000 {
            number / 1000
        } else {
            number
        });
    }
    let text = value.as_str()?;
    iso_to_epoch(text.trim())
}

fn iso_to_epoch(text: &str) -> Option<i64> {
    if text.len() < 19 {
        return None;
    }
    let year: i64 = text.get(0..4)?.parse().ok()?;
    let month: i64 = text.get(5..7)?.parse().ok()?;
    let day: i64 = text.get(8..10)?.parse().ok()?;
    let hour: i64 = text.get(11..13)?.parse().ok()?;
    let minute: i64 = text.get(14..16)?.parse().ok()?;
    let second: i64 = text.get(17..19)?.parse().ok()?;

    let mut rest = text.get(19..)?;
    // 小数秒：.123 / .123456789
    if let Some(stripped) = rest.strip_prefix('.') {
        let index = stripped
            .find(|ch: char| !ch.is_ascii_digit())
            .unwrap_or(stripped.len());
        rest = &stripped[index..];
    }
    // 时区：Z / +08:00 / -05:00；缺省按 UTC
    let mut offset = 0i64;
    if let Some(signed) = rest.strip_prefix('+').or_else(|| rest.strip_prefix('-')) {
        let sign = if rest.starts_with('-') { -1 } else { 1 };
        let hours: i64 = signed.get(0..2).and_then(|v| v.parse().ok()).unwrap_or(0);
        let minutes: i64 = signed.get(3..5).and_then(|v| v.parse().ok()).unwrap_or(0);
        offset = sign * (hours * 3600 + minutes * 60);
    }

    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour * 3600 + minute * 60 + second - offset)
}

/// Howard Hinnant 的 days_from_civil：公历日期 → 1970-01-01 起的天数。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// `q` 本地过滤（full_name 大小写不敏感包含）+ 空仓库最前 + 最近更新倒序 + 名字稳定排序。
fn shape_repos(mut repos: Vec<Value>, q: &str) -> Vec<Value> {
    if !q.is_empty() {
        let needle = q.to_lowercase();
        repos.retain(|repo| {
            repo["fullName"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .contains(&needle)
        });
    }
    repos.sort_by(|a, b| {
        let empty_a = a["empty"].as_bool().unwrap_or(false);
        let empty_b = b["empty"].as_bool().unwrap_or(false);
        if empty_a != empty_b {
            return if empty_a {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        let updated_a = a["updatedAt"].as_i64().unwrap_or(0);
        let updated_b = b["updatedAt"].as_i64().unwrap_or(0);
        if updated_a != updated_b {
            return updated_b.cmp(&updated_a);
        }
        a["fullName"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b["fullName"].as_str().unwrap_or("").to_lowercase())
    });
    repos
}

// ---------- HTTP ----------

fn build_agent() -> ureq::Agent {
    let builder = ureq::AgentBuilder::new().timeout(NET_TIMEOUT);
    // ureq 2.x 的 `native-tls` feature 只是适配器：不显式挂 connector 的话，
    // 默认还是「没有 TLS 后端」，https 会直接报 cannot make HTTPS request。
    // 这里挂 native-tls，Windows 上就是系统 Schannel，走系统根证书。
    match ureq::native_tls::TlsConnector::new() {
        Ok(tls) => builder.tls_connector(std::sync::Arc::new(tls)).build(),
        // 极端情况下建不出 connector：http 还能用，https 会给出明确错误。
        Err(_) => builder.build(),
    }
}

fn host_of(url: &str) -> String {
    let without_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    without_scheme.split('/').next().unwrap_or("").to_string()
}

fn http_get_text(url: &str, token: &str) -> Result<String, RemoteError> {
    let agent = build_agent();
    let mut request = agent.get(url).set("User-Agent", USER_AGENT);
    if !token.is_empty() {
        request = request.set("Authorization", &format!("token {token}"));
    }
    match request.call() {
        Ok(response) => response
            .into_string()
            .map_err(|err| RemoteError::new(502, format!("读取上游响应失败：{err}"))),
        Err(err) => Err(translate_error(err, &host_of(url))),
    }
}

fn http_get_json(url: &str, token: &str) -> Result<Value, RemoteError> {
    let body = http_get_text(url, token)?;
    serde_json::from_str(&body)
        .map_err(|err| RemoteError::new(502, format!("上游返回的不是 JSON：{err}")))
}

fn http_post_json(url: &str, token: &str, payload: &Value) -> Result<Value, RemoteError> {
    let agent = build_agent();
    let request = agent
        .post(url)
        .set("User-Agent", USER_AGENT)
        .set("Authorization", &format!("token {token}"));
    match request.send_json(payload) {
        Ok(response) => {
            let body = response
                .into_string()
                .map_err(|err| RemoteError::new(502, format!("读取上游响应失败：{err}")))?;
            serde_json::from_str(&body)
                .map_err(|err| RemoteError::new(502, format!("上游返回的不是 JSON：{err}")))
        }
        Err(err) => Err(translate_error(err, &host_of(url))),
    }
}

/// 从上游错误 body 里挖出原因：GitHub/Gitea 都是 `message`，Gitea 有时候是 `error`，
/// GitHub 的校验错误在 `errors[].message`。
fn upstream_message(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        for key in ["message", "error"] {
            if let Some(text) = value.get(key).and_then(Value::as_str) {
                let text = text.trim();
                if !text.is_empty() {
                    return truncate(text, DETAIL_LIMIT);
                }
            }
        }
        if let Some(items) = value.get("errors").and_then(Value::as_array) {
            let parts: Vec<String> = items
                .iter()
                .filter_map(|item| item.get("message").and_then(Value::as_str))
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
                .collect();
            if !parts.is_empty() {
                return truncate(&parts.join("；"), DETAIL_LIMIT);
            }
        }
    }
    // HTML 错误页（反代/网关）对用户毫无意义，只报状态码。
    if trimmed.starts_with('<') {
        return String::new();
    }
    truncate(trimmed, DETAIL_LIMIT)
}

fn translate_error(err: ureq::Error, host: &str) -> RemoteError {
    match err {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            let upstream = upstream_message(&body);
            status_error(code, &upstream)
        }
        ureq::Error::Transport(transport) => transport_error(&transport.to_string(), host),
    }
}

fn status_error(code: u16, upstream: &str) -> RemoteError {
    let suffix = if upstream.is_empty() {
        String::new()
    } else {
        format!("：{upstream}")
    };
    match code {
        401 => RemoteError::new(401, format!("token 无效或已过期{suffix}")),
        403 => RemoteError::new(403, format!("没有权限访问，确认 token 的权限范围{suffix}")),
        404 => RemoteError::new(
            404,
            format!("接口不存在，确认是 Gitea 而不是别的服务{suffix}"),
        ),
        409 | 422 => RemoteError::new(
            409,
            if upstream.is_empty() {
                "仓库已存在".to_string()
            } else {
                format!("仓库已存在：{upstream}")
            },
        ),
        _ => RemoteError::new(code, format!("上游返回 {code}{suffix}")),
    }
}

fn transport_error(detail: &str, host: &str) -> RemoteError {
    let lower = detail.to_lowercase();
    let host = if host.is_empty() { "上游" } else { host };
    if lower.contains("certificate")
        || lower.contains("cert")
        || lower.contains("tls")
        || lower.contains("schannel")
        || lower.contains("handshake")
        || lower.contains("ssl")
    {
        return RemoteError::new(502, format!("证书校验失败：{detail}"));
    }
    if lower.contains("timed out") || lower.contains("timeout") || lower.contains("timedout") {
        return RemoteError::new(504, format!("连接 {host} 超时，检查地址和网络"));
    }
    RemoteError::new(
        502,
        format!("连不上 {host}，检查地址和网络（{detail}）"),
    )
}

// ---------- 上游业务调用 ----------

struct UserInfo {
    login: String,
    name: String,
}

fn fetch_user(api_base: &str, token: &str) -> Result<UserInfo, RemoteError> {
    let url = format!("{}/user", api_base.trim_end_matches('/'));
    let value = http_get_json(&url, token)?;
    Ok(UserInfo {
        login: first_text(&value, &["login", "username"]),
        name: first_text(&value, &["full_name", "name"]),
    })
}

/// 认不出来就 400（契约 §2 probe）。网络/证书错误照常上抛，不伪装成「认不出」。
fn detect_kind(base_url: &str, token: &str) -> Result<String, RemoteError> {
    if site_host(base_url) == "github.com" || site_host(base_url) == "www.github.com" {
        return Ok("github".to_string());
    }
    let url = format!("{}/api/v1/version", base_url.trim_end_matches('/'));
    let unrecognized = || RemoteError::new(400, "认不出这是 GitHub 还是 Gitea");
    match http_get_text(&url, token) {
        Ok(body) => match serde_json::from_str::<Value>(&body) {
            Ok(value) if value.get("version").is_some() => Ok("gitea".to_string()),
            _ => Err(unrecognized()),
        },
        Err(err) if matches!(err.code, 400 | 401 | 403 | 404) => Err(unrecognized()),
        Err(err) => Err(err),
    }
}

// ---------- GET /local/remote/accounts ----------

fn accounts_get(request: Request) {
    match load_accounts() {
        Ok(list) => {
            // 按创建时间倒序：最近加的在最前
            let mut sorted = list;
            sorted.sort_by(|a, b| created_at(b).cmp(&created_at(a)));
            let accounts: Vec<Value> = sorted.iter().map(account_json).collect();
            respond_value(request, json!({ "accounts": accounts }));
        }
        Err(err) => respond_error(request, err),
    }
}

// ---------- POST /local/remote/accounts ----------

fn accounts_post(request: Request) {
    let Some((request, body)) = read_json_body(request) else {
        return;
    };
    match save_account(&body) {
        Ok(account) => respond_value(request, json!({ "account": account })),
        Err(err) => respond_error(request, err),
    }
}

fn save_account(body: &Value) -> Result<Value, RemoteError> {
    let base_url = normalize_base(&text(body, "baseUrl"))?;
    let token = raw_text(body, "token").trim().to_string();
    if token.is_empty() {
        return Err(RemoteError::new(400, "缺少 token"));
    }

    let wanted = text(body, "kind").to_lowercase();
    let mut kind = if matches!(wanted.as_str(), "github" | "gitea") {
        wanted
    } else {
        String::new()
    };
    let mut username = text(body, "username");
    let mut api_base = {
        let given = text(body, "apiBase");
        if given.is_empty() {
            String::new()
        } else {
            normalize_api_base(&given)
        }
    };

    if kind.is_empty() {
        // 没指定类型：等价于先 probe 一次（顺带验了 token）
        let probed = probe(&json!({
            "baseUrl": base_url,
            "token": token,
            "kind": "",
        }))?;
        kind = probed
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        api_base = probed
            .get("apiBase")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if username.is_empty() {
            username = probed
                .get("username")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
        }
    } else {
        if api_base.is_empty() {
            api_base = derive_api_base(&kind, &base_url);
        }
        if username.is_empty() {
            // 契约：username 空就调一次 /user 拿 login
            username = fetch_user(&api_base, &token)?.login;
        }
    }

    if username.is_empty() {
        return Err(RemoteError::new(
            400,
            "拿不到账号名，请填 username 或确认 token 有效",
        ));
    }

    let next = json!({
        "id": format!("rm-{}", random_hex(4)),
        "kind": kind,
        "baseUrl": base_url.clone(),
        "apiBase": api_base,
        "webUrl": base_url,
        "username": username,
        "token": token,
        "createdAt": now_ms(),
    });

    let mut list = load_accounts()?;
    let index = upsert_account(&mut list, next);
    save_accounts(&list)?;
    Ok(account_json(&list[index]))
}

// ---------- DELETE /local/remote/accounts ----------

fn accounts_delete(request: Request, pairs: &[(String, String)]) {
    let id = param(pairs, "id").unwrap_or("").trim().to_string();
    if id.is_empty() {
        let _ = json_error(request, 400, "缺少要删除的账号 id");
        return;
    }
    match delete_account(&id) {
        Ok(()) => respond_value(request, json!({ "ok": true })),
        Err(err) => respond_error(request, err),
    }
}

fn delete_account(id: &str) -> Result<(), RemoteError> {
    let mut list = load_accounts()?;
    let before = list.len();
    list.retain(|item| text(item, "id") != id);
    if list.len() == before {
        return Err(RemoteError::new(404, "没有这个账号"));
    }
    save_accounts(&list)
}

// ---------- POST /local/remote/probe ----------

fn probe_request(request: Request) {
    let Some((request, body)) = read_json_body(request) else {
        return;
    };
    match probe(&body) {
        Ok(value) => respond_value(request, value),
        Err(err) => respond_error(request, err),
    }
}

fn probe(body: &Value) -> Result<Value, RemoteError> {
    let base_url = normalize_base(&text(body, "baseUrl"))?;
    let token = raw_text(body, "token").trim().to_string();
    if token.is_empty() {
        return Err(RemoteError::new(400, "缺少 token"));
    }
    let hint = text(body, "kind").to_lowercase();
    let kind = if matches!(hint.as_str(), "github" | "gitea") {
        hint
    } else {
        detect_kind(&base_url, &token)?
    };
    let api_base = derive_api_base(&kind, &base_url);
    let user = fetch_user(&api_base, &token)?;
    if user.login.is_empty() {
        return Err(RemoteError::new(
            400,
            "这个 token 读不到账号名，确认 token 权限（GitHub 勾 repo，Gitea 勾 repository）",
        ));
    }

    let mut out = json!({
        "kind": kind,
        "webUrl": base_url,
        "apiBase": api_base,
        "username": user.login,
    });
    if !user.name.is_empty() {
        out["name"] = json!(user.name);
    }
    Ok(out)
}

// ---------- GET /local/remote/repos ----------

fn repos_request(request: Request, pairs: &[(String, String)]) {
    let account_id = param(pairs, "account").unwrap_or("").trim().to_string();
    if account_id.is_empty() {
        let _ = json_error(request, 400, "缺少 account 参数");
        return;
    }
    let q = param(pairs, "q").unwrap_or("").trim().to_lowercase();
    let limit = param_u64(pairs, "limit")
        .unwrap_or(REPO_LIMIT_DEFAULT)
        .clamp(1, REPO_LIMIT_MAX);

    match list_repos(&account_id, &q, limit) {
        Ok(value) => respond_value(request, value),
        Err(err) => respond_error(request, err),
    }
}

fn require_account(id: &str) -> Result<Value, RemoteError> {
    let list = load_accounts()?;
    let account = find_account(&list, id).ok_or_else(|| RemoteError::new(404, "没有这个账号"))?;
    if raw_text(&account, "token").trim().is_empty() {
        return Err(RemoteError::new(
            400,
            "这个账号没有保存 token，请重新添加",
        ));
    }
    Ok(account)
}

fn list_repos(account_id: &str, q: &str, limit: u64) -> Result<Value, RemoteError> {
    let account = require_account(account_id)?;
    let kind = text(&account, "kind").to_lowercase();
    let api_base = text(&account, "apiBase").trim_end_matches('/').to_string();
    let token = raw_text(&account, "token");

    let url = if kind == "github" {
        format!(
            "{api_base}/user/repos?per_page={limit}&sort=updated&affiliation=owner,collaborator,organization_member"
        )
    } else {
        format!("{api_base}/user/repos?limit={limit}&page=1")
    };

    let value = http_get_json(&url, &token)?;
    let items = value
        .as_array()
        .ok_or_else(|| RemoteError::new(502, "上游返回的仓库列表不是数组"))?;
    let repos: Vec<Value> = items.iter().map(|item| map_repo(&kind, item)).collect();
    Ok(json!({ "repos": shape_repos(repos, q) }))
}

// ---------- POST /local/remote/create ----------

fn create_request(request: Request) {
    let Some((request, body)) = read_json_body(request) else {
        return;
    };
    match create_repo(&body) {
        Ok(value) => respond_value(request, value),
        Err(err) => respond_error(request, err),
    }
}

fn create_repo(body: &Value) -> Result<Value, RemoteError> {
    let account_id = text(body, "account");
    if account_id.is_empty() {
        return Err(RemoteError::new(400, "缺少 account 参数"));
    }
    let name = text(body, "name");
    if !valid_repo_name(&name) {
        return Err(RemoteError::new(
            400,
            "仓库名只能用字母、数字、点、下划线、短横线",
        ));
    }
    let private = body.get("private").and_then(Value::as_bool).unwrap_or(false);
    let description = raw_text(body, "description").trim().to_string();

    let account = require_account(&account_id)?;
    let kind = text(&account, "kind").to_lowercase();
    let api_base = text(&account, "apiBase").trim_end_matches('/').to_string();
    let token = raw_text(&account, "token");

    let payload = json!({
        "name": name,
        "private": private,
        "description": description,
        // 必须 false：带初始提交的远端会让本地首推 non-fast-forward
        "auto_init": false,
    });
    let value = http_post_json(&format!("{api_base}/user/repos"), &token, &payload)?;
    Ok(json!({ "repo": map_repo(&kind, &value) }))
}

// ---------- POST /local/remote/login（账号密码换令牌，契约 §7.1） ----------

/// 读请求体 → 换令牌 → 回令牌。
///
/// 密码的生命周期被压在两个函数里：`login_request` 读完就从 JSON 上摘掉，
/// `login` 只在构造 Basic 头时用一次，随后立刻 `drop`。全程没有日志、没有落盘。
fn login_request(request: Request) {
    let Some((request, mut body)) = read_json_body(request) else {
        return;
    };
    let result = login(&body);
    // 不管成败，先把明文密码从请求体上抹掉，别让它跟着 body 活到函数返回之后。
    if let Some(map) = body.as_object_mut() {
        map.remove("password");
    }
    match result {
        Ok(value) => respond_value(request, value),
        Err(err) => respond_error(request, err),
    }
}

fn login(body: &Value) -> Result<Value, RemoteError> {
    let base_url = normalize_base(&text(body, "baseUrl"))?;
    let username = text(body, "username");
    if username.is_empty() {
        return Err(RemoteError::new(400, "请填 Gitea 用户名"));
    }
    // 密码不 trim：首尾空格可能是密码的一部分（用户从密码管理器粘出来的常见情况）。
    let password = raw_text(body, "password");
    if password.is_empty() {
        return Err(RemoteError::new(400, "请填密码"));
    }

    let hint = text(body, "kind").to_lowercase();
    let kind = if matches!(hint.as_str(), "github" | "gitea") {
        hint
    } else {
        // 契约 §7.1：kind 为空先按 §2 探测。`/api/v1/version` 是公开接口，不需要令牌。
        detect_kind(&base_url, "")?
    };
    if kind != "gitea" {
        return Err(RemoteError::new(
            400,
            "GitHub 不支持账号密码登录，请用令牌",
        ));
    }

    let api_base = derive_api_base(&kind, &base_url);
    let token_name = {
        let given: String = text(body, "tokenName")
            .chars()
            .take(TOKEN_NAME_MAX)
            .collect();
        if given.is_empty() {
            token_name()
        } else {
            given
        }
    };

    let tokens_url = format!(
        "{}/users/{}/tokens",
        api_base.trim_end_matches('/'),
        percent_encode_segment(&username)
    );
    // 不传 scopes：老版本 Gitea 不认这个字段，不传等于全权限，兼容性最好。
    let payload = json!({ "name": token_name });

    let auth = basic_auth_header(&username, &password);
    // 明文到此为止：后面只有 base64，密码变量直接释放。
    drop(password);
    let created = http_post_json_auth(&tokens_url, &auth, &payload, login_status_error)?;
    // 头里含凭据，拿完就不再需要。
    drop(auth);

    let token = first_text(&created, &["sha1", "token"]);
    if token.is_empty() {
        return Err(RemoteError::new(
            502,
            "上游没有返回令牌（响应里缺少 sha1）",
        ));
    }
    // 验一次：刚拿到的令牌必须真能读 /user，否则存下去只是个死账号。
    let user = fetch_user(&api_base, &token).map_err(|err| {
        RemoteError::new(err.code, format!("令牌拿到了但验证失败：{}", err.message))
    })?;
    let login_name = if user.login.is_empty() {
        username
    } else {
        user.login
    };

    Ok(login_result(
        &kind,
        &base_url,
        &api_base,
        &login_name,
        &user.name,
        &token,
        &token_name,
    ))
}

/// 契约 §7.1 的返回形状。抽成纯函数是为了能单测「里面没有 password」。
fn login_result(
    kind: &str,
    base_url: &str,
    api_base: &str,
    username: &str,
    name: &str,
    token: &str,
    token_name: &str,
) -> Value {
    json!({
        "kind": kind,
        "baseUrl": base_url,
        "apiBase": api_base,
        "webUrl": base_url,
        "username": username,
        "name": name,
        "token": token,
        "tokenName": token_name,
    })
}

/// 登录专用的 4xx 翻译。同一个 404，这里要说的和「列仓库」完全不是一回事。
fn login_status_error(code: u16, upstream: &str) -> RemoteError {
    let suffix = if upstream.is_empty() {
        String::new()
    } else {
        format!("：{upstream}")
    };
    match code {
        401 => RemoteError::new(401, format!("用户名或密码不对{suffix}")),
        403 => RemoteError::new(403, format!("这个账号没有创建访问令牌的权限{suffix}")),
        404 => RemoteError::new(
            404,
            "这个 Gitea 版本不支持用接口创建令牌，请改用令牌方式",
        ),
        // 409/422 在别的接口里意味着「仓库已存在」，这里只是上游在抱怨，别套那句文案。
        _ => RemoteError::new(code, format!("上游返回 {code}{suffix}")),
    }
}

/// 带自定义 `Authorization` 的 POST。登录只认 Basic，不能套 `token <token>` 那套前缀。
/// `map_status` 把 4xx 文案交给调用方决定（见 [`login_status_error`]）。
fn http_post_json_auth(
    url: &str,
    auth: &str,
    payload: &Value,
    map_status: fn(u16, &str) -> RemoteError,
) -> Result<Value, RemoteError> {
    let agent = build_agent();
    let request = agent
        .post(url)
        .set("User-Agent", USER_AGENT)
        .set("Authorization", auth)
        .set("Accept", "application/json");
    match request.send_json(payload) {
        Ok(response) => {
            let body = response
                .into_string()
                .map_err(|err| RemoteError::new(502, format!("读取上游响应失败：{err}")))?;
            serde_json::from_str(&body)
                .map_err(|err| RemoteError::new(502, format!("上游返回的不是 JSON：{err}")))
        }
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            Err(map_status(code, &upstream_message(&body)))
        }
        Err(ureq::Error::Transport(transport)) => {
            Err(transport_error(&transport.to_string(), &host_of(url)))
        }
    }
}

// ---------- POST /local/remote/open-url（契约 §7.2） ----------

/// 让外壳用系统默认浏览器打开地址（GitHub 的令牌创建页靠它）。
///
/// `open::that` 在 Windows 上会跑 PowerShell 并**等它退出**（实测 1 秒级），
/// PowerShell 起不来时还会退到 explorer；两个都失败才报错，这时才回 500。
fn open_url_request(request: Request) {
    let Some((request, body)) = read_json_body(request) else {
        return;
    };
    let url = text(&body, "url");
    if !valid_open_url(&url) {
        let _ = json_error(request, 400, "只支持 http / https 链接，且不超过 2048 个字符");
        return;
    }
    match open::that(&url) {
        Ok(()) => respond_value(request, json!({ "ok": true })),
        Err(err) => {
            crate::append_log(&format!("[remote] 打开链接失败：{err}（{url}）\n"));
            let _ = json_error(request, 500, "打开浏览器失败");
        }
    }
}

// ---------- 纯函数：凭据 / 令牌名 / 链接校验 ----------

/// RFC 7617 的 Basic 头：`Basic base64(user:pass)`。
///
/// 按 UTF-8 编码（Go 侧 Gitea 也按 UTF-8 解，中文用户名/密码才能对上）。
/// 编码完顺手把明文缓冲清零——内存里少留一份密码，能做的就做。
fn basic_auth_header(username: &str, password: &str) -> String {
    use base64::Engine as _;
    let mut raw = Vec::with_capacity(username.len() + password.len() + 1);
    raw.extend_from_slice(username.as_bytes());
    raw.push(b':');
    raw.extend_from_slice(password.as_bytes());
    let encoded = base64::engine::general_purpose::STANDARD.encode(&raw);
    for byte in raw.iter_mut() {
        *byte = 0;
    }
    format!("Basic {encoded}")
}

/// 路径段百分号编码：RFC 3986 的 unreserved 之外全部 `%XX`（大写）。
/// 用户名直接拼进 URL 的话，中文/`@`/空格会让上游直接 404。
fn percent_encode_segment(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 8);
    for &byte in raw.as_bytes() {
        let ch = byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '.' | '_' | '~') {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 令牌名默认值 `oc-workbench-YYYYMMDD`（本地日期，跟用户手表一致）。
fn token_name() -> String {
    let (year, month, day) = local_ymd();
    token_name_for(year, month, day)
}

fn token_name_for(year: i64, month: i64, day: i64) -> String {
    format!("oc-workbench-{year:04}{month:02}{day:02}")
}

/// 本地年月日。`GetLocalTime` 直接给本地时间，不用自己算时区偏移。
#[cfg(windows)]
fn local_ymd() -> (i64, i64, i64) {
    #[repr(C)]
    #[derive(Default)]
    struct WinSystemTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        milliseconds: u16,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetLocalTime(out: *mut WinSystemTime);
    }

    let mut stamp = WinSystemTime::default();
    unsafe { GetLocalTime(&mut stamp) };
    if stamp.year == 0 {
        return utc_ymd();
    }
    (
        i64::from(stamp.year),
        i64::from(stamp.month),
        i64::from(stamp.day),
    )
}

/// 非 Windows：外壳本来就是 Windows 专用（WebView2），这里只保证能编译，按 UTC 算。
#[cfg(not(windows))]
fn local_ymd() -> (i64, i64, i64) {
    utc_ymd()
}

fn utc_ymd() -> (i64, i64, i64) {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or(0);
    civil_from_days(seconds.div_euclid(86_400))
}

/// Howard Hinnant 的 `civil_from_days`：1970-01-01 起的天数 → 公历 (年, 月, 日)。
/// 是上面 [`days_from_civil`] 的反函数，用同一套算法保证互相咬合。
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// 只放 http / https：`javascript:` / `file:` / `data:` 全拒。
/// 另外挡两类：控制字符（回车换行别混进启动器参数）、空主机名（`http://`）。
fn valid_open_url(raw: &str) -> bool {
    let url = raw.trim();
    if url.is_empty() || url.len() > OPEN_URL_MAX {
        return false;
    }
    if url.chars().any(char::is_control) {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    let rest = if let Some(rest) = lower.strip_prefix("https://") {
        rest
    } else if let Some(rest) = lower.strip_prefix("http://") {
        rest
    } else {
        return false;
    };
    !rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .is_empty()
}

// ---------- 单元测试（纯函数；网络部分不测） ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_base_derivation() {
        assert_eq!(
            derive_api_base("github", "https://github.com"),
            "https://api.github.com"
        );
        assert_eq!(
            derive_api_base("github", "https://github.com/"),
            "https://api.github.com"
        );
        assert_eq!(
            derive_api_base("github", "https://www.github.com"),
            "https://api.github.com"
        );
        // GitHub Enterprise
        assert_eq!(
            derive_api_base("github", "https://ghe.example.com"),
            "https://ghe.example.com/api/v3"
        );
        assert_eq!(
            derive_api_base("github", "https://ghe.example.com/"),
            "https://ghe.example.com/api/v3"
        );
        // Gitea（含子路径部署）
        assert_eq!(
            derive_api_base("gitea", "http://192.168.31.8:3000"),
            "http://192.168.31.8:3000/api/v1"
        );
        assert_eq!(
            derive_api_base("gitea", "https://example.com/gitea/"),
            "https://example.com/gitea/api/v1"
        );
    }

    #[test]
    fn base_url_normalization() {
        assert_eq!(
            normalize_base("  https://github.com/  ").unwrap(),
            "https://github.com"
        );
        // 没写协议 → 补 http（局域网 Gitea 常见）
        assert_eq!(normalize_base("192.168.31.8:3000").unwrap(), "http://192.168.31.8:3000");
        assert_eq!(normalize_base("github.com").unwrap(), "http://github.com");
        // 误粘的 API 地址要剥回站点根
        assert_eq!(
            normalize_base("http://h:3000/api/v1/").unwrap(),
            "http://h:3000"
        );
        assert_eq!(
            normalize_base("https://ghe.example.com/api/v3").unwrap(),
            "https://ghe.example.com"
        );
        assert!(normalize_base("").is_err());
        assert!(normalize_base("ftp://h").is_err());
        assert!(normalize_base("https://").is_err());
    }

    #[test]
    fn repo_name_validation() {
        for ok in ["oc-workbench", "a", "A.b_c-9", "0", &"x".repeat(100)] {
            assert!(valid_repo_name(ok), "应当接受：{ok}");
        }
        for bad in [
            "",
            "a b",
            "a/b",
            "中文",
            "a@b",
            "a.b?",
            "a\\b",
            &"x".repeat(101),
        ] {
            assert!(!valid_repo_name(bad), "应当拒绝：{bad}");
        }
    }

    #[test]
    fn github_repo_mapping_and_empty() {
        let repo = json!({
            "full_name": "me/demo",
            "name": "demo",
            "owner": { "login": "me" },
            "private": false,
            "clone_url": "https://github.com/me/demo.git",
            "ssh_url": "git@github.com:me/demo.git",
            "default_branch": "main",
            "updated_at": "1970-01-02T00:00:00Z",
            "size": 0
        });
        let mapped = map_repo("github", &repo);
        assert_eq!(mapped["fullName"], "me/demo");
        assert_eq!(mapped["name"], "demo");
        assert_eq!(mapped["owner"], "me");
        assert_eq!(mapped["private"], false);
        assert_eq!(mapped["cloneUrl"], "https://github.com/me/demo.git");
        assert_eq!(mapped["sshUrl"], "git@github.com:me/demo.git");
        assert_eq!(mapped["defaultBranch"], "main");
        assert_eq!(mapped["updatedAt"], 86_400);
        // GitHub 的空仓库判据是 size === 0
        assert_eq!(mapped["empty"], true);
    }

    #[test]
    fn gitea_repo_mapping_prefers_empty_flag() {
        // empty=false 但 size=0：以站点给的 empty 为准
        let repo = json!({
            "full_name": "me/x",
            "name": "x",
            "owner": { "login": "me" },
            "private": true,
            "clone_url": "http://h/me/x.git",
            "default_branch": "main",
            "updated_at": "1970-01-01T08:00:00+08:00",
            "size": 0,
            "empty": false
        });
        let mapped = map_repo("gitea", &repo);
        assert_eq!(mapped["empty"], false);
        assert_eq!(mapped["private"], true);
        assert_eq!(mapped["updatedAt"], 0, "带 +08:00 的时间要换算成 UTC");
        // 没有 ssh_url → 空串，不是 null
        assert_eq!(mapped["sshUrl"], "");

        // 没有 empty 字段 → 退回 size === 0
        let fallback = json!({ "full_name": "me/y", "size": 0 });
        assert_eq!(map_repo("gitea", &fallback)["empty"], true);
    }

    #[test]
    fn repo_mapping_fallbacks() {
        // 没有 full_name / owner.login：从 owner.username + name 拼出来
        let repo = json!({
            "name": "project",
            "owner": { "username": "someone" },
            "html_url": "https://h/someone/project",
            "visibility": "private"
        });
        let mapped = map_repo("gitea", &repo);
        assert_eq!(mapped["fullName"], "someone/project");
        assert_eq!(mapped["owner"], "someone");
        assert_eq!(mapped["private"], true);
        assert_eq!(mapped["cloneUrl"], "https://h/someone/project");
    }

    #[test]
    fn iso_timestamps() {
        assert_eq!(iso_to_epoch("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_to_epoch("1970-01-02T00:00:00Z"), Some(86_400));
        assert_eq!(iso_to_epoch("1970-01-01T08:00:00+08:00"), Some(0));
        assert_eq!(iso_to_epoch("1970-01-01T00:00:00.123Z"), Some(0));
        assert_eq!(iso_to_epoch("不是时间"), None);
        // 毫秒时间戳按量级归一
        assert_eq!(parse_timestamp(&json!(1_700_000_000_000i64)), Some(1_700_000_000));
    }

    #[test]
    fn account_upsert_updates_in_place() {
        let mut list = vec![json!({
            "id": "rm-00000001",
            "kind": "gitea",
            "apiBase": "http://h/api/v1",
            "username": "bob",
            "token": "old",
            "createdAt": 1
        })];
        let index = upsert_account(
            &mut list,
            json!({
                "id": "rm-deadbeef",
                "kind": "gitea",
                "apiBase": "http://h/api/v1",
                "username": "bob",
                "token": "new",
                "createdAt": 2
            }),
        );
        assert_eq!(index, 0);
        assert_eq!(list.len(), 1, "同名账号不能新增");
        assert_eq!(list[0]["id"], "rm-00000001", "id 必须保留");
        assert_eq!(list[0]["token"], "new");
        assert_eq!(list[0]["createdAt"], 2);

        // 用户名大小写不同 → 按精确比较视为新账号（与 dev 侧一致）
        let index = upsert_account(
            &mut list,
            json!({
                "id": "rm-00000002",
                "kind": "gitea",
                "apiBase": "http://h/api/v1",
                "username": "Bob",
                "token": "x",
                "createdAt": 3
            }),
        );
        assert_eq!(index, 1);
        assert_eq!(list.len(), 2);

        // 同用户名但不同 kind → 不合并
        upsert_account(
            &mut list,
            json!({
                "id": "rm-00000003",
                "kind": "github",
                "apiBase": "http://h/api/v1",
                "username": "bob",
                "token": "z",
                "createdAt": 4
            }),
        );
        assert_eq!(list.len(), 3);
    }

    #[test]
    fn account_json_never_leaks_token() {
        let account = json!({
            "id": "rm-1a2b3c4d",
            "kind": "gitea",
            "baseUrl": "http://h",
            "apiBase": "http://h/api/v1",
            "webUrl": "http://h",
            "username": "bob",
            "token": "super-secret-token",
            "createdAt": 5
        });
        let out = account_json(&account);
        assert_eq!(out["hasToken"], true);
        assert_eq!(out["username"], "bob");
        assert!(out.get("token").is_none(), "读接口不能回 token");
        assert!(!out.to_string().contains("super-secret-token"));
        assert!(out.get("apiBase").is_none(), "列表项不带 apiBase");

        let empty = json!({ "id": "rm-2", "kind": "github", "token": "" });
        assert_eq!(account_json(&empty)["hasToken"], false);
        // webUrl 缺省时退回 baseUrl
        assert_eq!(account_json(&empty)["webUrl"], "");
    }

    #[test]
    fn repo_filter_and_sort() {
        let repos = vec![
            json!({ "fullName": "me/old", "updatedAt": 10, "empty": false }),
            json!({ "fullName": "me/New-Repo", "updatedAt": 30, "empty": false }),
            json!({ "fullName": "me/blank", "updatedAt": 5, "empty": true }),
            json!({ "fullName": "other/thing", "updatedAt": 20, "empty": false }),
        ];
        let sorted = shape_repos(repos.clone(), "");
        let names: Vec<&str> = sorted
            .iter()
            .map(|repo| repo["fullName"].as_str().unwrap_or(""))
            .collect();
        // 空仓库最前，其余按 updatedAt 倒序
        assert_eq!(names, vec!["me/blank", "me/New-Repo", "other/thing", "me/old"]);

        let filtered = shape_repos(repos, "new");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0]["fullName"], "me/New-Repo", "q 要大小写不敏感");

        // 同一时间按名字稳定排序
        let same_time = vec![
            json!({ "fullName": "b/x", "updatedAt": 1, "empty": false }),
            json!({ "fullName": "a/x", "updatedAt": 1, "empty": false }),
        ];
        let sorted = shape_repos(same_time, "");
        assert_eq!(sorted[0]["fullName"], "a/x");
    }

    #[test]
    fn upstream_message_extraction() {
        assert_eq!(
            upstream_message(r#"{"message":"Bad credentials"}"#),
            "Bad credentials"
        );
        assert_eq!(
            upstream_message(r#"{"error":"token is required"}"#),
            "token is required"
        );
        assert_eq!(
            upstream_message(r#"{"message":"Validation Failed","errors":[{"message":"already exists"}]}"#),
            "Validation Failed"
        );
        // HTML 错误页不往界面塞
        assert_eq!(upstream_message("<html>502</html>"), "");
        assert_eq!(upstream_message(""), "");
    }

    #[test]
    fn status_translation() {
        assert_eq!(status_error(401, "Bad credentials").code, 401);
        assert!(status_error(401, "Bad credentials")
            .message
            .starts_with("token 无效或已过期"));
        assert!(status_error(404, "").message.contains("确认是 Gitea"));
        assert_eq!(status_error(409, "repo exists").code, 409);
        assert!(status_error(409, "repo exists").message.contains("repo exists"));
        // GitHub 建重名仓库给 422，统一归一成 409
        assert_eq!(status_error(422, "name already exists").code, 409);
        assert!(status_error(422, "name already exists")
            .message
            .contains("仓库已存在"));
        assert_eq!(status_error(500, "boom").code, 500);
    }

    #[test]
    fn transport_translation() {
        let cert = transport_error("invalid peer certificate: UnknownIssuer", "github.com");
        assert_eq!(cert.code, 502);
        assert!(cert.message.contains("证书校验失败"));

        let refused = transport_error("Connection refused (os error 10061)", "127.0.0.1");
        assert_eq!(refused.code, 502);
        assert!(refused.message.contains("连不上 127.0.0.1"));

        let timeout = transport_error("timed out", "example.com");
        assert_eq!(timeout.code, 504);
        assert!(timeout.message.contains("超时"));
    }

    #[test]
    fn basic_auth_header_encoding() {
        assert_eq!(basic_auth_header("bob", "secret"), "Basic Ym9iOnNlY3JldA==");
        // 密码里的冒号不影响编码：Basic 只认「第一个冒号前是用户名」
        assert_eq!(basic_auth_header("a b", "c:d"), "Basic YSBiOmM6ZA==");
        // 中文用户名 + 特殊字符密码：先 UTF-8 再 base64
        assert_eq!(
            basic_auth_header("陆永康", "p@ss:word"),
            "Basic 6ZmG5rC45bq3OnBAc3M6d29yZA=="
        );
        assert_eq!(
            basic_auth_header("user", "密码123"),
            "Basic dXNlcjrlr4bnoIExMjM="
        );
        // 头部永远不出现 CR/LF：base64 之后只剩 ASCII 安全字符，没法插新头
        let hostile = basic_auth_header("a\r\nX-Injected: 1", "p\r\n");
        assert!(hostile.starts_with("Basic "));
        assert!(!hostile.contains('\r') && !hostile.contains('\n'));
        // 空密码也照样编：`:x` 这种形状不 panic，交给上游回 401
        assert_eq!(basic_auth_header("", "x"), "Basic Ong=");
    }

    #[test]
    fn token_name_date_format() {
        assert_eq!(token_name_for(2026, 11, 13), "oc-workbench-20261113");
        // 月和日必须补零
        assert_eq!(token_name_for(2026, 1, 5), "oc-workbench-20260105");
        assert_eq!(token_name_for(999, 12, 31), "oc-workbench-09991231");
        // 真实调用必须同一种形状：前缀 + 8 位数字
        let live = token_name();
        assert!(live.starts_with("oc-workbench-"), "实际拿到：{live}");
        assert_eq!(live.len(), "oc-workbench-".len() + 8);
        assert!(live["oc-workbench-".len()..]
            .chars()
            .all(|ch| ch.is_ascii_digit()));
        // civil_from_days 与 days_from_civil 必须互为反函数（闰年、世纪边界都过一遍）
        for (year, month, day) in [
            (1970, 1, 1),
            (1970, 1, 2),
            (2000, 2, 29),
            (2026, 11, 13),
            (2100, 3, 1),
        ] {
            assert_eq!(civil_from_days(days_from_civil(year, month, day)), (year, month, day));
        }
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(1), (1970, 1, 2));
    }

    #[test]
    fn username_segment_encoding() {
        assert_eq!(percent_encode_segment("luyongkang777"), "luyongkang777");
        assert_eq!(
            percent_encode_segment("陆永康"),
            "%E9%99%86%E6%B0%B8%E5%BA%B7"
        );
        assert_eq!(percent_encode_segment("a b/c"), "a%20b%2Fc");
        assert_eq!(percent_encode_segment("a@b.com"), "a%40b.com");
        // unreserved 一个都不该被编
        assert_eq!(percent_encode_segment("A.b_c-9~"), "A.b_c-9~");
        assert_eq!(percent_encode_segment(""), "");
    }

    #[test]
    fn open_url_whitelist() {
        for ok in [
            "https://github.com/settings/tokens/new?scopes=repo&description=OpenCode%20工作台",
            "http://192.168.31.8:3000/user/settings/applications",
            "  https://example.com  ",
            "HTTPS://EXAMPLE.COM/x",
        ] {
            assert!(valid_open_url(ok), "应当接受：{ok}");
        }
        for bad in [
            "",
            "   ",
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox(1)",
            "ftp://example.com",
            "mailto:a@b.com",
            "http://",
            "https:///path",
            "http://a\r\nb",
        ] {
            assert!(!valid_open_url(bad), "应当拒绝：{bad}");
        }
        // 长度：2048 正好过，2049 拒
        let base = "https://example.com/";
        let exact = format!("{base}{}", "a".repeat(OPEN_URL_MAX - base.len()));
        assert_eq!(exact.len(), OPEN_URL_MAX);
        assert!(valid_open_url(&exact));
        assert!(!valid_open_url(&format!("{exact}a")));
    }

    #[test]
    fn login_status_messages() {
        let unauthorized = login_status_error(401, "invalid username, password or token");
        assert_eq!(unauthorized.code, 401);
        assert!(unauthorized.message.starts_with("用户名或密码不对"));
        assert!(unauthorized
            .message
            .contains("invalid username, password or token"));
        assert!(login_status_error(403, "")
            .message
            .contains("没有创建访问令牌的权限"));
        assert!(login_status_error(404, "")
            .message
            .contains("不支持用接口创建令牌"));
        // 422 不能被套成「仓库已存在」
        let conflict = login_status_error(422, "token name has been used");
        assert_eq!(conflict.code, 422);
        assert!(!conflict.message.contains("仓库已存在"));
        assert!(conflict.message.contains("token name has been used"));
    }

    #[test]
    fn login_result_shape_has_no_password() {
        let out = login_result(
            "gitea",
            "http://192.168.31.8:3000",
            "http://192.168.31.8:3000/api/v1",
            "luyongkang777",
            "陆永康",
            "sha1-token",
            "oc-workbench-20261113",
        );
        assert_eq!(out["kind"], "gitea");
        assert_eq!(out["baseUrl"], "http://192.168.31.8:3000");
        assert_eq!(out["apiBase"], "http://192.168.31.8:3000/api/v1");
        assert_eq!(out["webUrl"], "http://192.168.31.8:3000");
        assert_eq!(out["username"], "luyongkang777");
        assert_eq!(out["name"], "陆永康");
        assert_eq!(out["token"], "sha1-token");
        assert_eq!(out["tokenName"], "oc-workbench-20261113");
        assert!(out.get("password").is_none(), "返回体里不能有 password");
        assert!(!out.to_string().contains("password"));
    }
}
