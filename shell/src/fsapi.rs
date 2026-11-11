//! 本地文件 API（`/local/fs/*`）：不经 opencode 后端，直接读磁盘。
//!
//! 这样三个问题一起解决：
//!   * 不再受上游 `/api/fs/read` 「整份返回」的限制，任意大小文件都能按行分页看；
//!   * 读文件不再占用 `MAX_CONCURRENT` 的转发名额，快速连点也不会把上游压出 503；
//!   * 目录列表带上文件大小，文件树不用再等后端在途请求排队。
//!
//! `PUT /local/fs/write` 是这条通道上唯一的写操作：整份 UTF-8 文本原子落盘，
//! 保留原文件的 BOM 与 CRLF；`expectedMtimeMs` 对不上就回 409，避免覆盖别处的改动。
//!
//! 安全边界：和 `/api/*` 一样先过 Host + `x-oc-token`；
//! 路径只允许落在 `root` 之内（逐段拒绝 `..`，canonicalize 后做前缀校验）。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::json;
use tiny_http::{Header, Response, StatusCode};

use crate::body::{read_body_with_timeout, BodyRead};
use crate::fsdecode::hex_dump;
use crate::fsindex::{self, Enc};
use crate::fsread;
use crate::fsutil::{mime_of, param, param_u64, parse_query};
use crate::server::{json_error, respond_json};

const READ_LINES_DEFAULT: u64 = 200;
const READ_LINES_MAX: u64 = 1000;
const TEXT_DEFAULT_MAX: u64 = 1024 * 1024;
const TEXT_HARD_MAX: u64 = 4 * 1024 * 1024;
const HEX_DEFAULT: usize = 4096;
const HEX_HARD_MAX: usize = 64 * 1024;
/// 单次保存的正文上限：编辑器只放 2MB 的文件进来，这里留一倍余量。
const WRITE_BODY_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Debug)]
struct PathError {
    code: u16,
    message: String,
}

