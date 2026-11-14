//! 找本地 opencode 服务，并拿到带认证的 cookie。
//!
//! 流程（实测 v2.2.5）：
//!   1. `opencode service status` 打印服务地址，例如 http://127.0.0.1:28894
//!   2. `opencode pair` 打印一次性配对链接 http://127.0.0.1:<port>/auth/connect/<code>
//!   3. 用带 `Accept: text/html` 的 GET 打开链接 → 302 + Set-Cookie: opencode_session_<port>=<token>
//!      （不带 text/html 只回 JSON token，那个 token 拿来当 Bearer 会 401）
//!
//! 命令定位（[`resolve_opencode`]）：先看 `OC_WORKBENCH_OPENCODE`，再用 `where` 走 PATH，
//! 最后按已知安装位置逐个命中。**不能只靠 PATH**：opencode 常见装法是
//! `%USERPROFILE%\.local\bin\opencode.cmd`（bun / npm 装的 shim）或
//! `%USERPROFILE%\.opencode\bin\opencode.exe`（官方安装器），这两个目录都不一定在 PATH 里，
//! 换台机器就只剩「找不到 opencode」。
//!
//! 注意：shim 是 .cmd 时 `CreateProcess` 直接跑会失败（报「不是有效的 Win32 应用」），
//! 必须经 `cmd /C "<shim>" args`；真正的 .exe 则直接启动，绕开 cmd 的引号解析。
//!
//! 每条子命令最多等 5 秒（[`CMD_TIMEOUT`]）：服务锁、UAC 拦截、shim 弹交互都会让
//! `Command::output()` 永久阻塞，而这段代码跑在后台线程里 —— 卡住就是不回复且没日志。
//!
//! 所有失败都返回带原因的错误字符串（命令、io::Error、退出码、stderr 片段），
//! 由 server 的后台重试线程写进 gui-error.log —— 这是排查「为什么没连接上后端」的唯一线索。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// 环境变量：显式指定 opencode 可执行文件（路径或命令名）。
pub const OPENCODE_ENV: &str = "OC_WORKBENCH_OPENCODE";

/// 单条 `opencode` 子命令的最长等待时间。
const CMD_TIMEOUT: Duration = Duration::from_secs(5);
/// try_wait 轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(50);
/// 子进程退出后，等 stdout/stderr 两段管道读到 EOF 的最长时间。
///
/// 子进程退出 ≠ 管道 EOF：它派生的孙进程（node）会继承 stdout/stderr 并继续持有。
/// 那种情况下 join 会永久阻塞，把后台 bootstrap 线程和 DISCOVER_LOCK 一起卡死，
/// 累积下去 64 个并发名额全被占满、所有请求 503。所以这里改成 channel + 超时。
const OUTPUT_TIMEOUT: Duration = Duration::from_secs(5);
/// 服务未运行时的自动启动等待窗口：opencode CLI 自己的启动预算是 120s，这里留 30s 余量，
/// 好让 CLI 的超时诊断先写进 stderr 再被我们读到。
const SERVICE_START_TIMEOUT: Duration = Duration::from_secs(150);
/// 自动启动后轮询 `service status` 的间隔。
const START_POLL: Duration = Duration::from_millis(500);

/// 读管道线程送回主线程的数据来源。
enum PipeKind {
    Out,
    Err,
}
/// Windows 的 CREATE_NO_WINDOW：GUI 进程起控制台子进程时不要弹黑窗。
#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 已连接的后端：上游地址 + 认证 cookie。
///
/// cookie 是凭据，不实现 `Debug`，也不进任何日志。
#[derive(Clone)]
pub struct Backend {
    pub base: String,
    pub cookie: String,
}

/// 把多行输出压成一行，并截到 limit 个字符（错误日志里够用即可）。
/// 把一次性配对链接里的 code 打码：它会出现在错误串里，不能进日志或界面。
fn redact(text: &str) -> String {
    const MARK: &str = "/auth/connect/";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(idx) = rest.find(MARK) {
        let (head, tail) = rest.split_at(idx + MARK.len());
        out.push_str(head);
        let end = tail
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
            .unwrap_or(tail.len());
        out.push_str("<redacted>");
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

fn snippet(text: &str, limit: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(limit).collect();
    if flat.chars().count() > limit {
        out.push_str("...");
    }
    out
}

/// 一次定位的结果：真正要启动的程序，以及它是不是脚本 shim。
#[derive(Clone, Debug)]
struct Target {
    program: PathBuf,
    /// 非 PE 文件一律要经 cmd.exe 启动。
    ///
    /// 新版 opencode 的安装器会落一个**没有扩展名**的启动包装
    /// （实测 `%LOCALAPPDATA%\hermes\node\opencode`），它既不是 .exe、
    /// 也不叫 .cmd，直接 CreateProcess 必然报 os error 193
    /// （「%1 不是有效的 Win32 应用程序」）。所以不能只看扩展名。
    shim: bool,
}

/// 已成功定位的结果会缓存在这里（只缓存成功）。
///
/// 不缓存失败：用户装完 opencode 回来点「重试」应该立刻能用，
/// 而失败时每 5 秒重试一次、每次多跑一个 `where` 也就几十毫秒。
static RESOLVED: Mutex<Option<Target>> = Mutex::new(None);

/// 缓存代次：`reset_resolution()` 每次 +1。
///
/// 用来挡住「解析过程中刚好装完 → 旧结果写回缓存」这种竞态：
/// 解析开始时记下代次，写缓存前再比一次，变了就丢弃本次结果。
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|value| !value.as_os_str().is_empty())
}

/// 文件头是不是一个**可执行的** PE：`MZ` + e_lfanew 处的 `PE\0\0`。
///
/// 只看 MZ 不够：下载中断/复制一半的 exe、16 位 DOS 程序也都以 MZ 开头，
/// 但拿去 CreateProcess 照样失败（os error 193）——正是这次要修的报错。
/// 读不到、或任何一步对不上，都按「非 PE」处理，后续走 cmd。
pub(crate) fn is_pe(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut dos = [0u8; 64];
    if file.read_exact(&mut dos).is_err() || &dos[..2] != b"MZ" {
        return false;
    }
    // e_lfanew 在 DOS 头 0x3C 处，4 字节小端，指向 PE 签名
    let lfanew = u32::from_le_bytes([dos[0x3C], dos[0x3D], dos[0x3E], dos[0x3F]]) as u64;
    if lfanew == 0 || lfanew > 0x10_0000 {
        return false;
    }
    if file.seek(SeekFrom::Start(lfanew)).is_err() {
        return false;
    }
    let mut sig = [0u8; 4];
    file.read_exact(&mut sig).is_ok() && &sig == b"PE\0\0"
}

/// 判断要不要走 cmd：扩展名是 .cmd/.bat/.ps1 的，或者文件本身不是 PE，都算 shim。
///
/// 只看扩展名是不够的：新版 opencode 落的是无扩展名包装脚本，会漏判成 exe，
/// 然后 `CreateProcess` 报 193。
fn classify(path: PathBuf) -> Target {
    let by_ext = path
        .extension()
        .map(|ext| {
            let ext = ext.to_string_lossy().to_ascii_lowercase();
            ext == "cmd" || ext == "bat" || ext == "ps1"
        })
        .unwrap_or(false);
    // 扩展名说不是 shim 时再看文件头：无扩展名的包装脚本就靠这一步救回来。
    let shim = by_ext || !is_pe(&path);
    Target { program: path, shim }
}

/// 在同一个目录里找出「真正能启动」的兄弟文件。
///
/// npm / bun 装的时候会一口气落三份：`opencode`（bash 脚本，无扩展名）、
/// `opencode.cmd`、`opencode.ps1`。而 `where opencode` 把无扩展名那个
/// 排在最前面，双击工作台就会拿它去 CreateProcess → os error 193。
/// 所以拿到非 PE 的候选后，先换成同目录的 .exe / .cmd。
fn pick_runnable(path: &Path) -> PathBuf {
    if is_pe(path) {
        return path.to_path_buf();
    }
    if let Some(ext) = path.extension() {
        let lower = ext.to_string_lossy().to_ascii_lowercase();
        // .cmd/.bat 本身就是正经的 Windows 启动方式，不用再换
        if lower == "cmd" || lower == "bat" {
            return path.to_path_buf();
        }
    }
    // 兄弟文件名用「去掉原扩展名」的 stem 拼：
    //   opencode      → opencode.exe / opencode.cmd
    //   opencode.ps1  → opencode.exe / opencode.cmd（不是 opencode.ps1.exe）
    let Some(stem) = path.file_stem().map(|value| value.to_string_lossy().to_string()) else {
        return path.to_path_buf();
    };
    for want in ["exe", "cmd"] {
        let candidate = path.with_file_name(format!("{stem}.{want}"));
        if candidate.is_file() && is_pe_or_script(&candidate) {
            return candidate;
        }
    }
    path.to_path_buf()
}

