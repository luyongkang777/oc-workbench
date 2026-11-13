//! OpenCode CLI 的版本探测、缺失即装、旧了自动更新。
//!
//! 为什么外壳要管这件事：工作台本身没有后端，所有功能都靠本机的 `opencode`
//! 服务。机器上没装、或者装的是 v1（协议对不上），页面就永远是「未连接」，
//! 而用户很难自己判断到底是「没装」「装错了版本」还是「装好了但不在 PATH」。
//! 所以这里把三件事收进一个模块：
//!
//!   1. **报版本**：定位到可执行文件后跑一次 `opencode --version`，把 v2.2.5 这种
//!      结果给页面显示（顶栏胶囊 + 更新面板）。
//!   2. **缺了就装**：发布包走 GitHub Release（`opencode-windows-<arch>.zip`），
//!      下载 → 解压 → 校验 → 落到官方安装器的位置 `%USERPROFILE%\.opencode\bin`。
//!   3. **旧了就更新**：启动后台线程静默比对，发现 v2 有新版就直接替换。
//!
//! 替换为什么不用「等进程退出」：Windows 上正在运行的 exe **不能覆盖，但可以改名**。
//! 所以顺序是「旧文件改名成 .bak → 新文件写到原路径」，后端服务正在跑也不影响，
//! 下一次连接自然用上新文件（[`crate::auth::reset_resolution`] 清掉定位缓存）。
//!
//! 版本只认同一条线：`v2.x.y`。npm 上 `opencode-ai` 的 1.19.5 是 v1，协议与工作台
//! 不兼容，装上了也没用，所以 [`needs_upgrade`] 会把「装了 v1」也算成「该装 v2」。
//!
//! 端点（都要 `x-oc-token`，由 `server.rs` 统一校验）：
//!
//!   * `GET  /local/cli/status[?remote=1]` 状态、版本、最新版、进度
//!   * `POST /local/cli/install`           下载并安装/更新（阻塞到结束）
//!   * `POST /local/cli/check`             强制刷新「最新版本」缓存
//!   * `POST /local/cli/auto`              `{ "enabled": true|false }`

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tiny_http::{Method, Request};

use crate::body::{read_body_with_timeout, BodyRead};

/// 发布列表接口；可用环境变量指向镜像（国内直连 api.github.com 经常超时）。
pub const RELEASES_ENV: &str = "OC_OPENCODE_RELEASES_API";
const DEFAULT_RELEASES_API: &str =
    "https://api.github.com/repos/anomalyco/opencode/releases?per_page=30";

/// 只要 v2 线：v1 的 CLI 协议跟工作台对不上。
const MAJOR: u64 = 2;
const API_TIMEOUT: Duration = Duration::from_secs(20);
/// 安装包一百多 MB，慢网下读超时要留足。
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(180);
/// 兜底上限：清单没给 size 时也不能让一次下载把磁盘写满。
const MAX_DOWNLOAD: u64 = 400 * 1024 * 1024;
const VERSION_TIMEOUT: Duration = Duration::from_secs(30);
/// 「最新版本」缓存：GitHub 匿名接口 60 次/小时，10 分钟内不重复问。
const LATEST_TTL: Duration = Duration::from_secs(10 * 60);
/// 本机版本缓存：`--version` 要启动一个几百 MB 的 exe，别每次查询都跑一遍。
const VERSION_TTL: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(50);
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 自动更新的设置键（与在线更新共用 settings.json，键名互不影响）。
const AUTO_KEY: &str = "autoUpdateCli";
/// 上次自动检查的时间戳（毫秒）。用来把「每次启动都查」降成「几小时查一次」。
const LAST_CHECK_KEY: &str = "lastCliCheckAt";
/// 自动检查的最小间隔：启动很频繁，但没必要每次都问 GitHub（匿名接口还限流）。
/// 缺了 CLI 的情况不受这个限制——那是「装不上就没法用」，立即处理。
const AUTO_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// 一次安装任务的进度。GET status 读它，安装线程写它。
#[derive(Clone)]
struct Job {
    busy: bool,
    phase: String,
    done: u64,
    total: u64,
    error: Option<String>,
}

static JOB: Mutex<Job> = Mutex::new(Job {
    busy: false,
    phase: String::new(),
    done: 0,
    total: 0,
    error: None,
});

static LATEST_CACHE: Mutex<Option<(Instant, Result<Latest, String>)>> = Mutex::new(None);
static VERSION_CACHE: Mutex<Option<(Instant, Result<String, String>)>> = Mutex::new(None);

/// 找到的最新 v2 发布包。
#[derive(Clone, Debug, PartialEq)]
pub struct Latest {
    pub version: String,
    pub url: String,
    pub size: u64,
    pub asset: String,
    pub notes: String,
}

// ---------------------------------------------------------------------------
// 版本号：解析与比较
// ---------------------------------------------------------------------------

