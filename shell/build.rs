//! 构建前检查内嵌资源：
//!   * `include_dir!("$CARGO_MANIFEST_DIR/../dist")` 在 dist 缺失时
//!     只会报一条很难懂的错误（找不到目录 / 空目录）；
//!   * `include_dir!("$CARGO_MANIFEST_DIR/assets/purge")`（破甲插件）同理。
//!
//! 这里提前给出人话提示，并把两份目录都登记成 rustc 的变更依赖。
//!
//! 注意 dist/ 在 .gitignore 里，新克隆仓库必须先跑 `npm.cmd run build`；
//! shell/assets/purge 则是提交进仓库的（发布物），改了插件要重跑
//! `node scripts/sync-purge-assets.mjs` 再提交。

use std::path::Path;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("拿不到 CARGO_MANIFEST_DIR");

    let index = Path::new(&manifest).join("..").join("dist").join("index.html");
    println!("cargo:rerun-if-changed=../dist/index.html");
    // 目录级监听：新增/删除 dist 里的文件也要触发重新编译（否则改了前端不重打包）。
    println!("cargo:rerun-if-changed=../dist");
    if !index.is_file() {
        panic!(
            "找不到前端产物 {}：请先运行 npm.cmd run build 生成 dist（在 workbench 根目录执行）",
            index.display()
        );
    }

    // 破甲插件随 exe 自带，资源目录必须在位；否则 include_dir! 的报错看不出是缺什么。
    let purge_entry = Path::new(&manifest).join("assets").join("purge").join("index.ts");
    println!("cargo:rerun-if-changed=assets/purge");
    if !purge_entry.is_file() {
        panic!(
            "找不到破甲插件资源 {}：请在 workbench 根目录运行 node scripts/sync-purge-assets.mjs \
             （它会从 ~/.config/opencode/plugins/purge 同步到 shell/assets/purge）",
            purge_entry.display()
        );
    }
}