impl PathError {
    fn new(code: u16, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub fn handle(request: tiny_http::Request, path: &str, url: &str) {
    let pairs = parse_query(url);
    let action = path.rsplit('/').next().unwrap_or("");
    let root = param(&pairs, "root").unwrap_or("").trim().to_string();
    let rel = param(&pairs, "path").unwrap_or("").to_string();
    if root.is_empty() {
        let _ = json_error(request, 400, "缺少 root 参数");
        return;
    }

    // 结构操作（新建/重命名/删除）：目标可能还不存在，不能走 resolve。
    if matches!(action, "mkdir" | "create" | "rename" | "delete") {
        fs_ops(request, action, &root, &rel, &pairs);
        return;
    }

    let target = match resolve(&root, &rel) {
        Ok(target) => target,
        Err(err) => {
            let _ = json_error(request, err.code, &err.message);
            return;
        }
    };

    // 目录/文件类型先分清：否则 list 一个文件、read 一个目录都会变成 500。
    if action == "list" {
        if !target.is_dir() {
            let _ = json_error(request, 400, "这不是目录");
            return;
        }
    } else if target.is_dir() {
        let _ = json_error(request, 400, "这是目录，不是文件");
        return;
    }

    match action {
        "list" => list(request, &target, &rel),
        "stat" => stat(request, &target, &pairs),
        "read" => read(request, &target, &pairs),
        "text" => text(request, &target, &pairs),
        "raw" => raw(request, &target),
        "hex" => hex(request, &target, &pairs),
        "write" => write(request, &target, &pairs),
        "search" => crate::fssearch::handle(request, &target, &pairs),
        _ => {
            let _ = json_error(request, 404, "未知的本地文件接口");
        }
    }
}

fn resolve(root: &str, rel: &str) -> Result<PathBuf, PathError> {
    let root_canon = Path::new(root)
        .canonicalize()
        .map_err(|_| PathError::new(404, format!("目录不存在：{root}")))?;
    if !root_canon.is_dir() {
        return Err(PathError::new(400, "root 不是目录"));
    }

    let mut joined = root_canon.clone();
    for part in rel.split(['\\', '/']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(PathError::new(400, "路径不允许包含 .."));
        }
        if part.contains(':') {
            return Err(PathError::new(400, "路径不允许包含盘符"));
        }
        joined.push(part);
    }

    let target = joined
        .canonicalize()
        .map_err(|_| PathError::new(404, format!("文件不存在：{rel}")))?;
    if !target.starts_with(&root_canon) {
        return Err(PathError::new(403, "路径越界"));
    }
    Ok(target)
}

// ---------- 结构操作：新建文件 / 新建文件夹 / 重命名 / 删除 ----------

/// Windows 保留设备名（不区分大小写，带不带扩展名都不行）。
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 只校验最后一段名字：分隔符、保留名、尾随点/空格这些在 Windows 上会出怪事。
fn validate_name(name: &str) -> Result<(), PathError> {
    if name.is_empty() {
        return Err(PathError::new(400, "名字不能为空"));
    }
    if name == "." || name == ".." {
        return Err(PathError::new(400, "名字不能是 . 或 .."));
    }
    if name.chars().count() > 200 {
        return Err(PathError::new(400, "名字太长"));
    }
    if name
        .chars()
        .any(|c| "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20)
    {
        return Err(PathError::new(400, "名字不能包含 <>:\"/\\|?* 或控制字符"));
    }
    if name.ends_with(' ') || name.ends_with('.') {
        return Err(PathError::new(400, "名字不能以空格或点结尾"));
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        return Err(PathError::new(400, "这是 Windows 保留名字，换一个"));
    }
    Ok(())
}

/// 解析「还不存在」的目标：父目录必须存在且落在 root 内，最后一段按新名字校验。
fn resolve_new(root: &str, rel: &str) -> Result<PathBuf, PathError> {
    let root_canon = Path::new(root)
        .canonicalize()
        .map_err(|_| PathError::new(404, format!("目录不存在：{root}")))?;
    if !root_canon.is_dir() {
        return Err(PathError::new(400, "root 不是目录"));
    }

    let parts: Vec<&str> = rel
        .split(['\\', '/'])
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    let Some((name, parents)) = parts.split_last() else {
        return Err(PathError::new(400, "路径不能为空"));
    };
    validate_name(name)?;

    let mut parent = root_canon.clone();
    for part in parents {
        if *part == ".." {
            return Err(PathError::new(400, "路径不允许包含 .."));
        }
        if part.contains(':') {
            return Err(PathError::new(400, "路径不允许包含盘符"));
        }
        parent.push(part);
    }
    let parent = parent
        .canonicalize()
        .map_err(|_| PathError::new(404, format!("父目录不存在：{rel}")))?;
    if !parent.starts_with(&root_canon) {
        return Err(PathError::new(403, "路径越界"));
    }
    Ok(parent.join(name))
}

/// 四个结构操作统一入口：只接受 POST，成功后回 `{ ok: true, path }`。
fn fs_ops(
    request: tiny_http::Request,
    action: &str,
    root: &str,
    rel: &str,
    pairs: &[(String, String)],
) {
    if !request.method().as_str().eq_ignore_ascii_case("POST") {
        let _ = json_error(request, 405, "这个接口只支持 POST");
        return;
    }
    let result: Result<String, PathError> = match action {
        "mkdir" => make_dir(root, rel),
        "create" => make_file(root, rel),
        "rename" => rename_entry(root, rel, param(pairs, "to").unwrap_or("")),
        "delete" => delete_entry(root, rel),
        _ => Err(PathError::new(404, "未知的结构操作")),
    };
    match result {
        Ok(path) => {
            let _ = respond_json(request, 200, json!({ "ok": true, "path": path }).to_string());
        }
        Err(err) => {
            let _ = json_error(request, err.code, &err.message);
        }
    }
}

fn make_dir(root: &str, rel: &str) -> Result<String, PathError> {
    let target = resolve_new(root, rel)?;
    if target.exists() {
        return Err(PathError::new(409, "同名文件或文件夹已存在"));
    }
    fs::create_dir(&target).map_err(|err| PathError::new(500, &format!("新建文件夹失败：{err}")))?;
    Ok(rel.to_string())
}

fn make_file(root: &str, rel: &str) -> Result<String, PathError> {
    let target = resolve_new(root, rel)?;
    match fs::OpenOptions::new().write(true).create_new(true).open(&target) {
        Ok(_) => Ok(rel.to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(PathError::new(409, "同名文件或文件夹已存在"))
        }
        Err(err) => Err(PathError::new(500, &format!("新建文件失败：{err}"))),
    }
}

fn rename_entry(root: &str, rel: &str, to: &str) -> Result<String, PathError> {
    if rel.trim().is_empty() || to.trim().is_empty() {
        return Err(PathError::new(400, "路径不能为空"));
    }
    let source = resolve(root, rel)?;
    let destination = resolve_new(root, to)?;
    if destination.exists() {
        return Err(PathError::new(409, "目标名字已被占用"));
    }
    fs::rename(&source, &destination).map_err(|err| PathError::new(500, &format!("重命名失败：{err}")))?;
    Ok(to.to_string())
}

fn delete_entry(root: &str, rel: &str) -> Result<String, PathError> {
    if rel.trim().is_empty() {
        return Err(PathError::new(400, "不能删除根目录"));
    }
    let target = resolve(root, rel)?;
    // resolve 已经保证目标存在；再挡一次「删到 root 自己」
    let root_canon = Path::new(root)
        .canonicalize()
        .map_err(|_| PathError::new(404, format!("目录不存在：{root}")))?;
    if target == root_canon {
        return Err(PathError::new(400, "不能删除根目录"));
    }
    let result = if target.is_dir() {
        fs::remove_dir_all(&target)
    } else {
        fs::remove_file(&target)
    };
    result.map_err(|err| PathError::new(500, &format!("删除失败：{err}")))?;
    Ok(rel.to_string())
}

fn list(request: tiny_http::Request, dir: &Path, rel: &str) {
    let reader = match fs::read_dir(dir) {
        Ok(reader) => reader,
        Err(err) => {
            let _ = json_error(request, 500, &format!("列目录失败：{err}"));
            return;
        }
    };

    let mut rows: Vec<(bool, String, serde_json::Value)> = Vec::new();
    for item in reader.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        let meta = item.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{}\\{}", rel.trim_end_matches(['\\', '/']), name)
        };
        let path = if is_dir { format!("{path}\\") } else { path };
        let size = if is_dir { None } else { meta.as_ref().map(|m| m.len()) };
        rows.push((
            is_dir,
            name.to_lowercase(),
            json!({
                "path": path,
                "type": if is_dir { "directory" } else { "file" },
                "size": size,
            }),
        ));
    }
    // 目录在前，其次按名字不区分大小写排序
    rows.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let entries: Vec<serde_json::Value> = rows.into_iter().map(|row| row.2).collect();
    let _ = respond_json(request, 200, json!({ "entries": entries }).to_string());
}