/// 候选文件是否值得用：真 PE，或者 .cmd/.bat。
fn is_pe_or_script(path: &Path) -> bool {
    if is_pe(path) {
        return true;
    }
    path.extension()
        .map(|ext| {
            let lower = ext.to_string_lossy().to_ascii_lowercase();
            lower == "cmd" || lower == "bat"
        })
        .unwrap_or(false)
}

/// PATH 之外的常见安装位置，按「最可能命中」排序。
///
/// 这些目录换台机器后通常仍然成立，是「双击 exe 就能用」的主要保障：
///   * 工作台 exe 同目录（绿色版：把 opencode.exe 丢在旁边）
///   * `%USERPROFILE%\.local\bin`（bun / npm 装的 shim 落点，实测本机就是这里）
///   * `%USERPROFILE%\.opencode\bin`（官方安装器）
///   * `%LOCALAPPDATA%\Programs\opencode`、`%APPDATA%\npm`（系统级安装）
///   * `%LOCALAPPDATA%\hermes\node`（Hermes 自带 node 运行时后，npm 装出来的落点）
fn candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        out.push(dir.join("opencode.exe"));
        out.push(dir.join("opencode.cmd"));
    }
    if let Some(home) = env_path("USERPROFILE") {
        out.push(home.join(".local").join("bin").join("opencode.exe"));
        out.push(home.join(".local").join("bin").join("opencode.cmd"));
        out.push(home.join(".opencode").join("bin").join("opencode.exe"));
    }
    if let Some(local) = env_path("LOCALAPPDATA") {
        out.push(local.join("Programs").join("opencode").join("opencode.exe"));
        out.push(local.join("opencode").join("bin").join("opencode.exe"));
        // Hermes（Nous Research 的 Agent）自带 node 运行时，npm 装的 shim 会落在
        // `%LOCALAPPDATA%\hermes\node`；这个目录不在 PATH 时只能靠这里兜住。
        out.push(local.join("hermes").join("node").join("opencode.exe"));
        out.push(local.join("hermes").join("node").join("opencode.cmd"));
    }
    if let Some(roaming) = env_path("APPDATA") {
        out.push(roaming.join("npm").join("opencode.cmd"));
        out.push(roaming.join("npm").join("opencode.exe"));
    }
    out
}

/// 用 `where <name>` 在 PATH 上找，返回第一个能真正启动的文件。
/// 从 `where` 的多行输出里挑一个能真正启动的。
///
/// npm / bun 会把无扩展名脚本和 `.cmd` / `.exe` 一起落到同一个目录，
/// `where` 按 PATH 顺序列出来，无扩展名那个经常排第一，但它不是 PE，
/// 直接 CreateProcess 就是 os error 193。所以这里的优先级是：
/// 真 PE → .cmd/.bat → 其余（保留原有顺序）。
fn pick_from_where_output(text: &str) -> Option<PathBuf> {
    let hits: Vec<PathBuf> = text
        .lines()
        .map(|line| PathBuf::from(line.trim()))
        .filter(|path| path.is_file())
        .collect();
    if let Some(best) = hits.iter().find(|path| is_pe(path)) {
        return Some(best.clone());
    }
    if let Some(best) = hits.iter().find(|path| is_pe_or_script(path)) {
        return Some(best.clone());
    }
    hits.into_iter().next()
}
/// 解码控制台程序的输出。
///
/// Windows 控制台程序（`where`、`chcp` 等）按**控制台代码页**写 stdout，
/// 中文系统是 936/GBK，不是 UTF-8。以前一律 `from_utf8_lossy`，中文用户名或
/// 中文安装目录会变成一串 U+FFFD，路径直接失效——「装了却说没装」的另一半根因。
fn decode_console(bytes: &[u8]) -> String {
    // 纯 ASCII 和已经是 UTF-8 的输出都不会走到 fallback
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => crate::winenc::decode_lossy(bytes),
    }
}


///
/// 必须自带超时：PATH 里有不可达的网络共享时 `where` 会卡很久。
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
                    // where.exe 按控制台代码页输出（中文系统是 936/GBK），不是 UTF-8。
                    // 按 UTF-8 解码会把中文路径变成 U+FFFD，随后 is_file() 为 false，
                    // 用户明明装着 opencode 也被判「未安装」。先试 UTF-8，失败退 GB18030。
                    let text = decode_console(&buf);
                    return pick_from_where_output(&text);
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
            thread::sleep(POLL_INTERVAL);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = name;
        None
    }
}

/// 定位 opencode：显式环境变量 → PATH → 已知安装位置。
fn resolve_opencode() -> Option<Target> {
    if let Ok(guard) = RESOLVED.lock() {
        if let Some(hit) = guard.as_ref() {
            return Some(hit.clone());
        }
    }

    // 记下「开始解析时」的代次。解析要跑 where（最长 3 秒），这期间用户可能刚好
    // 装完 opencode 并调 reset_resolution()；如果直接把结果写回缓存，就会把安装前
    // 的旧路径又塞回去，之后一直连旧路径直到重启进程。
    let generation = GENERATION.load(Ordering::SeqCst);
    let found = resolve_opencode_uncached();
    if let Some(hit) = found.as_ref() {
        // 指向一个并不存在的文件（OPENCODE_ENV 写了个找不到的命令名）时不要缓存：
        // 缓存了以后用户真装好了也永远是这条坏路径。
        if hit.program.is_file() && GENERATION.load(Ordering::SeqCst) == generation {
            if let Ok(mut guard) = RESOLVED.lock() {
                *guard = Some(hit.clone());
            }
        }
    }
    found
}

/// 已定位到的可执行文件路径（`.cmd` shim 也会原样返回）。
///
/// 给 CLI 版本探测和「原地升级」用：换文件时必须知道用户实际在用哪一个，
/// 换到别处等于没装。
pub fn locate() -> Option<PathBuf> {
    resolve_opencode().map(|target| target.program)
}

/// 装完/更新完 opencode 后清掉定位缓存。
///
/// 缓存只在成功时写入，而升级可能把文件换到新路径（先装到
/// `%USERPROFILE%\.opencode\bin`），不清就会一直连着旧路径。
pub fn reset_resolution() {
    // 先涨代次：正在解析中的线程看到代次变了就不会把旧结果写回缓存
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut guard) = RESOLVED.lock() {
        *guard = None;
    }
}

fn resolve_opencode_uncached() -> Option<Target> {
    // 1. 显式指定优先。允许给「路径」或「命令名」，两种都认。
    if let Some(raw) = env_path(OPENCODE_ENV) {
        if raw.is_file() {
            return Some(classify(pick_runnable(&raw)));
        }
        if let Some(found) = where_lookup(&raw.to_string_lossy()) {
            return Some(classify(pick_runnable(&found)));
        }
        // 形如 `opencode2.cmd` 但仍找不到：退回按名字启动，让 cmd 自己报错
        return Some(classify(raw));
    }

    // 2. PATH
    if let Some(found) = where_lookup("opencode") {
        return Some(classify(pick_runnable(&found)));
    }

    // 3. 已知安装位置
    candidates()
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| classify(pick_runnable(&path)))
}

/// 找不到时的错误串：把查过的位置列出来，用户照着一看就知道该装哪、或该设哪个变量。
fn missing_opencode() -> String {
    format!(
        "找不到 `opencode` 命令。已查过：PATH、程序所在目录、%USERPROFILE%\\.local\\bin、\
         %USERPROFILE%\\.opencode\\bin、%LOCALAPPDATA%\\Programs\\opencode、%APPDATA%\\npm。\
         装好 opencode 后点「重试」即可；装在别处就设环境变量 {OPENCODE_ENV} 指向 opencode.exe。"
    )
}

#[cfg(windows)]
fn command_for(args: &[&str]) -> Result<Command, String> {
    use std::os::windows::process::CommandExt;

    let target = resolve_opencode().ok_or_else(missing_opencode)?;
    // 定位阶段已经判过 shim，直接复用，不再读一次文件头。
    let mut cmd = build_command(&target, args);
    cmd.creation_flags(CREATE_NO_WINDOW);
    Ok(cmd)
}

