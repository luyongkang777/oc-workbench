//! `purge_seed` 的行为测试。
//!
//! 都在临时目录里跑：真实家目录一个字节都不碰。

use super::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn temp_home(tag: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "oc-purge-seed-{}-{tag}-{n}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("建临时目录");
    dir
}

/// 两个文件名带 `/` 的真实形状：插件入口 + 子目录资源。
fn sample_files() -> Vec<(&'static Path, &'static [u8])> {
    vec![
        (Path::new("index.ts"), b"export default 1\n".as_slice()),
        (Path::new("prompts/default.md"), b"# default\n".as_slice()),
    ]
}

#[test]
fn 空目录首次运行写入全部文件并补默认配置() {
    let home = temp_home("first");
    let files = sample_files();
    let report = ensure_in(&home, "1.0.0", &files);

    assert!(report.skipped.is_none(), "首次应该真的写盘");
    assert_eq!(report.wrote, 2);
    assert_eq!(report.total, 2);
    assert!(report.config_written);
    assert!(report.prompt_written);
    assert!(report.problems.is_empty(), "{:?}", report.problems);

    let plugins = plugins_dir(&home);
    assert!(plugins.join("index.ts").is_file());
    assert!(plugins.join("prompts/default.md").is_file());
    assert_eq!(
        fs::read_to_string(plugins.join(VERSION_FILE)).unwrap().trim(),
        "1.0.0"
    );

    let data = data_dir(&home);
    let config = fs::read_to_string(data.join("config.json")).unwrap();
    assert!(config.contains("\"injectDefault\": true"), "新机器必须默认兜底注入");
    assert_eq!(
        fs::read_to_string(data.join("prompt-inject.md")).unwrap(),
        "# default\n"
    );
}

#[test]
fn 同版本再启动直接跳过() {
    let home = temp_home("idempotent");
    let files = sample_files();
    ensure_in(&home, "1.0.0", &files);

    let again = ensure_in(&home, "1.0.0", &files);
    assert_eq!(again.wrote, 0);
    assert!(again.skipped.as_deref().unwrap_or("").contains("已是最新"));
    assert!(!again.config_written);
}

#[test]
fn 版本变化重写插件但保留用户配置() {
    let home = temp_home("upgrade");
    let files = sample_files();
    ensure_in(&home, "1.0.0", &files);

    // 用户改了配置和提示词
    let data = data_dir(&home);
    fs::write(data.join("config.json"), "{\"enabled\":false}").unwrap();
    fs::write(data.join("prompt-inject.md"), "用户自己的正文").unwrap();

    let report = ensure_in(&home, "1.1.0", &files);
    assert_eq!(report.wrote, 2, "版本变了就应该重写插件");
    assert!(!report.config_written, "配置必须原样保留");
    assert!(!report.prompt_written, "提示词必须原样保留");
    assert_eq!(
        fs::read_to_string(data.join("config.json")).unwrap(),
        "{\"enabled\":false}"
    );
    assert_eq!(
        fs::read_to_string(data.join("prompt-inject.md")).unwrap(),
        "用户自己的正文"
    );
    assert_eq!(
        fs::read_to_string(plugins_dir(&home).join(VERSION_FILE))
            .unwrap()
            .trim(),
        "1.1.0"
    );
}

#[test]
fn 存在_no_seed_时一个字节都不写() {
    let home = temp_home("optout");
    let data = data_dir(&home);
    fs::create_dir_all(&data).unwrap();
    fs::write(data.join(OPT_OUT_FILE), "").unwrap();

    let report = ensure_in(&home, "1.0.0", &sample_files());
    assert!(report.skipped.as_deref().unwrap_or("").contains(".no-seed"));
    assert_eq!(report.wrote, 0);
    assert!(!plugins_dir(&home).exists(), "跳过时不该建插件目录");
}

#[test]
fn 插件文件被删掉但版本戳还在时会重写() {
    let home = temp_home("missing");
    let files = sample_files();
    ensure_in(&home, "1.0.0", &files);

    fs::remove_file(plugins_dir(&home).join("index.ts")).unwrap();
    let report = ensure_in(&home, "1.0.0", &files);
    assert_eq!(report.wrote, 2, "index.ts 不在就不能信版本戳");
    assert!(plugins_dir(&home).join("index.ts").is_file());
}

#[test]
fn 内嵌资源必须包含插件入口与提示词() {
    let mut files = Vec::new();
    flatten(&BUNDLED, &mut files);
    let names: Vec<String> = files
        .iter()
        .map(|(rel, _)| rel.to_string_lossy().replace('\\', "/"))
        .collect();

    for required in [
        "index.ts",
        "core.mts",
        "prompts/default.md",
        "redteam/index.mts",
    ] {
        assert!(
            names.iter().any(|name| name == required),
            "内嵌资源缺少 {required}，构建前要跑 scripts/sync-purge-assets.mjs；实际有：{names:?}"
        );
    }
    let total_bytes: usize = files.iter().map(|(_, bytes)| bytes.len()).sum();
    assert!(
        total_bytes > 100_000,
        "提示词合计只有 {total_bytes} 字节，看起来同步漏了"
    );
}

#[test]
fn 部分写入失败时不盖版本戳以便下次重试() {
    let home = temp_home("partial");
    // Windows 上文件名带尖括号非法，用它稳定制造一次写失败。
    let files: Vec<(&Path, &[u8])> = vec![
        (Path::new("index.ts"), b"ok".as_slice()),
        (Path::new("bad<name>.ts"), b"nope".as_slice()),
    ];
    let report = ensure_in(&home, "1.0.0", &files);

    assert_eq!(report.wrote, 1, "只有正常那个能写进去");
    assert!(!report.problems.is_empty(), "失败要记进 problems");
    assert!(
        !plugins_dir(&home).join(VERSION_FILE).exists(),
        "部分失败不能盖版本戳，否则缺的文件永远补不回来"
    );
}

#[test]
fn 覆盖手改过的文件时会计数并写进日志描述() {
    let home = temp_home("overwrite");
    let files = sample_files();
    ensure_in(&home, "1.0.0", &files);

    fs::write(plugins_dir(&home).join("index.ts"), "本地改过的内容").unwrap();
    let report = ensure_in(&home, "2.0.0", &files);

    assert_eq!(report.overwritten, 1, "只有被改过的那个算覆盖");
    assert!(
        report.describe().contains("原来被改过"),
        "日志必须让人看见改动被覆盖了：{}",
        report.describe()
    );
    assert_eq!(
        fs::read_to_string(plugins_dir(&home).join("index.ts")).unwrap(),
        "export default 1
"
    );
}

#[test]
fn 描述文本能反映写入结果() {
    let home = temp_home("describe");
    let report = ensure_in(&home, "1.0.0", &sample_files());
    let text = report.describe();
    assert!(text.contains("写入 2 / 2"), "{text}");
    assert!(text.contains("config.json"), "{text}");

    let skipped = ensure_in(&home, "1.0.0", &sample_files());
    assert!(skipped.describe().contains("跳过"), "{}", skipped.describe());
}