/// 查询参数里的 `encoding`：None = 自动；名字不认识就回一句错误（调用方转 400）。
fn encoding_param(pairs: &[(String, String)]) -> Result<Option<Enc>, String> {
    match param(pairs, "encoding").filter(|value| !value.is_empty()) {
        Some(name) => Enc::from_name(name)
            .map(Some)
            .ok_or_else(|| format!("不认识的编码：{name}")),
        None => Ok(None),
    }
}

fn stat(request: tiny_http::Request, file: &Path, pairs: &[(String, String)]) {
    let meta = match fs::metadata(file) {
        Ok(meta) => meta,
        Err(err) => {
            let _ = json_error(request, 404, &format!("读文件信息失败：{err}"));
            return;
        }
    };
    if meta.is_dir() {
        let _ = json_error(request, 400, "这是目录，不是文件");
        return;
    }
    let forced = match encoding_param(pairs) {
        Ok(enc) => enc,
        Err(message) => {
            let _ = json_error(request, 400, &message);
            return;
        }
    };
    let index = match fsindex::index_for_encoding(file, forced) {
        Ok(index) => index,
        Err(err) => {
            let _ = json_error(request, 500, &format!("建立行索引失败：{err}"));
            return;
        }
    };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or(0);
    let body = json!({
        "size": index.size,
        "mtimeMs": mtime_ms,
        "lineCount": index.line_count,
        "encoding": index.enc.name(),
        "binary": index.binary,
    });
    let _ = respond_json(request, 200, body.to_string());
}