/// 按 `Target` 造命令：脚本 shim 走 `cmd /C`，真 PE 直接启动。
#[cfg(windows)]
fn build_command(target: &Target, args: &[&str]) -> Command {
    let mut cmd = if target.shim {
        // `cmd /C "<文件>" <args>`：整条命令行里只有一对引号且引号内是文件路径，
        // cmd 会原样保留这对引号，带空格的安装路径也不会被拆开（实测）。
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(&target.program);
        cmd
    } else {
        Command::new(&target.program)
    };
    for arg in args {
        cmd.arg(arg);
    }
    cmd
}

/// 按**给定路径**造命令：非 PE（脚本 shim）自动走 `cmd /C`，真 PE 直接启动。
///
/// 单独暴露出来是因为版本探测（[crate::cli::exe_version]）拿到的是具体文件路径，
/// 不走定位缓存；它同样必须遵守「脚本要经 cmd」这条，否则又是一次 os error 193。
#[cfg(windows)]
pub fn command_for_path(path: &Path, args: &[&str]) -> Command {
    build_command(&classify(path.to_path_buf()), args)
}

#[cfg(not(windows))]
pub fn command_for_path(path: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(path);
    for arg in args {
        cmd.arg(arg);
    }
    cmd
}

#[cfg(not(windows))]
fn command_for(args: &[&str]) -> Result<Command, String> {
    let mut cmd = Command::new("opencode");
    for arg in args {
        cmd.arg(arg);
    }
    Ok(cmd)
}

/// 杀掉子进程及其整棵树。
///
/// Windows 上 `cmd /C opencode` 真正的 node 进程是 cmd.exe 的子进程，
/// 只 `child.kill()` 会留下孤儿进程继续占着服务锁，所以先 taskkill /T /F。
fn kill_tree(child: &mut Child) {
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
}

/// 轮询 `try_wait` 等待退出，超时就杀树并返回错误。
fn wait_with_timeout(
    child: &mut Child,
    args: &[&str],
    timeout: Duration,
) -> Result<ExitStatus, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {}
            Err(err) => {
                kill_tree(child);
                return Err(format!("等待 `opencode {}` 结束失败：{err}", args.join(" ")));
            }
        }
        if Instant::now() >= deadline {
            kill_tree(child);
            return Err(format!(
                "`opencode {}` 超过 {} 秒未返回，已终止（服务锁卡住或弹了需要交互的窗口）",
                args.join(" "),
                timeout.as_secs()
            ));
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn read_all<R: Read>(pipe: Option<R>) -> Vec<u8> {
    let mut buf = Vec::new();
    if let Some(mut pipe) = pipe {
        let _ = pipe.read_to_end(&mut buf);
    }
    buf
}
/// 在 OUTPUT_TIMEOUT 内收齐 stdout/stderr 两段输出。
///
/// 收不齐（子进程已退出但管道没 EOF）就拿已收到的部分返回错误：
/// 半截输出解析出来的地址可能是错的，不能当成成功。
fn collect_output(
    receiver: &mpsc::Receiver<(PipeKind, Vec<u8>)>,
    args: &[&str],
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let deadline = Instant::now() + OUTPUT_TIMEOUT;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut received = 0;
    while received < 2 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match receiver.recv_timeout(remaining) {
            Ok((PipeKind::Out, data)) => {
                stdout = data;
                received += 1;
            }
            Ok((PipeKind::Err, data)) => {
                stderr = data;
                received += 1;
            }
            Err(_) => break,
        }
    }

    if received < 2 {
        return Err(format!(
            "`opencode {}` 已退出，但输出管道 {} 秒内没有关闭（子进程派生的进程仍占着 stdout/stderr），输出不完整（已收到 stdout {} 字节、stderr {} 字节）",
            args.join(" "),
            OUTPUT_TIMEOUT.as_secs(),
            stdout.len(),
            stderr.len()
        ));
    }

    Ok((stdout, stderr))
}

/// 跑 `opencode <args>`，返回 stdout+stderr。
/// 找不到命令、超时、退出码非 0 时返回 Err（含退出码与 stderr 前 200 字符）。
fn run(args: &[&str]) -> Result<String, String> {
    run_inner(args, CMD_TIMEOUT)
}

fn run_inner(args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut cmd = command_for(args)?;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|err| format!("执行 `opencode {}` 失败：{err}", args.join(" ")))?;

    // 输出交给两个线程读：子进程写满管道缓冲区会阻塞不退出，主线程的超时判定就失效了。
    // 读到的内容经 channel 送回主线程，主线程用 recv_timeout 计时，不等 join。
    let (sender, receiver) = mpsc::channel();
    let out_sender = sender.clone();
    thread::spawn({
        let pipe = child.stdout.take();
        move || {
            let _ = out_sender.send((PipeKind::Out, read_all(pipe)));
        }
    });
    thread::spawn({
        let pipe = child.stderr.take();
        move || {
            let _ = sender.send((PipeKind::Err, read_all(pipe)));
        }
    });

    let status = wait_with_timeout(&mut child, args, timeout)?;
    let (stdout, stderr) = collect_output(&receiver, args)?;

    let stdout = String::from_utf8_lossy(&stdout).to_string();
    let stderr = String::from_utf8_lossy(&stderr).to_string();

    if !status.success() {
        let code = status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "无（被信号终止）".to_string());
        return Err(format!(
            "`opencode {}` 退出码 {code}，stderr：{}",
            args.join(" "),
            snippet(&stderr, 200)
        ));
    }

    Ok(format!("{stdout}\n{stderr}"))
}

/// 启动后台服务：地址从 `service status` 轮询取，stdout 直接丢弃；
/// stderr 落临时文件（用读线程会在服务 detach 后永久阻塞、泄漏线程/句柄）。
/// 超时只结束直接子进程：服务可能已被它 detach 出去，taskkill 整树会把服务一起杀掉。
fn run_start(args: &[&str], timeout: Duration) -> Result<(), String> {
    let err_path = std::env::temp_dir().join(format!(
        "oc-workbench-start-{}.err",
        std::process::id()
    ));
    let err_file = std::fs::File::create(&err_path).ok();

    let mut cmd = command_for(args)?;
    cmd.stdin(Stdio::null()).stdout(Stdio::null());
    match err_file {
        Some(file) => {
            cmd.stderr(Stdio::from(file));
        }
        None => {
            cmd.stderr(Stdio::null());
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|err| format!("执行 `opencode {}` 失败：{err}", args.join(" ")))?;

    let deadline = Instant::now() + timeout;
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break Ok(()),
            Ok(Some(status)) => {
                let code = status
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "无".to_string());
                let detail = std::fs::read(&err_path)
                    .map(|bytes| snippet(&String::from_utf8_lossy(&bytes), 200))
                    .unwrap_or_default();
                break Err(if detail.is_empty() {
                    format!("`opencode {}` 退出码 {code}", args.join(" "))
                } else {
                    format!("`opencode {}` 退出码 {code}，stderr：{detail}", args.join(" "))
                });
            }
            Ok(None) => {}
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!("等待 `opencode {}` 结束失败：{err}", args.join(" ")));
            }
        }
        if Instant::now() >= deadline {
            // 只结束直接子进程；服务若已被 detach 出去就让它继续跑，外层用 status 判断
            let _ = child.kill();
            let _ = child.wait();
            // CLI 被我们杀掉之前可能已经写了诊断（例如它自己的 120s 超时），读出来一起返回
            let detail = std::fs::read(&err_path)
                .map(|bytes| snippet(&String::from_utf8_lossy(&bytes), 200))
                .unwrap_or_default();
            break Err(if detail.is_empty() {
                format!(
                    "`opencode {}` 超过 {} 秒未返回（服务锁卡住或弹了需要交互的窗口）",
                    args.join(" "),
                    timeout.as_secs()
                )
            } else {
                format!(
                    "`opencode {}` 超过 {} 秒未返回，stderr：{detail}",
                    args.join(" "),
                    timeout.as_secs()
                )
            });
        }
        thread::sleep(POLL_INTERVAL);
    };

    let _ = std::fs::remove_file(&err_path);
    result
}

/// 自动启动后探活：服务可能已经写了地址但还没准备好接请求。
/// 失败不阻塞，交给后面的 pair 报真实错误。
fn probe_ready(base: &str) {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(2))
        .build();
    for _ in 0..2 {
        match agent.get(&format!("{base}/api/info")).call() {
            // 401/403 等状态码说明端口已经在服务
            Ok(_) | Err(ureq::Error::Status(_, _)) => return,
            Err(_) => thread::sleep(Duration::from_millis(500)),
        }
    }
}

