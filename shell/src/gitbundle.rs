//! 便携版 git：机器上没装 git 时自动下 MinGit，解压到工作台自己的目录里用。
//!
//! 为什么要自己带一份：`/local/git/*` 全靠外部 git，而 Windows 上「装没装 git」
//! 是最不靠谱的一件事——Git for Windows 不保证进 PATH，GitHub Desktop 自带一份但
//! 藏在版本号目录里，绿色版到处放。与其让用户自己去找，不如缺了就直接下：
//!
//!   * 来源：git-for-windows/git 的 Release 资产 `MinGit-<ver>-64-bit.zip`
//!     （官方专门给「嵌进应用」用的精简版，无 GUI、无 bash，约 50 MB）
//!   * 落点：`%LOCALAPPDATA%\oc-workbench\git\`，纯用户目录，不需要管理员
//!   * 校验：解压后跑一次 `git --version`，跑不起来就整份作废重来
//!
//! 触发方式是**按需**：git 面板第一次访问发现没有 git 就起一个后台线程下载，
//! 当前这次请求立刻返回「正在下载，稍后重试」；面板本身会轮询，装完自动恢复。

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::fetch;

/// 发布列表接口；可用环境变量指向镜像。
pub const RELEASES_ENV: &str = "OC_GIT_RELEASES_API";
const DEFAULT_RELEASES_API: &str =
    "https://api.github.com/repos/git-for-windows/git/releases/latest";
const API_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(180);
/// MinGit 目前约 50 MB；留到 400 MB 是给「以后变大」的余量，不是正常值。
const MAX_DOWNLOAD: u64 = 400 * 1024 * 1024;
const VERIFY_TIMEOUT: Duration = Duration::from_secs(30);

static INSTALLING: AtomicBool = AtomicBool::new(false);

/// 正在下载/解压（面板据此显示不同的提示）。
pub fn installing() -> bool {
    INSTALLING.load(Ordering::Relaxed)
}

/// 便携版 git 的落点：`%LOCALAPPDATA%\oc-workbench\git\cmd\git.exe`。
pub fn managed_exe() -> Option<PathBuf> {
    let base = crate::update::data_dir()?.join("git");
    managed_exe_in(&base)
}

fn managed_exe_in(base: &std::path::Path) -> Option<PathBuf> {
    // MinGit 的 zip 根目录就是安装根：`cmd/git.exe`、`mingw64/...`
    for rel in ["cmd/git.exe", "mingw64/bin/git.exe"] {
        let path = base.join(rel);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn releases_api() -> String {
    std::env::var(RELEASES_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_RELEASES_API.to_string())
}

/// 从发布 JSON 里挑 MinGit 资产。返回 (版本, 下载地址, 字节数)。
pub fn pick_mingit(text: &str, arch: &str) -> Result<(String, String, u64), String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|err| format!("发布列表不是合法 JSON：{err}"))?;
    let version = value
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let assets = value
        .get("assets")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "发布里没有 assets".to_string())?;

    // x64 用 `-64-bit.zip`；arm64 用 `-arm64.zip`。busybox 变体不带完整命令，跳过。
    let (keyword, suffix) = if arch == "aarch64" {
        ("mingit-", "-arm64.zip")
    } else {
        ("mingit-", "-64-bit.zip")
    };

    let mut best: Option<(Vec<u64>, String, String, u64)> = None;
    for asset in assets {
        let Some(name) = asset.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let lower = name.to_ascii_lowercase();
        if !lower.starts_with(keyword)
            || !lower.ends_with(suffix)
            || lower.contains("busybox")
        {
            continue;
        }
        let Some(url) = asset.get("browser_download_url").and_then(|v| v.as_str()) else {
            continue;
        };
        let size = asset.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
        // MinGit-2.47.1-64-bit.zip → 2.47.1
        let ver = name
            .trim_start_matches("MinGit-")
            .trim_start_matches("mingit-")
            .split('-')
            .next()
            .unwrap_or("")
            .to_string();
        let key: Vec<u64> = ver
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect();
        let replace = best.as_ref().map(|(k, _, _, _)| &key > k).unwrap_or(true);
        if replace {
            best = Some((key, ver, url.to_string(), size));
        }
    }

    best.map(|(_, ver, url, size)| {
        let version = if version.is_empty() {
            ver
        } else {
            version.trim_start_matches('v').to_string()
        };
        (version, url, size)
    })
    .ok_or_else(|| format!("发布里没有 MinGit（{suffix}）资产"))
}

fn run_version(exe: &std::path::Path) -> Result<String, String> {
    let mut command = Command::new(exe);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("启动 {} 失败：{err}", exe.display()))?;
    let (sender, receiver) = mpsc::channel();
    let mut stdout = child.stdout.take();
    thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = stdout.as_mut() {
            use std::io::Read;
            let _ = pipe.read_to_end(&mut buf);
        }
        let _ = sender.send(buf);
    });

    let deadline = Instant::now() + VERIFY_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(err) => return Err(format!("等待 --version 失败：{err}")),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("git --version 超过 30 秒没返回".to_string());
        }
        thread::sleep(Duration::from_millis(50));
    }
    let out = receiver
        .recv_timeout(Duration::from_secs(5))
        .unwrap_or_default();
    let text = String::from_utf8_lossy(&out).trim().to_string();
    if text.is_empty() {
        return Err("git --version 没有输出".to_string());
    }
    Ok(text)
}

