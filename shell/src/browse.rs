//! 目录浏览：`/local/browse`（列目录）与 `/local/browse/mkdir`（新建文件夹）。
//!
//! 手机 / 浏览器里选项目不该让人手输路径（以前的实现是 `window.prompt`）。
//! 这里给前端一个「从盘符逐级点进去」的只读接口：**只列目录、不读文件内容**，
//! 路径必须是绝对路径，鉴权与 `/local/*` 其它接口一致（Host + x-oc-token/cookie）。
//!
//! 为什么不能复用 `/local/fs/list`：那个接口把一切限制在「当前项目根」之内，
//! 而选新项目恰恰要从根之外开始浏览。

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tiny_http::{Method, Request};

use crate::body::{read_body_with_timeout, BodyRead};
use crate::fsutil::{param, parse_query};

/// 单个目录最多返回多少子目录：C:\Windows\System32 也就几千个，给 1000 够用且不卡手机。
const MAX_DIRS: usize = 1000;
const BODY_LIMIT: usize = 8 * 1024;
/// Windows 文件名里不允许的字符。
const NAME_BAD: [char; 9] = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

pub fn handle(request: Request, path: &str, url: &str) {
    match path {
        "/local/browse" => list(request, url),
        "/local/browse/mkdir" => mkdir(request),
        _ => {
            let _ = crate::server::json_error(request, 404, "未知的目录接口");
        }
    }
}

fn list(request: Request, url: &str) {
    if request.method() != &Method::Get {
        let _ = crate::server::json_error(request, 405, "列目录只支持 GET");
        return;
    }
    let pairs = parse_query(url);
    let raw = param(&pairs, "path").unwrap_or("").trim().to_string();

    // 不给路径 → 盘符列表（前端用它当「根」）。
    if raw.is_empty() {
        let body = json!({
            "path": "",
            "parent": "",
            "drives": list_drives(),
            "dirs": [],
            "truncated": false,
        });
        let _ = crate::server::respond_json(request, 200, body.to_string());
        return;
    }

    let dir = PathBuf::from(&raw);
    if !dir.is_absolute() {
        let _ = crate::server::json_error(request, 400, "需要绝对路径（例如 C:\\Users）");
        return;
    }
    let reader = match fs::read_dir(&dir) {
        Ok(reader) => reader,
        Err(err) => {
            let _ = crate::server::json_error(request, 400, &format!("打不开这个目录：{err}"));
            return;
        }
    };

    let mut dirs: Vec<(String, String)> = Vec::new();
    let mut truncated = false;
    for entry in reader.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // 只列目录（含指向目录的链接）。判断失败就跳过，不要因此整页报错。
        let is_dir = match entry.file_type() {
            Ok(kind) => kind.is_dir() || (kind.is_symlink() && entry.path().is_dir()),
            Err(_) => false,
        };
        if !is_dir || is_noise(&name) {
            continue;
        }
        dirs.push((name, entry.path().to_string_lossy().to_string()));
        if dirs.len() >= MAX_DIRS {
            truncated = true;
            break;
        }
    }
    dirs.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));

    let body = json!({
        "path": display_path(&dir),
        "parent": parent_of(&dir),
        "drives": [ ],
        "dirs": dirs.into_iter().map(|(name, path)| json!({"name": name, "path": path})).collect::<Vec<_>>(),
        "truncated": truncated,
    });
    let _ = crate::server::respond_json(request, 200, body.to_string());
}

/// 新建一个文件夹（「创建新项目」就是先建一个空目录）。
fn mkdir(request: Request) {
    if request.method() != &Method::Post {
        let _ = crate::server::json_error(request, 405, "新建文件夹只支持 POST");
        return;
    }
    let Some((request, body)) = read_body_with_timeout(request, BODY_LIMIT) else {
        return;
    };
    let text = match body {
        BodyRead::Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
        BodyRead::TooLarge => {
            let _ = crate::server::json_error(request, 413, "请求体过大");
            return;
        }
        BodyRead::Failed(err) => {
            let _ = crate::server::json_error(request, 400, &format!("读取请求体失败：{err}"));
            return;
        }
    };
    let value: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(err) => {
            let _ = crate::server::json_error(request, 400, &format!("请求体不是 JSON：{err}"));
            return;
        }
    };

    let parent = value.get("parent").and_then(Value::as_str).unwrap_or("").trim();
    let name = value.get("name").and_then(Value::as_str).unwrap_or("").trim();
    if parent.is_empty() || !Path::new(parent).is_absolute() {
        let _ = crate::server::json_error(request, 400, "需要绝对路径的上级目录");
        return;
    }
    if let Err(message) = check_name(name) {
        let _ = crate::server::json_error(request, 400, &message);
        return;
    }

    let target = Path::new(parent).join(name);
    if target.exists() {
        let _ = crate::server::json_error(request, 409, "同名文件夹已存在");
        return;
    }
    match fs::create_dir(&target) {
        Ok(()) => {
            let body = json!({ "ok": true, "path": target.to_string_lossy() });
            let _ = crate::server::respond_json(request, 200, body.to_string());
        }
        Err(err) => {
            let _ = crate::server::json_error(request, 500, &format!("新建文件夹失败：{err}"));
        }
    }
}

fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("文件夹名不能为空".to_string());
    }
    if name == "." || name == ".." {
        return Err("文件夹名不能用 . 或 ..".to_string());
    }
    if name.chars().any(|c| NAME_BAD.contains(&c)) {
        return Err("文件夹名不能包含 \\ / : * ? \" < > |".to_string());
    }
    if name.chars().count() > 100 {
        return Err("文件夹名过长".to_string());
    }
    // Windows 会把结尾的点和空格吃掉，提前拦住免得建出来名字对不上。
    if name.ends_with('.') || name.ends_with(' ') {
        return Err("文件夹名不能以点或空格结尾".to_string());
    }
    Ok(())
}

#[link(name = "kernel32")]
extern "system" {
    fn GetLogicalDrives() -> u32;
    fn GetDriveTypeW(root: *const u16) -> u32;
}

/// 盘符列表。
///
/// 用 `GetDriveTypeW` 判断类型，而不是 `read_dir` 试探：机器上挂着**已断开的网络驱动器**
/// 时，`read_dir("Z:\\")` 会阻塞到系统超时（几十秒），用户看到的就是「列目录超时」。
/// 这里只保留本地固定盘和可移动盘（U 盘），跳过网络盘与光驱。
fn list_drives() -> Vec<Value> {
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for index in 0..26u32 {
        if mask & (1 << index) == 0 {
            continue;
        }
        let letter = (b'A' + index as u8) as char;
        let path = format!("{letter}:\\");
        let mut wide: Vec<u16> = path.encode_utf16().collect();
        wide.push(0);
        let kind = unsafe { GetDriveTypeW(wide.as_ptr()) };
        if kind != DRIVE_FIXED && kind != DRIVE_REMOVABLE {
            continue;
        }
        out.push(json!({ "name": format!("{letter}:"), "path": path }));
    }
    out
}

/// 去掉尾部分隔符（`C:\Users\` → `C:\Users`），盘符根保留 `C:\`。
fn display_path(dir: &Path) -> String {
    let text = dir.to_string_lossy().to_string();
    if text.len() > 3 {
        text.trim_end_matches(['\\', '/']).to_string()
    } else {
        text
    }
}

/// 上一级；盘符根返回空串（前端据此显示盘符列表）。
fn parent_of(dir: &Path) -> String {
    match dir.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => display_path(parent),
        _ => String::new(),
    }
}

/// 回收站、系统卷信息这类目录普通账号进不去，列出来只会让用户点一次报错。
///
/// 只挡这两个：它们由系统创建在卷根，普通账号必然打不开。
/// 不要再按名字挡别的（比如 `recovery`）—— 用户自己的项目目录可能正好叫这个名字。
fn is_noise(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        "$recycle.bin" | "system volume information"
    )
}

#[cfg(test)]
mod tests {
    use super::{check_name, display_path, parent_of};
    use std::path::Path;

    #[test]
    fn check_name_rejects_windows_illegal_names() {
        assert!(check_name("workbench").is_ok());
        assert!(check_name("我的项目 1").is_ok());
        assert!(check_name("").is_err());
        assert!(check_name(".").is_err());
        assert!(check_name("..").is_err());
        assert!(check_name("a/b").is_err());
        assert!(check_name("a\\b").is_err());
        assert!(check_name("a:b").is_err());
        assert!(check_name("a?b").is_err());
        assert!(check_name("a*b").is_err());
        assert!(check_name("a|b").is_err());
        assert!(check_name("tail.").is_err());
        assert!(check_name("tail ").is_err());
        assert!(check_name(&"x".repeat(101)).is_err());
    }

    #[test]
    fn display_path_strips_trailing_separator_but_keeps_drive_root() {
        assert_eq!(display_path(Path::new("C:\\Users\\a1890\\")), "C:\\Users\\a1890");
        assert_eq!(display_path(Path::new("C:\\")), "C:\\");
    }

    #[test]
    fn parent_of_drive_root_is_empty() {
        assert_eq!(parent_of(Path::new("C:\\")), "");
        assert_eq!(parent_of(Path::new("C:\\Users")), "C:\\");
        assert_eq!(parent_of(Path::new("C:\\Users\\a1890")), "C:\\Users");
    }
}