fn read(request: tiny_http::Request, file: &Path, pairs: &[(String, String)]) {
    let start = param_u64(pairs, "start").unwrap_or(0);
    let lines = param_u64(pairs, "lines")
        .unwrap_or(READ_LINES_DEFAULT)
        .clamp(1, READ_LINES_MAX);
    let forced = match encoding_param(pairs) {
        Ok(enc) => enc,
        Err(message) => {
            let _ = json_error(request, 400, &message);
            return;
        }
    };
    let index = match fsindex::index_for_encoding(file, forced) {
        Ok(index) => index,
        Err(err) => {
            let _ = json_error(request, 500, &format!("建立行索引失败：{err}"));
            return;
        }
    };
    if index.binary {
        let _ = json_error(request, 415, "二进制文件，无法按文本预览");
        return;
    }
    match fsread::read_window(file, &index, start, lines) {
        Ok(window) => {
            let body = json!({
                "start": window.start,
                "text": window.text,
                "next": window.next,
                "eof": window.eof,
                "lineCount": index.line_count,
            });
            let _ = respond_json(request, 200, body.to_string());
        }
        Err(err) => {
            let _ = json_error(request, 500, &format!("读取失败：{err}"));
        }
    }
}

fn text(request: tiny_http::Request, file: &Path, pairs: &[(String, String)]) {
    let max = param_u64(pairs, "maxBytes")
        .unwrap_or(TEXT_DEFAULT_MAX)
        .clamp(64 * 1024, TEXT_HARD_MAX);
    let forced = match encoding_param(pairs) {
        Ok(enc) => enc,
        Err(message) => {
            let _ = json_error(request, 400, &message);
            return;
        }
    };
    match fsindex::index_for_encoding(file, forced) {
        Ok(index) if index.binary => {
            let _ = json_error(request, 415, "二进制文件，无法按文本预览");
            return;
        }
        Ok(_) => {}
        Err(err) => {
            let _ = json_error(request, 500, &format!("建立行索引失败：{err}"));
            return;
        }
    }
    match crate::fsdecode::read_whole_with(file, max, forced) {
        Ok(Some(text)) => {
            let _ = respond_json(request, 200, json!({ "text": text }).to_string());
        }
        Ok(None) => {
            let _ = json_error(request, 413, "文件太大，全文预览请改用分页阅读");
        }
        Err(err) => {
            let _ = json_error(request, 500, &format!("读取失败：{err}"));
        }
    }
}

fn raw(request: tiny_http::Request, file: &Path) {
    let handle = match fs::File::open(file) {
        Ok(handle) => handle,
        Err(err) => {
            let _ = json_error(request, 404, &format!("打开文件失败：{err}"));
            return;
        }
    };
    let len = match handle.metadata() {
        Ok(meta) => meta.len(),
        Err(err) => {
            let _ = json_error(request, 500, &format!("读文件信息失败：{err}"));
            return;
        }
    };
    let content_type =
        Header::from_bytes(&b"content-type"[..], mime_of(file).as_bytes()).expect("content-type");
    let no_store =
        Header::from_bytes(&b"cache-control"[..], &b"no-store"[..]).expect("cache-control");
    let mut response = Response::new(StatusCode(200), vec![content_type, no_store], handle, Some(len as usize), None);
    response = response.with_chunked_threshold(usize::MAX);
    let _ = request.respond(response);
}

fn hex(request: tiny_http::Request, file: &Path, pairs: &[(String, String)]) {
    let offset = param_u64(pairs, "offset").unwrap_or(0);
    let bytes = param_u64(pairs, "bytes")
        .map(|value| value as usize)
        .unwrap_or(HEX_DEFAULT)
        .clamp(16, HEX_HARD_MAX);
    match hex_dump(file, offset, bytes) {
        Ok(text) => {
            let _ = respond_json(request, 200, json!({ "text": text }).to_string());
        }
        Err(err) => {
            let _ = json_error(request, 500, &format!("转储失败：{err}"));
        }
    }
}

