//! 远程访问的 ssh 反向隧道：由 exe 自己建立和维持，不需要人手动跑脚本。
//!
//! 链路：服务器 `127.0.0.1:<relayPort>` --ssh -R--> 本机 `127.0.0.1:<localPort>`
//! （`relayPort` 是登录/配对时网关分配的，`localPort` 就是本机工作台端口，默认 17800）。
//!
//! 行为：
//!   * 只要 exe 在跑就保持这条隧道；ssh 退出自动重连（5s 起，逐步退避到 30s）
//!   * 配置（relayPort / tunnelHost）变了就重建，不用重启 exe
//!   * exe 关闭时把子进程一起清掉；被强杀留下的孤儿在下次启动时清理
//!
//! 为什么不用脚本：要求是「打开 exe 就在线」。脚本要手动跑、要设开机自启、
//! 断线还得靠 watchdog 巡检，任何一环没配好，网页端看到的就是「离线」。
//!
//! **线程代际**：`apply` 可能被调用多次（启动一次、登录拿到 relayPort 又一次）。
//! 不能用「一个全局 STOPPED 标志」来停旧线程 —— 第二次 apply 会把标志重置成
//! false，旧线程从 sleep 醒来看到 false 就复活了。实测两个 ssh 抢同一个服务器
//! 端口：一个成功、另一个每 5 秒 exit 255 刷日志。所以每次重建都递增 GENERATION，
//! 线程只在自己那一代仍然有效时才继续。
//!
//! 系统操作（找 ssh / 杀进程 / 记 PID）在 [`crate::tunnel_proc`]。

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use crate::tunnel_proc as proc;
use crate::update;

/// settings.json 里的键：服务器上分给这台设备的回环端口。
const RELAY_KEY: &str = "relayPort";
/// settings.json 里的键：ssh 目标（别名或 user@host）。
const HOST_KEY: &str = "tunnelHost";
/// 没配 tunnelHost 时用的目标：与 scripts/remote-tunnel.ps1 保持一致，
/// 老机器只要 ssh config 里有这条别名就能直接工作。
const DEFAULT_HOST: &str = "tiku";
const RETRY_MIN: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(30);

/// 隧道配置。相同配置不重复重建（避免每次拉设备列表都闪断一次）。
#[derive(Clone, PartialEq, Eq)]
struct TunnelConfig {
    local_port: u16,
    relay_port: u16,
    host: String,
}

static CURRENT: Mutex<Option<TunnelConfig>> = Mutex::new(None);
/// 当前有效的代际号；不相等说明这个线程已经被新的 apply 取代。
static GENERATION: AtomicU64 = AtomicU64::new(0);
static CHILD_PID: AtomicU32 = AtomicU32::new(0);
static LOCAL_PORT: AtomicU32 = AtomicU32::new(0);

/// 读配置：优先 settings.json 里的 relayPort / tunnelHost。
fn read_config(local_port: u16) -> Option<TunnelConfig> {
    if local_port == 0 {
        return None;
    }
    let relay_port = update::number_setting(RELAY_KEY)
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| *value > 0)?;
    let host = update::text_setting(HOST_KEY)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_HOST.to_string());
    Some(TunnelConfig {
        local_port,
        relay_port,
        host,
    })
}

/// 按当前配置起隧道；配置没变就什么都不做。
///
/// 可以重复调用：启动时调一次、登录认领拿到 relayPort 后再调一次。
pub fn apply(local_port: u16) {
    if local_port > 0 {
        LOCAL_PORT.store(local_port as u32, Ordering::SeqCst);
    }
    let port = LOCAL_PORT.load(Ordering::SeqCst) as u16;
    let Some(config) = read_config(port) else {
        return;
    };
    // 上一代 exe 可能留下孤儿隧道（被强杀/崩溃时来不及清），先清掉：
    // 它一直占着服务器端口，不清的话新隧道每次 -R 都失败（exit 255）。
    clean_stale_once(config.relay_port);
    {
        let guard = match CURRENT.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if guard.as_ref() == Some(&config) {
            return;
        }
    }
    retire_current();
    let generation = GENERATION.load(Ordering::SeqCst);
    {
        let mut guard = match CURRENT.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        *guard = Some(config.clone());
    }
    crate::append_log(&format!(
        "[tunnel] 建立隧道：服务器 127.0.0.1:{} -> 本机 127.0.0.1:{}（ssh {}）\n",
        config.relay_port, config.local_port, config.host
    ));
    thread::spawn(move || keep_alive(config, generation));
}

/// 停掉当前隧道（exe 退出或配置变更时）。
pub fn stop() {
    retire_current();
    let mut guard = match CURRENT.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    *guard = None;
}