/// 从任意输出里抠出第一个 `x.y.z`。
///
/// `opencode --version` 实测输出是 `opencode v2.2.5`（带前缀、带换行），
/// 不同渠道的 shim 还可能夹着别的日志，所以不做整行匹配。
pub fn parse_version(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let mut parts: Vec<String> = Vec::new();
        loop {
            let start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if i == start {
                break;
            }
            parts.push(chars[start..i].iter().collect());
            if parts.len() == 3 {
                break;
            }
            // 必须紧跟「.数字」才算继续，否则 `2026-11-13` 这种会被误读
            if i + 1 < chars.len() && chars[i] == '.' && chars[i + 1].is_ascii_digit() {
                i += 1;
            } else {
                break;
            }
        }
        if parts.len() == 3 {
            return Some(format!("{}.{}.{}", parts[0], parts[1], parts[2]));
        }
    }
    None
}

/// 版本号拆成可比较的数值向量（`2.10.0` > `2.9.9`，字符串比较会反）。
pub fn version_key(version: &str) -> Vec<u64> {
    version
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

/// candidate 是否比 current 新。
pub fn is_newer(candidate: &str, current: &str) -> bool {
    version_key(candidate) > version_key(current)
}

/// 是不是我们要的 v2 线。
pub fn is_v2(version: &str) -> bool {
    version_key(version).first() == Some(&MAJOR)
}

/// 是否需要安装/升级：没装 v2（含装的是 v1、版本号解析不出来）或 v2 上有新版。
pub fn needs_upgrade(current: &str, latest: &str) -> bool {
    if !is_v2(current) {
        return true;
    }
    is_newer(latest, current)
}

/// 发布标签 → 版本号。只认 `v2.x.y` / `2.x.y` 这种三段纯数字标签，
/// 仓库里还混着 `process-daemon-v0.5.2` 这类别的包，不能一律收。
pub fn v2_tag(tag: &str) -> Option<String> {
    let raw = tag.strip_prefix('v').unwrap_or(tag);
    let parts: Vec<&str> = raw.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    if !parts.iter().all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    if parts[0].parse::<u64>().ok()? != MAJOR {
        return None;
    }
    Some(raw.to_string())
}

// ---------------------------------------------------------------------------
// 发布列表：找最新 v2 + 对应架构的 Windows 包
// ---------------------------------------------------------------------------

fn releases_api() -> String {
    std::env::var(RELEASES_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_RELEASES_API.to_string())
}

fn build_agent(overall: Duration, read: Option<Duration>) -> Result<ureq::Agent, String> {
    crate::fetch::agent(overall, read)
}

/// 按当前架构挑安装包名（顺序即优先级）。
///
/// x64 优先普通包，其次 baseline：baseline 是不带 AVX 的兼容构建，
/// 只有在普通包不存在或跑不起来时才该用它。
pub fn asset_names(arch: &str) -> Vec<&'static str> {
    if arch == "aarch64" {
        vec!["opencode-windows-arm64.zip"]
    } else {
        vec!["opencode-windows-x64.zip", "opencode-windows-x64-baseline.zip"]
    }
}

fn pick_asset(assets: &[serde_json::Value], arch: &str) -> Option<(String, String, u64)> {
    let wanted = asset_names(arch);
    for name in &wanted {
        for asset in assets {
            if asset.get("name").and_then(|v| v.as_str()) == Some(*name) {
                let url = asset.get("browser_download_url").and_then(|v| v.as_str())?;
                let size = asset.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                return Some((url.to_string(), (*name).to_string(), size));
            }
        }
    }
    // 兜底：名字变了也不会直接报「没有安装包」
    assets.iter().find_map(|asset| {
        let name = asset.get("name").and_then(|v| v.as_str())?;
        let lower = name.to_ascii_lowercase();
        if !lower.ends_with(".zip") || !lower.contains("windows") {
            return None;
        }
        let url = asset.get("browser_download_url").and_then(|v| v.as_str())?;
        let size = asset.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
        Some((url.to_string(), name.to_string(), size))
    })
}

fn notes_of(item: &serde_json::Value) -> String {
    let body = item.get("body").and_then(|v| v.as_str()).unwrap_or("");
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    trimmed.chars().take(400).collect()
}

/// 从发布列表里挑最新 v2（跳过 draft / prerelease）。
pub fn pick_latest(text: &str, arch: &str) -> Result<Latest, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|err| format!("发布列表不是合法 JSON：{err}"))?;
    let list = value
        .as_array()
        .ok_or_else(|| "发布列表不是数组".to_string())?;

    let mut best: Option<(Vec<u64>, Latest)> = None;
    for item in list {
        if item.get("draft").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        if item.get("prerelease").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        let tag = item.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
        let Some(version) = v2_tag(tag) else {
            continue;
        };
        let assets = item
            .get("assets")
            .and_then(|v| v.as_array())
            .map(|list| list.as_slice())
            .unwrap_or(&[]);
        let Some((url, asset, size)) = pick_asset(assets, arch) else {
            continue;
        };
        let key = version_key(&version);
        let replace = best.as_ref().map(|(best_key, _)| key > *best_key).unwrap_or(true);
        if replace {
            best = Some((
                key,
                Latest {
                    version,
                    url,
                    size,
                    asset,
                    notes: notes_of(item),
                },
            ));
        }
    }

    best.map(|(_, latest)| latest)
        .ok_or_else(|| "发布列表里没有 v2 的 Windows 安装包".to_string())
}

