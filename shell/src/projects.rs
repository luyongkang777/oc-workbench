//! 项目清单的落盘。
//!
//! 外壳只当存储：读回原样 JSON、写入原样 JSON。列表逻辑（去重、排序、每个项目
//! 记住的界面状态）全在前端一处实现，避免 Rust/TS 两套规则慢慢走偏。
//!
//! 为什么不能放 localStorage：本地服务端口每次启动都变，页面 origin 跟着变，
//! localStorage 按 origin 分区，跨不了启动；所以沿用 root.txt 的落盘思路。

use std::path::{Path, PathBuf};

const PROJECTS_NAME: &str = "projects.json";
/// 清单是纯文本，几十个项目也就几 KB。超过 1 MB 基本是写坏了，不落盘。
pub(crate) const MAX_BYTES: usize = 1024 * 1024;
const EMPTY: &str = "[]";

/// 主存储位置：%LOCALAPPDATA%\\oc-workbench\\projects.json（exe 可能在只读目录）。
pub(crate) fn projects_file() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    let dir = base.join("oc-workbench");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join(PROJECTS_NAME))
}

/// 读写候选：先主位置，再 exe 同目录（兼容老版本/便携放置）。
fn candidates() -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Some(path) = projects_file() {
        list.push(path);
    }
    if let Some(path) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(PROJECTS_NAME)))
    {
        list.push(path);
    }
    list
}

/// 读清单；都没有或内容不像数组时回 `[]`，让前端从空清单开始。
pub(crate) fn load() -> String {
    for path in candidates() {
        if let Some(text) = read_text(&path) {
            return text;
        }
    }
    EMPTY.to_string()
}

/// 写清单。写失败返回原因（调用方记日志，不影响界面）。
pub(crate) fn save(json: &str) -> Result<(), String> {
    let text = check(json)?;
    let mut last: Option<String> = None;
    for path in candidates() {
        match write_text(&path, text) {
            Ok(()) => return Ok(()),
            Err(err) => last = Some(err),
        }
    }
    Err(last.unwrap_or_else(|| "没有可写位置".to_string()))
}

/// 写入前把关：大小、非空、必须是 JSON 数组。返回修剪后的文本。
fn check(json: &str) -> Result<&str, String> {
    let text = json.trim();
    if text.is_empty() {
        return Err("清单是空的".to_string());
    }
    if text.len() > MAX_BYTES {
        return Err(format!("清单过大（{} 字节，上限 {MAX_BYTES}）", text.len()));
    }
    if !text.starts_with('[') || !text.ends_with(']') {
        return Err("清单必须是 JSON 数组".to_string());
    }
    Ok(text)
}

fn read_text(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let trimmed = text.trim();
    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn write_text(path: &Path, json: &str) -> Result<(), String> {
    std::fs::write(path, json).map_err(|err| format!("{}：{err}", path.display()))
}

#[cfg(test)]
#[path = "projects_tests.rs"]
mod tests;
