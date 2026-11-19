//! 破甲插件随 exe 自带：启动时按版本自愈落盘。
//!
//! 背景：破甲注入本体是 OpenCode 的全局插件，装在
//! `%USERPROFILE%\.config\opencode\plugins\purge`。以前换台电脑要手工复制，
//! 忘了复制就会出现「工作台顶栏开关是开的、模型却照拒」——开关只改 `config.json`
//! 的一个字段，插件不存在时它改的是一份没人读的文件。
//!
//! 现在把插件整棵目录树在编译期嵌进 exe（`shell/assets/purge`），启动时：
//!
//!   1. 数据目录里有 `.no-seed` → 整段跳过（用户主动关掉自带）；
//!   2. `.seed-version` 等于当前 exe 版本、且 `index.ts` 在 → 什么都不做；
//!   3. 其余情况把内嵌文件逐个写入，最后写版本号。
//!
//! **只写插件代码，永远不覆盖用户数据**：`purge/config.json`、
//! `purge/prompt-inject.md` 缺了才补默认，存在就一个字不动。
//!
//! 升级 exe = 版本号变化 = 插件跟着更新，不需要再手工同步。

use include_dir::{include_dir, Dir};
use std::fs;
use std::path::{Path, PathBuf};

/// 编译期内嵌的插件目录树（由 `scripts/sync-purge-assets.mjs` 从用户目录同步）。
pub static BUNDLED: Dir = include_dir!("$CARGO_MANIFEST_DIR/assets/purge");

/// 记住「上次是哪个 exe 版本落的盘」。放插件目录里，跟插件同生命周期。
const VERSION_FILE: &str = ".seed-version";
/// 逃生门：数据目录里放这个文件就完全跳过自带逻辑。
const OPT_OUT_FILE: &str = ".no-seed";

/// 新电脑第一次落盘用的配置。
///
/// `injectDefault: true` 是关键：别人的电脑没有本机那套 `purge/*` provider，
/// `perModel` 按模型 ID 精确匹配会全部落空。只有默认正文兜底才能保证
/// 「随便换个模型也能注入」。
const DEFAULT_CONFIG: &str = r#"{
  "enabled": true,
  "injectDefault": true,
  "keywordMap": {
    "glm": "prompts/glm.md",
    "gpt": "prompts/gpt.md",
    "deepseek": "prompts/deepseek.md",
    "claude": "prompts/claude.md",
    "grok": "prompts/grok.md",
    "gemini": "prompts/gemini.md"
  },
  "promptFile": "prompt-inject.md",
  "perModel": {},
  "temperature": null,
  "maxTokens": null,
  "tools": { "deny": [] },
  "verbose": false
}
"#;

/// 这一次启动对磁盘做了什么。
#[derive(Debug, Default)]
pub struct SeedReport {
    /// 跳过的原因；有值就说明一个字节都没写。
    pub skipped: Option<String>,
    /// 写成功的插件文件数。
    pub wrote: usize,
    /// 写成功的字节数。
    pub bytes: usize,
    /// 写之前内容与内嵌版本不同的文件数（升级覆盖了用户手改的内容时 > 0）。
    pub overwritten: usize,
    /// 内嵌文件总数（判断资源是否被打包进来时看它）。
    pub total: usize,
    pub config_written: bool,
    pub prompt_written: bool,
    /// 写失败等异常，逐条记下来（不影响启动）。
    pub problems: Vec<String>,
}