/// 让现有线程失效并杀掉它的子进程。代际号 +1 是唯一可靠的失效方式。
fn retire_current() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    let pid = CHILD_PID.swap(0, Ordering::SeqCst);
    if pid > 0 {
        proc::kill_pid(pid);
    }
}

fn still_current(generation: u64) -> bool {
    GENERATION.load(Ordering::SeqCst) == generation
}

/// 只清理一次：配置重建时不能再扫，否则会杀掉自己刚起的进程。
fn clean_stale_once(relay_port: u16) {
    static CLEANED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if CLEANED.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(pid) = proc::take_pid() {
        // 只杀确认是 ssh 的进程：PID 可能已经被别的程序复用。
        if pid > 0 && pid != std::process::id() && proc::is_ssh(pid) {
            crate::append_log(&format!("[tunnel] 清理上次残留的隧道进程 pid={pid}\n"));
            proc::kill_pid(pid);
        }
    }
    // 首次升级没有 pid 文件，按端口再扫一遍（也会清掉用户手动跑的脚本）。
    proc::kill_by_port(relay_port);
    thread::sleep(proc::RELEASE_GRACE);
}

/// 后台线程：起 ssh、等它退出、退避重连。
fn keep_alive(config: TunnelConfig, generation: u64) {
    let mut backoff = RETRY_MIN;
    loop {
        if !still_current(generation) {
            return;
        }
        match proc::spawn_ssh(config.relay_port, config.local_port, &config.host) {
            Ok(mut child) => {
                CHILD_PID.store(child.id(), Ordering::SeqCst);
                proc::remember_pid(child.id());
                backoff = RETRY_MIN;
                // 不能「进程起来就清错误」：ssh 失败时也是先起来再退出（DNS 解析失败、
                // 端口被占都是秒退），那样错误会在「有」和「没有」之间每 5 秒翻转，
                // 界面根本看不清原因。改成「活过 3 秒才算连上」，连上才清。
                let mut early_exit = None;
                for _ in 0..6 {
                    thread::sleep(Duration::from_millis(500));
                    if !still_current(generation) {
                        proc::kill_pid(child.id());
                        return;
                    }
                    match child.try_wait() {
                        Ok(None) => {}
                        Ok(Some(status)) => {
                            early_exit = Some(status);
                            break;
                        }
                        Err(_) => break,
                    }
                }
                if early_exit.is_none() {
                    crate::tunnel_status::set_error(None);
                }
                // try_wait 已经收割过时不能再 wait（不同平台行为不一致），直接用观察到的状态。
                let status = match early_exit {
                    Some(status) => Ok(status),
                    None => child.wait(),
                };
                CHILD_PID.store(0, Ordering::SeqCst);
                proc::forget_pid();
                if !still_current(generation) {
                    return;
                }
                // 常见原因：服务器上该端口已被别的 ssh 占着、密钥没配好、网络断了。
                // 具体报错在 tunnel.log 里（stderr 直接重定向过去），这里转成人话给界面。
                let detail = crate::tunnel_status::last_log_line().unwrap_or_default();
                let reason = match status {
                    Ok(code) => format!("{code}"),
                    Err(err) => format!("等待失败：{err}"),
                };
                crate::tunnel_status::set_error(Some(crate::tunnel_status::describe_failure(
                    &detail,
                    &config.host,
                    reason.as_str(),
                )));
                crate::append_log(&format!(
                    "[tunnel] ssh 退出（{reason}），{} 秒后重连\n",
                    backoff.as_secs()
                ));
            }
            Err(err) => {
                crate::tunnel_status::set_error(Some(format!("启动 ssh 失败：{err}")));
                crate::append_log(&format!("[tunnel] 启动 ssh 失败：{err}\n"));
            }
        }
        // 分秒睡：配置变更时能立刻退出，不用等满退避时间。
        let mut left = backoff;
        while left > Duration::ZERO {
            if !still_current(generation) {
                return;
            }
            let step = left.min(Duration::from_secs(1));
            thread::sleep(step);
            left -= step;
        }
        backoff = (backoff * 2).min(RETRY_MAX);
    }
}

/// 给界面的隧道状态（`GET /local/account/tunnel`）。
///
/// running = ssh 子进程在不在；error = 最近一次失败的人话原因。
pub fn status_json() -> String {
    let (host, relay, local) = match CURRENT.lock() {
        Ok(guard) => match guard.as_ref() {
            Some(cfg) => (cfg.host.clone(), cfg.relay_port, cfg.local_port),
            None => (String::new(), 0, 0),
        },
        Err(poisoned) => match poisoned.into_inner().as_ref() {
            Some(cfg) => (cfg.host.clone(), cfg.relay_port, cfg.local_port),
            None => (String::new(), 0, 0),
        },
    };
    crate::tunnel_status::status_json(&host, relay, local, CHILD_PID.load(Ordering::SeqCst))
}
