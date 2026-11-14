//! 单实例判定的单测。
//!
//! 只测纯函数：真去枚举窗口要跑在真实桌面会话里，CI 与远程会话都不稳定。
//! 判定口径本身是纯计算，输入就是「标题 + exe 路径 + 是否可见」三样。

use crate::single::WINDOW_TITLE;
use crate::single_peer::{
    exe_name_is_workbench, is_peer_window, title_looks_like_workbench,
};

/// exe 名判定：不同版本、带 -shell 后缀、大小写混写都算。
#[test]
fn exe_name_covers_every_packaged_name() {
    for name in [
        "oc-workbench.exe",
        "oc-workbench-shell.exe",
        "OC-Workbench.EXE",
        "oc-workbench-1.3.4-win64.exe",
    ] {
        assert!(exe_name_is_workbench(name), "{name} 应该被认成工作台");
    }
    for name in ["notepad.exe", "code.exe", "workbench.exe", ""] {
        assert!(!exe_name_is_workbench(name), "{name} 不该被认成工作台");
    }
}

/// 读得到路径时只认 exe 名：浏览器打开 dev 页会带着同样的标题，
/// 但绝不能被当成重复实例（否则守护线程会去关用户的浏览器）。
#[test]
fn readable_path_with_foreign_exe_is_never_a_peer() {
    for exe in [
        "C:\\Program Files\\BraveSoftware\\brave.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Windows\\notepad.exe",
        "C:\\Windows\\explorer.exe",
    ] {
        assert!(
            !is_peer_window(WINDOW_TITLE, Some(exe), true),
            "{exe} 带着同样的标题也不能算工作台"
        );
    }
}

/// 老版本的 exe 名、装在不同目录，也要认出来。
#[test]
fn any_version_or_directory_counts_as_peer() {
    assert!(is_peer_window(
        WINDOW_TITLE,
        Some("F:\\opencode\\workbench\\release\\oc-workbench-1.1.2-win64\\oc-workbench.exe"),
        true
    ));
    assert!(is_peer_window(
        "",
        Some("D:\\tools\\oc-workbench-shell.exe"),
        false
    ));
}

/// 读不到路径时退化成标题精确匹配；标题不一致就不认（宁可漏认）。
#[test]
fn falls_back_to_exact_title_when_path_is_unreadable() {
    assert!(is_peer_window(WINDOW_TITLE, None, true));
    assert!(!is_peer_window(WINDOW_TITLE, None, false));
    assert!(!is_peer_window(
        "OpenCode 工作台 - 用户数据 1 - Microsoft Edge",
        None,
        true
    ));
}

/// 「认得出」和「敢动手」必须分开。
///
/// 读不到 exe 路径时，判定是按标题猜的；这时就算标题刚好等于
/// WINDOW_TITLE，也**只允许用来阻止自己启动**，绝不允许去关那个窗口。
/// 这条守的是「不会误杀用户的浏览器」：用浏览器打开 dev 页时标题一模一样，
/// 而某些权限场景下（管理员进程）我们读不到它的 exe 路径。
#[test]
fn title_prefilter_is_prefix_friendly() {
    assert!(title_looks_like_workbench("OpenCode 工作台"));
    assert!(title_looks_like_workbench("OpenCode 工作台 - workbench 项目"));
    assert!(!title_looks_like_workbench("记事本"));
    assert!(!title_looks_like_workbench(""));
}
