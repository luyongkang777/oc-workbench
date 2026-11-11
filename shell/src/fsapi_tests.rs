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

// ---------- 保存（PUT /local/fs/write） ----------

/// 编码：BOM 与 CRLF 都要按原样还原，正文里的裸 CR 也要归一；UTF-16 一定带 BOM。
#[test]
fn encode_text_keeps_bom_and_crlf() {
    use crate::fsindex::Enc;
    assert_eq!(
        super::encode_text("a\nb\n", Enc::Utf8, false, false).expect("utf8"),
        b"a\nb\n".to_vec()
    );
    assert_eq!(
        super::encode_text("a\nb\n", Enc::Utf8, true, false).expect("utf8 bom"),
        b"\xEF\xBB\xBFa\nb\n".to_vec()
    );
    assert_eq!(
        super::encode_text("a\nb\n", Enc::Utf8, false, true).expect("utf8 crlf"),
        b"a\r\nb\r\n".to_vec()
    );
    // 前端偶尔会带 \r（粘贴、旧草稿），统一归一后再按文件风格写回
    assert_eq!(
        super::encode_text("a\r\nb\rc", Enc::Utf8, true, true).expect("utf8 混合"),
        b"\xEF\xBB\xBFa\r\nb\r\nc".to_vec()
    );
    // bom 参数对 UTF-16 无效：不写 BOM 下次就认不出来了
    assert_eq!(
        super::encode_text("a\n", Enc::Utf16Le, false, false).expect("utf16le"),
        vec![0xFF, 0xFE, b'a', 0, b'\n', 0]
    );
    assert_eq!(
        super::encode_text("a\n", Enc::Utf16Be, false, false).expect("utf16be"),
        vec![0xFE, 0xFF, 0, b'a', 0, b'\n']
    );
}

/// GBK 按 Windows 代码页编解码：中文往返一致，且字节不是 UTF-8。
#[cfg(windows)]
#[test]
fn gbk_roundtrip_and_detection() {
    use crate::fsindex::Enc;
    let text = "中文\n第二行\n";
    let bytes = super::encode_text(text, Enc::Gbk, false, false).expect("GBK 编码");
    assert_ne!(bytes, text.as_bytes().to_vec(), "GBK 字节不应等于 UTF-8");
    assert_eq!(crate::winenc::decode_lossy(&bytes), text);

    let dir = temp_dir();
    let path = write_file(&dir, "gbk.txt", &bytes);
    let index = fsindex::index_for(&path).expect("建索引");
    assert_eq!(index.enc, Enc::Gbk);
    assert_eq!(index.line_count, 2);
    let window = fsread::read_window(&path, &index, 0, 10).expect("读窗口");
    assert_eq!(window.text, "中文\n第二行");

    // 同样的中文写成 UTF-8 必须仍认成 UTF-8（不能被 GBK 抢走）
    let utf8 = write_file(&dir, "utf8.txt", text.as_bytes());
    assert_eq!(fsindex::index_for(&utf8).expect("建索引").enc, Enc::Utf8);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn count_lines_matches_index_semantics() {
    assert_eq!(super::count_lines(""), 0);
    assert_eq!(super::count_lines("a"), 1);
    assert_eq!(super::count_lines("a\n"), 1);
    assert_eq!(super::count_lines("a\nb"), 2);
    assert_eq!(super::count_lines("a\nb\n"), 2);
}

/// 保存后内容、行数、mtime 全部变化；再拿旧 mtime 保存必须 409。
#[test]
fn write_text_file_roundtrip_and_conflict() {
    let dir = temp_dir();
    let path = write_file(&dir, "edit.txt", b"one\ntwo\n");
    let before = fs::metadata(&path).expect("元信息");
    let before_mtime = super::mtime_ms(&before);

    let outcome =
        super::write_text_file(&path, "one\ntwo\nthree\n", Some(before_mtime), None).expect("保存");
    assert_eq!(outcome.line_count, 3);
    assert_eq!(outcome.size, 14);
    assert_eq!(fs::read(&path).expect("读回"), b"one\ntwo\nthree\n");

    let stale = super::write_text_file(&path, "nope\n", Some(before_mtime), None)
        .expect_err("旧 mtime 必须冲突");
    assert_eq!(stale.code, 409);
    assert_eq!(fs::read(&path).expect("读回"), b"one\ntwo\nthree\n");

    let _ = fs::remove_dir_all(&dir);
}

/// 保存保留原文件的 BOM / CRLF 风格。
#[test]
fn write_text_file_keeps_original_style() {
    let dir = temp_dir();
    let path = write_file(&dir, "style.txt", b"\xEF\xBB\xBFa\r\nb\r\n");

    super::write_text_file(&path, "a\nb\nc\n", None, None).expect("保存");
    assert_eq!(fs::read(&path).expect("读回"), b"\xEF\xBB\xBFa\r\nb\r\nc\r\n");

    let _ = fs::remove_dir_all(&dir);
}

/// 指定编码保存：UTF-8 文件改写成 UTF-16LE，再读回来还是同一份文本。
#[test]
fn write_text_file_can_switch_encoding() {
    use crate::fsindex::Enc;
    let dir = temp_dir();
    let path = write_file(&dir, "u.txt", "a\n".as_bytes());

    let outcome = super::write_text_file(&path, "一\n二\n", None, Some(Enc::Utf16Le)).expect("保存");
    assert_eq!(outcome.encoding, Enc::Utf16Le);
    let index = fsindex::index_for(&path).expect("建索引");
    assert_eq!(index.enc, Enc::Utf16Le);
    let window = fsread::read_window(&path, &index, 0, 10).expect("读窗口");
    assert_eq!(window.text, "一\n二");

    // 再改回 UTF-8：BOM 必须去掉
    let outcome = super::write_text_file(&path, "一\n二\n", None, Some(Enc::Utf8)).expect("保存");
    assert_eq!(outcome.encoding, Enc::Utf8);
    assert_eq!(fs::read(&path).expect("读回"), "一\n二\n".as_bytes());

    let _ = fs::remove_dir_all(&dir);
}

/// 二进制文件不能保存：编辑器写回文本会毁掉原字节。
#[test]
fn write_text_file_rejects_binary() {
    let dir = temp_dir();
    let path = write_file(&dir, "blob.bin", &[0x00, 0x01, 0x02, 0xff, 0x00]);
    let err = super::write_text_file(&path, "text", None, None).expect_err("二进制必须拒绝");
    assert_eq!(err.code, 415);
    assert_eq!(fs::read(&path).expect("读回"), vec![0x00, 0x01, 0x02, 0xff, 0x00]);

    let _ = fs::remove_dir_all(&dir);
}

/// 写完不留临时文件。
#[test]
fn write_atomic_leaves_no_temp_file() {
    let dir = temp_dir();
    let path = write_file(&dir, "tmp.txt", b"old\n");
    super::write_atomic(&path, b"new\n").expect("写入");
    assert_eq!(fs::read(&path).expect("读回"), b"new\n");
    let leftovers: Vec<String> = fs::read_dir(&dir)
        .expect("列目录")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "不应残留临时文件：{leftovers:?}");

    let _ = fs::remove_dir_all(&dir);
}

