//! 按行分页读取 + 全文/十六进制解码。
//!
//! 所有窗口都以「整行」为单位返回，不会切坏多字节字符；CRLF 统一成 LF。
//! 单行异常长（压缩过的 JS/JSON）时按 [`MAX_LINE_BYTES`] 截断并丢弃该行剩余部分。

use std::fs::File;
use std::io::{self, BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;

use crate::fsindex::{Enc, Index};

/// 单次窗口的字节上限：再大对前端渲染也没有意义。
pub const MAX_WINDOW_BYTES: usize = 512 * 1024;
/// 单行上限：超出就截断。
const MAX_LINE_BYTES: usize = 256 * 1024;
const READ_BUF: usize = 64 * 1024;

pub struct Window {
    pub start: u64,
    pub text: String,
    pub next: u64,
    pub eof: bool,
}

/// 找 start 行之前最近的检查点：(检查点行号, 字节偏移)。
fn checkpoint_for(index: &Index, start: u64) -> (u64, u64) {
    let mut best = (0u64, 0u64);
    for (line, offset) in &index.checkpoints {
        if *line > start {
            break;
        }
        best = (*line, *offset);
    }
    best
}

pub fn read_window(
    path: &Path,
    index: &Index,
    start: u64,
    max_lines: u64,
) -> io::Result<Window> {
    if index.binary || start >= index.line_count || max_lines == 0 {
        return Ok(Window {
            start,
            text: String::new(),
            next: index.line_count.max(start),
            eof: true,
        });
    }

    let (check_line, check_offset) = checkpoint_for(index, start);
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(check_offset))?;
    let mut reader = BufReader::with_capacity(READ_BUF, file);
    let skip = start - check_line;
    let limit = max_lines.min(index.line_count - start);

    match index.enc {
        Enc::Utf8 => read_bytes(&mut reader, skip, limit, start, index.line_count, false),
        Enc::Gbk => read_bytes(&mut reader, skip, limit, start, index.line_count, true),
        Enc::Utf16Le | Enc::Utf16Be => {
            read_utf16(&mut reader, index.enc, skip, limit, start, index.line_count)
        }
    }
}

/// 单字节编码（UTF-8 / GBK）按行读：换行处切行，再整行解码。
///
/// 两种编码的换行字节都是 0x0A，且 GBK 的双字节序列里不会出现 0x0A，
/// 所以在字节层切行是安全的。
fn read_bytes<R: BufRead>(
    reader: &mut R,
    skip: u64,
    limit: u64,
    start: u64,
    total: u64,
    gbk: bool,
) -> io::Result<Window> {
    let mut scratch = Vec::new();
    let mut skipped = 0;
    while skipped < skip {
        if !read_line_bytes(reader, &mut scratch)? {
            break;
        }
        skipped += 1;
    }

    let mut lines: Vec<String> = Vec::with_capacity(limit.min(512) as usize);
    let mut bytes = 0usize;
    let mut hit_eof = false;
    while (lines.len() as u64) < limit {
        if !read_line_bytes(reader, &mut scratch)? {
            hit_eof = true;
            break;
        }
        let text = if gbk {
            crate::winenc::decode_lossy(&scratch)
        } else {
            String::from_utf8_lossy(&scratch).into_owned()
        };
        bytes += text.len() + 1;
        lines.push(text);
        if bytes >= MAX_WINDOW_BYTES {
            break;
        }
    }

    let next = start + lines.len() as u64;
    Ok(Window {
        start,
        text: lines.join("\n"),
        next,
        eof: next >= total || hit_eof,
    })
}

/// 读一行（不含换行符），返回是否读到了内容。
///
/// 用 `fill_buf` 手写循环而不是 `read_until`：既能限制单行字节数，
/// 又能在超长行里把剩余部分消费掉，保证下一行从正确的换行处开始。
fn read_line_bytes<R: BufRead>(reader: &mut R, out: &mut Vec<u8>) -> io::Result<bool> {
    out.clear();
    let mut truncated = false;
    loop {
        let (consumed, done) = {
            let available = reader.fill_buf()?;
            if available.is_empty() {
                trim_cr(out);
                return Ok(!out.is_empty());
            }
            let newline = available.iter().position(|b| *b == b'\n');
            let (body, consumed, done) = match newline {
                Some(pos) => (&available[..pos], pos + 1, true),
                None => (available, available.len(), false),
            };
            if !truncated {
                let room = MAX_LINE_BYTES.saturating_sub(out.len());
                if body.len() > room {
                    out.extend_from_slice(&body[..room]);
                    truncated = true;
                } else {
                    out.extend_from_slice(body);
                }
            }
            (consumed, done)
        };
        reader.consume(consumed);
        if done {
            break;
        }
    }
    trim_cr(out);
    Ok(true)
}

fn trim_cr(out: &mut Vec<u8>) {
    if out.last() == Some(&b'\r') {
        out.pop();
    }
}

fn read_utf16<R: BufRead>(
    reader: &mut R,
    enc: Enc,
    skip: u64,
    limit: u64,
    start: u64,
    total: u64,
) -> io::Result<Window> {
    let mut skipped = 0;
    while skipped < skip {
        if !skip_utf16_line(reader, enc)? {
            break;
        }
        skipped += 1;
    }

    let mut lines: Vec<String> = Vec::with_capacity(limit.min(512) as usize);
    let mut bytes = 0usize;
    let mut hit_eof = false;
    while (lines.len() as u64) < limit {
        let (units, any) = read_utf16_line(reader, enc)?;
        if !any {
            hit_eof = true;
            break;
        }
        let text = String::from_utf16_lossy(&units);
        bytes += text.len() + 1;
        lines.push(text);
        if bytes >= MAX_WINDOW_BYTES {
            break;
        }
    }

    let next = start + lines.len() as u64;
    Ok(Window {
        start,
        text: lines.join("\n"),
        next,
        eof: next >= total || hit_eof,
    })
}

fn read_unit<R: BufRead>(reader: &mut R, enc: Enc) -> io::Result<Option<u16>> {
    let mut pair = [0u8; 2];
    match reader.read_exact(&mut pair) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(err) => return Err(err),
    }
    Ok(Some(if enc == Enc::Utf16Le {
        u16::from_le_bytes(pair)
    } else {
        u16::from_be_bytes(pair)
    }))
}

fn read_utf16_line<R: BufRead>(reader: &mut R, enc: Enc) -> io::Result<(Vec<u16>, bool)> {
    let mut units = Vec::new();
    let mut any = false;
    loop {
        let Some(unit) = read_unit(reader, enc)? else {
            break;
        };
        any = true;
        if unit == 0x000A {
            break;
        }
        if units.len() < MAX_LINE_BYTES / 2 {
            units.push(unit);
        }
    }
    if units.last() == Some(&0x000D) {
        units.pop();
    }
    Ok((units, any))
}

fn skip_utf16_line<R: BufRead>(reader: &mut R, enc: Enc) -> io::Result<bool> {
    let mut any = false;
    loop {
        match read_unit(reader, enc)? {
            Some(unit) => {
                any = true;
                if unit == 0x000A {
                    break;
                }
            }
            None => break,
        }
    }
    Ok(any)
}
