//! 整份解码与十六进制转储（从 fsread 拆出）。

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use crate::fsindex::{detect_encoding, Enc};

/// 读整份文本用于 Markdown 预览：超过 `max_bytes` 返回 `None`（由调用方报 413）。
pub fn read_whole(path: &Path, max_bytes: u64) -> io::Result<Option<String>> {
    let mut file = File::open(path)?;
    // 不信任 metadata 的长度：文件可能在这两步之间被写大。多读 1 字节用来判超限。
    let mut bytes = Vec::with_capacity(max_bytes.min(1024 * 1024) as usize);
    file.by_ref()
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Ok(None);
    }
    let (enc, data_start) = detect_encoding(&bytes[..bytes.len().min(4)]);
    let body = &bytes[(data_start as usize).min(bytes.len())..];
    let text = match enc {
        Enc::Utf8 => String::from_utf8_lossy(body).into_owned(),
        Enc::Utf16Le => decode_utf16(body, true),
        Enc::Utf16Be => decode_utf16(body, false),
    };
    Ok(Some(text.replace("\r\n", "\n")))
}

fn decode_utf16(body: &[u8], little: bool) -> String {
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

/// 十六进制转储（二进制文件预览用）。
pub fn hex_dump(path: &Path, offset: u64, len: usize) -> io::Result<String> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let offset = offset.min(size);
    let want = len.min((size - offset) as usize);
    let mut buf = vec![0u8; want];
    file.seek(SeekFrom::Start(offset))?;
    let mut got = 0;
    while got < want {
        match file.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        }
    }
    buf.truncate(got);

    let mut out = String::with_capacity(buf.len() * 4 + 32);
    for (row, chunk) in buf.chunks(16).enumerate() {
        let addr = offset + (row * 16) as u64;
        out.push_str(&format!("{addr:08x}  "));
        for i in 0..16 {
            match chunk.get(i) {
                Some(byte) => out.push_str(&format!("{byte:02x} ")),
                None => out.push_str("   "),
            }
            if i == 7 {
                out.push(' ');
            }
        }
        out.push_str(" |");
        for byte in chunk {
            let ch = if (0x20..0x7f).contains(byte) {
                *byte as char
            } else {
                '.'
            };
            out.push(ch);
        }
        out.push_str("|\n");
    }
    Ok(out)
}