/// 把 `http://<主机>:<端口>/<路径>` 拆开，并把主机归一成可连的形式。
///
/// 不是 http URL、没有端口、端口不是纯数字一律 None。
fn split_url(token: &str) -> Option<(String, String, String)> {
    let token = token.trim_matches(|c: char| c == '"' || c == '\'' || c == ',' || c == ';');
    let rest = token.strip_prefix("http://")?;
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, format!("/{path}")),
        None => (rest, String::new()),
    };
    let (host, port) = split_authority(authority)?;
    Some((normalize_host(&host), port, path))
}

/// 拆分 authority，兼容 IPv6 字面量（`[::1]:4096`）。
fn split_authority(authority: &str) -> Option<(String, String)> {
    let (host, port) = match authority.strip_prefix('[') {
        Some(rest) => {
            let (host, tail) = rest.split_once(']')?;
            (format!("[{host}]"), tail.strip_prefix(':')?)
        }
        None => {
            let (host, port) = authority.rsplit_once(':')?;
            (host.to_string(), port)
        }
    };
    if host.is_empty() || port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((host.to_string(), port.to_string()))
}

/// 通配地址、localhost、127.x 一律归一成 127.0.0.1。
///
/// 服务监听在 `0.0.0.0` 时回环必然通；把 `0.0.0.0` 当客户端目标用并不可靠。
/// 绑在具体网卡地址上的服务（极少见）保留原地址，不自作主张改成回环。
fn normalize_host(host: &str) -> String {
    let lower = host.to_ascii_lowercase();
    match lower.as_str() {
        "0.0.0.0" | "::" | "[::]" | "[::1]" | "::1" | "localhost" => "127.0.0.1".to_string(),
        _ if lower.starts_with("127.") => "127.0.0.1".to_string(),
        _ => host.to_string(),
    }
}

/// 从一段文本里截出第一个服务地址（`http://<主机>:<端口>`）。
///
/// 老实现只认字面量 `http://127.0.0.1:`。服务端配了 host 时 `service status`
/// 会打印 `http://0.0.0.0:4096`（实测某台机器就是），于是永远解析不到地址，
/// 面板卡在「服务已启动，但 150 秒内 service status 仍没有地址」。
fn find_base(text: &str) -> Option<String> {
    text.split_whitespace().find_map(|token| {
        split_url(token).map(|(host, port, _path)| format!("http://{host}:{port}"))
    })
}

/// 从 `opencode pair` 的输出里找配对链接。优先回环地址那一条。
///
/// v2.3.0 一次会打印多条（回环 + 各网卡地址），取回环那条发请求最稳。
fn find_link(text: &str) -> Option<String> {
    let mut fallback: Option<String> = None;
    for token in text.split_whitespace() {
        let Some((host, port, path)) = split_url(token) else {
            continue;
        };
        if !path.contains("/auth/connect/") {
            continue;
        }
        let link = format!("http://{host}:{port}{path}");
        if host == "127.0.0.1" {
            return Some(link);
        }
        fallback.get_or_insert(link);
    }
    fallback
}

fn port_of(url: &str) -> Option<String> {
    split_url(url).map(|(_, port, _path)| port)
}

pub fn discover() -> Result<Backend, String> {
    // 所有错误串统一过一遍：配对链接（等同一次性凭据）不能进日志或界面。
    let backend = discover_inner().map_err(|err| redact(&err))?;
    if !needs_server_shell_probe() {
        return Ok(backend);
    }
    // 外壳能跑 pwsh 不代表服务端能跑：Store/MSIX 版 pwsh 在服务进程里会解析成
    // `C:\Program Files\WindowsApps\<包>\pwsh.EXE` 并 spawn 失败（实测 500）。
    // 这里向服务端实测一次，失败就把 SHELL 换成系统自带的 Windows PowerShell。
    static PROBED: std::sync::OnceLock<ServerShell> = std::sync::OnceLock::new();
    let state = *PROBED.get_or_init(|| server_shell_state(&backend));
    if state != ServerShell::Broken {
        return Ok(backend);
    }
    if apply_server_shell_fallback() {
        crate::append_log("[auth] 服务端起不了 store 版 pwsh，已改用 Windows PowerShell，重新连接\n");
        return discover_inner().map_err(|err| redact(&err));
    }
    crate::append_log("[auth] 服务端起不了 shell，且兜底失败，按原配置继续\n");
    Ok(backend)
}

/// 需不需要向服务端实测 shell。
///
/// 两个条件同时成立才探测：
///   1. 服务配置里**没有**显式 SHELL —— 有就不动，那可能是用户自己选的
///      cmd / bash / 便携版 pwsh，覆盖它就是违背用户意图；
///   2. PATH 里的 pwsh 来自 WindowsApps —— 外壳能跑、服务端可能跑不了。
///
/// 「已经显式配了」这条同时挡住了重复重启：兜底写完 SHELL 后，下一轮
/// discover 会直接跳过探测，不会每 5 秒再 start 一次服务。
fn needs_server_shell_probe() -> bool {
    if read_service_shell().is_some_and(|current| !current.trim().is_empty()) {
        return false;
    }
    crate::shellprobe::pwsh_from_windows_store()
}

/// 服务端 shell 的三态判定：只有明确的「坏」才去改配置并重启服务。
#[derive(Debug, Clone, Copy, PartialEq)]
enum ServerShell {
    /// 服务端真能跑。
    Ok,
    /// 服务端明确起不来（HTTP 500，或命令 exit != 0）。
    Broken,
    /// 探测本身没成（网络/超时/格式变化）：保守不动。
    Unknown,
}

/// 让服务端真跑一条 `exit 0`，看它到底能不能起 shell。
///
/// 起不来时 `/api/shell` 直接回 500（实测 `failed to spawn ... pwsh.EXE`）；
/// 网络抖动、超时、响应格式变化都归 Unknown，避免误改配置把服务重启一遍。
fn server_shell_state(backend: &Backend) -> ServerShell {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .build();
    let body = serde_json::json!({
        "command": "exit 0",
        "cwd": std::env::temp_dir().to_string_lossy(),
    })
    .to_string();
    let resp = match agent
        .post(&format!("{}/api/shell", backend.base))
        .set("cookie", &backend.cookie)
        .set("content-type", "application/json")
        .send_string(&body)
    {
        Ok(resp) => resp,
        Err(ureq::Error::Status(code, _)) if code >= 500 => return ServerShell::Broken,
        Err(_) => return ServerShell::Unknown,
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&resp.into_string().unwrap_or_default())
    else {
        return ServerShell::Unknown;
    };
    let Some(id) = value["data"]["id"].as_str().map(str::to_string) else {
        return ServerShell::Unknown;
    };
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        thread::sleep(Duration::from_millis(150));
        let url = format!("{}/api/shell/{id}", backend.base);
        let Ok(resp) = agent.get(&url).set("cookie", &backend.cookie).call() else {
            return ServerShell::Unknown;
        };
        let text = resp.into_string().unwrap_or_default();
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            let status = value["data"]["status"].as_str().unwrap_or_default();
            if !status.is_empty() && status != "running" {
                return if value["data"]["exit"].as_i64() == Some(0) {
                    ServerShell::Ok
                } else {
                    ServerShell::Broken
                };
            }
        }
        if Instant::now() >= deadline {
            return ServerShell::Unknown;
        }
    }
}

/// 把 SHELL 写进服务配置并重启；成功返回 true。
///
/// `service set env` 自己会先停服务，所以写完必须重新 start 一次。
fn apply_server_shell_fallback() -> bool {
    let Some(powershell) = crate::shellprobe::powershell_path() else {
        return false;
    };
    let value = powershell.to_string_lossy().into_owned();
    let Some(_guard) = RestartClaim::acquire() else {
        crate::append_log("[auth] 另一个实例正在调整服务配置，跳过本次兜底\n");
        return false;
    };
    crate::append_log(&format!("[auth] 服务端起不了 store 版 pwsh，改用：{value}\n"));
    if run_inner(
        &["service", "set", "env", "SHELL", &value],
        SERVICE_CONFIG_TIMEOUT,
    )
    .is_err()
    {
        return false;
    }
    let _ = write_shell_marker(&value);
    let _ = run_start(&["service", "start"], SERVICE_START_TIMEOUT);
    true
}

/// opencode 服务的 `SHELL` 现状与目标：`Some(要设的值)` / `None(该清掉)`。
///
/// **为什么必须写进服务配置而不是给 CLI 塞环境变量**：实测 `opencode service
/// start/restart` **不继承调用方的环境变量**（它只从 service.json 的 `env` 读），
/// 塞 `SHELL` 给 CLI 对守护进程毫无作用。`service set env SHELL <路径>` 才是
/// 官方支持的做法，写完持久生效，重启服务也不会丢。
#[derive(Debug, PartialEq)]
enum ShellPlan {
    /// 把 SHELL 设成这个值（pwsh 坏了，改走 Windows PowerShell）。
    Set(String),
    /// 把 SHELL 清掉（pwsh 已经好了，别一直压着它）。
    Clear,
}