fn fetch_latest_now() -> Result<Latest, String> {
    let url = releases_api();
    let agent = build_agent(API_TIMEOUT, None)?;
    let mut text = String::new();
    agent
        .get(&url)
        .set("accept", "application/vnd.github+json")
        .set("user-agent", "oc-workbench-cli")
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(code, _) => format!("发布列表返回 HTTP {code}（可能是限流）"),
            other => format!("连不上发布列表：{other}"),
        })?
        .into_reader()
        .take(4 * 1024 * 1024)
        .read_to_string(&mut text)
        .map_err(|err| format!("读发布列表失败：{err}"))?;
    pick_latest(&text, std::env::consts::ARCH)
}

/// 取最新 v2 发布；`force=false` 时命中 10 分钟缓存就不联网。
pub fn latest_release(force: bool) -> Result<Latest, String> {
    if !force {
        if let Ok(guard) = LATEST_CACHE.lock() {
            if let Some((at, cached)) = guard.as_ref() {
                if at.elapsed() < LATEST_TTL {
                    return cached.clone();
                }
            }
        }
    }
    let result = fetch_latest_now();
    if let Ok(mut guard) = LATEST_CACHE.lock() {
        *guard = Some((Instant::now(), result.clone()));
    }
    result
}

// ---------------------------------------------------------------------------
// 本机版本
// ---------------------------------------------------------------------------

/// 跑 `<exe> --version`，返回解析出的版本号。
///
/// **必须经 [crate::auth::command_for_path]**：老实现直接 `Command::new(exe)`，
/// 遇到非 PE 的 shim（npm 的无扩展名 bash 脚本、.cmd）就必然失败，
/// 页面于是显示「已安装，版本读取失败」+ os error 193。
///
/// 几百 MB 的 exe 冷启动可能就要几秒，所以给 30 秒；超时一律杀进程树，
/// 免得留下一个「半启动」的 opencode 占着服务锁。
fn exe_version(exe: &Path) -> Result<String, String> {
    let mut command = crate::auth::command_for_path(exe, &["--version"]);
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|err| format!("启动 {} 失败：{err}", exe.display()))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // 管道读取放独立线程：父进程退出不等于管道 EOF（孙进程还会占着）。
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut out = Vec::new();
        if let Some(mut pipe) = stdout {
            let _ = pipe.read_to_end(&mut out);
        }
        let mut err = Vec::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_end(&mut err);
        }
        let _ = sender.send((out, err));
    });

    let deadline = Instant::now() + VERSION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("等待 --version 失败：{err}"));
            }
        }
        if Instant::now() >= deadline {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = Command::new("taskkill")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "`{} --version` 超过 {} 秒没返回（被拦或卡在初始化）",
                exe.display(),
                VERSION_TIMEOUT.as_secs()
            ));
        }
        thread::sleep(POLL);
    }

    let (out, err) = receiver.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out),
        String::from_utf8_lossy(&err)
    );
    parse_version(&text).ok_or_else(|| {
        let brief: String = text.trim().chars().take(120).collect();
        format!("--version 输出里没有版本号：{brief}")
    })
}

/// 本机已安装的版本（命中 60 秒缓存）。没装就是 Err。
pub fn installed_version() -> Result<String, String> {
    if let Ok(guard) = VERSION_CACHE.lock() {
        if let Some((at, cached)) = guard.as_ref() {
            if at.elapsed() < VERSION_TTL {
                return cached.clone();
            }
        }
    }
    let result = match crate::auth::locate() {
        Some(exe) => exe_version(&exe),
        None => Err("没找到 opencode（PATH、程序目录、%USERPROFILE%\\.opencode\\bin 都没有）".to_string()),
    };
    if let Ok(mut guard) = VERSION_CACHE.lock() {
        *guard = Some((Instant::now(), result.clone()));
    }
    result
}

fn forget_version() {
    if let Ok(mut guard) = VERSION_CACHE.lock() {
        *guard = None;
    }
}

// ---------------------------------------------------------------------------
// 下载 / 解压 / 替换
// ---------------------------------------------------------------------------

fn with_job(update: impl FnOnce(&mut Job)) {
    if let Ok(mut job) = JOB.lock() {
        update(&mut job);
    }
}

fn is_busy() -> bool {
    JOB.lock().map(|job| job.busy).unwrap_or(false)
}

/// `%LOCALAPPDATA%\oc-workbench\cli`：下载包和解压目录都放这里。
fn work_dir() -> Result<PathBuf, String> {
    let dir = crate::update::data_dir()
        .ok_or_else(|| "没有 LOCALAPPDATA，无法确定下载目录".to_string())?
        .join("cli");
    fs::create_dir_all(&dir).map_err(|err| format!("建下载目录失败：{err}"))?;
    Ok(dir)
}

