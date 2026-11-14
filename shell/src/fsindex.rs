//! 文件行索引：一次线性扫描拿到行数与稀疏检查点，供任意大小文件按行分页读取。
//!
//! 检查点每 [`CHECKPOINT_EVERY`] 行记一条 `(行号, 该行起始字节偏移)`，
//! 于是读第 N 行最多只需要「seek 到最近检查点 + 跳过 <4096 行」，不用从头扫。
//! 索引按「路径 + size + mtime」缓存，文件被改写后自动重建。

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

pub const CHECKPOINT_EVERY: u64 = 4096;
const SCAN_BUF: usize = 256 * 1024;
const BINARY_PROBE: usize = 8192;
const CACHE_CAP: usize = 8;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Enc {
    Utf8,
    Utf16Le,
    Utf16Be,
    /// GBK / GB18030（中文 Windows 默认代码页）；没有 BOM，靠「不是合法 UTF-8」判出来。
    Gbk,
}

impl Enc {
    pub fn name(self) -> &'static str {
        match self {
            Enc::Utf8 => "utf8",
            Enc::Utf16Le => "utf16le",
            Enc::Utf16Be => "utf16be",
            Enc::Gbk => "gbk",
        }
    }

    /// 与 UTF-8 一样按「字节 0x0A」切行：GBK 的双字节序列里不会出现 0x0A。
    pub fn byte_lines(self) -> bool {
        matches!(self, Enc::Utf8 | Enc::Gbk)
    }

    /// 前端 / 查询参数里的编码名 → 枚举；大小写和连字符都容忍。
    pub fn from_name(name: &str) -> Option<Enc> {
        match name.trim().to_ascii_lowercase().as_str() {
            "utf8" | "utf-8" => Some(Enc::Utf8),
            "utf16le" | "utf-16le" | "utf16" => Some(Enc::Utf16Le),
            "utf16be" | "utf-16be" => Some(Enc::Utf16Be),
            "gbk" | "gb2312" | "gb18030" => Some(Enc::Gbk),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub struct Index {
    pub enc: Enc,
    pub size: u64,
    /// 文本行数；二进制文件为 0。
    pub line_count: u64,
    pub binary: bool,
    /// `(行号, 该行第一个字节的绝对偏移)`，升序，首条恒为 `(0, 正文起点)`。
    pub checkpoints: Vec<(u64, u64)>,
}

/// 按 BOM 判断编码，返回（编码, 正文起始偏移）。
pub fn detect_encoding(head: &[u8]) -> (Enc, u64) {
    if head.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (Enc::Utf8, 3)
    } else if head.starts_with(&[0xFF, 0xFE]) {
        (Enc::Utf16Le, 2)
    } else if head.starts_with(&[0xFE, 0xFF]) {
        (Enc::Utf16Be, 2)
    } else {
        (Enc::Utf8, 0)
    }
}

/// 没有 BOM 时用来分辨 UTF-8 / GBK 的探测长度；8KB 足够看到中文正文。
const ENCODING_PROBE: usize = 8192;

/// 完整判定编码：先看 BOM；没有 BOM 就按「合法 UTF-8 → 否则合法 GB18030」猜。
///
/// 判 GBK 前必须先确认「不是 UTF-8」：GBK 很宽松，UTF-8 的中文字节通常也能解成 GBK 乱码。
/// 按内存里的字节判定编码（与 [`detect_file_encoding`] 同一套规则）。
///
/// 整份读取（Markdown / HTML 预览）拿到的是已经在内存里的 bytes，
/// 不能只按 BOM 判：无 BOM 的 GBK 文件会被当成 UTF-8 解成乱码。
pub fn detect_bytes_encoding(bytes: &[u8], size: u64) -> (Enc, u64) {
    let (enc, data_start) = detect_encoding(&bytes[..bytes.len().min(4)]);
    if enc != Enc::Utf8 || data_start != 0 || size == 0 {
        return (enc, data_start);
    }
    let probe = &bytes[..bytes.len().min(ENCODING_PROBE)];
    if probe.is_empty() || is_utf8_prefix(probe) {
        return (Enc::Utf8, 0);
    }
    if crate::winenc::decode_strict(probe).is_some() {
        return (Enc::Gbk, 0);
    }
    // 两边都不合法：保持旧行为，交给 UTF-8 lossy 显示
    (Enc::Utf8, 0)
}

pub fn detect_file_encoding(file: &mut File, size: u64) -> io::Result<(Enc, u64)> {
    let mut head = [0u8; 4];
    let head_len = read_up_to(file, &mut head)?;
    let (enc, data_start) = detect_encoding(&head[..head_len]);
    if enc != Enc::Utf8 || data_start != 0 || size == 0 {
        return Ok((enc, data_start));
    }

    file.seek(SeekFrom::Start(0))?;
    let want = size.min(ENCODING_PROBE as u64) as usize;
    let mut probe = vec![0u8; want];
    let got = read_up_to(file, &mut probe)?;
    probe.truncate(got);
    if probe.is_empty() || is_utf8_prefix(&probe) {
        return Ok((Enc::Utf8, 0));
    }
    if crate::winenc::decode_strict(&probe).is_some() {
        return Ok((Enc::Gbk, 0));
    }
    // 两边都不合法：保持旧行为，交给 UTF-8 lossy 显示
    Ok((Enc::Utf8, 0))
}

/// 整段是否「像被切断的 UTF-8」：只有末尾半截字符才允许失败。
fn is_utf8_prefix(bytes: &[u8]) -> bool {
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        Err(err) => err.error_len().is_none(),
    }
}

