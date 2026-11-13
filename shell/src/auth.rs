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
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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

/// 一次定位的结果：真正要启动的程序，以及它是不是批处理 shim。
#[derive(Clone, Debug)]
struct Target {
    program: PathBuf,
    /// `.cmd` / `.bat` 必须经 cmd.exe 启动；`.exe` 直接启动更快也不用操心引号。
    shim: bool,
}

/// 已成功定位的结果会缓存在这里（只缓存成功）。
///
/// 不缓存失败：用户装完 opencode 回来点「重试」应该立刻能用，
/// 而失败时每 5 秒重试一次、每次多跑一个 `where` 也就几十毫秒。
static RESOLVED: Mutex<Option<Target>> = Mutex::new(None);

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|value| !value.as_os_str().is_empty())
}

/// 按扩展名判断要不要走 cmd。`.cmd` / `.bat` 是批处理，直接 CreateProcess 会失败。
fn classify(path: PathBuf) -> Target {
    let shim = path
        .extension()
        .map(|ext| {
            let ext = ext.to_string_lossy().to_ascii_lowercase();
            ext == "cmd" || ext == "bat"
        })
        .unwrap_or(false);
    Target { program: path, shim }
}

/// PATH 之外的常见安装位置，按「最可能命中」排序。
///
/// 这些目录换台机器后通常仍然成立，是「双击 exe 就能用」的主要保障：
///   * 工作台 exe 同目录（绿色版：把 opencode.exe 丢在旁边）
///   * `%USERPROFILE%\.local\bin`（bun / npm 装的 shim 落点，实测本机就是这里）
///   * `%USERPROFILE%\.opencode\bin`（官方安装器）
///   * `%LOCALAPPDATA%\Programs\opencode`、`%APPDATA%\npm`（系统级安装）
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
    }
    if let Some(roaming) = env_path("APPDATA") {
        out.push(roaming.join("npm").join("opencode.cmd"));
        out.push(roaming.join("npm").join("opencode.exe"));
    }
    if let Some(program_files) = env_path("ProgramFiles") {
        out.push(program_files.join("opencode").join("opencode.exe"));
    }
    out
}

/// 用 `where <name>` 在 PATH 上找，返回第一个真实存在的文件。
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

    let found = resolve_opencode_uncached();
    if let Some(hit) = found.as_ref() {
        if let Ok(mut guard) = RESOLVED.lock() {
            *guard = Some(hit.clone());
        }
    }
    found
}

fn resolve_opencode_uncached() -> Option<Target> {
    // 1. 显式指定优先。允许给「路径」或「命令名」，两种都认。
    if let Some(raw) = env_path(OPENCODE_ENV) {
        if raw.is_file() {
            return Some(classify(raw));
        }
        if let Some(found) = where_lookup(&raw.to_string_lossy()) {
            return Some(classify(found));
        }
        // 形如 `opencode2.cmd` 但仍找不到：退回按名字启动，让 cmd 自己报错
        return Some(classify(raw));
    }

    // 2. PATH
    if let Some(found) = where_lookup("opencode") {
        return Some(classify(found));
    }

    // 3. 已知安装位置
    candidates()
        .into_iter()
        .find(|path| path.is_file())
        .map(classify)
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
    let mut cmd = if target.shim {
        // 批处理必须经 cmd。整条命令行是 `cmd /C "<shim>" <args>`：
        // 余下部分里只有一对引号且引号内是可执行文件，cmd 会原样保留这对引号，
        // 带空格的安装路径也不会被拆开（实测）。
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(&target.program);
        for arg in args {
            cmd.arg(arg);
        }
        cmd
    } else {
        let mut cmd = Command::new(&target.program);
        for arg in args {
            cmd.arg(arg);
        }
        cmd
    };
    cmd.creation_flags(CREATE_NO_WINDOW);
    Ok(cmd)
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

fn trimmed(text: &str, start: usize) -> String {
    let rest = &text[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
        .unwrap_or(rest.len());
    rest[..end].to_string()
}

/// 从一段文本里截出一个 http://127.0.0.1:<port> 形式的地址。
fn find_base(text: &str) -> Option<String> {
    let start = text.find("http://127.0.0.1:")?;
    let base = trimmed(text, start);
    let base = base.trim_end_matches('/');
    if base.len() > "http://127.0.0.1:".len() {
        Some(base.to_string())
    } else {
        None
    }
}

fn find_link(text: &str) -> Option<String> {
    let start = text.find("http://127.0.0.1:")?;
    let link = trimmed(text, start);
    if link.contains("/auth/connect/") {
        Some(link)
    } else {
        None
    }
}

fn port_of(url: &str) -> Option<String> {
    let after = url.strip_prefix("http://127.0.0.1:")?;
    let port: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    if port.is_empty() {
        None
    } else {
        Some(port)
    }
}

pub fn discover() -> Result<Backend, String> {
    // 所有错误串统一过一遍：配对链接（等同一次性凭据）不能进日志或界面。
    discover_inner().map_err(|err| redact(&err))
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
            "`opencode service status` 输出里没有 http://127.0.0.1:<端口>：{}",
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
        "`opencode pair` 输出里没有 127.0.0.1 的 /auth/connect/ 链接（原文已省略，避免配对链接落日志）"
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
mod tests {
    use super::*;

    #[test]
    fn exe_is_not_treated_as_shim() {
        let target = classify(PathBuf::from(r"C:\tools\opencode.exe"));
        assert!(!target.shim);
        assert_eq!(target.program, PathBuf::from(r"C:\tools\opencode.exe"));
    }

    #[test]
    fn cmd_and_bat_are_shims_case_insensitively() {
        assert!(classify(PathBuf::from(r"C:\Users\me\.local\bin\opencode.cmd")).shim);
        assert!(classify(PathBuf::from(r"C:\x\OPENCODE.CMD")).shim);
        assert!(classify(PathBuf::from(r"C:\x\opencode.BAT")).shim);
    }

    #[test]
    fn no_extension_is_not_shim() {
        assert!(!classify(PathBuf::from(r"C:\x\opencode")).shim);
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
}
