//! 构建前检查前端产物：`include_dir!("$CARGO_MANIFEST_DIR/../dist")` 在 dist 缺失时
//! 只会报一条很难懂的错误（找不到目录 / 空目录），这里提前给出人话提示。
//!
//! 注意 dist/ 在 .gitignore 里，新克隆仓库必须先跑 `npm.cmd run build`。

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
}