fn download(latest: &Latest) -> Result<PathBuf, String> {
    let dir = work_dir()?;
    let final_path = dir.join(format!("opencode-{}.zip", latest.version));
    let part_path = dir.join(format!("opencode-{}.zip.part", latest.version));
    let _ = fs::remove_file(&part_path);

    with_job(|job| {
        job.phase = format!("下载 v{}（{}）", latest.version, latest.asset);
        job.done = 0;
        job.total = latest.size;
    });

    let agent = build_agent(Duration::from_secs(900), Some(DOWNLOAD_READ_TIMEOUT))?;
    let response = agent.get(&latest.url).call().map_err(|err| match err {
        ureq::Error::Status(code, _) => format!("下载失败：HTTP {code}"),
        other => format!("下载失败：{other}"),
    })?;

    let limit = if latest.size > 0 { latest.size } else { MAX_DOWNLOAD }.min(MAX_DOWNLOAD);
    let mut reader = response.into_reader();
    let mut file = fs::File::create(&part_path).map_err(|err| format!("建临时文件失败：{err}"))?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut copied: u64 = 0;
    loop {
        let read = reader.read(&mut buf).map_err(|err| {
            let _ = fs::remove_file(&part_path);
            format!("读下载流失败：{err}")
        })?;
        if read == 0 {
            break;
        }
        file.write_all(&buf[..read]).map_err(|err| {
            let _ = fs::remove_file(&part_path);
            format!("写文件失败：{err}")
        })?;
        copied += read as u64;
        if copied > limit {
            let _ = fs::remove_file(&part_path);
            return Err(format!("下载体积超过声明（>{limit} 字节），已丢弃"));
        }
        with_job(|job| job.done = copied);
    }
    drop(file);

    if latest.size > 0 && copied != latest.size {
        let _ = fs::remove_file(&part_path);
        return Err(format!(
            "下载体积不对：期望 {} 字节，实际 {copied} 字节，已丢弃",
            latest.size
        ));
    }

    // 头两字节必须是 PK：避免把一段 HTML 错误页当成 zip 解压下去。
    let mut head = [0u8; 2];
    {
        let mut probe = fs::File::open(&part_path).map_err(|err| format!("回读失败：{err}"))?;
        probe
            .read_exact(&mut head)
            .map_err(|err| format!("回读失败：{err}"))?;
    }
    if &head != b"PK" {
        let _ = fs::remove_file(&part_path);
        return Err("下载到的不是 zip（缺少 PK 头），已丢弃".to_string());
    }

    let _ = fs::remove_file(&final_path);
    fs::rename(&part_path, &final_path).map_err(|err| format!("改名失败：{err}"))?;
    Ok(final_path)
}

fn find_exe(dir: &Path, depth: usize) -> Option<PathBuf> {
    crate::fetch::find_named(dir, "opencode.exe", depth)
}

/// 解压 zip 并找到里面的 `opencode.exe`。解压细节（系统 bsdtar → PowerShell 兜底）
/// 在 [`crate::fetch::extract_zip`]，和便携版 git 共用同一套，避免两份实现走偏。
fn extract(zip: &Path, out: &Path) -> Result<PathBuf, String> {
    crate::fetch::extract_zip(zip, out)?;
    find_exe(out, 3).ok_or_else(|| "解压后没找到 opencode.exe（包结构可能变了）".to_string())
}

/// 安装落点。
///
/// 三种情况：
///   1. 定位到的是**真 PE**（`opencode.exe`）→ 原地升级，PATH 与 shim 都不用动。
///   2. 定位到的是脚本 shim（npm 的无扩展名 bash 脚本 / .cmd）→ 装到**同一个目录**
///      下的 `opencode.exe`。不能装到别处：用户 PATH 指的是这个目录，
///      装远了下一次定位仍然被 shim 抢先，面板会永远停在「要更新」。
///   3. 什么都没定位到 → 官方安装器的目录 `%USERPROFILE%\.opencode\bin`。
fn install_target() -> Result<PathBuf, String> {
    if let Some(exe) = crate::auth::locate() {
        let is_exe = exe
            .extension()
            .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("exe"))
            .unwrap_or(false);
        // 只看文件头 2 字节。以前 `std::fs::read` 读整个文件——本机一个旧版
        // opencode 就有 200MB+，为两个字节读 200MB 纯属白烧内存。
        if is_exe && crate::auth::is_pe(&exe) {
            return Ok(exe);
        }
        // 必须是绝对路径且有父目录：OPENCODE_ENV 指向一个找不到的「命令名」时
        // locate() 会原样返回那个相对路径，parent() 是空串，join 出来就是
        // "opencode.exe" —— replace_exe 会往进程当前目录写一个 200MB 的 exe。
        if exe.is_absolute() {
            if let Some(dir) = exe.parent().filter(|dir| !dir.as_os_str().is_empty()) {
                return Ok(dir.join("opencode.exe"));
            }
        }
    }
    let home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .ok_or_else(|| "没有 USERPROFILE，无法确定安装目录".to_string())?;
    Ok(home.join(".opencode").join("bin").join("opencode.exe"))
}

fn backup_name(target: &Path, version: &str) -> PathBuf {
    let safe: String = version
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect();
    target.with_file_name(format!("opencode.exe.bak-{safe}"))
}

