//! 首次启动窗口尺寸的单测。
//!
//! 只测纯计算：真去读显示器得先有事件循环和窗口系统，CI 与远程会话里不可靠，
//! 而那些分支的输入（物理分辨率、缩放率）本来就是这两个纯函数的参数。

use super::{
    centered_window_position, clamp_saved_window, comfort_window_logical, format_window_size,
    normalize_scale, parse_window_size, should_remember_window, window_memory_decision,
    WindowMemory,
};

/// 有代表性的「物理分辨率 + 缩放率」组合。
const CASES: &[(u32, u32, f64, &str)] = &[
    (1920, 1080, 1.0, "1080p@100%"),
    (1920, 1080, 1.25, "1080p@125%"),
    (1920, 1080, 1.5, "1080p@150%"),
    (2560, 1440, 1.0, "1440p@100%"),
    (2560, 1440, 1.5, "1440p@150%"),
    (3840, 2160, 2.0, "4K@200%"),
    (1366, 768, 1.0, "1366×768"),
    (1024, 600, 1.0, "1024×600"),
    (2880, 1800, 2.0, "MacBook@200%"),
    (3440, 1440, 1.0, "带鱼屏@100%"),
];

fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() < 0.01,
        "{label}: 期望 {expected}，实际 {actual}"
    );
}

#[test]
fn never_exceeds_the_screen_with_margin() {
    for &(w, h, scale, label) in CASES {
        let scale = normalize_scale(scale);
        let avail_w = w as f64 / scale;
        let avail_h = h as f64 / scale;
        let (win_w, win_h) = comfort_window_logical(avail_w, avail_h);

        assert!(win_w > 0.0 && win_h > 0.0, "{label}: 尺寸非正");
        // 小屏兜底：最多占可用逻辑尺寸的 90% / 86%。
        assert!(
            win_w <= avail_w * 0.90 + 0.01,
            "{label}: 宽 {win_w:.1} 超过可用宽 {avail_w:.1} 的 90%"
        );
        assert!(
            win_h <= avail_h * 0.86 + 0.01,
            "{label}: 高 {win_h:.1} 超过可用高 {avail_h:.1} 的 86%"
        );
        // 大屏也不放开上限，避免 4K 下开出巨窗。
        assert!(win_w <= 1280.0 + 0.01, "{label}: 宽超过 1280 上限");
        assert!(win_h <= 840.0 + 0.01, "{label}: 高超过 840 上限");
        // 只有屏幕真的放不下时，才允许低于舒适下限。
        assert!(
            win_w >= 960.0_f64.min(avail_w * 0.90) - 0.01,
            "{label}: 宽 {win_w:.1} 低于舒适下限"
        );
        assert!(
            win_h >= 620.0_f64.min(avail_h * 0.86) - 0.01,
            "{label}: 高 {win_h:.1} 低于舒适下限"
        );
    }
}

#[test]
fn full_hd_at_100_percent_is_comfortable() {
    // 1920×1080@100%：宽度到舒适上限，高度按 74% 取，四周明显留白。
    let (w, h) = comfort_window_logical(1920.0, 1080.0);
    assert_close(w, 1280.0, "宽");
    assert_close(h, 799.2, "高");
    assert!(w < 1920.0 * 0.7 && h < 1080.0 * 0.8, "窗口仍然偏大：{w}×{h}");
}

#[test]
fn shrinks_as_scale_factor_grows() {
    // 同一块 1080p 屏，缩放越高，逻辑可用区越小，窗口也必须跟着小。
    let (w100, _) = comfort_window_logical(1920.0, 1080.0);
    let (w125, _) = comfort_window_logical(1536.0, 864.0);
    let (w150, _) = comfort_window_logical(1280.0, 720.0);
    assert!(w100 > w125 && w125 > w150, "100% {w100} / 125% {w125} / 150% {w150}");
    // 150% 下必须真的收窄到屏幕以内，这正是原来写死 1400 时溢出的地方。
    assert!(w150 < 1280.0, "150% 下窗口宽 {w150} 仍顶到屏幕");
}

#[test]
fn small_screen_keeps_taskbar_visible() {
    // 1366×768：高度够不到舒适下限 620，但也不能盖住任务栏。
    let (w, h) = comfort_window_logical(1366.0, 768.0);
    assert_close(w, 983.52, "宽");
    assert_close(h, 620.0, "高");
    assert!(h < 768.0 * 0.85, "高 {h} 太高，会压到任务栏");
}

