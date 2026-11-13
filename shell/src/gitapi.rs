//! Git 面板后端（`/local/git/*`）：只做初始化 / 状态 / 提交 / 推送 / 回滚 / 排除。
//!
//! 与 `/local/fs/*` 共用一条通道：Host + `x-oc-token` 已经在 [`crate::server`] 里统一校验，
//! 这里不再查 token。也不引 git2 —— 全部走 `std::process::Command` 调系统 git，行为与
//! 用户在命令行里看到的一致（尤其是 stderr 原文要透传给界面）。
//!
//! 三个硬约定：
//!   * 每条子命令前统一插 `-c core.quotepath=false`，否则中文文件名会变成八进制转义；
//!   * 状态类输出统一 `-z` 读，按 `\0` 切 —— 空格、引号、中文都不会把解析搞崩；
//!   * 子进程一律隐藏窗口（`CREATE_NO_WINDOW`），否则每次 git 调用都会闪一下黑框。
//!
//! 超时：`std::process::Command` 没有内建超时，这里用「子线程 `wait_with_output` +
//! `mpsc::recv_timeout`」计时，超时按 PID `taskkill /T /F` 整棵树（子进程已经被 move 进
//! 子线程，拿不回 `Child` 了）。判据和 [`crate::body`] 读请求体是同一套思路。
//!
//! 错误统一 `{ error, status }`，`error` 优先透传 git 的 stderr（Windows 下可能是 GBK，
//! 走 `from_utf8_lossy`，花一点也不能 panic）。

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tiny_http::Request;

use crate::body::{read_body_with_timeout, BodyRead};
use crate::fsutil::{param, param_u64, parse_query};
use crate::server::{json_error, respond_json};

/// POST 请求体上限：只有路径数组和提交说明，1MB 绰绰有余。
const BODY_LIMIT: usize = 1024 * 1024;
/// 只读类子命令的超时。
const TIMEOUT_FAST: Duration = Duration::from_secs(30);
/// 会写 index / 提交的超时。
const TIMEOUT_WRITE: Duration = Duration::from_secs(60);
/// 要走网络的超时。
const TIMEOUT_PUSH: Duration = Duration::from_secs(180);
/// 回给前端的 git 输出上限（push 的进度输出可能很长）。
const OUTPUT_LIMIT: usize = 4000;
/// 环境变量：显式指定 git 可执行文件（路径或命令名）。
///
/// 没这个口子的话，「装在非默认位置」的机器就永远只能用 PATH——
/// 而 Git for Windows 的安装器并不保证把 `cmd` 目录加进 PATH。
pub const GIT_ENV: &str = "OC_WORKBENCH_GIT";
/// 探测结果缓存：`None` = 还没找过；`Some(None)` = 找过但没有（没装）。
///
/// 不能把「没找到」永久缓存成「永远找不到」——用户装完 git 回来点重试，
/// 或者插上一个绿色版，应该立刻能用。所以在 [`resolve_git`] 里只缓存成功。
static GIT_FOUND: Mutex<Option<PathBuf>> = Mutex::new(None);
/// 历史默认条数与上限（契约 §1：默认 50、上限 200）。
const LOG_LIMIT_DEFAULT: u64 = 50;
const LOG_LIMIT_MAX: u64 = 200;
/// `init` 顺手写的基础排除规则。
const DEFAULT_GITIGNORE: [&str; 7] = [
    "node_modules/",
    "dist/",
    ".tmp/",
    "*.log",
    ".DS_Store",
    "target/",
    ".vite/",
];
/// 目录列表里永远不出现：`.git` 本身不能给用户点「排除」。
const TREE_SKIP: [&str; 1] = [".git"];
/// 重目录：只列到上一级，不再往下展开（用户要排除的是整个目录）。
const TREE_HEAVY: [&str; 4] = ["node_modules", "dist", "target", ".vite"];

/// Windows 的 CREATE_NO_WINDOW：GUI 进程起控制台子进程时不要弹黑窗。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 统一的错误形状：HTTP 状态码 + 中文文案（文案里通常已经是 git 的 stderr 原文）。
#[derive(Debug)]
struct GitError {
    code: u16,
    message: String,
}

impl GitError {
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
    let action = path.rsplit('/').next().unwrap_or("");
    let root = param(&pairs, "root").unwrap_or("").trim().to_string();

    let post_only = matches!(
        action,
        "init" | "commit" | "push" | "rollback" | "discard" | "ignore" | "remote"
    );
    let method_ok = if post_only {
        request.method().as_str().eq_ignore_ascii_case("POST")
    } else {
        request.method().as_str().eq_ignore_ascii_case("GET")
    };
    if !method_ok {
        let message = if post_only {
            "这个接口只支持 POST"
        } else {
            "这个接口只支持 GET"
        };
        let _ = json_error(request, 405, message);
        return;
    }

    if root.is_empty() {
        let _ = json_error(request, 400, "缺少 root 参数");
        return;
    }
    if !Path::new(&root).is_dir() {
        let _ = json_error(request, 400, &format!("目录不存在：{root}"));
        return;
    }

    match action {
        "status" => status(request, &root),
        "log" => log(request, &root, &pairs),
        "tree" => tree(request, &root, &pairs),
        "init" => init(request, &root),
        "commit" => commit(request, &root),
        "push" => push(request, &root),
        "rollback" => rollback(request, &root),
        "discard" => discard(request, &root),
        "ignore" => ignore(request, &root),
        "remote" => remote(request, &root),
        _ => {
            let _ = json_error(request, 404, "未知的 git 接口");
        }
    }
}

// ---------- 子进程封装 ----------

struct GitOutput {
    ok: bool,
    stdout: Vec<u8>,
    stderr: String,
}

impl GitOutput {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    /// 失败文案：优先透传 git 的 stderr，没有才用手写兜底。
    fn failure(&self, fallback: &str) -> String {
        let stderr = self.stderr.trim();
        if stderr.is_empty() {
            fallback.to_string()
        } else {
            truncate(stderr, OUTPUT_LIMIT)
        }
    }
}

// ---------- 定位 git ----------
//
// 为什么不能直接 `Command::new("git")`：Git for Windows 装完**不保证**把 `cmd`
// 加进 PATH（安装向导里的「只在 Git Bash 用」选项就会这样），换台机器就变成
// 「400 找不到 git 命令：program not found」。这里按 opencode 的老办法：
// 显式环境变量 → PATH → 逐个已知安装位置。

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|value| !value.as_os_str().is_empty())
}

/// 用 `where` 在 PATH 上找。必须自带超时：PATH 里有不可达的网络共享时会卡很久。
fn where_lookup(name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut child = Command::new("where")
            .arg(name)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        return None;
                    }
                    let mut buf = Vec::new();
                    child.stdout.take()?.read_to_end(&mut buf).ok()?;
                    return String::from_utf8_lossy(&buf)
                        .lines()
                        .map(|line| PathBuf::from(line.trim()))
                        .find(|path| path.is_file());
                }
                Ok(None) => {}
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
    #[cfg(not(windows))]
    {
        let _ = name;
        None
    }
}

/// GitHub Desktop 自带一份 git（`%LOCALAPPDATA%\GitHubDesktop\app-<版本>\resources\app\git`）。
/// 目录名带版本号，要倒序取最新的，否则可能挑到升级前的旧副本。
fn github_desktop_git(local: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(local.join("GitHubDesktop")) else {
        return Vec::new();
    };
    let mut apps: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("app-"))
        .map(|entry| entry.path())
        .collect();
    apps.sort();
    apps.reverse();
    apps.into_iter()
        .map(|app| {
            app.join("resources")
                .join("app")
                .join("git")
                .join("cmd")
                .join("git.exe")
        })
        .collect()
}

/// PATH 之外的常见安装位置，按「最可能命中」排序。
fn git_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    // 绿色版：把 git 丢在工作台 exe 旁边，或旁边建个 git 目录
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        out.push(dir.join("git.exe"));
        out.push(dir.join("git").join("cmd").join("git.exe"));
    }
    if let Some(program_files) = env_path("ProgramFiles") {
        out.push(program_files.join("Git").join("cmd").join("git.exe"));
        out.push(program_files.join("Git").join("bin").join("git.exe"));
    }
    if let Some(program_files) = env_path("ProgramFiles(x86)") {
        out.push(program_files.join("Git").join("cmd").join("git.exe"));
    }
    if let Some(local) = env_path("LOCALAPPDATA") {
        out.push(local.join("Programs").join("Git").join("cmd").join("git.exe"));
        out.push(local.join("Programs").join("Git").join("bin").join("git.exe"));
        out.extend(github_desktop_git(&local));
    }
    if let Some(home) = env_path("USERPROFILE") {
        out.push(home.join("scoop").join("shims").join("git.exe"));
        out.push(
            home.join("scoop")
                .join("apps")
                .join("git")
                .join("current")
                .join("cmd")
                .join("git.exe"),
        );
    }
    out.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin\git.exe"));
    out
}