/// 把新 exe 换到目标路径。运行中的 exe 允许改名、不允许覆盖，所以是
/// 「旧文件改名 → 写新文件」；写失败就把改名回滚，绝不留一个没有 exe 的目录。
fn replace_exe(new: &Path, target: &Path, version: &str) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("建安装目录失败：{err}"))?;
    }

    let mut backup: Option<PathBuf> = None;
    if target.is_file() {
        let bak = backup_name(target, version);
        let _ = fs::remove_file(&bak);
        let mut moved = fs::rename(target, &bak).is_ok();
        if !moved {
            // 被别的东西短暂占着：重试几秒（正常情况第一次就成功）
            for _ in 0..40 {
                thread::sleep(Duration::from_millis(250));
                if fs::rename(target, &bak).is_ok() {
                    moved = true;
                    break;
                }
            }
        }
        if !moved {
            return Err(format!(
                "{} 被占用，改名失败（先退出正在运行的 opencode 再试）",
                target.display()
            ));
        }
        backup = Some(bak);
    }

    match fs::copy(new, target) {
        Ok(_) => Ok(()),
        Err(err) => {
            if let Some(bak) = backup {
                let _ = fs::rename(&bak, target);
            }
            Err(format!("写入 {} 失败：{err}", target.display()))
        }
    }
}

fn install_inner() -> Result<String, String> {
    let latest = latest_release(true)?;
    with_job(|job| {
        job.total = latest.size;
        job.done = 0;
        job.phase = format!("准备安装 v{}", latest.version);
    });

    let zip = download(&latest)?;

    with_job(|job| job.phase = "解压安装包".to_string());
    let unpacked = work_dir()?.join(format!("opencode-{}", latest.version));
    let fresh = extract(&zip, &unpacked)?;

    with_job(|job| job.phase = "校验新文件".to_string());
    let found = exe_version(&fresh)?;
    if !is_v2(&found) {
        return Err(format!("下载到的不是 v2（版本 {found}），已放弃"));
    }

    let target = install_target()?;
    with_job(|job| job.phase = format!("替换 {}", target.display()));
    replace_exe(&fresh, &target, &latest.version)?;

    // 定位缓存里还是旧路径/旧文件，清掉让下一次连接用新装的
    crate::auth::reset_resolution();
    forget_version();

    let verified = exe_version(&target).unwrap_or(found);
    if !is_v2(&verified) {
        return Err(format!("替换后版本异常（{verified}），请手动检查 {}", target.display()));
    }

    // 清掉下载产物；清不掉不算失败
    let _ = fs::remove_file(&zip);
    let _ = fs::remove_dir_all(&unpacked);

    crate::append_log(&format!(
        "[cli] opencode 已装到 v{verified}（{}）\n",
        target.display()
    ));
    Ok(verified)
}

/// 下载并安装/更新。阻塞到结束（每个 HTTP 请求一个线程，不会挡住界面）。
pub fn install() -> Result<String, String> {
    if !cfg!(windows) {
        return Err("自动安装只在 Windows 上提供".to_string());
    }
    {
        let Ok(mut job) = JOB.lock() else {
            return Err("安装状态锁失效".to_string());
        };
        if job.busy {
            return Err("已经在下载/安装中，别连点".to_string());
        }
        job.busy = true;
        job.error = None;
        job.done = 0;
        job.total = 0;
        job.phase = "检查最新版本".to_string();
    }

    let result = install_inner();
    match &result {
        Ok(version) => with_job(|job| {
            job.busy = false;
            job.phase = format!("已更新到 v{version}");
            job.error = None;
        }),
        Err(err) => {
            crate::append_log(&format!("[cli] 安装失败：{err}\n"));
            with_job(|job| {
                job.busy = false;
                job.phase = "安装失败".to_string();
                job.error = Some(err.clone());
            });
        }
    }
    result
}

/// 自动更新开关（默认开）。
pub fn auto_update() -> bool {
    crate::update::bool_setting(AUTO_KEY, true)
}

fn save_auto(enabled: bool) -> Result<(), String> {
    crate::update::set_bool_setting(AUTO_KEY, enabled, true)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|span| span.as_millis() as i64)
        .unwrap_or(0)
}

/// 上次自动检查完成的时间（毫秒）。只用来节流，读坏了按「没查过」处理。
fn last_check_at() -> Option<i64> {
    crate::update::number_setting(LAST_CHECK_KEY)
}

fn mark_checked() {
    let _ = crate::update::set_number_setting(LAST_CHECK_KEY, Some(now_ms()));
}