/// 需要改动服务配置时返回计划；配置已经正确就返回 None（不发任何命令）。
///
/// 四条原则：
///   1. 用户手工把 SHELL 设成别的东西（cmd / bash / 自己装的 pwsh / 便携版 powershell）
///      时**既不覆盖、也不清理**——判据是标记文件记录的「我们写过的值」，不是路径长得像；
///   2. 我们写过的那份，在 pwsh 恢复健康后要撤掉，别让用户永远被钉在 5.1；
///   3. 配置已经对得上就不发任何命令（不白停一次服务）；
///   4. 1.3.6 及更早版本没有标记文件：只有「当前值 == 这次要兜底写入的值」时才认领——
///      此时 pwsh 正坏着，那份配置只可能是旧版兜底写的。
fn shell_plan() -> Option<ShellPlan> {
    let desired = crate::shellprobe::shell_override();
    let current = read_service_shell();
    let mut marker = read_shell_marker();

    if marker.is_none() {
        if let (Some(have), Some(want)) = (current.as_deref(), desired.as_deref()) {
            if paths_equal(have, want) && write_shell_marker(have).is_ok() {
                marker = Some(have.to_string());
            }
        }
    }

    let plan = plan_shell(marker.as_deref(), current.as_deref(), desired.as_deref());

    // Store/MSIX 版 pwsh：外壳进程用短别名能跑（所以 desired 是 None），但服务进程
    // 解析成 WindowsApps 包目录里的 exe 会 spawn 失败（见 auth::discover 的服务端实测）。
    // 这种情况不能按「pwsh 好了」把兜底撤掉：撤了服务端立刻又坏，下一轮 discover
    // 再设回来，等于每次启动白停两次服务。等用户换掉这份 pwsh 再恢复。
    if matches!(plan, Some(ShellPlan::Clear)) && crate::shellprobe::pwsh_from_windows_store() {
        crate::append_log("[auth] PATH 里的 pwsh 来自 WindowsApps，保留上一轮的 shell 兜底\n");
        return None;
    }

    plan
}

/// 纯决策：`marker` 是我们上次写进服务配置的值，`current` 是现在的值，`desired` 是探针结论。
fn plan_shell(
    marker: Option<&str>,
    current: Option<&str>,
    desired: Option<&str>,
) -> Option<ShellPlan> {
    let ours = |value: &str| marker.is_some_and(|saved| paths_equal(saved, value));
    match desired {
        // pwsh 坏了，需要兜底。
        Some(want) => {
            if let Some(have) = current {
                if paths_equal(have, want) {
                    return None; // 已经是我们要的值
                }
                if !ours(have) {
                    return None; // 用户自己的选择，一个字节都别动
                }
            }
            Some(ShellPlan::Set(want.to_string()))
        }
        // pwsh 好了：只撤掉自己写过的那一份。
        None => match current {
            Some(have) if ours(have) => Some(ShellPlan::Clear),
            _ => None,
        },
    }
}


/// 读 `opencode service get env SHELL`；没设过或命令失败都是 None。
fn read_service_shell() -> Option<String> {
    let text = run(&["service", "get", "env", "SHELL"]).ok()?;
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    // 输出里夹着 CLI 自己的日志行时就当没设过，别拿日志当路径。
    (line.contains('\\') || line.contains('/')).then(|| line.to_string())
}

fn paths_equal(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// 记录「服务配置里的 SHELL 是我们自己写的」。
///
/// 为什么不能只看路径：用户完全可以把 SHELL 设成自己的一份
/// `D:\tools\WindowsPowerShell\v1.0\powershell.exe`（便携版），
/// 旧实现按路径后缀判断，会把这份配置当成自己的、pwsh 一好就删掉。
fn shell_marker_path() -> PathBuf {
    workbench_local_dir().join("shell-fallback.marker")
}

fn read_shell_marker() -> Option<String> {
    read_trimmed(&shell_marker_path())
}

fn write_shell_marker(value: &str) -> std::io::Result<()> {
    let path = shell_marker_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(path, value)
}

fn clear_shell_marker() {
    let _ = std::fs::remove_file(shell_marker_path());
}


/// 改服务配置用的超时。
///
/// `service set env` 内部会先 stop 服务再写盘，实测单次要 3~4 秒；默认的
/// [`CMD_TIMEOUT`]（5 秒）余量太薄，慢机器/杀软环境会超时误判成失败。
const SERVICE_CONFIG_TIMEOUT: Duration = Duration::from_secs(60);

/// 占位文件超过这个时间还留着，说明认领它的进程已经死了，可以接管。
const CLAIM_STALE: Duration = Duration::from_secs(300);

/// 把计划写进服务配置；失败时返回原因（含 stderr 片段）。
///
/// `service set env` 自己会先 stop 服务（opencode 侧实现），调用方随后要重新 start。
fn apply_shell_plan(plan: &ShellPlan) -> Result<(), String> {
    let args: &[&str] = match plan {
        ShellPlan::Set(value) => &["service", "set", "env", "SHELL", value],
        ShellPlan::Clear => &["service", "unset", "env", "SHELL"],
    };
    run_inner(args, SERVICE_CONFIG_TIMEOUT).map(|_| ())
}

/// 「我正在改配置并重启服务」的认领凭证。
///
/// 两个作用：
///   1. 并发互斥——同时开多个工作台时，只让一个去改配置/重启服务；
///   2. **进程被服务重启连带杀掉时自动失效**：认领文件里写了持有者的 PID，
///      下一个实例看到 PID 已经不存在就直接接管，不必干等 [`CLAIM_STALE`]。
///
/// 这一条是压测挖出来的真 bug：原来的实现只在成功路径删认领，进程在
/// `service set env` 停掉服务的那一刻被杀，认领就永久残留，之后所有实例都被挡在
/// 「别人正在处理」的判断上，坏 pwsh 再也修不了。
struct RestartClaim {
    path: PathBuf,
}

impl RestartClaim {
    /// 尝试认领；拿不到（别人正在处理且还活着）返回 None。
    fn acquire() -> Option<RestartClaim> {
        let path = shell_claim_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Some(token) = read_trimmed(&path) {
            if !claim_is_expired(&token, &path) {
                return None;
            }
            // 持有者已经死了（或超时）：清掉重新认领。
            let _ = std::fs::remove_file(&path);
        }
        use std::io::Write;
        let token = std::process::id().to_string();
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let _ = file.write_all(token.as_bytes());
                Some(RestartClaim { path })
            }
            // 别人抢先创建了：让给它。
            Err(_) => None,
        }
    }
}

