//! `projects` 模块单元测试：原样读写、非数组拒绝、超大拒绝、缺文件回空清单。
//!
//! 只用临时目录，不碰真实 %LOCALAPPDATA%，避免测试互相污染。

use std::path::PathBuf;

use super::{check, read_text, write_text, MAX_BYTES};

fn temp_dir(tag: &str) -> PathBuf {
    let name = format!(
        "oc-workbench-projects-{tag}-{}",
        std::process::id() as u64 + std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u64)
            .unwrap_or(0)
    );
    let dir = std::env::temp_dir().join(name);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[test]
fn 原样读写清单() {
    let dir = temp_dir("roundtrip");
    let path = dir.join("projects.json");
    let json = r#"[{"path":"F:\\a","name":"a","state":{"file":"src/x.ts"}}]"#;

    write_text(&path, json).expect("写入应成功");
    assert_eq!(read_text(&path).as_deref(), Some(json));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn 写入会去掉首尾空白() {
    let dir = temp_dir("trim");
    let path = dir.join("projects.json");

    write_text(&path, "  []  \n").expect("写入应成功");
    assert_eq!(read_text(&path).as_deref(), Some("[]"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn 缺文件时不认() {
    let dir = temp_dir("missing");
    assert!(read_text(&dir.join("nope.json")).is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn 内容不是数组时不认() {
    let dir = temp_dir("notarray");
    let path = dir.join("projects.json");

    write_text(&path, r#"{"projects":[]}"#).expect("写入应成功");
    assert!(read_text(&path).is_none(), "对象形状应被当成坏数据");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn 空清单拒绝() {
    assert!(check("   ").is_err());
}

#[test]
fn 非数组拒绝() {
    assert!(check(r#"{"a":1}"#).is_err());
    assert!(check("[1,2] trailing").is_err());
}

#[test]
fn 超大拒绝() {
    let big = format!("[{}]", "\"x\"".repeat(MAX_BYTES / 3 + 32));
    assert!(check(&big).is_err(), "超过上限应拒绝");
}

#[test]
fn 正常数组通过并被修剪() {
    assert_eq!(check("  [ {\"a\":1} ]  ").unwrap(), "[ {\"a\":1} ]");
}