/// 已缓存的 git 路径（只缓存成功；没装时每次都会重新找，装完立刻可用）。
pub fn resolve_git() -> Option<PathBuf> {
    if let Ok(guard) = GIT_FOUND.lock() {
        if let Some(hit) = guard.as_ref() {
            return Some(hit.clone());
        }
    }
    let found = resolve_git_uncached();
    if let Some(hit) = found.as_ref() {
        if let Ok(mut guard) = GIT_FOUND.lock() {
            *guard = Some(hit.clone());
        }
    }
    found
}

fn resolve_git_uncached() -> Option<PathBuf> {
    // 显式指定优先；指到不存在的路径时继续往下找，不能因为一条错配置就判定「没有 git」
    if let Some(raw) = env_path(GIT_ENV) {
        if raw.is_file() {
            return Some(raw);
        }
        if let Some(found) = where_lookup(&raw.to_string_lossy()) {
            return Some(found);
        }
    }
    if let Some(found) = where_lookup("git") {
        return Some(found);
    }
    git_candidates().into_iter().find(|path| path.is_file())
}

/// 找不到 git 时的错误：把查过的位置和下一步都说清楚，别只甩一句 program not found。
pub fn missing_git() -> GitError {
    GitError::new(
        400,
        format!(
            "这台电脑上找不到 git。已查过：PATH、程序所在目录、Program Files\\Git、\
             %LOCALAPPDATA%\\Programs\\Git、scoop、GitHub Desktop 自带的 git。\
             装一个 Git for Windows（https://git-scm.com/download/win）后点「刷新」即可；\
             已经装了但不在这些位置，就设环境变量 {GIT_ENV} 指向 git.exe。"
        ),
    )
}

fn run_git(root: &str, args: &[&str], timeout: Duration) -> Result<GitOutput, GitError> {
    run_git_with_input(root, args, timeout, None)
}

/// 跑一条 git 子命令。`input` 非空时从 stdin 灌进去（`check-ignore --stdin` 用）。
fn run_git_with_input(
    root: &str,
    args: &[&str],
    timeout: Duration,
    input: Option<Vec<u8>>,
) -> Result<GitOutput, GitError> {
    let program = resolve_git().ok_or_else(missing_git)?;
    let mut cmd = Command::new(program);
    // quotepath 必须放在子命令之前，否则中文路径会变成 \344\270\255 这种八进制转义。
    cmd.arg("-c").arg("core.quotepath=false");
    for arg in args {
        cmd.arg(arg);
    }
    cmd.current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|err| GitError::new(500, format!("启动 git 失败：{err}")))?;
    let pid = child.id();

    if let Some(bytes) = input {
        if let Some(mut stdin) = child.stdin.take() {
            // 输入很小，但仍然放子线程：子进程提前退出时写管道不能把请求线程卡住。
            thread::spawn(move || {
                let _ = stdin.write_all(&bytes);
            });
        }
    }

    // wait_with_output 要吃掉 Child，所以超时只能按 PID 杀，不能调 child.kill()。
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(child.wait_with_output());
    });

    match receiver.recv_timeout(timeout) {
        Ok(Ok(output)) => Ok(GitOutput {
            ok: output.status.success(),
            stdout: output.stdout,
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        }),
        Ok(Err(err)) => Err(GitError::new(500, format!("执行 git 失败：{err}"))),
        Err(_) => {
            kill_tree(pid);
            Err(GitError::new(
                504,
                format!("git 超过 {} 秒没有结束，已终止", timeout.as_secs()),
            ))
        }
    }
}

/// 按 PID 杀整棵树：git 可能派生子进程（push 走 ssh / credential helper）。
#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;

    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(windows))]
