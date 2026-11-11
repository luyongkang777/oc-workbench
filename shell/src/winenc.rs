//! GBK / GB18030 编解码：直接调 kernel32，不引第三方 crate。
//!
//! 工作台是 Windows 专用外壳，用系统代码页比自己塞一张映射表更省事，
//! 也让 dev（Node 的 TextDecoder）与生产（这里）对同一段字节给出同样的结果。
//!
//! 用 54936（GB18030）而不是 936（GBK）：GB18030 是 GBK 的超集，
//! 常见 GBK 文件逐字节一致，生僻字还能多覆盖一层。

/// GB18030 代码页。
const CODE_PAGE: u32 = 54936;
/// 遇到非法字节直接失败，而不是替换成默认字符（检测编码时要靠这个区分）。
const MB_ERR_INVALID_CHARS: u32 = 0x0000_0008;
/// 有字符无法用该代码页表示时失败。
const WC_ERR_INVALID_CHARS: u32 = 0x0000_0080;

#[cfg(windows)]
mod imp {
    use super::{CODE_PAGE, MB_ERR_INVALID_CHARS, WC_ERR_INVALID_CHARS};

    #[link(name = "kernel32")]
    extern "system" {
        fn MultiByteToWideChar(
            code_page: u32,
            flags: u32,
            bytes: *const u8,
            byte_count: i32,
            out: *mut u16,
            out_len: i32,
        ) -> i32;
        fn WideCharToMultiByte(
            code_page: u32,
            flags: u32,
            units: *const u16,
            unit_count: i32,
            out: *mut u8,
            out_len: i32,
            default_char: *const u8,
            used_default: *mut i32,
        ) -> i32;
    }

    fn decode_with(bytes: &[u8], flags: u32) -> Option<String> {
        if bytes.is_empty() {
            return Some(String::new());
        }
        let byte_count = i32::try_from(bytes.len()).ok()?;
        let len = unsafe {
            MultiByteToWideChar(CODE_PAGE, flags, bytes.as_ptr(), byte_count, std::ptr::null_mut(), 0)
        };
        if len <= 0 {
            return None;
        }
        let mut out = vec![0u16; len as usize];
        let written = unsafe {
            MultiByteToWideChar(CODE_PAGE, flags, bytes.as_ptr(), byte_count, out.as_mut_ptr(), len)
        };
        if written <= 0 {
            return None;
        }
        out.truncate(written as usize);
        Some(String::from_utf16_lossy(&out))
    }

    pub fn decode_strict(bytes: &[u8]) -> Option<String> {
        decode_with(bytes, MB_ERR_INVALID_CHARS)
    }

    pub fn decode_lossy(bytes: &[u8]) -> String {
        decode_with(bytes, 0).unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned())
    }

    pub fn encode(text: &str) -> Option<Vec<u8>> {
        let units: Vec<u16> = text.encode_utf16().collect();
        if units.is_empty() {
            return Some(Vec::new());
        }
        let unit_count = i32::try_from(units.len()).ok()?;
        let len = unsafe {
            WideCharToMultiByte(
                CODE_PAGE,
                WC_ERR_INVALID_CHARS,
                units.as_ptr(),
                unit_count,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
                std::ptr::null_mut(),
            )
        };
        if len <= 0 {
            return None;
        }
        let mut out = vec![0u8; len as usize];
        let written = unsafe {
            WideCharToMultiByte(
                CODE_PAGE,
                WC_ERR_INVALID_CHARS,
                units.as_ptr(),
                unit_count,
                out.as_mut_ptr(),
                len,
                std::ptr::null(),
                std::ptr::null_mut(),
            )
        };
        if written <= 0 {
            return None;
        }
        out.truncate(written as usize);
        Some(out)
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn decode_strict(_bytes: &[u8]) -> Option<String> {
        None
    }

    pub fn decode_lossy(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).into_owned()
    }

    pub fn encode(_text: &str) -> Option<Vec<u8>> {
        None
    }
}

pub use imp::{decode_lossy, decode_strict, encode};