impl Drop for RestartClaim {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// 认领是否已失效：持有者进程没了，或文件超过 [`CLAIM_STALE`]。
fn claim_is_expired(token: &str, path: &Path) -> bool {
    let alive = token
        .lines()
        .next()
        .and_then(|line| line.trim().parse::<u32>().ok())
        .map(|pid| pid == std::process::id() || pid_is_running(pid))
        .unwrap_or(false);
    if !alive {
        return true;
    }
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .map(|at| at.elapsed().map(|age| age > CLAIM_STALE).unwrap_or(false))
        .unwrap_or(false)
}

/// 进程是否还活着（Windows：能拿到进程句柄就是在跑）。
///
/// 只做一次 `OpenProcess` + `CloseHandle`，不读目标进程内存。
fn pid_is_running(pid: u32) -> bool {
    #[cfg(windows)]
    {
        // PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        // SAFETY: 仅查询句柄，失败返回 null（进程已退出或无权限）。
        let handle = unsafe { OpenProcess(0x1000, 0, pid) };
        if handle.is_null() {
            return false;
        }
        unsafe { CloseHandle(handle) };
        true
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        false
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}

fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// 「正在重启」的占位文件，`create_new` 做并发互斥。
fn shell_claim_path() -> PathBuf {
    workbench_local_dir().join("shell-fallback.claim")
}

fn workbench_local_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("oc-workbench")
}

fn discover_inner() -> Result<Backend, String> {
    // opencode 没装 / 找不到：先定位，别白等服务启动窗口。
    if resolve_opencode().is_none() {
        return Err(missing_opencode());
    }
    // 服务没跑时自动拉起：用户只双击 exe，不再需要先开命令行跑 opencode。
    // `service start` 是幂等的——已有服务会立刻返回现有地址，不会重复启动。
    // 正常「未运行」是 Ok("stopped")；这里的 Err 属于异常（超时/CLI 损坏），必须报出来。
    let mut status = match run(&["service", "status"]) {
        Ok(text) => text,
        Err(err) => return Err(format!("`opencode service status` 执行失败：{err}")),
    };
    let mut auto_started = false;
    // pwsh 坏了就把它从 opencode 的 shell 候选里顶掉。opencode 的 ShellSelect 顺序是
    // pwsh → powershell → git bash → cmd，取第一个就直接用、不验证能否启动；而
    // Store/MSIX 版的 pwsh 别名起不来时它也不回退，整条 shell 工具直接报错。
    // 这里写服务配置而不是给 CLI 塞环境变量：实测 `service start/restart` 不继承
    // 调用方环境，塞 SHELL 对守护进程无效。
    if let Some(plan) = shell_plan() {
        let key = match &plan {
            ShellPlan::Set(value) => value.clone(),
            ShellPlan::Clear => "clear".to_string(),
        };
        if let Some(_guard) = RestartClaim::acquire() {
            crate::append_log(&format!("[auth] 调整 opencode 的 shell 配置：{key}\n"));
            match apply_shell_plan(&plan) {
                Ok(()) => {
                    // 记下「这份配置是我们写的」，下次 pwsh 好了才敢清理。
                    match &plan {
                        ShellPlan::Set(value) => {
                            let _ = write_shell_marker(value);
                        }
                        ShellPlan::Clear => clear_shell_marker(),
                    }
                    // service set/unset env 会先停服务，这里重新拉起并等就绪。
                    let deadline = Instant::now() + SERVICE_START_TIMEOUT;
                    let _ = run_start(&["service", "start"], SERVICE_START_TIMEOUT);
                    status = run(&["service", "status"]).unwrap_or_default();
                    while find_base(&status).is_none() && Instant::now() < deadline {
                        thread::sleep(START_POLL);
                        status = run(&["service", "status"]).unwrap_or_default();
                    }
                    auto_started = true;
                }
                Err(err) => {
                    // 改配置失败不强求：服务可能还在跑，按原样继续连。
                    crate::append_log(&format!("[auth] 设置 SHELL 失败，继续沿用原配置：{err}\n"));
                    status = run(&["service", "status"]).unwrap_or_default();
                }
            }
        }
    }
    if find_base(&status).is_none() {
        // 「启动 + 等就绪」共用同一个截止时间：start 耗掉的时间也算在里面，
        // 否则两个窗口会叠加，discover 锁被长期占住。
        let deadline = Instant::now() + SERVICE_START_TIMEOUT;
        auto_started = true;
        match run_start(&["service", "start"], SERVICE_START_TIMEOUT) {
            Ok(()) => {
                // 先查一次再进循环：start 刚成功时旧 status 里可能还没有地址
                status = run(&["service", "status"]).unwrap_or_default();
                while find_base(&status).is_none() {
                    if Instant::now() >= deadline {
                        return Err(format!(
                            "服务已启动，但 {} 秒内 `service status` 仍没有地址",
                            SERVICE_START_TIMEOUT.as_secs()
                        ));
                    }
                    thread::sleep(START_POLL);
                    status = run(&["service", "status"]).unwrap_or_default();
                }
            }
            Err(err) => {
                // 启动命令失败：服务可能其实已在跑（例如端口占用但服务已存在），先查一次
                status = run(&["service", "status"]).unwrap_or_default();
                if find_base(&status).is_none() {
                    return Err(format!("自动启动服务失败：{err}"));
                }
            }
        }
    }
    let base = find_base(&status).ok_or_else(|| {
        format!(
            "`opencode service status` 输出里没有服务地址（http://<主机>:<端口>）：{}",
            snippet(&status, 200)
        )
    })?;
    // 刚拉起的服务可能已监听但还没准备好：先短探活，避免首轮 pair 必然失败
    if auto_started {
        probe_ready(&base);
    }
    let port = port_of(&base)
        .ok_or_else(|| format!("`opencode service status` 给了地址但解析不出端口：{base}"))?;
    let pair = run(&["pair"]).map_err(|err| format!("`opencode pair` 执行失败：{err}"))?;
    // 解析失败时**不回显 pair 原文**：那是一枚 5 分钟有效的一次性配对链接，
    // 不能因为格式变化就把它写进 gui-error.log（后台每 5 秒重试会反复写）。
    let link = find_link(&pair).ok_or_else(|| {
        "`opencode pair` 输出里没有 /auth/connect/ 配对链接（原文已省略，避免配对链接落日志）"
            .to_string()
    })?;

    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(Duration::from_secs(10))
        .build();

    // 302 会被 ureq 当成正常响应返回（redirects(0)）；个别版本包成 Err(Status)，两种都取。
    let raw = match agent.get(&link).set("accept", "text/html").call() {
        Ok(resp) => resp.header("set-cookie").map(|v| v.to_string()),
        Err(ureq::Error::Status(_, resp)) => resp.header("set-cookie").map(|v| v.to_string()),
        Err(err) => return Err(format!("打开配对链接失败（{base}）：{err}")),
    }
    .ok_or_else(|| format!("配对链接没有返回 set-cookie（{base}）"))?;

    let cookie = raw
        .split(';')
        .next()
        .ok_or_else(|| "配对返回的 set-cookie 为空".to_string())?
        .trim()
        .to_string();
    // 只比对 cookie 名，避免把凭据本身写进日志。
    let cookie_name = cookie.split('=').next().unwrap_or("").to_string();
    if !cookie.starts_with(&format!("opencode_session_{port}=")) {
        return Err(format!(
            "cookie 名与服务端口不匹配：期望 opencode_session_{port}=...，实际 {cookie_name}=..."
        ));
    }

    Ok(Backend { base, cookie })
}

#[cfg(test)]
mod restart_tests {
    use super::*;

    #[test]
    fn paths_compare_case_insensitively_with_trim() {
        assert!(paths_equal(
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"  c:\windows\system32\windowspowershell\v1.0\powershell.exe  "
        ));
        assert!(!paths_equal(r"C:\a\pwsh.exe", r"C:\b\pwsh.exe"));
    }


    /// 本机 PID 一定存活。
    #[test]
    fn own_pid_is_alive() {
        assert!(pid_is_running(std::process::id()), "自己的 PID 必须判活");
    }

    fn claim_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ocwb-claim-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建目录");
        dir
    }