// ---------- HTTP 层：真实请求打到 fsapi::handle ----------

/// 起一个真实 tiny_http 服务，处理一次请求；返回 (状态行, 响应体)。
fn http_roundtrip(request_line: &str, headers: &str, body: &str) -> String {
    use std::io::{Read as _, Write as _};
    use std::net::TcpStream;

    let server = tiny_http::Server::http("127.0.0.1:0").expect("起测试服务");
    let port = server.server_addr().to_ip().expect("需要 IP 监听地址").port();

    let worker = std::thread::spawn(move || {
        if let Ok(request) = server.recv() {
            let url = request.url().to_string();
            let path = url.split('?').next().unwrap_or("").to_string();
            super::handle(request, &path, &url);
        }
    });

    let request = format!(
        "{request_line} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
        body.len()
    );
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("连接测试服务");
    stream.write_all(request.as_bytes()).expect("发送请求");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("读响应");
    worker.join().expect("服务线程");
    response
}

/// PUT 保存：200 + 落盘；GET 打同一接口必须 405。
#[test]
fn http_write_put_and_method_guard() {
    let dir = temp_dir();
    let path = write_file(&dir, "http.txt", b"one\n");
    let root = dir.to_string_lossy().replace('\\', "/");

    let ok = http_roundtrip(
        &format!("PUT /local/fs/write?root={root}&path=http.txt"),
        "",
        "one\ntwo\n",
    );
    assert!(ok.starts_with("HTTP/1.1 200"), "响应：{ok}");
    assert_eq!(fs::read(&path).expect("读回"), b"one\ntwo\n");

    let refused = http_roundtrip(
        &format!("GET /local/fs/write?root={root}&path=http.txt"),
        "",
        "",
    );
    assert!(refused.starts_with("HTTP/1.1 405"), "响应：{refused}");
    assert_eq!(fs::read(&path).expect("读回"), b"one\ntwo\n");

    let _ = fs::remove_dir_all(&dir);
}