/// 启动时跑一次：没装就装、装了 v2 有新版就更新。失败只记日志，不打扰界面。
pub fn spawn_auto_update() {
    thread::spawn(|| {
        // 让页面先连上、先渲染；装完再让 bootstrap 自己重连（它每 5 秒重试一次）
        thread::sleep(Duration::from_secs(8));
        if !auto_update() {
            crate::append_log("[cli] 自动更新已关闭，跳过\n");
            return;
        }
        if is_busy() {
            return;
        }
        match crate::auth::locate() {
            None => {
                crate::append_log("[cli] 没找到 opencode，开始自动安装 v2…\n");
                match install() {
                    Ok(version) => crate::append_log(&format!("[cli] 自动安装完成：v{version}\n")),
                    Err(err) => crate::append_log(&format!("[cli] 自动安装失败：{err}\n")),
                }
            }
            Some(exe) => {
                // 装了就先看「上次检查是什么时候」：启动很频繁，没必要每次都问 GitHub。
                // 只读本机版本、不联网也要几分钟一次，6 小时内直接跳过。
                if let Some(last) = last_check_at() {
                    let elapsed = now_ms().saturating_sub(last);
                    if elapsed < AUTO_INTERVAL.as_millis() as i64 {
                        crate::append_log(&format!(
                            "[cli] 上次检查在 {} 分钟前，{} 小时内的自动检查跳过（面板里可手动检查）\n",
                            elapsed / 60_000,
                            AUTO_INTERVAL.as_secs() / 3600
                        ));
                        return;
                    }
                }
                let current = match installed_version() {
                    Ok(version) => version,
                    Err(err) => {
                        crate::append_log(&format!("[cli] 读本机版本失败：{err}\n"));
                        return;
                    }
                };
                let latest = match latest_release(false) {
                    Ok(latest) => latest,
                    Err(err) => {
                        crate::append_log(&format!("[cli] 查最新版本失败：{err}\n"));
                        return;
                    }
                };
                // 查成功才记账：网络不通时下次启动还会再试，不会被「刚查过」挡住
                mark_checked();
                if !needs_upgrade(&current, &latest.version) {
                    crate::append_log(&format!(
                        "[cli] opencode v{current} 已是最新（{}）\n",
                        exe.display()
                    ));
                    return;
                }
                crate::append_log(&format!(
                    "[cli] opencode v{current} → v{}，开始自动更新\n",
                    latest.version
                ));
                match install() {
                    Ok(version) => crate::append_log(&format!("[cli] 自动更新完成：v{version}\n")),
                    Err(err) => crate::append_log(&format!("[cli] 自动更新失败：{err}\n")),
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/// 组一次状态。`want_latest=false` 时**完全不联网**，只报本机情况——
/// 页面挂在顶栏上时用它，避免每次启动都去问 GitHub。
fn status_json(force_remote: bool, want_latest: bool) -> String {
    let located = crate::auth::locate();
    let installed = located.is_some();
    let path = located.map(|exe| exe.to_string_lossy().to_string());

    let mut version: Option<String> = None;
    let mut error: Option<String> = None;
    if installed {
        match installed_version() {
            Ok(found) => version = Some(found),
            Err(err) => error = Some(err),
        }
    }

    let mut latest: Option<String> = None;
    let mut size = 0u64;
    let mut notes = String::new();
    let mut url: Option<String> = None;
    let mut newer = false;
    if want_latest {
        match latest_release(force_remote) {
            Ok(release) => {
                newer = match version.as_deref() {
                    Some(current) => needs_upgrade(current, &release.version),
                    None => true,
                };
                latest = Some(release.version);
                size = release.size;
                notes = release.notes;
                url = Some(release.url);
            }
            Err(err) => {
                // 查不到最新版不该把「本机没装」的事实盖掉，两条信息都留着
                error = match error {
                    Some(own) => Some(format!("{own}；{err}")),
                    None => Some(err),
                };
            }
        }
    }

    let job = JOB.lock().map(|job| job.clone()).unwrap_or(Job {
        busy: false,
        phase: String::new(),
        done: 0,
        total: 0,
        error: None,
    });
    if job.error.is_some() {
        error = job.error.clone();
    }
    // 装完/换路径后 status 要反映新路径；`installed` 与版本一起重算，
    // 否则会出现「路径有了、状态还是未安装」这种自相矛盾的组合。
    let mut version_error: Option<String> = None;
    let (installed, path, version) = match crate::auth::locate().filter(|_| path.is_none()) {
        Some(exe) => {
            let fresh_path = exe.to_string_lossy().to_string();
            // 探测失败不能 `.ok()` 一吞了之：那样会 installed=true + version=null +
            // error=null，前端只能显示一句没头没尾的「版本读取失败」。
            let fresh_version = match installed_version() {
                Ok(value) => Some(value),
                Err(err) => {
                    version_error = Some(err);
                    version
                }
            };
            (true, Some(fresh_path), fresh_version)
        }
        None => (installed, path, version),
    };
    // 版本探测重新成功了，就把之前那条「读取失败」清掉；仍失败则补上原因
    match version_error {
        Some(err) => error = Some(err),
        None if installed && version.is_some() => {
            if error.as_deref().is_some_and(|text| text.contains("版本")) {
                error = None;
            }
        }
        None => {}
    }
    // 版本被刷新后 `newer` 必须跟着重算：否则刚装完还高亮「更新到 vX」。
    if let Some(current) = version.as_deref() {
        if let Some(latest_version) = latest.as_deref() {
            newer = needs_upgrade(current, latest_version);
        }
    }

    serde_json::json!({
        "supported": cfg!(windows),
        "installed": installed,
        "path": path,
        "version": version,
        "latest": latest,
        "newer": newer,
        "size": size,
        "notes": notes,
        "url": url,
        "autoUpdate": auto_update(),
        "busy": job.busy,
        "phase": job.phase,
        "done": job.done,
        "total": job.total,
        "error": error,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// HTTP 端点
// ---------------------------------------------------------------------------

fn json_respond(request: Request, status: u16, body: String) {
    let _ = crate::server::respond_json(request, status, body);
}

fn method_is(request: &Request, want: Method) -> bool {
    request.method() == &want
}

fn query_flag(url: &str, key: &str) -> bool {
    query_value(url, key).is_some_and(|value| matches!(value, "1" | "true" | "yes"))
}

/// 显式关闭的查询参数（`latest=0` / `false` / `no`）。
fn query_false(url: &str, key: &str) -> bool {
    query_value(url, key).is_some_and(|value| matches!(value, "0" | "false" | "no"))
}

fn query_value<'a>(url: &'a str, key: &str) -> Option<&'a str> {
    let (_, query) = url.split_once('?')?;
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if name == key {
            Some(value)
        } else {
            None
        }
    })
}

pub fn handle(request: Request, path: &str, url: &str) {
    match path {
        "/local/cli/status" => status_endpoint(request, url),
        "/local/cli/check" => check_endpoint(request),
        "/local/cli/install" => install_endpoint(request),
        "/local/cli/auto" => auto_endpoint(request),
        other => json_respond(
            request,
            404,
            serde_json::json!({ "error": format!("未知的 CLI 接口：{other}") }).to_string(),
        ),
    }
}

fn status_endpoint(request: Request, url: &str) {
    if !method_is(&request, Method::Get) {
        json_respond(
            request,
            405,
            serde_json::json!({ "error": "只支持 GET" }).to_string(),
        );
        return;
    }
    // `latest=0`：只报本机状态，不联网。顶栏挂载时用它，点开面板才问最新版。
    let want_latest = !query_false(url, "latest");
    json_respond(
        request,
        200,
        status_json(query_flag(url, "remote"), want_latest),
    );
}

/// 强制刷新「最新版本」（绕过 10 分钟缓存）。
fn check_endpoint(request: Request) {
    if !method_is(&request, Method::Post) {
        json_respond(
            request,
            405,
            serde_json::json!({ "error": "只支持 POST" }).to_string(),
        );
        return;
    }
    let Some((request, _body)) = read_body_with_timeout(request, 64 * 1024) else {
        return;
    };
    json_respond(request, 200, status_json(true, true));
}

fn install_endpoint(request: Request) {
    if !method_is(&request, Method::Post) {
        json_respond(
            request,
            405,
            serde_json::json!({ "error": "只支持 POST" }).to_string(),
        );
        return;
    }
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

    match install() {
        Ok(version) => json_respond(
            request,
            200,
            serde_json::json!({ "ok": true, "version": version }).to_string(),
        ),
        Err(err) => json_respond(
            request,
            500,
            serde_json::json!({ "error": err }).to_string(),
        ),
    }
}

fn auto_endpoint(request: Request) {
    if !method_is(&request, Method::Post) {
        json_respond(
            request,
            405,
            serde_json::json!({ "error": "只支持 POST" }).to_string(),
        );
        return;
    }
    let Some((request, body)) = read_body_with_timeout(request, 64 * 1024) else {
        return;
    };
    let text = match body {
        BodyRead::Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
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
    let Some(enabled) = parsed.get("enabled").and_then(|v| v.as_bool()) else {
        json_respond(
            request,
            400,
            serde_json::json!({ "error": "缺少 enabled（true/false）" }).to_string(),
        );
        return;
    };
    match save_auto(enabled) {
        Ok(()) => json_respond(request, 200, "{}".to_string()),
        Err(err) => json_respond(
            request,
            500,
            serde_json::json!({ "error": err }).to_string(),
        ),
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_version_from_cli_output() {
        assert_eq!(parse_version("opencode v2.2.5\n").as_deref(), Some("2.2.5"));
        assert_eq!(parse_version("2.2.7"), Some("2.2.7".to_string()));
        assert_eq!(parse_version("opencode v2.10.0 (windows)"), Some("2.10.0".to_string()));
        assert_eq!(parse_version("no version here"), None);
        // 日期不能被当成版本号
        assert_eq!(parse_version("2026-11-13"), None);
    }

    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("2.10.0", "2.9.9"));
        assert!(!is_newer("2.2.5", "2.2.5"));
        assert!(is_newer("2.2.7", "2.2.5"));
        assert!(!is_newer("1.19.5", "2.2.5"));
    }

    #[test]
    fn treats_v1_as_needing_install() {
        assert!(needs_upgrade("1.19.5", "2.2.7"));
        assert!(needs_upgrade("2.2.5", "2.2.7"));
        assert!(!needs_upgrade("2.2.7", "2.2.7"));
        assert!(is_v2("2.2.5"));
        assert!(!is_v2("1.19.5"));
    }

    #[test]
    fn accepts_only_v2_tags() {
        assert_eq!(v2_tag("v2.2.7").as_deref(), Some("2.2.7"));
        assert_eq!(v2_tag("2.2.7").as_deref(), Some("2.2.7"));
        assert_eq!(v2_tag("v1.19.5"), None);
        assert_eq!(v2_tag("process-daemon-v0.5.2"), None);
        assert_eq!(v2_tag("v2.2"), None);
        assert_eq!(v2_tag("v2.2.7-rc1"), None);
    }

    const LIST: &str = r#"[
      {"tag_name":"process-daemon-v0.5.2","draft":false,"prerelease":false,
       "assets":[{"name":"opencode-pty-0.5.2-x86_64-pc-windows-msvc.tar.gz","browser_download_url":"https://x/pty.tgz","size":10}]},
      {"tag_name":"v2.2.7","draft":false,"prerelease":false,"body":"修了什么",
       "assets":[
         {"name":"opencode-windows-arm64.zip","browser_download_url":"https://x/arm.zip","size":30},
         {"name":"opencode-windows-x64-baseline.zip","browser_download_url":"https://x/base.zip","size":20},
         {"name":"opencode-windows-x64.zip","browser_download_url":"https://x/x64.zip","size":40}]},
      {"tag_name":"v2.9.0","draft":false,"prerelease":true,
       "assets":[{"name":"opencode-windows-x64.zip","browser_download_url":"https://x/pre.zip","size":41}]},
      {"tag_name":"v2.2.6","draft":false,"prerelease":false,
       "assets":[{"name":"opencode-windows-x64.zip","browser_download_url":"https://x/old.zip","size":39}]}
    ]"#;

    #[test]
    fn picks_newest_stable_v2_for_arch() {
        let latest = pick_latest(LIST, "x86_64").expect("应该挑到 v2.2.7");
        assert_eq!(latest.version, "2.2.7");
        assert_eq!(latest.url, "https://x/x64.zip");
        assert_eq!(latest.size, 40);
        assert_eq!(latest.notes, "修了什么");

        let arm = pick_latest(LIST, "aarch64").expect("arm64 也要能挑到");
        assert_eq!(arm.url, "https://x/arm.zip");
    }

    #[test]
    fn falls_back_to_baseline_when_plain_missing() {
        let text = r#"[
          {"tag_name":"v2.3.0","draft":false,"prerelease":false,
           "assets":[{"name":"opencode-windows-x64-baseline.zip","browser_download_url":"https://x/base.zip","size":20}]}
        ]"#;
        let latest = pick_latest(text, "x86_64").expect("应该退到 baseline 包");
        assert_eq!(latest.asset, "opencode-windows-x64-baseline.zip");
    }

    #[test]
    fn reports_missing_windows_package() {
        let text = r#"[
          {"tag_name":"v2.4.0","draft":false,"prerelease":false,
           "assets":[{"name":"opencode-darwin-arm64.zip","browser_download_url":"https://x/mac.zip","size":1}]}
        ]"#;
        let err = pick_latest(text, "x86_64").expect_err("没有 Windows 包就该报错");
        assert!(err.contains("Windows"), "错误信息要说明缺 Windows 包：{err}");
    }

    /// 临时目录：每个测试一个，跑完自己清。
    fn temp_dir(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("oc-cli-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("建临时目录");
        base
    }

    #[test]
    fn finds_exe_in_nested_extract_output() {
        let dir = temp_dir("find");
        let nested = dir.join("opencode-windows-x64").join("bin");
        fs::create_dir_all(&nested).expect("建嵌套目录");
        fs::write(nested.join("opencode.exe"), b"MZ").expect("写假 exe");
        fs::write(dir.join("README.md"), b"x").expect("写无关文件");

        let found = find_exe(&dir, 3).expect("应该能在嵌套目录里找到");
        assert_eq!(found, nested.join("opencode.exe"));
        // 深度 0 只看顶层，不该再往里翻
        assert!(find_exe(&dir, 0).is_none());
    }

    #[test]
    fn replace_keeps_backup_and_overwrites_target() {
        let dir = temp_dir("replace");
        let target = dir.join("opencode.exe");
        let fresh = dir.join("new.exe");
        fs::write(&target, b"OLD-BINARY").expect("写旧文件");
        fs::write(&fresh, b"NEW-BINARY").expect("写新文件");

        replace_exe(&fresh, &target, "2.2.7").expect("替换应该成功");
        assert_eq!(fs::read(&target).expect("读新文件"), b"NEW-BINARY");
        let backup = backup_name(&target, "2.2.7");
        assert_eq!(fs::read(&backup).expect("读备份"), b"OLD-BINARY");
        assert!(backup.to_string_lossy().contains("bak-2.2.7"));
    }

    #[test]
    fn replace_creates_missing_target_dir() {
        let dir = temp_dir("replace-new");
        let target = dir.join("bin").join("opencode.exe");
        let fresh = dir.join("new.exe");
        fs::write(&fresh, b"FRESH").expect("写新文件");
        replace_exe(&fresh, &target, "2.2.7").expect("目录不存在也要能装上");
        assert_eq!(fs::read(&target).expect("读新文件"), b"FRESH");
    }

    /// 版本探测必须遵守「脚本 shim 要经 cmd」：这正是面板显示
    /// 「已安装，版本读取失败」+ os error 193 的根因。
    ///
    /// 用 .cmd 测是因为真实场景里 npm 落的就是这套（opencode / opencode.cmd /
    /// opencode.ps1 三份），而定位层已经把无扩展名那个换成了 .cmd。
    #[test]
    fn version_probe_goes_through_cmd_for_shim() {
        let dir = temp_dir("cli-shim");
        let script = dir.join("opencode.cmd");
        fs::write(&script, b"@echo opencode v2.3.0\r\n").expect("写假 shim");
        let found = exe_version(&script).expect("shim 也要能读到版本");
        assert_eq!(found, "2.3.0");
        let _ = fs::remove_dir_all(&dir);
    }
}