/// `PUT /local/fs/write?root=&path=&expectedMtimeMs=&encoding=`：整份文本保存。
///
/// 请求体就是纯文本（不做 JSON 包装，省一次转义）。只接受已存在的文件：
/// 新建文件走别的入口，免得编辑框误建出一堆空文件。
/// `encoding` 决定写回用的编码（utf8 / utf16le / utf16be / gbk），不传就沿用文件原编码。
fn write(request: tiny_http::Request, file: &Path, pairs: &[(String, String)]) {
    if !request.method().as_str().eq_ignore_ascii_case("PUT") {
        let _ = json_error(request, 405, "保存只支持 PUT");
        return;
    }
    let Some((request, body)) = read_body_with_timeout(request, WRITE_BODY_LIMIT) else {
        return;
    };
    let bytes = match body {
        BodyRead::Ok(bytes) => bytes,
        BodyRead::TooLarge => {
            let _ = json_error(request, 413, "文件太大，单次保存上限 8MB");
            return;
        }
        BodyRead::Failed(err) => {
            let _ = json_error(request, 400, &format!("读取请求体失败：{err}"));
            return;
        }
    };
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => {
            let _ = json_error(request, 400, "请求体不是合法的 UTF-8 文本");
            return;
        }
    };

    let expected = param_u64(pairs, "expectedMtimeMs");
    let encoding = match param(pairs, "encoding").filter(|value| !value.is_empty()) {
        Some(name) => match Enc::from_name(name) {
            Some(enc) => Some(enc),
            None => {
                let _ = json_error(request, 400, &format!("不认识的编码：{name}"));
                return;
            }
        },
        None => None,
    };

    match write_text_file(file, &text, expected, encoding) {
        Ok(outcome) => {
            let body = json!({
                "size": outcome.size,
                "mtimeMs": outcome.mtime_ms,
                "lineCount": outcome.line_count,
                "encoding": outcome.encoding.name(),
            });
            let _ = respond_json(request, 200, body.to_string());
        }
        Err(err) => {
            let _ = json_error(request, err.code, &err.message);
        }
    }
}

/// 保存结果：前端拿到后直接当新的 stat（避免再打一次 stat）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WriteOutcome {
    pub size: u64,
    pub mtime_ms: u64,
    pub line_count: u64,
    pub encoding: Enc,
}

/// 把整份文本写回文件。
///
///   * `expected` 给了就必须和磁盘上的 mtime 一致，否则 409（别的地方改过了）；
///   * `encoding` 不传就沿用文件原编码；传了就按指定编码写（改编码保存）；
///   * 二进制文件 415；GBK 写不了的字符回 400，让用户改用 UTF-8；
///   * BOM 与换行风格按目标编码保留（UTF-16 一定带 BOM，否则下次认不出来）。
fn write_text_file(
    file: &Path,
    text: &str,
    expected: Option<u64>,
    encoding: Option<Enc>,
) -> Result<WriteOutcome, PathError> {
    let meta = fs::metadata(file)
        .map_err(|err| PathError::new(404, format!("读文件信息失败：{err}")))?;
    if meta.is_dir() {
        return Err(PathError::new(400, "这是目录，不是文件"));
    }
    if let Some(expected) = expected {
        if expected != mtime_ms(&meta) {
            return Err(PathError::new(
                409,
                "文件已在磁盘上被修改，请重新加载后再保存",
            ));
        }
    }

    let index =
        fsindex::index_for(file).map_err(|err| PathError::new(500, format!("建立行索引失败：{err}")))?;
    if index.binary {
        return Err(PathError::new(415, "二进制文件不支持编辑"));
    }

    let target = encoding.unwrap_or(index.enc);
    let (mut bom, crlf) = file_traits(file, index.enc);
    // 换编码保存时不能沿用原编码的 BOM；UTF-16 必须写 BOM 才能被认出来
    if target != index.enc {
        bom = matches!(target, Enc::Utf16Le | Enc::Utf16Be);
    }

    let bytes = encode_text(text, target, bom, crlf).map_err(|err| PathError::new(400, &err))?;
    write_atomic(file, &bytes).map_err(|err| PathError::new(500, &format!("保存失败：{err}")))?;

    let meta = fs::metadata(file)
        .map_err(|err| PathError::new(500, format!("保存后读文件信息失败：{err}")))?;
    Ok(WriteOutcome {
        size: meta.len(),
        mtime_ms: mtime_ms(&meta),
        line_count: count_lines(text),
        encoding: target,
    })
}