impl SeedReport {
    /// 一行日志：启动路径上只打这一条。
    pub fn describe(&self) -> String {
        if let Some(reason) = &self.skipped {
            return format!("跳过（{reason}）");
        }
        let mut text = format!("写入 {} / {} 个文件，{} 字节", self.wrote, self.total, self.bytes);
        if self.config_written {
            text.push_str("，补默认 config.json");
        }
        if self.prompt_written {
            text.push_str("，补默认提示词");
        }
        if self.overwritten > 0 {
            text.push_str(&format!(
                "，其中 {} 个文件原来被改过（已按 exe 内置版本覆盖）",
                self.overwritten
            ));
        }
        for problem in &self.problems {
            text.push_str("；");
            text.push_str(problem);
        }
        text
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// 插件目录：`<home>/.config/opencode/plugins/purge`。
pub fn plugins_dir(home: &Path) -> PathBuf {
    home.join(".config").join("opencode").join("plugins").join("purge")
}

/// 数据目录：`<home>/.config/opencode/purge`（config.json / 提示词 / state）。
pub fn data_dir(home: &Path) -> PathBuf {
    home.join(".config").join("opencode").join("purge")
}

/// 把内嵌目录树摊平成 (相对路径, 内容) 列表。
///
/// 单独拆出来是为了让测试能塞假数据：`include_dir::Dir` 没有公开构造器。
fn flatten<'a>(dir: &'a Dir<'a>, out: &mut Vec<(&'a Path, &'a [u8])>) {
    for file in dir.files() {
        out.push((file.path(), file.contents()));
    }
    for sub in dir.dirs() {
        flatten(sub, out);
    }
}

/// 生产入口：用真实家目录 + 当前 exe 版本。
pub fn ensure() -> SeedReport {
    let Some(home) = home_dir() else {
        return SeedReport {
            skipped: Some("读不到用户目录".to_string()),
            ..SeedReport::default()
        };
    };
    let mut files = Vec::new();
    flatten(&BUNDLED, &mut files);
    ensure_in(&home, env!("CARGO_PKG_VERSION"), &files)
}

/// 核心逻辑（家目录与文件清单都可注入，便于单测）。
pub fn ensure_in(home: &Path, version: &str, files: &[(&Path, &[u8])]) -> SeedReport {
    let mut report = SeedReport {
        total: files.len(),
        ..SeedReport::default()
    };

    let data = data_dir(home);
    if data.join(OPT_OUT_FILE).exists() {
        report.skipped = Some(format!("存在 {OPT_OUT_FILE}"));
        return report;
    }
    if files.is_empty() {
        report.skipped = Some("内嵌资源为空（构建时没跑 sync-purge-assets）".to_string());
        return report;
    }

    let plugins = plugins_dir(home);
    let stamp = plugins.join(VERSION_FILE);
    let installed = fs::read_to_string(&stamp)
        .map(|text| text.trim().to_string())
        .unwrap_or_default();
    if installed == version && plugins.join("index.ts").is_file() {
        report.skipped = Some(format!("已是最新（v{version}）"));
        // 插件本身不用写，但配置可能被用户删了，仍然补一次缺失项。
        seed_data(&data, files, &mut report);
        return report;
    }

    // 插件代码以 exe 为准：手改过的会被覆盖，这是「自带」的代价。
    // 要保住自己的改动就把插件复制出去另起一个 id，或者在数据目录放 .no-seed。
    for (rel, bytes) in files {
        let target = plugins.join(rel);
        if let Some(parent) = target.parent() {
            if let Err(err) = fs::create_dir_all(parent) {
                report.problems.push(format!("建目录 {} 失败：{err}", parent.display()));
                continue;
            }
        }
        // 先读旧内容：升级时全量重写，但真正有差异的才值得记一笔——
        // 用户手改过提示词的话，这行日志是他唯一能发现「改动没了」的地方。
        let differs = fs::read(&target)
            .map(|old| old.as_slice() != *bytes)
            .unwrap_or(false);
        match fs::write(&target, bytes) {
            Ok(()) => {
                report.wrote += 1;
                report.bytes += bytes.len();
                if differs {
                    report.overwritten += 1;
                }
            }
            Err(err) => report
                .problems
                .push(format!("写 {} 失败：{err}", rel.display())),
        }
    }

    // 版本戳只在**全部**写成功后落。
    //
    // 部分失败（某个文件被占用 / 权限不够）时若也盖戳，下次启动看到「版本一致 +
    // index.ts 在」就整个跳过，缺掉的那几个文件永远补不回来——表现是「插件装了，
    // 但某个提示词/子模块不见了」，而且没有任何报错。
    // 不盖戳则下次会重写全部（幂等），代价只是多写一遍。
    if report.wrote == report.total {
        if let Err(err) = fs::write(&stamp, version) {
            report.problems.push(format!("写版本戳失败：{err}"));
        }
    }

    seed_data(&data, files, &mut report);
    report
}

/// 补数据目录里缺失的默认文件，**已存在的一律不碰**。
fn seed_data(data: &Path, files: &[(&Path, &[u8])], report: &mut SeedReport) {
    if let Err(err) = fs::create_dir_all(data) {
        report.problems.push(format!("建数据目录失败：{err}"));
        return;
    }
    let config = data.join("config.json");
    if !config.exists() {
        match fs::write(&config, DEFAULT_CONFIG) {
            Ok(()) => report.config_written = true,
            Err(err) => report.problems.push(format!("写默认配置失败：{err}")),
        }
    }
    let prompt = data.join("prompt-inject.md");
    if !prompt.exists() {
        // 用内嵌的 prompts/default.md 当起始正文；找不到就交给插件自己 seed。
        let bundled_default = files
            .iter()
            .find(|(rel, _)| rel.to_string_lossy().replace('\\', "/") == "prompts/default.md")
            .map(|(_, bytes)| *bytes);
        if let Some(bytes) = bundled_default {
            match fs::write(&prompt, bytes) {
                Ok(()) => report.prompt_written = true,
                Err(err) => report.problems.push(format!("写默认提示词失败：{err}")),
            }
        }
    }
}

#[cfg(test)]
#[path = "purge_seed_tests.rs"]
mod tests;
