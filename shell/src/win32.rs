//! single.rs / peer.rs 共用的最小 Win32 声明。
//!
//! 只有这两个模块用得到，所以没有引 `windows-sys`：
//! 但声明必须**集中放一处**——同一个常量或函数签名在两处各写一份，
//! 迟早出现「改了一处漏了另一处」。
#![allow(dead_code)]

use std::ffi::c_void;

/// 窗口句柄（HWND）。
pub type Hwnd = *mut c_void;
/// 内核对象句柄。
pub type Handle = *mut c_void;

pub const ERROR_ALREADY_EXISTS: u32 = 183;

pub const SW_RESTORE: i32 = 9;
pub const SW_SHOW: i32 = 5;
/// MB_OK | MB_ICONINFORMATION
pub const MB_INFO: u32 = 0x40;
pub const WM_CLOSE: u32 = 0x0010;

/// 读进程基本信息的「只读」权限，跨完整性级别通常也放行。
pub const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
/// 终止进程。属写类权限，会被完整性级别（MIC）拦下——**所以只在确认要动手时才申请**。
pub const PROCESS_TERMINATE: u32 = 0x0001;
pub const SYNCHRONIZE: u32 = 0x0010_0000;
pub const WAIT_OBJECT_0: u32 = 0;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    pub fn CreateMutexW(attrs: *const c_void, owner: i32, name: *const u16) -> Handle;
    pub fn CloseHandle(handle: Handle) -> i32;
    pub fn GetLastError() -> u32;
    pub fn GetCurrentProcessId() -> u32;
    pub fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    pub fn QueryFullProcessImageNameW(
        process: Handle,
        flags: u32,
        buffer: *mut u16,
        size: *mut u32,
    ) -> i32;
    pub fn TerminateProcess(process: Handle, code: u32) -> i32;
    pub fn WaitForSingleObject(handle: Handle, millis: u32) -> u32;
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    pub fn EnumWindows(callback: EnumProc, lparam: isize) -> i32;
    pub fn GetWindowTextW(hwnd: Hwnd, buffer: *mut u16, max: i32) -> i32;
    pub fn GetWindowThreadProcessId(hwnd: Hwnd, pid: *mut u32) -> u32;
    pub fn IsWindowVisible(hwnd: Hwnd) -> i32;
    pub fn IsWindow(hwnd: Hwnd) -> i32;
    pub fn IsIconic(hwnd: Hwnd) -> i32;
    pub fn ShowWindow(hwnd: Hwnd, cmd: i32) -> i32;
    pub fn SetForegroundWindow(hwnd: Hwnd) -> i32;
    pub fn PostMessageW(hwnd: Hwnd, msg: u32, w: usize, l: isize) -> i32;
    pub fn MessageBoxW(
        hwnd: Hwnd,
        text: *const u16,
        caption: *const u16,
        utype: u32,
    ) -> i32;
}

/// `EnumWindows` 的回调类型。
pub type EnumProc = Option<unsafe extern "system" fn(Hwnd, isize) -> i32>;