#[test]
fn tiny_screen_falls_back_to_ratio_cap() {
    // 1024×600 连舒适下限都放不下，此时比例上限说了算。
    let (w, h) = comfort_window_logical(1024.0, 600.0);
    assert_close(w, 1024.0 * 0.90, "宽");
    assert_close(h, 600.0 * 0.86, "高");
}

#[test]
fn centers_window_on_the_monitor() {
    // 3840×2160 主屏上放 1440×900：左右各留 1200，上下各留 630。
    let pos = centered_window_position((0, 0), (3840, 2160), (1440, 900));
    assert_eq!(pos, (1200, 630));

    // 副屏在右边（原点 1920,0）时，位置要跟着原点偏移。
    let pos = centered_window_position((1920, 0), (2560, 1440), (1280, 720));
    assert_eq!(pos, (1920 + 640, 360));

    // 窗口比屏幕还大时不出现负坐标，贴住左上角。
    let pos = centered_window_position((100, 50), (800, 600), (1600, 1200));
    assert_eq!(pos, (100, 50));
}

#[test]
fn abnormal_scale_falls_back_to_one() {
    assert_eq!(normalize_scale(1.25), 1.25);
    assert_eq!(normalize_scale(2.0), 2.0);
    assert_eq!(normalize_scale(0.0), 1.0);
    assert_eq!(normalize_scale(-1.0), 1.0);
    assert_eq!(normalize_scale(f64::NAN), 1.0);
    assert_eq!(normalize_scale(f64::INFINITY), 1.0);
    assert_eq!(normalize_scale(100.0), 1.0);
}

#[test]
fn parses_and_formats_saved_size() {
    assert_eq!(parse_window_size("1280x840"), Some((1280.0, 840.0)));
    assert_eq!(parse_window_size("  1280 X 840 \n"), Some((1280.0, 840.0)));
    // 坏值当没存：手改坏设置不该把窗口带到奇怪的位置。
    assert_eq!(parse_window_size("1280"), None);
    assert_eq!(parse_window_size("0x840"), None);
    assert_eq!(parse_window_size("-10x840"), None);
    assert_eq!(parse_window_size("nanx840"), None);
    assert_eq!(parse_window_size("99999x840"), None);
    assert_eq!(parse_window_size(""), None);
    // 存的是整数逻辑像素，四舍五入。
    assert_eq!(format_window_size((1280.4, 839.6)), "1280x840");
}

#[test]
fn restored_size_is_clamped_by_current_screen() {
    // 大屏上原样保留用户拖的尺寸，不强行拉回舒适区间。
    assert_eq!(clamp_saved_window((1500.0, 900.0), 2048.0, 1152.0), (1500.0, 900.0));

    // 换到 1080p@125%（可用 1536×864）：收到可用区的 90% / 86%。
    let (w, h) = clamp_saved_window((1500.0, 900.0), 1536.0, 864.0);
    assert_close(w, 1536.0 * 0.90, "宽");
    assert_close(h, 864.0 * 0.86, "高");

    // 存的是个比最小窗口还小的值（手改坏）：抬到最小窗口。
    assert_eq!(clamp_saved_window((600.0, 400.0), 2048.0, 1152.0), (800.0, 560.0));
}

#[test]
fn untouched_window_is_not_remembered() {
    // 完全没动：不记，保留「按分辨率自动」的能力。
    assert!(!should_remember_window((1280.0, 840.0), (1280.0, 840.0)));
    // 贴边吸附 / DPI 取整抖几像素：也算没动。
    assert!(!should_remember_window((1283.0, 842.0), (1280.0, 840.0)));
    // 真拖过：记。
    assert!(should_remember_window((1100.0, 840.0), (1280.0, 840.0)));
    assert!(should_remember_window((1280.0, 700.0), (1280.0, 840.0)));
}

#[test]
fn window_memory_decision_covers_all_three_cases() {
    let initial = (1000.0, 700.0);
    let auto = (1280.0, 840.0);
    // 没拖过：不写盘，自动尺寸继续跟着屏幕走。
    assert_eq!(
        window_memory_decision((1000.0, 700.0), initial, auto),
        WindowMemory::Skip
    );
    // 拖到了自定义尺寸：记住。
    assert_eq!(
        window_memory_decision((1100.0, 650.0), initial, auto),
        WindowMemory::Save
    );
    // 拖回当前屏幕的自动尺寸：清掉记忆 = 恢复自动。
    assert_eq!(
        window_memory_decision((1280.0, 840.0), initial, auto),
        WindowMemory::Clear
    );
}