/// 冲突走 409、缺 root 走 400：错误码不能被吞成 500。
#[test]
fn http_write_conflict_and_unknown_root() {
    let dir = temp_dir();
    let _path = write_file(&dir, "c.txt", b"a\n");
    let root = dir.to_string_lossy().replace('\\', "/");

    let conflict = http_roundtrip(
        &format!("PUT /local/fs/write?root={root}&path=c.txt&expectedMtimeMs=1"),
        "",
        "a\nb\n",
    );
    assert!(conflict.starts_with("HTTP/1.1 409"), "响应：{conflict}");

    let missing = http_roundtrip("PUT /local/fs/write?root=&path=c.txt", "", "x\n");
    assert!(missing.starts_with("HTTP/1.1 400"), "响应：{missing}");

    let _ = fs::remove_dir_all(&dir);
}

/// 「以指定编码重新打开」：强制编码覆盖自动探测，并按该编码重新切行/解码。
#[test]
fn forced_encoding_overrides_detection() {
    use crate::fsindex::Enc;

    let dir = temp_dir();
    // UTF-8 正文：默认认成 utf8，强制 GBK 后解出来就是另一串字
    let path = write_file(&dir, "both.txt", "中文\n".as_bytes());
    assert_eq!(fsindex::index_for(&path).expect("建索引").enc, Enc::Utf8);

    let forced = fsindex::index_for_encoding(&path, Some(Enc::Gbk)).expect("强制 GBK");
    assert_eq!(forced.enc, Enc::Gbk);
    let window = fsread::read_window(&path, &forced, 0, 10).expect("读窗口");
    assert_ne!(window.text, "中文");

    // 强制 UTF-8 BOM 文件：BOM 与编码一致时仍要跳过 3 字节
    let bom = write_file(&dir, "bom.txt", b"\xEF\xBB\xBFone\ntwo\n");
    let index = fsindex::index_for_encoding(&bom, Some(Enc::Utf8)).expect("强制 utf8");
    assert_eq!(index.line_count, 2);
    let window = fsread::read_window(&bom, &index, 0, 10).expect("读窗口");
    assert_eq!(window.text, "one\ntwo");

    let _ = fs::remove_dir_all(&dir);
}

// ---------- 结构操作：新建 / 重命名 / 删除 ----------

#[test]
fn create_rename_delete_roundtrip() {
    let dir = temp_dir();
    let root = dir.to_string_lossy().replace('\\', "/");

    super::make_dir(&root, "src").expect("新建目录");
    assert!(dir.join("src").is_dir());

    super::make_file(&root, "src/main.cpp").expect("新建文件");
    assert!(dir.join("src/main.cpp").is_file());
    assert_eq!(
        super::make_file(&root, "src/main.cpp").expect_err("重名必须拒绝").code,
        409
    );

    super::rename_entry(&root, "src/main.cpp", "src/app.cpp").expect("重命名");
    assert!(dir.join("src/app.cpp").is_file());
    assert!(!dir.join("src/main.cpp").exists());
    assert_eq!(
        super::rename_entry(&root, "src/app.cpp", "src").expect_err("目标已被占用").code,
        409
    );

    super::delete_entry(&root, "src").expect("删除目录");
    assert!(!dir.join("src").exists());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn name_and_path_guards() {
    let dir = temp_dir();
    let root = dir.to_string_lossy().replace('\\', "/");

    assert_eq!(super::validate_name("a:b").expect_err("冒号").code, 400);
    assert_eq!(super::validate_name("CON.txt").expect_err("保留名").code, 400);
    assert_eq!(super::validate_name("bad.").expect_err("尾点").code, 400);
    assert_eq!(super::validate_name("").expect_err("空名").code, 400);
    assert!(super::validate_name("main.cpp").is_ok());
    assert!(super::validate_name("中文 名字.h").is_ok());

    // 父目录必须存在（不帮忙建路径）
    assert_eq!(
        super::make_file(&root, "nope/a.cpp").expect_err("父目录不存在").code,
        404
    );
    // 越界 / 不能删根
    assert_eq!(
        super::make_file(&root, "../evil.cpp").expect_err("越界").code,
        400
    );
    assert_eq!(super::delete_entry(&root, "").expect_err("删根").code, 400);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn http_fs_ops_require_post() {
    let dir = temp_dir();
    let root = dir.to_string_lossy().replace('\\', "/");

    let ok = http_roundtrip(&format!("POST /local/fs/mkdir?root={root}&path=docs"), "", "");
    assert!(ok.starts_with("HTTP/1.1 200"), "响应：{ok}");
    assert!(dir.join("docs").is_dir());

    let get = http_roundtrip(&format!("GET /local/fs/mkdir?root={root}&path=other"), "", "");
    assert!(get.starts_with("HTTP/1.1 405"), "响应：{get}");
    assert!(!dir.join("other").exists());

    let _ = fs::remove_dir_all(&dir);
}