fn kill_tree(pid: u32) {
    let _ = Command::new("kill")
        .args(["-9", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn run_git_owned(root: &str, args: &[String], timeout: Duration) -> Result<GitOutput, GitError> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(root, &refs, timeout)
}

// ---------- 请求体 ----------

/// 读 JSON 请求体。`None` = 已经回过错误（或读超时，连接已放弃），调用方直接 return。
fn read_json_body(request: Request) -> Option<(Request, Value)> {
    let (request, body) = read_body_with_timeout(request, BODY_LIMIT)?;
    let bytes = match body {
        BodyRead::Ok(bytes) => bytes,
        BodyRead::TooLarge => {
            let _ = json_error(request, 413, "请求体太大，上限 1MB");
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

fn string_list(body: &Value, key: &str) -> Vec<String> {
    body.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out: String = text.chars().take(limit).collect();
    out.push_str("...");
    out
}

// ---------- 仓库判定与路径 ----------

/// `git rev-parse --show-toplevel`：只在 root 本身就是仓库根时返回路径。
///
/// root 是某个仓库的子目录时也能量出 toplevel，但 porcelain 给出的路径是相对仓库根的，
/// 会破坏「路径相对 root」的约定，所以那种情况按「未初始化」处理。
fn repo_root(root: &str) -> Option<String> {
    let out = run_git(root, &["rev-parse", "--show-toplevel"], TIMEOUT_FAST).ok()?;
    if !out.ok {
        return None;
    }
    let text = out.text().trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn repo_initialized(root: &str) -> bool {
    match repo_root(root) {
        // 先比字面量；不一致时再 canonicalize 一次。
        //
        // `git rev-parse --show-toplevel` 返回「长名」路径，而调用方手里的 root
        // 可能是 8.3 短名（例如 CI 上的 C:\Users\RUNNER~1\...）或带 \?\ 前缀的
        // canonical 形式——只比字面量会误判成「未初始化」。
        // canonicalize 落在失败分支上，正常路径不会多一次 IO。
        Some(toplevel) => {
            same_dir(&toplevel, root) || same_dir(&canonical_dir(&toplevel), &canonical_dir(root))
        }
        None => false,
    }
}

/// 取目录的规范路径；拿不到就原样返回（比较函数自己会兜底）。
fn canonical_dir(path: &str) -> String {
    std::fs::canonicalize(path)
        .map(|resolved| resolved.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string())
}

/// 目录比较：抹掉 `\\?\` 前缀、统一分隔符与大小写、去掉结尾分隔符。
fn normalize_dir(path: &str) -> String {
    let mut text = path.trim().trim_matches('"').replace('/', "\\");
    if let Some(rest) = text.strip_prefix("\\\\?\\") {
        text = rest.to_string();
    }
    if let Some(rest) = text.strip_prefix("\\\\.\\") {
        text = rest.to_string();
    }
    while text.len() > 1 && text.ends_with('\\') {
        text.pop();
    }
    text.to_lowercase()
}

fn same_dir(a: &str, b: &str) -> bool {
    normalize_dir(a) == normalize_dir(b)
}

fn current_branch(root: &str) -> String {
    match run_git(root, &["symbolic-ref", "--short", "HEAD"], TIMEOUT_FAST) {
        Ok(out) if out.ok => out.text().trim().to_string(),
        _ => String::new(),
    }
}

/// 校验一条「相对 root」的路径：拒绝空、绝对路径、盘符、`..`，统一成 `\` 分隔。
fn check_rel(raw: &str) -> Result<String, GitError> {
    let text = raw.trim().trim_matches('"');
    if text.is_empty() {
        return Err(GitError::new(400, "路径不能为空"));
    }
    if text.starts_with('\\') || text.starts_with('/') {
        return Err(GitError::new(400, "路径必须是相对 root 的相对路径"));
    }
    if text.len() >= 2 && text.as_bytes()[1] == b':' {
        return Err(GitError::new(400, "路径不允许包含盘符"));
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in text.split(['\\', '/']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(GitError::new(400, "路径不允许包含 .."));
        }
        if part.contains(':') {
            return Err(GitError::new(400, "路径不允许包含盘符"));
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return Err(GitError::new(400, "路径不能为空"));
    }
    Ok(parts.join("\\"))
}

/// 把相对路径拼到 root 下。逐段拒绝 `..`，不做 canonicalize（目标可能已经被删掉）。
fn join_inside(root: &str, rel: &str) -> Result<PathBuf, GitError> {
    let mut joined = PathBuf::from(root);
    for part in rel.split('\\') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(GitError::new(400, "路径不允许包含 .."));
        }
        joined.push(part);
    }
    Ok(joined)
}

// ---------- GET /local/git/status ----------

fn status(request: Request, root: &str) {
    match collect_status(root) {
        Ok(body) => {
            let _ = respond_json(request, 200, body.to_string());
        }
        Err(err) => {
            let _ = json_error(request, err.code, &err.message);
        }
    }
}

fn empty_status() -> Value {
    json!({
        "initialized": false,
        "branch": "",
        "remote": "",
        "upstream": "",
        "ahead": 0,
        "behind": 0,
        "detached": false,
        "files": [],
        "lastCommit": null,
        "gitignore": [],
    })
}

fn collect_status(root: &str) -> Result<Value, GitError> {
    if !repo_initialized(root) {
        // 未初始化不报错：前端靠这个字段决定显示「一键初始化」还是正常面板。
        return Ok(empty_status());
    }

    let (branch, detached) = match run_git(root, &["symbolic-ref", "--short", "HEAD"], TIMEOUT_FAST)
    {
        Ok(out) if out.ok => (out.text().trim().to_string(), false),
        _ => (String::new(), true),
    };

    let remote = run_git(root, &["config", "--get", "remote.origin.url"], TIMEOUT_FAST)
        .ok()
        .filter(|out| out.ok)
        .map(|out| out.text().trim().to_string())
        .unwrap_or_default();

    let upstream = run_git(
        root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        TIMEOUT_FAST,
    )
    .ok()
    .filter(|out| out.ok)
    .map(|out| out.text().trim().to_string())
    .filter(|name| !name.is_empty());

    let mut ahead: i64 = 0;
    let mut behind: i64 = 0;
    if upstream.is_some() {
        if let Ok(out) = run_git(
            root,
            &["rev-list", "--left-right", "--count", "@{u}...HEAD"],
            TIMEOUT_FAST,
        ) {
            if out.ok {
                // 左 = 只有上游有（behind），右 = 只有本地有（ahead）
                let text = out.text();
                let mut parts = text.split_whitespace();
                behind = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                ahead = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            }
        }
    }

    let status_out = run_git(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        TIMEOUT_FAST,
    )?;
    if !status_out.ok {
        return Err(GitError::new(
            500,
            status_out.failure("读取仓库状态失败"),
        ));
    }
    let files: Vec<Value> = parse_porcelain(&status_out.stdout)
        .iter()
        .map(change_json)
        .collect();

    let last_commit = run_git(
        root,
        &["log", "-1", "--format=%H%x00%h%x00%s%x00%an%x00%at"],
        TIMEOUT_FAST,
    )
    .ok()
    .filter(|out| out.ok)
    .and_then(|out| parse_commit_line(&out.text()))
    .unwrap_or(Value::Null);

    let gitignore = read_gitignore(Path::new(root));

    let mut body = json!({
        "initialized": true,
        "branch": branch,
        "remote": remote,
        "upstream": upstream.clone().unwrap_or_default(),
        "ahead": ahead,
        "behind": behind,
        "detached": detached,
        "files": files,
        "lastCommit": last_commit,
        "gitignore": gitignore,
    });
    if upstream.is_none() {
        body["noUpstream"] = json!(true);
    }
    Ok(body)
}

// ---------- porcelain 解析（纯函数，便于单测） ----------

/// porcelain v1 的一条记录。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Change {
    path: String,
    status: &'static str,
    staged: bool,
    worktree_dirty: bool,
    renamed_from: Option<String>,
}

/// 解析 `git status --porcelain -z`。
///
/// `-z` 下 rename/copy 的两条路径是「新路径\0旧路径」（与非 -z 的 `旧 -> 新` 相反）。
fn parse_porcelain(bytes: &[u8]) -> Vec<Change> {
    let mut tokens = bytes.split(|byte| *byte == 0).filter(|token| !token.is_empty());
    let mut out = Vec::new();

    while let Some(token) = tokens.next() {
        // 最少 "XY p" 四个字节
        if token.len() < 4 {
            continue;
        }
        let x = token[0];
        let y = token[1];
        let path = String::from_utf8_lossy(&token[3..]).replace('/', "\\");

        let renamed = matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C');
        let renamed_from = if renamed {
            tokens
                .next()
                .map(|old| String::from_utf8_lossy(old).replace('/', "\\"))
        } else {
            None
        };

        let conflicted = matches!(
            (x, y),
            (b'U', b'U')
                | (b'A', b'A')
                | (b'D', b'D')
                | (b'A', b'U')
                | (b'U', b'A')
                | (b'D', b'U')
                | (b'U', b'D')
                | (b'A', b'D')
                | (b'D', b'A')
        );

        let status = if conflicted {
            "conflicted"
        } else if x == b'?' {
            "untracked"
        } else if x != b' ' {
            change_of(x)
        } else {
            change_of(y)
        };

        out.push(Change {
            path,
            status,
            // X 非空且非 `?` = 已进 index；X 与 Y 同时非空且不是 `??` = 工作区又有新改动（MM/AM）
            staged: x != b' ' && x != b'?',
            worktree_dirty: x != b' ' && x != b'?' && y != b' ',
            renamed_from,
        });
    }
    out
}

fn change_of(code: u8) -> &'static str {
    match code {
        b'A' => "added",
        b'D' => "deleted",
        b'R' => "renamed",
        // 复制在契约里没有单独类型，按新增算
        b'C' => "added",
        b'?' => "untracked",
        b'U' => "conflicted",
        // M / T（类型变化）/ 其它一律按修改
        _ => "modified",
    }
}

fn change_json(change: &Change) -> Value {
    let mut value = json!({
        "path": change.path,
        "status": change.status,
        "staged": change.staged,
        "worktreeDirty": change.worktree_dirty,
    });
    if let Some(from) = &change.renamed_from {
        value["renamedFrom"] = json!(from);
    }
    value
}

// ---------- .gitignore ----------

/// `.gitignore` 的有效行：去掉空行与 `#` 注释，保留原样（含结尾 `/`）。
fn gitignore_lines(text: &str) -> Vec<String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    text.lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect()
}

fn read_gitignore(dir: &Path) -> Vec<String> {
    fs::read(dir.join(".gitignore"))
        .map(|bytes| gitignore_lines(&String::from_utf8_lossy(&bytes)))
        .unwrap_or_default()
}

/// 把一条相对路径转成 gitignore 规则：目录 → `path/`，文件 → `path`。
fn gitignore_rule(root: &str, raw: &str) -> Result<String, GitError> {
    let text = raw.trim();
    let ends_with_sep = text.ends_with('\\') || text.ends_with('/');
    let rel = check_rel(text)?;
    let is_dir = ends_with_sep || join_inside(root, &rel).map(|p| p.is_dir()).unwrap_or(false);
    let slash = rel.replace('\\', "/");
    Ok(if is_dir {
        format!("{slash}/")
    } else {
        slash
    })
}

/// 两条规则是否等价（分隔符与结尾 `/` 不敏感）。
fn same_rule(line: &str, rule: &str) -> bool {
    let normalize = |text: &str| {
        text.trim()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string()
    };
    normalize(line) == normalize(rule)
}

// ---------- POST /local/git/init ----------

fn init(request: Request, root: &str) {
    match init_inner(root) {
        Ok(body) => {
            let _ = respond_json(request, 200, body.to_string());
        }
        Err(err) => {
            let _ = json_error(request, err.code, &err.message);
        }
    }
}

fn init_inner(root: &str) -> Result<Value, GitError> {
    if repo_initialized(root) {
        return Ok(json!({
            "ok": true,
            "branch": current_branch(root),
            "alreadyInitialized": true,
        }));
    }

    // git >= 2.28 支持 `init -b`；老版本不认这个参数，退回 init + symbolic-ref。
    let first = run_git(root, &["init", "-b", "main"], TIMEOUT_WRITE)?;
    if !first.ok {
        let second = run_git(root, &["init"], TIMEOUT_WRITE)?;
        if !second.ok {
            return Err(GitError::new(500, second.failure("初始化仓库失败")));
        }
        let head = run_git(
            root,
            &["symbolic-ref", "HEAD", "refs/heads/main"],
            TIMEOUT_WRITE,
        )?;
        if !head.ok {
            return Err(GitError::new(500, head.failure("设置默认分支失败")));
        }
    }

    write_default_gitignore(Path::new(root))?;

    Ok(json!({
        "ok": true,
        "branch": current_branch(root),
        "alreadyInitialized": false,
    }))
}

/// 只在 `.gitignore` 不存在时写一份基础规则。
fn write_default_gitignore(dir: &Path) -> Result<(), GitError> {
    let file = dir.join(".gitignore");
    if file.exists() {
        return Ok(());
    }
    let text = format!("{}\n", DEFAULT_GITIGNORE.join("\n"));
    fs::write(&file, text).map_err(|err| GitError::new(500, format!("写入 .gitignore 失败：{err}")))
}

// ---------- POST /local/git/commit ----------

fn commit(request: Request, root: &str) {
    let Some((request, body)) = read_json_body(request) else {
        return;
    };
    match commit_inner(root, &body) {
        Ok(value) => {
            let _ = respond_json(request, 200, value.to_string());
        }
        Err(err) => {
            let _ = json_error(request, err.code, &err.message);
        }
    }
}

fn commit_inner(root: &str, body: &Value) -> Result<Value, GitError> {
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if message.is_empty() {
        return Err(GitError::new(400, "提交说明不能为空"));
    }

    let mut paths: Vec<String> = Vec::new();
    for raw in string_list(body, "paths") {
        let rel = check_rel(&raw)?;
        if !paths.contains(&rel) {
            paths.push(rel);
        }
    }

    // 暂存：空数组 = 全部；非空 = 只暂存这些路径（-A 能带上删除）
    let mut add: Vec<String> = vec!["add".into(), "-A".into()];
    if !paths.is_empty() {
        add.push("--".into());
        add.extend(paths.iter().cloned());
    }
    let added = run_git_owned(root, &add, TIMEOUT_WRITE)?;
    if !added.ok {
        return Err(GitError::new(500, added.failure("暂存改动失败")));
    }

    // 没有任何暂存内容就别调 commit，否则 git 会吐一堆英文
    let staged = run_git(root, &["diff", "--cached", "--name-only", "-z"], TIMEOUT_FAST)?;
    if !staged.ok {
        return Err(GitError::new(500, staged.failure("读取暂存区失败")));
    }
    if staged.stdout.is_empty() {
        return Err(GitError::new(409, "没有可提交的改动"));
    }

    let mut args: Vec<String> = vec!["commit".into(), "-m".into(), message];
    if !paths.is_empty() {
        args.push("--".into());
        args.extend(paths.iter().cloned());
    }
    let committed = run_git_owned(root, &args, TIMEOUT_WRITE)?;
    if !committed.ok {
        return Err(GitError::new(500, committed.failure("提交失败")));
    }

    let head = run_git(root, &["rev-parse", "HEAD"], TIMEOUT_FAST)?;
    if !head.ok {
        return Err(GitError::new(500, head.failure("提交成功但读不到提交号")));
    }
    let hash = head.text().trim().to_string();
    let short: String = hash.chars().take(7).collect();

    // 本次提交实际涉及的文件数（rename 会算两条，够用了）
    let shown = run_git(root, &["show", "--name-only", "--format=", "HEAD"], TIMEOUT_FAST)?;
    let count = if shown.ok {
        shown
            .text()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count()
    } else {
        0
    };

    Ok(json!({ "ok": true, "hash": hash, "short": short, "count": count }))
}

// ---------- POST /local/git/push ----------

fn push(request: Request, root: &str) {
    let Some((request, body)) = read_json_body(request) else {
        return;
    };
    match push_inner(root, &body) {
        Ok(value) => {
            let _ = respond_json(request, 200, value.to_string());
        }
        Err(err) => {
            let _ = json_error(request, err.code, &err.message);
        }
    }
}

fn push_inner(root: &str, body: &Value) -> Result<Value, GitError> {
    let set_upstream = body
        .get("setUpstream")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let origin = run_git(root, &["config", "--get", "remote.origin.url"], TIMEOUT_FAST)
        .ok()
        .filter(|out| out.ok)
        .map(|out| out.text().trim().to_string())
        .unwrap_or_default();
    if origin.is_empty() {
        return Err(GitError::new(400, "还没设置远程仓库，先填一个地址"));
    }

    let branch = current_branch(root);
    let upstream = run_git(
        root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        TIMEOUT_FAST,
    )
    .ok()
    .filter(|out| out.ok)
    .map(|out| out.text().trim().to_string())
    .filter(|name| !name.is_empty());

    let mut args: Vec<String> = vec!["push".into()];
    if upstream.is_none() {
        if branch.is_empty() {
            return Err(GitError::new(400, "当前不在任何分支上，无法推送"));
        }
        if set_upstream {
            args.push("-u".into());
        }
        args.push("origin".into());
        args.push(branch.clone());
    }

    let out = run_git_owned(root, &args, TIMEOUT_PUSH)?;
    let output = truncate(&format!("{}{}", out.text(), out.stderr), OUTPUT_LIMIT);
    if !out.ok {
        // 认证失败 / 非快进 / 网络不通：原文给用户，别吞
        return Err(GitError::new(502, out.failure("推送失败")));
    }
    Ok(json!({ "ok": true, "branch": branch, "output": output }))
}

// ---------- GET /local/git/log ----------

fn log(request: Request, root: &str, pairs: &[(String, String)]) {
    let limit = param_u64(pairs, "limit")
        .unwrap_or(LOG_LIMIT_DEFAULT)
        .clamp(1, LOG_LIMIT_MAX);
    match collect_log(root, limit) {
        Ok(value) => {
            let _ = respond_json(request, 200, value.to_string());
        }
        Err(err) => {
            let _ = json_error(request, err.code, &err.message);
        }
    }
}

fn collect_log(root: &str, limit: u64) -> Result<Value, GitError> {
    // 空仓库（还没有提交）不报错，直接给契约 §1 的空结构
    let head_ref = run_git(root, &["rev-parse", "--verify", "--quiet", "HEAD"], TIMEOUT_FAST);
    if !matches!(head_ref, Ok(ref out) if out.ok) {
        return Ok(empty_log());
    }

    let count = limit.to_string();
    let out = run_git(
        root,
        &[
            "log",
            "--all",
            "--date-order",
            "-n",
            &count,
            "--format=%H%x00%h%x00%P%x00%s%x00%an%x00%at%x00%D",
        ],
        TIMEOUT_FAST,
    )?;
    if !out.ok {
        return Err(GitError::new(500, out.failure("读取历史失败")));
    }
    let commits = parse_log_z(&out.text());

    // 一次 for-each-ref 拿全局部 / 远程 / 标签，绝不对每条分支再调一次 git
    let refs_out = run_git(
        root,
        &[
            "for-each-ref",
            "--format=%(refname:short)%00%(objectname)%00%(refname)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
        TIMEOUT_FAST,
    )?;
    let branches = if refs_out.ok {
        parse_branches(&refs_out.text())
    } else {
        Vec::new()
    };

    let head = current_branch(root);
    let detached = head.is_empty();

    // 一次 rev-list 拿全量未推送集合（这里是唯一允许算 unpushed 的地方）。
    // 没有远程引用时无从比较，按契约「全部未推送」；rev-list 失败同样退化成全部未推送，
    // 不能当 500 —— 它只决定圆点是实心还是空心。
    let unpushed_set: Option<HashSet<String>> = if branches.iter().any(|b| b.kind == "remote") {
        match run_git(root, &["rev-list", "--all", "--not", "--remotes"], TIMEOUT_FAST) {
            Ok(rev) if rev.ok => Some(parse_rev_list(&rev.text())),
            _ => None,
        }
    } else {
        None
    };

    let commits: Vec<Value> = commits
        .iter()
        .map(|commit| {
            let unpushed = match &unpushed_set {
                None => true,
                Some(set) => set.contains(&commit.hash),
            };
            commit_json(commit, unpushed)
        })
        .collect();

    let branches: Vec<Value> = branches
        .iter()
        .map(|branch| json!({ "name": branch.name, "kind": branch.kind, "hash": branch.hash }))
        .collect();

    Ok(json!({
        "commits": commits,
        "branches": branches,
        "head": head,
        "detached": detached,
    }))
}

/// 空仓库 / 还没有提交时的固定结构（契约 §1 最后一条）。
fn empty_log() -> Value {
    json!({ "commits": [], "branches": [], "head": "", "detached": false })
}

/// 一次 `git log` 解析出来的提交。只差 `unpushed`，由收集层按一次 rev-list 结果补。
#[derive(Debug, Clone, PartialEq, Eq)]
struct LogCommit {
    hash: String,
    short: String,
    parents: Vec<String>,
    message: String,
    author: String,
    time: i64,
    is_head: bool,
    refs: Vec<String>,
    tags: Vec<String>,
}

fn commit_json(commit: &LogCommit, unpushed: bool) -> Value {
    json!({
        "hash": commit.hash,
        "short": commit.short,
        "parents": commit.parents,
        "message": commit.message,
        "author": commit.author,
        "time": commit.time,
        "isHead": commit.is_head,
        "tags": commit.tags,
        "refs": commit.refs,
        "unpushed": unpushed,
    })
}

/// 解析 `git log --all --date-order --format=%H\0%h\0%P\0%s\0%an\0%at\0%D`。
///
/// 字段顺序和 dev 侧完全一致；`%s` 是单行主题，不会把记录拆乱。
fn parse_log_z(text: &str) -> Vec<LogCommit> {
    let mut out = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut fields = line.split('\u{0}');
        let hash = fields.next().unwrap_or("");
        if hash.is_empty() {
            continue;
        }
        let short = fields.next().unwrap_or("");
        let parents_raw = fields.next().unwrap_or("");
        let message = fields.next().unwrap_or("");
        let author = fields.next().unwrap_or("");
        let time: i64 = fields.next().unwrap_or("").trim().parse().unwrap_or(0);
        let decor = fields.next().unwrap_or("");
        let (is_head, refs, tags) = parse_decor(decor);
        out.push(LogCommit {
            hash: hash.to_string(),
            short: short.to_string(),
            // %P 空格分隔；根提交是空串 → 空 vec
            parents: parents_raw.split_whitespace().map(str::to_string).collect(),
            message: message.to_string(),
            author: author.to_string(),
            time,
            is_head,
            refs,
            tags,
        });
    }
    out
}

/// `%D` 形如 `HEAD -> main, origin/main, tag: v1` → `(isHead, refs, tags)`。
///
/// `refs` 保留原始形态（前端直接显示，`tag: ` 前缀不剥）；`tags` 只给去前缀后的名字。
/// 分离 HEAD 时 `%D` 只有一个 `HEAD`：它不是分支也不是标签，不放进 `refs`。
fn parse_decor(decor: &str) -> (bool, Vec<String>, Vec<String>) {
    let mut is_head = false;
    let mut refs = Vec::new();
    let mut tags = Vec::new();
    for part in decor.split(',').map(str::trim).filter(|part| !part.is_empty()) {
        if part == "HEAD" || part.starts_with("HEAD ->") {
            is_head = true;
        }
        if part == "HEAD" {
            continue;
        }
        refs.push(part.to_string());
        if let Some(tag) = part.strip_prefix("tag: ") {
            let tag = tag.trim();
            if !tag.is_empty() {
                tags.push(tag.to_string());
            }
        }
    }
    (is_head, refs, tags)
}

/// `for-each-ref` 的一行：短名 / 指向的提交 / 完整 refname。
#[derive(Debug, Clone, PartialEq, Eq)]
struct BranchRow {
    name: String,
    kind: &'static str,
    hash: String,
}

/// 解析 `for-each-ref --format=%(refname:short)%00%(objectname)%00%(refname)`。
///
/// `refs/remotes/origin/HEAD` 是符号引用（而且 `%(refname:short)` 只给 `origin`），
/// 必须按完整 refname 过滤，否则前端会多出一条假远程分支。
fn parse_branches(text: &str) -> Vec<BranchRow> {
    let mut out = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut fields = line.split('\u{0}');
        let name = fields.next().unwrap_or("");
        let hash = fields.next().unwrap_or("");
        let full = fields.next().unwrap_or("");
        if name.is_empty() || full.is_empty() {
            continue;
        }
        let kind = if full.starts_with("refs/heads/") {
            "local"
        } else if full.starts_with("refs/remotes/") {
            if full.ends_with("/HEAD") {
                continue;
            }
            "remote"
        } else if full.starts_with("refs/tags/") {
            "tag"
        } else {
            continue;
        };
        out.push(BranchRow {
            name: name.to_string(),
            kind,
            hash: hash.to_string(),
        });
    }
    out
}

/// `git rev-list` 的逐行输出 → hash 集合（空白行忽略）。
fn parse_rev_list(text: &str) -> HashSet<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

fn parse_commit_line(text: &str) -> Option<Value> {
    let line = text.lines().next()?.trim_end_matches('\r');
    if line.is_empty() {
        return None;
    }
    let mut fields = line.split('\u{0}');
    let hash = fields.next().unwrap_or("");
    if hash.is_empty() {
        return None;
    }
    let short = fields.next().unwrap_or("");
    let message = fields.next().unwrap_or("");
    let author = fields.next().unwrap_or("");
    let time: i64 = fields.next().unwrap_or("").trim().parse().unwrap_or(0);
    Some(json!({
        "hash": hash,
        "short": short,
        "message": message,
        "author": author,
        "time": time,
    }))
}

// ---------- POST /local/git/rollback ----------

fn rollback(request: Request, root: &str) {
    let Some((request, body)) = read_json_body(request) else {
        return;
    };
    match rollback_inner(root, &body) {
        Ok(value) => {
            let _ = respond_json(request, 200, value.to_string());
        }
        Err(err) => {
            let _ = json_error(request, err.code, &err.message);
        }
    }
}

fn rollback_inner(root: &str, body: &Value) -> Result<Value, GitError> {
    let hash = body
        .get("hash")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let mode = body
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("soft")
        .trim()
        .to_string();
    if !matches!(mode.as_str(), "soft" | "hard") {
        return Err(GitError::new(400, "回滚方式只能是 soft 或 hard"));
    }
    if hash.is_empty() || hash.starts_with('-') {
        return Err(GitError::new(400, "找不到这个提交"));
    }

    let spec = format!("{hash}^{{commit}}");
    let resolved = run_git(root, &["rev-parse", "--verify", "--quiet", &spec], TIMEOUT_FAST)?;
    let resolved = if resolved.ok {
        resolved.text().trim().to_string()
    } else {
        String::new()
    };
    if resolved.is_empty() {
        return Err(GitError::new(400, "找不到这个提交"));
    }

    let flag = format!("--{mode}");
    let out = run_git(root, &["reset", &flag, &resolved], TIMEOUT_WRITE)?;
    if !out.ok {
        return Err(GitError::new(500, out.failure("回滚失败")));
    }

    Ok(json!({
        "ok": true,
        "hash": resolved,
        "mode": mode,
        "branch": current_branch(root),
    }))
}

// ---------- POST /local/git/discard ----------

fn discard(request: Request, root: &str) {
    let Some((request, body)) = read_json_body(request) else {
        return;
    };
    match discard_inner(root, &body) {
        Ok(value) => {
            let _ = respond_json(request, 200, value.to_string());
        }
        Err(err) => {
            let _ = json_error(request, err.code, &err.message);
        }
    }
}

fn discard_inner(root: &str, body: &Value) -> Result<Value, GitError> {
    let mut paths: Vec<String> = Vec::new();
    for raw in string_list(body, "paths") {
        let rel = check_rel(&raw)?;
        if !paths.contains(&rel) {
            paths.push(rel);
        }
    }
    if paths.is_empty() {
        return Err(GitError::new(400, "没有指定要撤销的路径"));
    }

    let mut count = 0;
    for rel in &paths {
        let restored = run_git(
            root,
            &[
                "restore",
                "--source=HEAD",
                "--staged",
                "--worktree",
                "--",
                rel,
            ],
            TIMEOUT_FAST,
        )?;
        if restored.ok {
            count += 1;
            continue;
        }

        // 未跟踪路径 restore 一定失败（pathspec 不匹配），直接删掉
        let tracked = run_git(root, &["ls-files", "-z", "--", rel], TIMEOUT_FAST)
            .map(|out| out.ok && !out.stdout.is_empty())
            .unwrap_or(false);
        if tracked {
            return Err(GitError::new(500, restored.failure("撤销改动失败")));
        }

        let target = join_inside(root, rel)?;
        if target.is_dir() {
            fs::remove_dir_all(&target)
                .map_err(|err| GitError::new(500, format!("删除目录失败：{err}")))?;
        } else if target.exists() {
            fs::remove_file(&target)
                .map_err(|err| GitError::new(500, format!("删除文件失败：{err}")))?;
        }
        count += 1;
    }

    Ok(json!({ "ok": true, "count": count }))
}

// ---------- GET /local/git/tree ----------

fn tree(request: Request, root: &str, pairs: &[(String, String)]) {
    let rel = param(pairs, "path").unwrap_or("").trim().to_string();
    match tree_inner(root, &rel) {
        Ok(value) => {
            let _ = respond_json(request, 200, value.to_string());
        }
        Err(err) => {
            let _ = json_error(request, err.code, &err.message);
        }
    }
}

fn tree_inner(root: &str, rel: &str) -> Result<Value, GitError> {
    let dir_rel = if rel.is_empty() {
        String::new()
    } else {
        check_rel(rel)?
    };
    let dir = join_inside(root, &dir_rel)?;
    if !dir.is_dir() {
        return Err(GitError::new(400, "这不是目录"));
    }
    let root_canon = Path::new(root)
        .canonicalize()
        .map_err(|_| GitError::new(400, &format!("目录不存在：{root}")))?;
    let dir_canon = dir
        .canonicalize()
        .map_err(|_| GitError::new(400, &format!("目录不存在：{dir_rel}")))?;
    if !dir_canon.starts_with(&root_canon) {
        return Err(GitError::new(400, "路径越界"));
    }

    // 重目录不再往下展开：前面一级已经列过它了
    if dir_rel
        .split('\\')
        .any(|part| TREE_HEAVY.contains(&part.to_lowercase().as_str()))
    {
        return Ok(json!({ "entries": [] }));
    }

    let reader = fs::read_dir(&dir_canon)
        .map_err(|err| GitError::new(500, format!("列目录失败：{err}")))?;

    // (是目录, 小写名, 原名, 相对路径)
    let mut rows: Vec<(bool, String, String, String)> = Vec::new();
    for item in reader.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        if TREE_SKIP
            .iter()
            .any(|skip| name.eq_ignore_ascii_case(skip))
        {
            continue;
        }
        let is_dir = item.metadata().map(|meta| meta.is_dir()).unwrap_or(false);
        let child_rel = if dir_rel.is_empty() {
            name.clone()
        } else {
            format!("{dir_rel}\\{name}")
        };
        rows.push((is_dir, name.to_lowercase(), name, child_rel));
    }
    // 目录在前，其次按名字不区分大小写（与 /local/fs/list 一致）
    rows.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));

    let paths: Vec<String> = rows.iter().map(|row| row.3.clone()).collect();
    let ignored = check_ignored(root, &paths);

    let entries: Vec<Value> = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            json!({
                "path": row.3,
                "name": row.2,
                "type": if row.0 { "directory" } else { "file" },
                "ignored": ignored.get(index).copied().unwrap_or(false),
            })
        })
        .collect();

    Ok(json!({ "entries": entries }))
}