/// 原文件是否带 BOM、是否用 CRLF（按原编码解码前 64KB 判断，UTF-16 的 CRLF 是 0D 00 0A 00）。
fn file_traits(file: &Path, enc: Enc) -> (bool, bool) {
    let mut head = [0u8; 64 * 1024];
    let Ok(mut handle) = fs::File::open(file) else {
        return (false, false);
    };
    let read = handle.read(&mut head).unwrap_or(0);
    let bytes = &head[..read];
    let bom = match enc {
        Enc::Utf8 => bytes.starts_with(&[0xEF, 0xBB, 0xBF]),
        Enc::Utf16Le => bytes.starts_with(&[0xFF, 0xFE]),
        Enc::Utf16Be => bytes.starts_with(&[0xFE, 0xFF]),
        Enc::Gbk => false,
    };
    let start = match enc {
        Enc::Utf8 => {
            if bom {
                3
            } else {
                0
            }
        }
        Enc::Utf16Le | Enc::Utf16Be => {
            if bom {
                2
            } else {
                0
            }
        }
        Enc::Gbk => 0,
    };
    let body = &bytes[start.min(bytes.len())..];
    let decoded = match enc {
        Enc::Utf8 => String::from_utf8_lossy(body).into_owned(),
        Enc::Utf16Le => decode_utf16_bytes(body, true),
        Enc::Utf16Be => decode_utf16_bytes(body, false),
        Enc::Gbk => crate::winenc::decode_lossy(body),
    };
    (bom, decoded.contains("\r\n"))
}

fn decode_utf16_bytes(body: &[u8], little: bool) -> String {
    let units: Vec<u16> = body
        .chunks_exact(2)
        .map(|pair| {
            if little {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

/// 按目标编码编码整份文本：先把各种换行归一到 `\n`，需要时再整体换成 CRLF。
///
/// GBK 遇到无法表示的字符（emoji、生僻字）会返回错误，让前端提示改用 UTF-8。
pub(crate) fn encode_text(text: &str, enc: Enc, bom: bool, crlf: bool) -> Result<Vec<u8>, String> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let body = if crlf {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    };
    let mut out = Vec::with_capacity(body.len() + 3);
    match enc {
        Enc::Utf8 => {
            if bom {
                out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            }
            out.extend_from_slice(body.as_bytes());
        }
        Enc::Utf16Le => {
            out.extend_from_slice(&[0xFF, 0xFE]);
            for unit in body.encode_utf16() {
                out.extend_from_slice(&unit.to_le_bytes());
            }
        }
        Enc::Utf16Be => {
            out.extend_from_slice(&[0xFE, 0xFF]);
            for unit in body.encode_utf16() {
                out.extend_from_slice(&unit.to_be_bytes());
            }
        }
        Enc::Gbk => {
            let bytes = crate::winenc::encode(&body)
                .ok_or_else(|| "文本含有 GBK/GB18030 无法表示的字符，请改用 UTF-8 保存".to_string())?;
            out.extend_from_slice(&bytes);
        }
    }
    Ok(out)
}

/// 同目录临时文件 + rename：写一半失败也不会把原文件截断。
pub(crate) fn write_atomic(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = file
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "文件没有父目录"))?;
    let name = file
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let tmp = dir.join(format!(".{name}.ocwb-{}.tmp", std::process::id()));
    fs::write(&tmp, bytes)?;
    match fs::rename(&tmp, file) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(&tmp);
            Err(err)
        }
    }
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or(0)
}

/// 行数口径与 [`crate::fsindex`] 一致：`"a\nb\n"` 是 2 行，空文件 0 行。
pub(crate) fn count_lines(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }
    let newlines = text.bytes().filter(|byte| *byte == b'\n').count() as u64;
    if text.ends_with('\n') {
        newlines
    } else {
        newlines + 1
    }
}

#[cfg(test)]
#[path = "fsapi_tests.rs"]
mod tests;
