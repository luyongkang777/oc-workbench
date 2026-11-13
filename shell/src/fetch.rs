//! 下载与解压的共用小工具（opencode CLI 与便携版 git 都用）。
//!
//! 抽出来只为一件事：解压 zip 的路径很讲究——PATH 里的 `tar` 可能是 Git Bash 的
//! GNU tar（不认 zip），必须先试 `%SystemRoot%\System32\tar.exe`（Win10 1803+
//! 的 bsdtar，认 zip），再退回 PowerShell 的 `Expand-Archive`。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 统一的 HTTP Agent：显式走 Windows 证书库（schannel）。
///
/// ureq 的 `native-tls` feature 只是提供 `impl TlsConnector`，不显式传进去
/// HTTPS 会直接报「no TLS backend is configured」。
pub fn agent(overall: Duration, read: Option<Duration>) -> Result<ureq::Agent, String> {
    let connector =
        native_tls::TlsConnector::new().map_err(|err| format!("初始化 TLS 连接器失败：{err}"))?;
    let mut builder = ureq::AgentBuilder::new()
        .tls_connector(std::sync::Arc::new(connector))
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout(overall);
    if let Some(read) = read {
        builder = builder.timeout_read(read);
    }
    Ok(builder.build())
}

/// 下载到文件（先写 `.part` 再改名，断网不会留下半截「看起来能用」的文件）。
pub fn download_to(
    url: &str,
    dest: &Path,
    expected: u64,
    max: u64,
    read_timeout: Duration,
) -> Result<u64, String> {
    let part = dest.with_extension("part");
    let _ = fs::remove_file(&part);

    let agent = agent(Duration::from_secs(900), Some(read_timeout))?;
    let response = agent.get(url).call().map_err(|err| match err {
        ureq::Error::Status(code, _) => format!("下载失败：HTTP {code}"),
        other => format!("下载失败：{other}"),
    })?;

    let limit = if expected > 0 { expected } else { max }.min(max);
    let mut reader = response.into_reader();
    let mut file = fs::File::create(&part).map_err(|err| format!("建临时文件失败：{err}"))?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut copied: u64 = 0;
    loop {
        let read = reader.read(&mut buf).map_err(|err| {
            let _ = fs::remove_file(&part);
            format!("读下载流失败：{err}")
        })?;
        if read == 0 {
            break;
        }
        file.write_all(&buf[..read]).map_err(|err| {
            let _ = fs::remove_file(&part);
            format!("写文件失败：{err}")
        })?;
        copied += read as u64;
        if copied > limit {
            let _ = fs::remove_file(&part);
            return Err(format!("下载体积超过声明（>{limit} 字节），已丢弃"));
        }
    }
    file.flush().map_err(|err| format!("写文件失败：{err}"))?;
    drop(file);

    if expected > 0 && copied != expected {
        let _ = fs::remove_file(&part);
        return Err(format!(
            "下载体积不对：期望 {expected} 字节，实际 {copied} 字节，已丢弃"
        ));
    }

    // 头两字节必须是 PK：避免把一段 HTML 错误页当成 zip 解压下去
    let mut head = [0u8; 2];
    {
        let mut probe = fs::File::open(&part).map_err(|err| format!("回读失败：{err}"))?;
        probe
            .read_exact(&mut head)
            .map_err(|err| format!("回读失败：{err}"))?;
    }
    if &head != b"PK" {
        let _ = fs::remove_file(&part);
        return Err("下载到的不是 zip（缺少 PK 头），已丢弃".to_string());
    }

    let _ = fs::remove_file(dest);
    fs::rename(&part, dest).map_err(|err| format!("改名失败：{err}"))?;
    Ok(copied)
}

fn run_quiet(command: &mut Command) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn ps_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

/// 解压 zip 到 `out`（目录会被清空重建）。
pub fn extract_zip(zip: &Path, out: &Path) -> Result<(), String> {
    if out.exists() {
        let _ = fs::remove_dir_all(out);
    }
    fs::create_dir_all(out).map_err(|err| format!("建解压目录失败：{err}"))?;

    // 1) 系统自带的 bsdtar（认 zip）。PATH 里的 GNU tar 不认，所以写绝对路径优先。
    let mut tars: Vec<PathBuf> = Vec::new();
    if let Some(root) = std::env::var_os("SystemRoot") {
        tars.push(PathBuf::from(root).join("System32").join("tar.exe"));
    }
    tars.push(PathBuf::from("tar"));
    for tar in tars {
        if run_quiet(Command::new(&tar).arg("-xf").arg(zip).arg("-C").arg(out)) {
            return Ok(());
        }
    }

    // 2) PowerShell 兜底
    let script = format!(
        "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath {} -DestinationPath {} -Force",
        ps_quote(zip),
        ps_quote(out)
    );
    let ok = run_quiet(
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
            ])
            .arg(script),
    );
    if ok {
        Ok(())
    } else {
        Err("解压失败：系统 tar 与 PowerShell 都没成功".to_string())
    }
}

/// 在目录里按文件名找文件（大小写不敏感，最多往下 `depth` 层）。
pub fn find_named(dir: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    let wanted = name.to_ascii_lowercase();
    let entries = fs::read_dir(dir).ok()?;
    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if path.file_name()?.to_string_lossy().to_ascii_lowercase() == wanted {
                return Some(path);
            }
        } else if path.is_dir() && depth > 0 {
            dirs.push(path);
        }
    }
    for sub in dirs {
        if let Some(found) = find_named(&sub, name, depth - 1) {
            return Some(found);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_named_file_case_insensitively() {
        let dir = std::env::temp_dir().join(format!("oc-fetch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let nested = dir.join("a").join("b");
        fs::create_dir_all(&nested).expect("建目录");
        fs::write(nested.join("Git.EXE"), b"MZ").expect("写文件");

        let found = find_named(&dir, "git.exe", 3).expect("应该能找到");
        assert_eq!(found, nested.join("Git.EXE"));
        assert!(find_named(&dir, "nope.exe", 3).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ps_quote_doubles_single_quotes() {
        assert_eq!(ps_quote(Path::new("C:\\a'b")), "'C:\\a''b'");
    }
}
