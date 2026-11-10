//! fsapi / fsindex / fsread 的单测：行数统计、分页窗口、编码与路径校验。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::resolve;
use crate::fsdecode;
use crate::fsindex;
use crate::fsread;

fn temp_dir() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|dur| dur.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("ocwb-fsapi-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

fn write_file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).expect("写临时文件");
    path
}

#[test]
fn utf8_line_count_and_window() {
    let dir = temp_dir();
    let path = write_file(&dir, "a.txt", b"alpha\nbeta\ngamma\n");
    let index = fsindex::index_for(&path).expect("建索引");
    assert!(!index.binary);
    assert_eq!(index.line_count, 3);

    let first = fsread::read_window(&path, &index, 0, 1).expect("读窗口");
    assert_eq!(first.text, "alpha");
    assert_eq!(first.next, 1);
    assert!(!first.eof);

    let rest = fsread::read_window(&path, &index, 1, 10).expect("读窗口");
    assert_eq!(rest.text, "beta\ngamma");
    assert_eq!(rest.next, 3);
    assert!(rest.eof);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn crlf_is_normalized() {
    let dir = temp_dir();
    let path = write_file(&dir, "win.txt", b"one\r\ntwo\r\n");
    let index = fsindex::index_for(&path).expect("建索引");
    assert_eq!(index.line_count, 2);
    let window = fsread::read_window(&path, &index, 0, 10).expect("读窗口");
    assert_eq!(window.text, "one\ntwo");
    assert!(!window.text.contains('\r'));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn no_trailing_newline_counts_last_line() {
    let dir = temp_dir();
    let path = write_file(&dir, "tail.txt", b"a\nb");
    let index = fsindex::index_for(&path).expect("建索引");
    assert_eq!(index.line_count, 2);
    let window = fsread::read_window(&path, &index, 1, 5).expect("读窗口");
    assert_eq!(window.text, "b");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn empty_file_has_no_lines() {
    let dir = temp_dir();
    let path = write_file(&dir, "empty.txt", b"");
    let index = fsindex::index_for(&path).expect("建索引");
    assert_eq!(index.line_count, 0);
    let window = fsread::read_window(&path, &index, 0, 10).expect("读窗口");
    assert_eq!(window.text, "");
    assert!(window.eof);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn long_file_uses_checkpoints() {
    let dir = temp_dir();
    let mut content = String::new();
    for i in 0..10_000 {
        content.push_str(&format!("line-{i}\n"));
    }
    let path = write_file(&dir, "big.log", content.as_bytes());
    let index = fsindex::index_for(&path).expect("建索引");
    assert_eq!(index.line_count, 10_000);
    // 10000 行至少要有 2 个检查点（0 与 4096）
    assert!(index.checkpoints.len() >= 2);

    let window = fsread::read_window(&path, &index, 9_000, 3).expect("读窗口");
    assert_eq!(window.text, "line-9000\nline-9001\nline-9002");
    assert_eq!(window.next, 9_003);
    assert_eq!(window.start, 9_000);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn utf16le_with_bom() {
    let dir = temp_dir();
    let mut bytes = vec![0xFF, 0xFE];
    for unit in "a\nb\n".encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    let path = write_file(&dir, "u16.txt", &bytes);
    let index = fsindex::index_for(&path).expect("建索引");
    assert_eq!(index.enc, fsindex::Enc::Utf16Le);
    assert_eq!(index.line_count, 2);
    // 索引正文起点已跳过 BOM；窗口里不应再出现 BOM
    let window = fsread::read_window(&path, &index, 0, 10).expect("读窗口");
    assert_eq!(window.text, "a\nb");
    assert!(!window.text.contains('\u{feff}'));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn binary_is_detected() {
    let dir = temp_dir();
    let path = write_file(&dir, "blob.bin", &[0x4d, 0x5a, 0x00, 0x01, 0x02]);
    let index = fsindex::index_for(&path).expect("建索引");
    assert!(index.binary);
    assert_eq!(index.line_count, 0);

    let dump = fsdecode::hex_dump(&path, 0, 64).expect("hex");
    assert!(dump.contains("4d 5a 00 01 02"));
    assert!(dump.contains("|MZ..."));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn path_traversal_is_rejected() {
    let dir = temp_dir();
    write_file(&dir, "ok.txt", b"ok");
    fs::create_dir_all(dir.join("sub")).expect("建子目录");

    let inside = resolve(dir.to_str().unwrap(), "sub").expect("子目录应可解析");
    assert!(inside.ends_with("sub"));

    let err = resolve(dir.to_str().unwrap(), "..\\..\\windows").expect_err("越界必须拒绝");
    assert_eq!(err.code, 400);
    assert!(err.message.contains(".."));

    let err = resolve(dir.to_str().unwrap(), "C:\\Windows").expect_err("盘符必须拒绝");
    assert_eq!(err.code, 400);

    let err = resolve(dir.to_str().unwrap(), "missing.txt").expect_err("不存在必须 404");
    assert_eq!(err.code, 404);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_whole_respects_limit() {
    let dir = temp_dir();
    let path = write_file(&dir, "doc.md", b"# title\n\nbody\n");
    let text = fsdecode::read_whole(&path, 1024).expect("读全文").expect("未超限");
    assert_eq!(text, "# title\n\nbody\n");
    assert!(fsdecode::read_whole(&path, 4).expect("读全文").is_none());

    let _ = fs::remove_dir_all(&dir);
}

/// 索引建好后文件被截断：窗口必须置 eof，不能让前端拿着 next 原地重试。
#[test]
fn stale_index_reports_eof_instead_of_empty_loop() {
    let dir = temp_dir();
    let mut content = String::new();
    for i in 0..10 {
        content.push_str(&format!("line-{i}\n"));
    }
    let path = write_file(&dir, "shrink.log", content.as_bytes());
    let index = fsindex::index_for(&path).expect("建索引");
    assert_eq!(index.line_count, 10);

    std::fs::write(&path, b"line-0\nline-1\n").expect("截断文件");
    let window = fsread::read_window(&path, &index, 0, 10).expect("读窗口");
    assert_eq!(window.text, "line-0\nline-1");
    assert!(window.eof, "文件比索引短时必须 eof");
    assert_eq!(window.next, 2);

    let _ = fs::remove_dir_all(&dir);
}

/// 整文件搜索：大小写不敏感、limit 截断、大小写敏感模式。
#[test]
fn search_matches_is_case_insensitive_and_limited() {
    let dir = temp_dir();
    let path = write_file(&dir, "search.log", b"alpha one\nbeta two\nALPHA three\n");
    let index = fsindex::index_for(&path).expect("建索引");

    let (found, truncated) =
        crate::fssearch::find_matches(&path, &index, "alpha", false, 10, 0).expect("搜索");
    assert_eq!(found.iter().map(|(line, _)| *line).collect::<Vec<_>>(), vec![0, 2]);
    assert!(!truncated);

    let (limited, truncated) =
        crate::fssearch::find_matches(&path, &index, "alpha", false, 1, 0).expect("搜索");
    assert_eq!(limited.len(), 1);
    assert!(truncated);

    let (exact, _) =
        crate::fssearch::find_matches(&path, &index, "ALPHA", true, 10, 0).expect("搜索");
    assert_eq!(exact.iter().map(|(line, _)| *line).collect::<Vec<_>>(), vec![2]);

    let _ = fs::remove_dir_all(&dir);
}