    /// 认领过期判定：NaN 之类的坏 token 一律按过期处理（宁可重试）。
    #[test]
    fn malformed_token_is_expired() {
        let dir = claim_dir("bad");
        let path = dir.join("a.claim");
        std::fs::write(&path, "not-a-pid").expect("写占位");
        assert!(claim_is_expired("not-a-pid", &path));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 认领过期判定：自己持有的 token 必须判活（除非超时）。
    #[test]
    fn own_token_is_not_expired() {
        let dir = claim_dir("own");
        let path = dir.join("b.claim");
        let token = format!("{}\nC:\\x\\pwsh.exe", std::process::id());
        std::fs::write(&path, &token).expect("写占位");
        assert!(!claim_is_expired(&token, &path), "自己的认领不该判过期");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 死进程留下的认领必须立刻可被接管（压测挖出的真 bug 的回归）。
    ///
    /// 场景：上一个工作台在 `service set env` 停服务时被连带杀掉，认领残留；
    /// 旧实现要干等 5 分钟才接管，用户在这期间「坏 pwsh 一直修不了」。
    #[test]
    fn claim_from_dead_process_is_taken_over() {
        let dir = claim_dir("dead");
        let path = dir.join("c.claim");
        let token = "999999\nC:\\x\\pwsh.exe";
        std::fs::write(&path, token).expect("写死进程认领");
        assert!(claim_is_expired(token, &path), "死进程的认领必须立刻可被接管");
        let _ = std::fs::remove_dir_all(&dir);
    }
}



#[cfg(test)]
mod server_shell_probe_tests {
    use super::*;

    /// 起一个只会按固定脚本应答的假服务端，模拟 /api/shell。
    fn fake_server(
        post_status: u16,
        post_body: &'static str,
        get_body: &'static str,
    ) -> String {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("起假服务");
        let port = server.server_addr().to_ip().expect("拿到端口").port();
        std::thread::spawn(move || {
            for _ in 0..6 {
                let Ok(request) = server.recv() else { break };
                let is_post = request.url() == "/api/shell";
                let (status, body) = if is_post {
                    (post_status, post_body)
                } else {
                    (200, get_body)
                };
                let response = tiny_http::Response::from_string(body).with_status_code(status);
                let _ = request.respond(response);
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    fn backend(base: String) -> Backend {
        Backend {
            base,
            cookie: "opencode_session_1=x".to_string(),
        }
    }

    /// 服务端 500（实测 failed to spawn pwsh.EXE 就是这条）必须判坏。
    #[test]
    fn http_500_is_broken() {
        let base = fake_server(500, "boom", "{}");
        assert_eq!(server_shell_state(&backend(base)), ServerShell::Broken);
    }

    /// 正常返回 + 最终 exit 0：判好，不应该去改配置。
    #[test]
    fn exit_zero_is_healthy() {
        let base = fake_server(
            200,
            r#"{"data":{"id":"sh_1","status":"running"}}"#,
            r#"{"data":{"id":"sh_1","status":"exited","exit":0}}"#,
        );
        assert_eq!(server_shell_state(&backend(base)), ServerShell::Ok);
    }

    /// 能起来但命令失败（exit != 0）：同样算坏，要走兜底。
    #[test]
    fn non_zero_exit_is_broken() {
        let base = fake_server(
            200,
            r#"{"data":{"id":"sh_1","status":"running"}}"#,
            r#"{"data":{"id":"sh_1","status":"exited","exit":1}}"#,
        );
        assert_eq!(server_shell_state(&backend(base)), ServerShell::Broken);
    }

    /// 响应里没有 id（格式变了/被中间件拦了）：保守判 Unknown，不乱动。
    #[test]
    fn missing_id_is_unknown() {
        let base = fake_server(200, "not json", "{}");
        assert_eq!(server_shell_state(&backend(base)), ServerShell::Unknown);
    }
}

#[cfg(test)]
mod shell_plan_tests {
    use super::*;

    const PS: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";

    fn set(value: &str) -> Option<ShellPlan> {
        Some(ShellPlan::Set(value.to_string()))
    }

    /// 什么都没配、pwsh 又坏了：写入兜底。
    #[test]
    fn sets_fallback_when_nothing_configured() {
        assert_eq!(plan_shell(None, None, Some(PS)), set(PS));
    }

    /// 配置已经就是我们要的值：不发任何命令（不白停一次服务）。
    #[test]
    fn keeps_config_that_already_matches() {
        assert_eq!(plan_shell(Some(PS), Some(PS), Some(PS)), None);
    }

    /// 用户自己设的 SHELL 一律不覆盖、也不清理。
    ///
    /// 最后一条是回归：旧实现按「路径后缀」判断，会把用户自己放的便携版
    /// `WindowsPowerShell\v1.0\powershell.exe` 当成我们写的，pwsh 一好就删掉。
    #[test]
    fn never_touches_user_values() {
        let users = [
            r"C:\Windows\System32\cmd.exe",
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"D:\tools\WindowsPowerShell\v1.0\powershell.exe",
        ];
        for user in users {
            assert_eq!(
                plan_shell(None, Some(user), Some(PS)),
                None,
                "{user} 不该被覆盖"
            );
            assert_eq!(plan_shell(None, Some(user), None), None, "{user} 不该被清理");
        }
    }

    /// pwsh 恢复健康：只撤掉自己写过的那一份。
    #[test]
    fn clears_only_our_own_value() {
        assert_eq!(plan_shell(Some(PS), Some(PS), None), Some(ShellPlan::Clear));
        // 用户后来又手工改成别人的：不认，别删
        assert_eq!(
            plan_shell(Some(PS), Some(r"C:\Windows\System32\cmd.exe"), None),
            None
        );
    }

    /// 兜底目标变了（不同安装位置）：替换成新值，而不是干脆不管。
    #[test]
    fn replaces_our_fallback_when_target_changes() {
        let old = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
        let new = r"C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe";
        assert_eq!(plan_shell(Some(old), Some(old), Some(new)), set(new));
    }

    /// 路径比较不区分大小写：Windows 上同一个文件可能大小写不同。
    #[test]
    fn treats_case_variants_as_the_same_path() {
        let upper = r"C:\WINDOWS\SYSTEM32\WINDOWSPOWERSHELL\V1.0\POWERSHELL.EXE";
        assert_eq!(plan_shell(Some(upper), Some(PS), None), Some(ShellPlan::Clear));
        assert_eq!(plan_shell(Some(PS), Some(upper), Some(PS)), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个临时目录里写文件，用完自己清。
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ocwb-auth-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }
    /// 造一个「最小但合法」的 PE：MZ + e_lfanew 指向 PE\0\0。
    ///
    /// 只写 `MZ` 两个字节的假件会被 `is_pe` 判成非 PE——那正是我们想要的：
    /// 下载中断的半截 exe 不该被当成可执行文件。
    fn write_fake_pe(path: &Path) {
        let mut bytes = vec![0u8; 0x80];
        bytes[0] = b'M';
        bytes[1] = b'Z';
        // e_lfanew = 0x40
        bytes[0x3C..0x40].copy_from_slice(&0x40u32.to_le_bytes());
        bytes[0x40..0x44].copy_from_slice(b"PE\0\0");
        std::fs::write(path, bytes).expect("写假 PE");
    }


    #[test]
    fn real_pe_is_not_treated_as_shim() {
        let dir = temp_dir("pe");
        let exe = dir.join("opencode.exe");
        write_fake_pe(&exe);
        let target = classify(exe.clone());
        assert!(!target.shim);
        assert_eq!(target.program, exe);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cmd_and_bat_are_shims_case_insensitively() {
        assert!(classify(PathBuf::from(r"C:\Users\me\.local\bin\opencode.cmd")).shim);
        assert!(classify(PathBuf::from(r"C:\x\OPENCODE.CMD")).shim);
        assert!(classify(PathBuf::from(r"C:\x\opencode.BAT")).shim);
    }

    /// 这一条是本轮 bug 的核心回归：npm 在 Hermes 的 node 目录里落的
    /// `opencode` 是无扩展名 bash 脚本，必须判成 shim（走 cmd），
    /// 否则 CreateProcess 直接报 os error 193。
    #[test]
    fn extension_less_script_is_shim() {
        let dir = temp_dir("shim");
        let script = dir.join("opencode");
        std::fs::write(&script, b"#!/bin/sh\nexec \"$(dirname \"$0\")/opencode.exe\" \"$@\"\n")
            .expect("写假 shim");
        let target = classify(script.clone());
        assert!(target.shim, "无扩展名的 shell 包装必须按 shim 处理");
        assert_eq!(target.program, script);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 明明存在同名 .exe 时，不能拿着无扩展名脚本去启动。
    #[test]
    fn prefers_sibling_exe_over_extension_less_script() {
        let dir = temp_dir("sibling");
        let script = dir.join("opencode");
        std::fs::write(&script, b"#!/bin/sh\n").expect("写假 shim");
        let exe = dir.join("opencode.exe");
        write_fake_pe(&exe);

        assert_eq!(pick_runnable(&script), exe, "应换成同目录的真 PE");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 同目录没有 .exe 时，退到 .cmd（那也是能启动的）。
    #[test]
    fn falls_back_to_sibling_cmd() {
        let dir = temp_dir("sibling-cmd");
        let script = dir.join("opencode");
        std::fs::write(&script, b"#!/bin/sh\n").expect("写假 shim");
        let cmd = dir.join("opencode.cmd");
        std::fs::write(&cmd, b"@echo off\r\n").expect("写假 cmd");

        assert_eq!(pick_runnable(&script), cmd);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 带扩展名的 shim 也要按 stem 找兄弟：`opencode.ps1` → `opencode.cmd`，
    /// 不能拼成 `opencode.ps1.cmd`（那永远不存在）。
    #[test]
    fn ps1_shim_maps_to_sibling_by_stem() {
        let dir = temp_dir("sibling-ps1");
        let ps1 = dir.join("opencode.ps1");
        std::fs::write(&ps1, b"# ps1\n").expect("写假 ps1");
        let cmd = dir.join("opencode.cmd");
        std::fs::write(&cmd, b"@echo off\r\n").expect("写假 cmd");

        assert_eq!(pick_runnable(&ps1), cmd);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 孤零零的无扩展名脚本（没有兄弟文件）也要原样用，由 cmd 去跑。
    #[test]
    fn keeps_lone_script_when_no_sibling() {
        let dir = temp_dir("lone");
        let script = dir.join("opencode");
        std::fs::write(&script, b"#!/bin/sh\n").expect("写假 shim");
        assert_eq!(pick_runnable(&script), script);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 候选表必须覆盖「本机实际装法」，否则换台机器又会找不到。
    #[test]
    fn candidates_cover_common_install_dirs() {
        let list = candidates();
        let text: Vec<String> = list
            .iter()
            .map(|path| path.to_string_lossy().to_lowercase())
            .collect();
        assert!(text.iter().any(|item| item.ends_with(r"\.local\bin\opencode.cmd")));
        assert!(text.iter().any(|item| item.ends_with(r"\.opencode\bin\opencode.exe")));
        assert!(text.iter().any(|item| item.ends_with(r"\npm\opencode.cmd")));
        // exe 同目录优先（绿色版）
        assert!(text[0].ends_with("opencode.exe"));
    }

    /// Hermes 自带 node 运行时，opencode 的 npm shim 会落在它目录下；
    /// 这个落点不在 PATH 时，候选表必须兜住（不然又是「找不到 opencode」）。
    #[test]
    fn candidates_cover_hermes_node_dir() {
        let text: Vec<String> = candidates()
            .iter()
            .map(|path| path.to_string_lossy().to_lowercase())
            .collect();
        assert!(
            text.iter().any(|item| item.ends_with(r"\hermes\node\opencode.cmd")),
            "候选表要包含 hermes\\node\\opencode.cmd：{text:?}"
        );
    }

    /// 缓存只存成功：解析到 shim 后第二次调用要命中同一份结果。
    #[test]
    fn resolve_caches_successful_lookup() {
        let dir = std::env::temp_dir().join(format!("ocwb-auth-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let fake = dir.join("opencode.cmd");
        std::fs::write(&fake, "@echo off\r\n").expect("写假 shim");

        std::env::set_var(OPENCODE_ENV, &fake);
        if let Ok(mut guard) = RESOLVED.lock() {
            *guard = None;
        }
        let first = resolve_opencode().expect("按环境变量应能定位");
        let second = resolve_opencode().expect("缓存后仍应能定位");
        assert!(first.shim);
        assert_eq!(first.program, second.program);

        std::env::remove_var(OPENCODE_ENV);
        if let Ok(mut guard) = RESOLVED.lock() {
            *guard = None;
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 端到端复现本轮 bug：Hermes 目录下同时存在 npm 的三份产物，
    /// 环境变量指向无扩展名那个，最终必须落到 `.cmd`（能启动、能读版本）。
    #[test]
    fn resolves_hermes_layout_to_runnable_cmd() {
        let dir = std::env::temp_dir().join(format!("ocwb-hermes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");

        let bare = dir.join("opencode");
        std::fs::write(&bare, b"#!/bin/sh\nexec node opencode.js \"$@\"\n").expect("写裸脚本");
        let cmd = dir.join("opencode.cmd");
        std::fs::write(&cmd, b"@echo off\r\nnode opencode.js %*\r\n").expect("写 cmd");
        let ps1 = dir.join("opencode.ps1");
        std::fs::write(&ps1, b"# ps1\n").expect("写 ps1");

        std::env::set_var(OPENCODE_ENV, &bare);
        if let Ok(mut guard) = RESOLVED.lock() {
            *guard = None;
        }

        let target = resolve_opencode().expect("应该能定位");
        assert_eq!(target.program, cmd, "必须换成同目录的 .cmd，而不是裸脚本");
        assert!(target.shim, ".cmd 要走 cmd 启动");

        std::env::remove_var(OPENCODE_ENV);
        if let Ok(mut guard) = RESOLVED.lock() {
            *guard = None;
        }
        let _ = std::fs::remove_dir_all(&dir);
    }


    /// `where` 的第一行是无扩展名脚本时必须跳过它，选同目录的 .cmd。
    /// 这条直接对应本轮 bug 的触发条件（Hermes 目录里的 npm shim）。
    #[test]
    fn pick_from_where_output_skips_extensionless_first() {
        let dir = temp_dir("where-pick");
        let bare = dir.join("opencode");
        std::fs::write(&bare, b"#!/bin/sh\n").expect("写裸脚本");
        let cmd = dir.join("opencode.cmd");
        std::fs::write(&cmd, b"@echo off\r\n").expect("写 cmd");

        // 模拟 where 的输出：裸脚本在前、.cmd 在后
        let text = format!("{}\r\n{}\r\n", bare.display(), cmd.display());
        assert_eq!(pick_from_where_output(&text), Some(cmd));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 有真 PE 时优先 PE，哪怕它排在 .cmd 后面。
    #[test]
    fn pick_from_where_output_prefers_pe() {
        let dir = temp_dir("where-pe");
        let cmd = dir.join("opencode.cmd");
        std::fs::write(&cmd, b"@echo off\r\n").expect("写 cmd");
        let exe = dir.join("opencode.exe");
        write_fake_pe(&exe);

        let text = format!("{}\r\n{}\r\n", cmd.display(), exe.display());
        assert_eq!(pick_from_where_output(&text), Some(exe));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 全是不可执行的文本时也别丢：退回第一个命中，让 cmd 去报错。
    #[test]
    fn pick_from_where_output_falls_back_to_first_hit() {
        let dir = temp_dir("where-text");
        let bare = dir.join("opencode");
        std::fs::write(&bare, b"#!/bin/sh\n").expect("写裸脚本");
        let text = format!("{}\r\n", bare.display());
        assert_eq!(pick_from_where_output(&text), Some(bare.clone()));
        // 不存在的路径不算命中
        assert_eq!(pick_from_where_output(r"C:\nope\opencode"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `where` 的输出是控制台代码页（中文系统 GBK），不是 UTF-8。
    ///
    /// 这是「装了却说没装」的另一半根因：按 UTF-8 解码后中文目录变成 U+FFFD，
    /// `is_file()` 必然 false，于是 pick_from_where_output 一个都选不出来。
    #[test]
    fn decode_console_handles_gbk_path() {
        // 「测试目录」的 GBK 字节
        let gbk = [
            0x46u8, 0x3A, 0x5C, 0x74, 0x6D, 0x70, 0x5C, 0xB2, 0xE2, 0xCA, 0xD4, 0xC4, 0xBF, 0xC2, 0xBC,
            0x5C, 0x6F, 0x70, 0x65, 0x6E, 0x63, 0x6F, 0x64, 0x65, 0x2E, 0x63, 0x6D, 0x64,
        ];
        assert_eq!(decode_console(&gbk), r"F:\tmp\测试目录\opencode.cmd");
        // 纯 ASCII（本机常见情况）走原样
        assert_eq!(decode_console(b"C:\\a\\opencode.cmd"), r"C:\a\opencode.cmd");
    }

    /// `service status` 打印的地址不一定是 127.0.0.1：服务端配了 host 时会打印
    /// `http://0.0.0.0:4096`（实测某台机器就是这样），旧实现只认 `http://127.0.0.1:`，
    /// 于是永远解析不到地址，白等 150 秒再报「仍没有地址」。
    #[test]
    fn find_base_accepts_wildcard_and_localhost() {
        assert_eq!(
            find_base("http://0.0.0.0:4096\n").as_deref(),
            Some("http://127.0.0.1:4096")
        );
        assert_eq!(
            find_base("http://127.0.0.1:28894\n").as_deref(),
            Some("http://127.0.0.1:28894")
        );
        assert_eq!(
            find_base("http://localhost:4096/\n").as_deref(),
            Some("http://127.0.0.1:4096")
        );
        assert_eq!(
            find_base("http://[::1]:4096\n").as_deref(),
            Some("http://127.0.0.1:4096")
        );
        // 绑在具体网卡上的地址保留原样，不硬改成回环
        assert_eq!(
            find_base("http://10.10.10.36:4096\n").as_deref(),
            Some("http://10.10.10.36:4096")
        );
        // 服务没跑时的写法
        assert_eq!(find_base("stopped"), None);
        assert_eq!(find_base(""), None);
    }

    /// `opencode pair` 一次打印多条链接（回环 + 各网卡），要挑回环那条。
    #[test]
    fn find_link_prefers_loopback_among_many() {
        let text = "  http://10.10.10.36:4096/auth/connect/AAA\n  http://127.0.0.1:4096/auth/connect/BBB\n";
        assert_eq!(
            find_link(text).as_deref(),
            Some("http://127.0.0.1:4096/auth/connect/BBB")
        );
        // 通配地址归一成回环后也能用
        assert_eq!(
            find_link("http://0.0.0.0:4096/auth/connect/CCC").as_deref(),
            Some("http://127.0.0.1:4096/auth/connect/CCC")
        );
        assert_eq!(find_link("no link here"), None);
    }

    #[test]
    fn port_of_accepts_any_host() {
        assert_eq!(port_of("http://127.0.0.1:4096").as_deref(), Some("4096"));
        assert_eq!(port_of("http://10.10.10.36:28894/").as_deref(), Some("28894"));
        assert_eq!(port_of("http://nope"), None);
    }
}
