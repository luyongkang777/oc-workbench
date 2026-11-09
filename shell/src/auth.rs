//! 找本地 opencode 服务，并拿到带认证的 cookie。
//!
//! 流程（实测 v2.2.5）：
//!   1. `opencode service status` 打印服务地址，例如 http://127.0.0.1:28894
//!   2. `opencode pair` 打印一次性配对链接 http://127.0.0.1:<port>/auth/connect/<code>
//!   3. 用带 `Accept: text/html` 的 GET 打开链接 → 302 + Set-Cookie: opencode_session_<port>=<token>
//!      （不带 text/html 只回 JSON token，那个 token 拿来当 Bearer 会 401）
//!
//! 注意：npm 装的 `opencode` 是 .cmd shim，`Command::new("opencode")` 在 Windows 找不到，
//! 必须走 `cmd /C opencode ...`。
//!
//! 每条子命令最多等 5 秒（[`CMD_TIMEOUT`]）：服务锁、UAC 拦截、shim 弹交互都会让
//! `Command::output()` 永久阻塞，而这段代码跑在后台线程里 —— 卡住就是不回复且没日志。
//!
//! 所有失败都返回带原因的错误字符串（命令、io::Error、退出码、stderr 片段），
//! 由 server 的后台重试线程写进 gui-error.log —— 这是排查「为什么没连接上后端」的唯一线索。

use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

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
/// 服务未运行时的自动启动等待窗口（冷启动要起 node + 初始化）。
const SERVICE_START_TIMEOUT: Duration = Duration::from_secs(45);
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

#[cfg(windows)]
fn command_for(args: &[&str]) -> Command {
    use std::os::windows::process::CommandExt;

    let mut cmd = Command::new("cmd");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.arg("/C").arg("opencode");
    for arg in args {
        cmd.arg(arg);
    }
    cmd
}

#[cfg(not(windows))]
fn command_for(args: &[&str]) -> Command {
    let mut cmd = Command::new("opencode");
    for arg in args {
        cmd.arg(arg);
    }
    cmd
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
    kill_tree_on_timeout: bool,
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
            // 启动命令（service start）超时只能结束直接子进程：它可能已经把服务作为
            // 后代拉起来了，整树 taskkill 会把刚启动的服务一起杀掉。
            if kill_tree_on_timeout {
                kill_tree(child);
            } else {
                let _ = child.kill();
                let _ = child.wait();
            }
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
    strict: bool,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    // 管道收尾固定 5 秒。`service start` 拉起的服务会继承并持有 stdout/stderr，
    // 管道可能永远不关，所以那种调用传 strict=false，只用已收到的输出。
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

    if received < 2 && strict {
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
    run_inner(args, CMD_TIMEOUT, true)
}

/// 启动服务专用：超时只结束直接子进程，管道收不齐也不算失败。
/// `opencode service start` 把服务 detach 到后台后，stdout/stderr 可能被它继续持有。
fn run_start(args: &[&str], timeout: Duration) -> Result<String, String> {
    run_inner(args, timeout, false)
}

fn run_inner(args: &[&str], timeout: Duration, strict: bool) -> Result<String, String> {
    let mut cmd = command_for(args);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|err| {
        format!(
            "执行 `opencode {}` 失败：{err}（确认 opencode 已安装并在 PATH 里）",
            args.join(" ")
        )
    })?;

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

    let status = wait_with_timeout(&mut child, args, timeout, strict)?;
    let (stdout, stderr) = collect_output(&receiver, args, strict)?;

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
    // 服务没跑时自动拉起：用户只双击 exe，不再需要先开命令行跑 opencode。
    // `service start` 是幂等的——已有服务会立刻返回现有地址，不会重复启动。
    let mut status = match run(&["service", "status"]) {
        Ok(text) => text,
        Err(err) => {
            // 命令本身起不来（没装 / 不在 PATH）：直接返回诊断，别白等启动窗口
            if err.contains("确认 opencode 已安装") {
                return Err(err);
            }
            // 服务未运行时 status 可能以非 0 退出：继续走自动启动
            String::new()
        }
    };
    if find_base(&status).is_none() {
        // 「启动 + 等就绪」共用同一个截止时间：start 耗掉的时间也算在里面，
        // 否则两个 45 秒窗口会叠加成 90 秒以上，discover 锁被长期占住。
        let deadline = Instant::now() + SERVICE_START_TIMEOUT;
        let started = run_start(&["service", "start"], SERVICE_START_TIMEOUT);
        if let Ok(text) = &started {
            if find_base(text).is_some() {
                status = text.clone();
            }
        }
        while find_base(&status).is_none() {
            if Instant::now() >= deadline {
                let detail = match &started {
                    Ok(text) => snippet(text, 200),
                    Err(err) => err.clone(),
                };
                return Err(format!(
                    "服务未运行，自动执行 `opencode service start` 后约 {} 秒内仍未就绪（{}）",
                    SERVICE_START_TIMEOUT.as_secs(),
                    detail
                ));
            }
            thread::sleep(START_POLL);
            status = run(&["service", "status"]).unwrap_or_default();
        }
    }
    let base = find_base(&status).ok_or_else(|| {
        format!(
            "`opencode service status` 输出里没有 http://127.0.0.1:<端口>：{}",
            snippet(&status, 200)
        )
    })?;
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