/// 一次批量问 `git check-ignore --stdin -z`，返回与 `paths` 等长的布尔数组。
///
/// 未初始化 / 没有命中任何规则时 git 都返回非 0（1 = 一条都没被忽略），一律当「都没忽略」。
fn check_ignored(root: &str, paths: &[String]) -> Vec<bool> {
    if paths.is_empty() {
        return Vec::new();
    }
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.replace('\\', "/").as_bytes());
        input.push(0);
    }
    let out = match run_git_with_input(
        root,
        &["check-ignore", "--stdin", "-z"],
        TIMEOUT_FAST,
        Some(input),
    ) {
        Ok(out) if out.ok => out,
        _ => return vec![false; paths.len()],
    };

    // 输出是 NUL 分隔的「被忽略的路径」，内容与喂进去的写法一致
    let ignored: Vec<String> = out
        .stdout
        .split(|byte| *byte == 0)
        .filter(|token| !token.is_empty())
        .map(|token| normalize_rule(&String::from_utf8_lossy(token)))
        .collect();
    paths
        .iter()
        .map(|path| ignored.contains(&normalize_rule(path)))
        .collect()
}

fn normalize_rule(text: &str) -> String {
    text.trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

// ---------- POST /local/git/ignore ----------

fn ignore(request: Request, root: &str) {
    let Some((request, body)) = read_json_body(request) else {
        return;
    };
    match ignore_inner(root, &body) {
        Ok(value) => {
            let _ = respond_json(request, 200, value.to_string());
        }
        Err(err) => {
            let _ = json_error(request, err.code, &err.message);
        }
    }
}

fn ignore_inner(root: &str, body: &Value) -> Result<Value, GitError> {
    let action = body
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("add")
        .trim()
        .to_string();
    if !matches!(action.as_str(), "add" | "remove") {
        return Err(GitError::new(400, "只能执行 add 或 remove"));
    }

    let mut paths: Vec<String> = Vec::new();
    for raw in string_list(body, "paths") {
        let rel = check_rel(&raw)?;
        if !paths.contains(&rel) {
            paths.push(rel);
        }
    }
    if paths.is_empty() {
        return Err(GitError::new(400, "没有指定要排除的路径"));
    }

    let file = Path::new(root).join(".gitignore");
    let existing = fs::read(&file)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    // 保留注释和空行：只增删命中规则行，别把用户的注释洗掉
    let mut raw: Vec<String> = existing.lines().map(str::to_string).collect();

    if action == "add" {
        let mut rules: Vec<(String, String)> = Vec::new();
        for rel in &paths {
            let rule = gitignore_rule(root, rel)?;
            if !rules.iter().any(|(_, existing)| same_rule(existing, &rule)) {
                rules.push((rel.clone(), rule));
            }
        }

        // 已被跟踪的路径：光写 .gitignore 不生效，必须先移出 index
        let initialized = repo_initialized(root);
        for (rel, _) in &rules {
            if !initialized {
                continue;
            }
            let tracked = run_git(root, &["ls-files", "-z", "--", rel], TIMEOUT_FAST)
                .map(|out| out.ok && !out.stdout.is_empty())
                .unwrap_or(false);
            if !tracked {
                continue;
            }
            let out = run_git(
                root,
                &["rm", "-r", "--cached", "-q", "--", rel],
                TIMEOUT_FAST,
            )?;
            if !out.ok {
                return Err(GitError::new(500, out.failure("把路径移出暂存区失败")));
            }
        }

        for (_, rule) in &rules {
            if !raw.iter().any(|line| same_rule(line, rule)) {
                raw.push(rule.clone());
            }
        }
    } else {
        let targets: Vec<String> = paths
            .iter()
            .map(|rel| normalize_rule(rel))
            .collect();
        raw.retain(|line| {
            let text = line.trim();
            if text.is_empty() || text.starts_with('#') {
                return true;
            }
            !targets.contains(&normalize_rule(text))
        });
    }

    let newline = if existing.contains("\r\n") { "\r\n" } else { "\n" };
    let mut content = raw.join(newline);
    if !content.is_empty() {
        // 原文件末尾没换行时先补一个，避免新规则粘在上一行
        content.push_str(newline);
    }
    if content != existing {
        fs::write(&file, &content)
            .map_err(|err| GitError::new(500, format!("写入 .gitignore 失败：{err}")))?;
    }

    Ok(json!({ "ok": true, "gitignore": gitignore_lines(&content) }))
}

// ---------- POST /local/git/remote ----------

fn remote(request: Request, root: &str) {
    let Some((request, body)) = read_json_body(request) else {
        return;
    };
    match remote_inner(root, &body) {
        Ok(value) => {
            let _ = respond_json(request, 200, value.to_string());
        }
        Err(err) => {
            let _ = json_error(request, err.code, &err.message);
        }
    }
}

fn remote_inner(root: &str, body: &Value) -> Result<Value, GitError> {
    let url = body
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();

    if url.is_empty() {
        // 清空地址 = 删掉 origin，本来没有就忽略
        let _ = run_git(root, &["remote", "remove", "origin"], TIMEOUT_FAST);
        return Ok(json!({ "ok": true, "remote": "" }));
    }

    if !valid_remote_url(&url) {
        return Err(GitError::new(400, "远程地址看起来不对"));
    }

    let added = run_git(root, &["remote", "add", "origin", &url], TIMEOUT_FAST)?;
    if !added.ok {
        let updated = run_git(root, &["remote", "set-url", "origin", &url], TIMEOUT_FAST)?;
        if !updated.ok {
            return Err(GitError::new(400, updated.failure("设置远程地址失败")));
        }
    }
    Ok(json!({ "ok": true, "remote": url }))
}

/// 远程地址形态校验：`https://` / `http://` / `ssh://` / `git@host:path` / 本地绝对路径。
///
/// 不做网络可达性检查（离线仓库、内网地址都要允许），只挡明显的手误。
fn valid_remote_url(url: &str) -> bool {
    let url = url.trim();
    if url.is_empty() || url.starts_with('-') {
        return false;
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    if let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .or_else(|| url.strip_prefix("ssh://"))
    {
        // 协议头之后至少要有主机名
        return !rest.trim_matches('/').is_empty();
    }
    // scp 风格：git@github.com:me/repo.git
    if let Some((user, rest)) = url.split_once('@') {
        if !user.is_empty() && !rest.is_empty() && rest.contains(':') && !rest.starts_with(':') {
            let host = rest.split(':').next().unwrap_or("");
            return !host.is_empty() && !host.contains('/');
        }
    }
    // 本地绝对路径：/x、\\server\share、F:\x、F:/x
    if url.starts_with('/') || url.starts_with("\\\\") {
        return url.len() > 1;
    }
    let bytes = url.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }
    false
}

// ---------- 单元测试（纯函数，不需要真仓库） ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_untracked_and_worktree_modified() {
        let changes = parse_porcelain(b"?? new.txt\0 M src/a.ts\0A  added.ts\0");
        assert_eq!(changes.len(), 3);

        assert_eq!(changes[0].path, "new.txt");
        assert_eq!(changes[0].status, "untracked");
        assert!(!changes[0].staged);
        assert!(!changes[0].worktree_dirty);

        // Y 侧有改动、X 为空：只在工作区
        assert_eq!(changes[1].path, "src\\a.ts");
        assert_eq!(changes[1].status, "modified");
        assert!(!changes[1].staged);
        assert!(!changes[1].worktree_dirty);

        // X 侧有改动、Y 为空：已暂存
        assert_eq!(changes[2].status, "added");
        assert!(changes[2].staged);
        assert!(!changes[2].worktree_dirty);
    }

    #[test]
    fn porcelain_mm_marks_worktree_dirty() {
        let changes = parse_porcelain(b"MM src/a.ts\0AM src/b.ts\0");
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].status, "modified");
        assert!(changes[0].staged);
        assert!(changes[0].worktree_dirty);
        assert_eq!(changes[1].status, "added");
        assert!(changes[1].staged);
        assert!(changes[1].worktree_dirty);
    }

    #[test]
    fn porcelain_renamed_consumes_origin_token() {
        // -z 下是「新路径\0旧路径」
        let changes = parse_porcelain(b"R  new.txt\0old.txt\0 M other.txt\0");
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].path, "new.txt");
        assert_eq!(changes[0].status, "renamed");
        assert_eq!(changes[0].renamed_from.as_deref(), Some("old.txt"));
        assert!(changes[0].staged);
        // 旧路径不能被当成下一条记录
        assert_eq!(changes[1].path, "other.txt");
        assert_eq!(changes[1].status, "modified");
        assert_eq!(changes[1].renamed_from, None);
    }

    #[test]
    fn porcelain_keeps_chinese_path() {
        let changes = parse_porcelain("M  中文/目录/文件.ts\0?? 中文/新文件.md\0".as_bytes());
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].path, "中文\\目录\\文件.ts");
        assert_eq!(changes[0].status, "modified");
        assert_eq!(changes[1].path, "中文\\新文件.md");
        assert_eq!(changes[1].status, "untracked");
    }

    #[test]
    fn porcelain_conflicts_are_reported() {
        let changes = parse_porcelain(b"UU merge.txt\0AA both-added.txt\0DD both-gone.txt\0");
        assert_eq!(changes.len(), 3);
        for change in &changes {
            assert_eq!(change.status, "conflicted");
        }
    }

    #[test]
    fn porcelain_handles_trailing_and_short_tokens() {
        assert!(parse_porcelain(b"").is_empty());
        assert!(parse_porcelain(b"\0\0").is_empty());
        // 不足 "XY p" 长度的垃圾数据不能 panic
        assert!(parse_porcelain(b"M\0").is_empty());
    }

    #[test]
    fn gitignore_filter_drops_blank_and_comments() {
        let text = "\u{feff}# 注释\n\nnode_modules/\r\ndist/  \n   \n!keep.txt\n#又一个注释\n";
        let lines = gitignore_lines(text);
        assert_eq!(lines, vec!["node_modules/", "dist/", "!keep.txt"]);
    }

    #[test]
    fn gitignore_rule_marks_directories() {
        let root = std::env::temp_dir();
        let dir = root.to_string_lossy().to_string();
        // 结尾带分隔符 → 目录规则
        assert_eq!(gitignore_rule(&dir, "src\\sub\\").unwrap(), "src/sub/");
        // 不存在的普通路径 → 文件规则
        assert_eq!(
            gitignore_rule(&dir, "src\\missing.ts").unwrap(),
            "src/missing.ts"
        );
        // 越界路径必须被拒
        assert!(gitignore_rule(&dir, "..\\escape").is_err());
        assert!(gitignore_rule(&dir, "F:\\abs").is_err());
    }

    #[test]
    fn remote_url_validation() {
        for ok in [
            "https://github.com/me/repo.git",
            "http://127.0.0.1:8080/repo.git",
            "ssh://git@example.com/me/repo.git",
            "git@github.com:me/repo.git",
            "F:\\repos\\demo",
            "F:/repos/demo",
            "\\\\server\\share\\repo",
        ] {
            assert!(valid_remote_url(ok), "应当接受：{ok}");
        }
        for bad in [
            "",
            "   ",
            "-oops",
            "github.com/me/repo",
            "https://",
            "git@",
            "git@github.com",
            "C:relative",
            "有时间 不合法",
        ] {
            assert!(!valid_remote_url(bad), "应当拒绝：{bad}");
        }
    }

    #[test]
    fn rel_paths_reject_escape() {
        assert_eq!(check_rel("src\\a.ts").unwrap(), "src\\a.ts");
        assert_eq!(check_rel("./src/a.ts").unwrap(), "src\\a.ts");
        assert_eq!(check_rel("src\\").unwrap(), "src");
        assert!(check_rel("").is_err());
        assert!(check_rel("..\\x").is_err());
        assert!(check_rel("a\\..\\..\\b").is_err());
        assert!(check_rel("C:\\abs").is_err());
        assert!(check_rel("\\\\server\\share").is_err());
        assert!(check_rel("/abs").is_err());
    }

    #[test]
    fn log_parsing_reads_parents_refs_and_tags() {
        // 字段顺序：hash, short, parents, message, author, time, %D
        let text = concat!(
            "abc1234\u{0}abc123\u{0}def5678 9988776\u{0}合并提交\u{0}me\u{0}1712345678\u{0}",
            "HEAD -> main, tag: v1, origin/main\n",
            "def5678\u{0}def567\u{0}\u{0}first\u{0}you\u{0}1712345679\u{0}\n",
        );
        let commits = parse_log_z(text);
        assert_eq!(commits.len(), 2);

        let head = commit_json(&commits[0], false);
        assert_eq!(head["hash"], "abc1234");
        assert_eq!(head["message"], "合并提交");
        assert_eq!(head["time"], 1712345678);
        assert_eq!(head["isHead"], true);
        assert_eq!(head["tags"][0], "v1");
        // refs 保留原始形态（`tag: ` 不剥），parents 按空格拆成两条且顺序不动
        assert_eq!(head["refs"][0], "HEAD -> main");
        assert!(
            head["refs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item == "tag: v1"),
            "refs 应原样保留 tag: v1：{}",
            head["refs"]
        );
        assert_eq!(head["parents"].as_array().map(Vec::len), Some(2));
        assert_eq!(head["parents"][1], "9988776");

        // 根提交：空 %P → 空数组；没有装饰 → refs / tags 都是空
        let root = commit_json(&commits[1], true);
        assert_eq!(root["parents"].as_array().map(Vec::len), Some(0));
        assert_eq!(root["refs"].as_array().map(Vec::len), Some(0));
        assert_eq!(root["isHead"], false);
        assert_eq!(root["unpushed"], true);
    }

    #[test]
    fn decor_keeps_refs_and_splits_tags() {
        let (is_head, refs, tags) = parse_decor("HEAD -> main, origin/main, tag: v0.2");
        assert!(is_head);
        assert_eq!(refs, vec!["HEAD -> main", "origin/main", "tag: v0.2"]);
        assert_eq!(tags, vec!["v0.2"]);

        // 分离 HEAD 的裸 `HEAD`：只算 isHead，不进 refs
        let (is_head, refs, tags) = parse_decor("HEAD");
        assert!(is_head);
        assert!(refs.is_empty());
        assert!(tags.is_empty());

        // 没有装饰
        let (is_head, refs, tags) = parse_decor("");
        assert!(!is_head);
        assert!(refs.is_empty());
        assert!(tags.is_empty());
    }

    #[test]
    fn branches_split_kinds_and_skip_remote_head() {
        // origin/HEAD 的 %(refname:short) 只给 `origin`，只能靠完整 refname 认出来
        let text = concat!(
            "main\u{0}aaa\u{0}refs/heads/main\n",
            "origin\u{0}aaa\u{0}refs/remotes/origin/HEAD\n",
            "origin/main\u{0}bbb\u{0}refs/remotes/origin/main\n",
            "v0.2\u{0}ccc\u{0}refs/tags/v0.2\n",
        );
        assert_eq!(
            parse_branches(text),
            vec![
                BranchRow {
                    name: "main".into(),
                    kind: "local",
                    hash: "aaa".into(),
                },
                BranchRow {
                    name: "origin/main".into(),
                    kind: "remote",
                    hash: "bbb".into(),
                },
                BranchRow {
                    name: "v0.2".into(),
                    kind: "tag",
                    hash: "ccc".into(),
                },
            ]
        );
        assert!(parse_branches("").is_empty());
    }

    #[test]
    fn rev_list_set_ignores_blank_lines() {
        let set = parse_rev_list("aaa\nbbb\n\n  ccc  \n");
        assert_eq!(set.len(), 3);
        assert!(set.contains("ccc"));
    }

    #[test]
    fn dir_normalization_ignores_prefix_and_case() {
        assert!(same_dir("\\\\?\\F:\\opencode\\workbench", "F:/Opencode/Workbench/"));
        assert!(!same_dir("F:\\opencode\\workbench", "F:\\opencode\\workbench\\shell"));
    }

    #[test]
    fn truncate_is_char_safe() {
        assert_eq!(truncate("abc", 5), "abc");
        assert_eq!(truncate("中文中文", 2), "中文...");
    }

    /// GitHub Desktop 的版本目录必须倒序取最新，否则升级后还在用旧副本。
    #[test]
    fn github_desktop_prefers_newest_app_dir() {
        let dir = std::env::temp_dir().join(format!("ocwb-gitdesk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for name in ["app-3.4.0", "app-3.10.0", "app-3.9.1"] {
            fs::create_dir_all(dir.join("GitHubDesktop").join(name).join("resources"))
                .expect("建假版本目录");
        }
        let found = github_desktop_git(&dir);
        let first = found.first().expect("至少要给出一个候选");
        // 按字典序倒排：app-3.9.1 > app-3.4.0，版本号排序在这里不适用（也不影响可用性）
        assert!(first.to_string_lossy().contains("app-3.9.1"), "实际第一个：{first:?}");
        assert_eq!(found.len(), 3);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 找不到时的文案要能指导下一步：装哪个、装完点哪、装在别处怎么指。
    #[test]
    fn missing_git_message_is_actionable() {
        let err = missing_git();
        assert_eq!(err.code, 400);
        assert!(err.message.contains("Git for Windows"), "{}", err.message);
        assert!(err.message.contains(GIT_ENV), "{}", err.message);
    }

    /// 本机装了 git 时，定位器必须能找到（找不到就是回归）。
    #[test]
    fn resolves_git_when_installed() {
        if where_lookup("git").is_none() && git_candidates().iter().all(|p| !p.is_file()) {
            return; // 这台机器确实没装
        }
        assert!(resolve_git().is_some(), "既然按路径能命中，resolve_git 不该返回 None");
    }

    /// 真仓库冒烟：临时目录 init → 提交 → 历史 → 目录树 → 排除 → 远程。
    ///
    /// 机器上没有 git 时直接跳过（`cargo check` 仍是唯一硬门槛）。
    #[test]
    fn temp_repo_roundtrip() {
        // 用定位器而不是裸 "git"：本来就是为了覆盖「git 不在 PATH、只在默认安装目录」的机器
        let Some(program) = resolve_git() else {
            return;
        };
        let git_ok = Command::new(program)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !git_ok {
            return;
        }

        let dir = std::env::temp_dir().join(format!("ocwb-gitapi-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时仓库目录");
        let root = dir.to_string_lossy().to_string();

        // 未初始化：200 + initialized:false，不报错
        let before = collect_status(&root).expect("未初始化时 status 不能失败");
        assert_eq!(before["initialized"], false);
        assert_eq!(before["files"].as_array().map(Vec::len), Some(0));

        let init = init_inner(&root).expect("初始化仓库");
        assert_eq!(init["alreadyInitialized"], false);
        assert_eq!(init["branch"], "main");
        assert!(dir.join(".gitignore").exists(), "应当写默认 .gitignore");

        // 提交需要身份；写进临时仓库自己的 config，别污染全局
        for (key, value) in [
            ("user.name", "ocwb-test"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
        ] {
            let out = run_git(&root, &["config", key, value], TIMEOUT_FAST).expect("写 git config");
            assert!(out.ok, "git config {key} 失败：{}", out.stderr);
        }

        fs::write(dir.join("a.txt"), "hello\n").expect("写测试文件");
        let after = collect_status(&root).expect("初始化后 status");
        assert_eq!(after["initialized"], true);
        assert_eq!(after["branch"], "main");
        let files = after["files"].as_array().expect("files 数组");
        assert!(
            files.iter().any(|file| file["path"] == "a.txt"
                && file["status"] == "untracked"
                && file["staged"] == false),
            "应有未跟踪的 a.txt：{after}"
        );

        let committed = commit_inner(&root, &json!({ "message": "首次提交" })).expect("提交");
        assert_eq!(committed["ok"], true);
        assert_eq!(committed["hash"].as_str().map(str::len), Some(40));
        assert_eq!(committed["short"].as_str().map(str::len), Some(7));
        // .gitignore 是 init 时写的，一起进了首次提交
        assert_eq!(committed["count"].as_u64(), Some(2));

        // 没有改动再提交 → 409
        let err = commit_inner(&root, &json!({ "message": "再来一次" })).expect_err("应当报 409");
        assert_eq!(err.code, 409);

        // 空说明 → 400
        let err = commit_inner(&root, &json!({ "message": "   " })).expect_err("空说明应 400");
        assert_eq!(err.code, 400);

        let log = collect_log(&root, 50).expect("读历史");
        let commits = log["commits"].as_array().expect("commits 数组");
        assert_eq!(commits.len(), 1, "只有一个提交：{log}");
        assert_eq!(commits[0]["message"], "首次提交");
        assert_eq!(commits[0]["isHead"], true);
        assert_eq!(commits[0]["author"], "ocwb-test");
        // 契约 §1 的新字段：根提交没有父；当前分支 main；还没有远程 → 未推送
        assert_eq!(log["head"], "main");
        assert_eq!(log["detached"], false);
        assert_eq!(commits[0]["parents"].as_array().map(Vec::len), Some(0));
        assert_eq!(commits[0]["unpushed"], true);
        let branches = log["branches"].as_array().expect("branches 数组");
        assert!(
            branches
                .iter()
                .any(|branch| branch["kind"] == "local" && branch["name"] == "main"),
            "branches 里应有本地 main：{branches:?}"
        );

        // 目录树：列出文件、排掉 .git
        let tree = tree_inner(&root, "").expect("列目录");
        let names: Vec<&str> = tree["entries"]
            .as_array()
            .expect("entries 数组")
            .iter()
            .filter_map(|entry| entry["name"].as_str())
            .collect();
        assert!(names.contains(&"a.txt"), "目录树应含 a.txt：{names:?}");
        assert!(!names.contains(&".git"), ".git 不能被列出来：{names:?}");

        // 排除一个已跟踪文件：写进规则 + 移出 index
        let ignored = ignore_inner(&root, &json!({ "paths": ["a.txt"], "action": "add" }))
            .expect("排除 a.txt");
        let rules = ignored["gitignore"].as_array().expect("gitignore 数组");
        assert!(
            rules.iter().any(|rule| rule == "a.txt"),
            "规则里应有 a.txt：{rules:?}"
        );
        // 已被跟踪的文件：规则写进去了，还要从 index 移出（否则规则不生效）。
        // 移出后 git 把它报成「已暂存的删除」，磁盘上的文件因为刚被忽略，不再出现为 untracked。
        let status = collect_status(&root).expect("排除后 status");
        let files = status["files"].as_array().expect("files 数组");
        assert!(
            files
                .iter()
                .any(|file| file["path"] == "a.txt"
                    && file["status"] == "deleted"
                    && file["staged"] == true),
            "a.txt 应显示为已暂存的删除：{status}"
        );
        let tracked = run_git(&root, &["ls-files", "-z", "--", "a.txt"], TIMEOUT_FAST)
            .expect("ls-files");
        assert!(tracked.stdout.is_empty(), "a.txt 必须已经移出 index");

        // 取消排除
        let removed = ignore_inner(&root, &json!({ "paths": ["a.txt"], "action": "remove" }))
            .expect("取消排除");
        let rules = removed["gitignore"].as_array().expect("gitignore 数组");
        assert!(!rules.iter().any(|rule| rule == "a.txt"), "规则应被删掉：{rules:?}");

        // 远程地址：合法写入、非法 400、清空删除
        let set = remote_inner(&root, &json!({ "url": "git@github.com:me/repo.git" })).expect("设远程");
        assert_eq!(set["remote"], "git@github.com:me/repo.git");
        let status = collect_status(&root).expect("设完远程 status");
        assert_eq!(status["remote"], "git@github.com:me/repo.git");
        let err = remote_inner(&root, &json!({ "url": "不是地址" })).expect_err("非法地址");
        assert_eq!(err.code, 400);
        let cleared = remote_inner(&root, &json!({ "url": "" })).expect("清空远程");
        assert_eq!(cleared["remote"], "");
        let status = collect_status(&root).expect("清空后 status");
        assert_eq!(status["remote"], "");

        // 回滚到不存在的提交 → 400
        let err = rollback_inner(&root, &json!({ "hash": "deadbeef", "mode": "soft" }))
            .expect_err("不存在的提交");
        assert_eq!(err.code, 400);
        let err = rollback_inner(&root, &json!({ "hash": "HEAD", "mode": "sideways" }))
            .expect_err("非法模式");
        assert_eq!(err.code, 400);

        // 撤销未跟踪文件：删掉并从计数里体现
        fs::write(dir.join("scratch.txt"), "tmp\n").expect("写临时文件");
        let discarded = discard_inner(&root, &json!({ "paths": ["scratch.txt"] })).expect("撤销");
        assert_eq!(discarded["count"], 1);
        assert!(!dir.join("scratch.txt").exists(), "未跟踪文件应被删除");

        let _ = fs::remove_dir_all(&dir);
    }
}