struct Cached {
    key: String,
    size: u64,
    mtime: Option<SystemTime>,
    index: Arc<Index>,
}

static CACHE: Mutex<Vec<Cached>> = Mutex::new(Vec::new());

/// 取（或重建）文件索引。大文件只在第一次打开时扫一遍，之后命中缓存。
pub fn index_for(path: &Path) -> io::Result<Arc<Index>> {
    index_for_encoding(path, None)
}

/// 指定编码建索引（「以 X 编码重新打开」用）。
///
/// 缓存键带上编码：同一文件按 UTF-8 / GBK 扫出来的行布局可能不同（UTF-16 尤其明显），
/// 不能共用一份索引。`None` 表示按 BOM / 探测自动判定。
pub fn index_for_encoding(path: &Path, forced: Option<Enc>) -> io::Result<Arc<Index>> {
    let key = match forced {
        Some(enc) => format!("{}#{}", path.to_string_lossy(), enc.name()),
        None => path.to_string_lossy().to_string(),
    };
    let meta = std::fs::metadata(path)?;
    let size = meta.len();
    let mtime = meta.modified().ok();
    if let Some(index) = lookup(&key, size, mtime) {
        return Ok(index);
    }
    let index = Arc::new(scan(path, forced)?);
    store(Cached {
        key,
        size,
        mtime,
        index: index.clone(),
    });
    Ok(index)
}

fn lookup(key: &str, size: u64, mtime: Option<SystemTime>) -> Option<Arc<Index>> {
    let mut cache = lock_cache();
    let pos = cache.iter().position(|item| item.key == key)?;
    if cache[pos].size != size || cache[pos].mtime != mtime {
        cache.remove(pos);
        return None;
    }
    let index = cache[pos].index.clone();
    // 命中的挪到最前，近似 LRU
    let item = cache.remove(pos);
    cache.insert(0, item);
    Some(index)
}

fn store(entry: Cached) {
    let mut cache = lock_cache();
    cache.retain(|item| item.key != entry.key);
    cache.insert(0, entry);
    cache.truncate(CACHE_CAP);
}

/// 锁中毒时照常取数据：缓存失效只会让下一次重扫，不能让请求失败。
fn lock_cache() -> std::sync::MutexGuard<'static, Vec<Cached>> {
    match CACHE.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn scan(path: &Path, forced: Option<Enc>) -> io::Result<Index> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let (enc, data_start) = match forced {
        Some(enc) => {
            // 强制编码：只有 BOM 跟它一致时才跳过 BOM，否则从 0 开始解
            let mut head = [0u8; 4];
            let n = read_up_to(&mut file, &mut head)?;
            let (bom_enc, bom_start) = detect_encoding(&head[..n]);
            if bom_enc == enc {
                (enc, bom_start)
            } else {
                (enc, 0)
            }
        }
        None => detect_file_encoding(&mut file, size)?,
    };

    // 只有单字节编码（UTF-8 / GBK）才做「前 8KB 有 NUL 就是二进制」的判断；UTF-16 到处都是 NUL。
    let binary = enc.byte_lines() && size > data_start && probe_binary(&mut file, data_start, size)?;
    if binary {
        return Ok(Index {
            enc,
            size,
            line_count: 0,
            binary: true,
            checkpoints: Vec::new(),
        });
    }

    file.seek(SeekFrom::Start(data_start))?;
    let mut buf = vec![0u8; SCAN_BUF];
    let mut newlines = 0u64;
    let mut checkpoints = vec![(0u64, data_start)];
    let mut consumed = 0u64;
    let mut last_is_newline = false;

    loop {
        // 用 read_up_to 把缓冲区尽量填满：只有最后一次短读，保证 UTF-16 配对始终 2 字节对齐。
        let n = read_up_to(&mut file, &mut buf)?;
        if n == 0 {
            break;
        }
        match enc {
            Enc::Utf8 | Enc::Gbk => {
                for (i, byte) in buf[..n].iter().enumerate() {
                    last_is_newline = *byte == b'\n';
                    if !last_is_newline {
                        continue;
                    }
                    newlines += 1;
                    if newlines % CHECKPOINT_EVERY == 0 {
                        checkpoints.push((newlines, data_start + consumed + i as u64 + 1));
                    }
                }
            }
            Enc::Utf16Le | Enc::Utf16Be => {
                let mut i = 0;
                while i + 1 < n {
                    let unit = if enc == Enc::Utf16Le {
                        u16::from_le_bytes([buf[i], buf[i + 1]])
                    } else {
                        u16::from_be_bytes([buf[i], buf[i + 1]])
                    };
                    last_is_newline = unit == 0x000A;
                    if last_is_newline {
                        newlines += 1;
                        if newlines % CHECKPOINT_EVERY == 0 {
                            checkpoints.push((newlines, data_start + consumed + i as u64 + 2));
                        }
                    }
                    i += 2;
                }
            }
        }
        consumed += n as u64;
    }

    let mut line_count = newlines;
    if size > data_start && !last_is_newline {
        line_count += 1;
    }

    Ok(Index {
        enc,
        size,
        line_count,
        binary: false,
        checkpoints,
    })
}

fn probe_binary(file: &mut File, data_start: u64, size: u64) -> io::Result<bool> {
    let want = BINARY_PROBE.min((size - data_start) as usize);
    let mut probe = vec![0u8; want];
    file.seek(SeekFrom::Start(data_start))?;
    let got = read_up_to(file, &mut probe)?;
    Ok(probe[..got].contains(&0))
}

fn read_up_to(file: &mut File, buf: &mut [u8]) -> io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        match file.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        }
    }
    Ok(got)
}