fn fetch_release() -> Result<(String, String, u64), String> {
    let agent = fetch::agent(API_TIMEOUT, None)?;
    let mut text = String::new();
    {
        use std::io::Read;
        agent
            .get(&releases_api())
            .set("accept", "application/vnd.github+json")
            .set("user-agent", "oc-workbench-git")
            .call()
            .map_err(|err| match err {
                ureq::Error::Status(code, _) => format!("发布列表返回 HTTP {code}（可能是限流）"),
                other => format!("连不上发布列表：{other}"),
            })?
            .into_reader()
            .take(4 * 1024 * 1024)
            .read_to_string(&mut text)
            .map_err(|err| format!("读发布列表失败：{err}"))?;
    }
    pick_mingit(&text, std::env::consts::ARCH)
}

fn install_blocking() -> Result<PathBuf, String> {
    let dir = crate::update::data_dir()
        .ok_or_else(|| "没有 LOCALAPPDATA，无法确定安装目录".to_string())?
        .join("git");

    let (version, url, size) = fetch_release()?;
    crate::append_log(&format!(
        "[git] 没有可用的 git，开始下载便携版 {version}（{} MB）\n",
        size / 1024 / 1024
    ));

    // zip 放在目标目录外面：解压会清空目标目录
    let zip = crate::update::data_dir()
        .ok_or_else(|| "没有 LOCALAPPDATA，无法确定下载目录".to_string())?
        .join("git-bundle.zip");
    fetch::download_to(&url, &zip, size, MAX_DOWNLOAD, DOWNLOAD_READ_TIMEOUT)
        .map_err(|err| format!("下载便携版 git 失败：{err}"))?;

    fetch::extract_zip(&zip, &dir).map_err(|err| format!("解压便携版 git 失败：{err}"))?;
    let _ = fs::remove_file(&zip);

    let exe = managed_exe_in(&dir).ok_or_else(|| "解压后没找到 cmd/git.exe".to_string())?;
    let banner = run_version(&exe)?;
    crate::append_log(&format!(
        "[git] 便携版就绪：{}（{banner}）\n",
        exe.display()
    ));
    // 让 gitapi 丢掉「没找到」的印象，下一次请求直接用上
    crate::gitapi::reset_resolution();
    Ok(exe)
}

/// 按需触发一次后台安装（同一时刻只有一个）。返回给用户看的一句话。
pub fn request_install() -> String {
    if let Some(exe) = managed_exe() {
        return format!("便携版 git 已就绪：{}", exe.display());
    }
    if installing() {
        return "正在后台下载便携版 git（约 50 MB），完成后点「重试」即可".to_string();
    }
    INSTALLING.store(true, Ordering::Relaxed);
    thread::spawn(|| {
        let result = install_blocking();
        match &result {
            Ok(exe) => crate::append_log(&format!("[git] 自动安装完成：{}\n", exe.display())),
            Err(err) => crate::append_log(&format!("[git] 自动安装失败：{err}\n")),
        }
        INSTALLING.store(false, Ordering::Relaxed);
    });
    "本机没有 git，已在后台下载便携版（约 50 MB），完成后点「重试」即可".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RELEASE: &str = r#"{
      "tag_name": "v2.47.1.windows.1",
      "assets": [
        {"name":"MinGit-2.47.1-32-bit.zip","browser_download_url":"https://x/32.zip","size":10},
        {"name":"MinGit-2.47.1-64-bit.zip","browser_download_url":"https://x/64.zip","size":50},
        {"name":"MinGit-2.47.1-64-bit-busybox.zip","browser_download_url":"https://x/busy.zip","size":40},
        {"name":"MinGit-2.47.1-arm64.zip","browser_download_url":"https://x/arm.zip","size":45},
        {"name":"PortableGit-2.47.1-64-bit.7z.exe","browser_download_url":"https://x/portable.exe","size":60}
      ]
    }"#;

    #[test]
    fn picks_mingit_for_arch_and_skips_busybox() {
        let (version, url, size) = pick_mingit(RELEASE, "x86_64").expect("应该挑到 64 位包");
        assert_eq!(url, "https://x/64.zip");
        assert_eq!(size, 50);
        assert!(version.starts_with("2.47.1"));

        let (_, arm, _) = pick_mingit(RELEASE, "aarch64").expect("应该挑到 arm64 包");
        assert_eq!(arm, "https://x/arm.zip");
    }

    #[test]
    fn reports_missing_mingit() {
        let text = r#"{"tag_name":"v2.0.0","assets":[{"name":"PortableGit-2.0.0-64-bit.7z.exe","browser_download_url":"https://x/p.exe","size":1}]}"#;
        let err = pick_mingit(text, "x86_64").expect_err("没有 MinGit 就该报错");
        assert!(err.contains("MinGit"), "{err}");
    }

    #[test]
    fn managed_exe_only_when_present() {
        let dir = std::env::temp_dir().join(format!("oc-gitbundle-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert!(managed_exe_in(&dir).is_none());
        fs::create_dir_all(dir.join("cmd")).expect("建目录");
        fs::write(dir.join("cmd").join("git.exe"), b"MZ").expect("写文件");
        assert!(managed_exe_in(&dir).is_some());
        let _ = fs::remove_dir_all(&dir);
    }
}
