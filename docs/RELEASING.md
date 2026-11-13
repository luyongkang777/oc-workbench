# 发版手册（oc-workbench）

> 一条命令改版本 → 改说明 → 打 tag → CI 自动构建并发布 → 客户端下次检查就能看到更新。
> 遇到问题先看第 7 节「常见故障」。

---

## 1. 版本号规则

| 位置 | 谁在用 | 说明 |
|---|---|---|
| `package.json` → `version` | 前端顶栏（`__APP_VERSION__`）、`latest.json`、发布包名 | 用户能看到的版本 |
| `shell/Cargo.toml` → `version` | 编译进二进制的 `CURRENT_VERSION` | 决定「要不要更新」 |
| `shell/Cargo.lock` → `oc-workbench-shell` 那段 | cargo 自己写 | 不影响行为，但三处不一致会让 `cargo` 每次重写 |

三处**必须一致**。`npm run bump` 会同时改这三处，并在不一致时直接拒绝执行。

递增规则：修 bug → `patch`；新增功能 → `minor`；不兼容改动（界面/协议）→ `major`。

---

## 2. 标准流程

```powershell
# 1. 改版本（三处一起改，并生成 RELEASE_NOTES.md 草稿）
npm.cmd run bump -- patch          # 也可以 minor / major / 1.2.3
npm.cmd run bump -- patch --dry-run  # 只看会改成什么，不写文件

# 2. 改 RELEASE_NOTES.md：第一条是给用户看的一句话，会出现在更新面板里
#    （草稿按上个 tag 之后的提交生成，会自动过滤 chore/docs/ci/test）

# 3. 提交并打 tag —— tag 是唯一触发条件
git add -A
git commit -m "release: 1.1.3"
git tag v1.1.3
git push origin HEAD:main --tags
```

> 用 `HEAD:main` 而不是 `main`：这个仓库平时在 `feature/workbench-v0` 上开发，
> 本地的 `main` 是旧的镜像；`HEAD:main` 表示「把当前分支推成远端 main」，
> 不会推错。

推送 tag 后去 [Actions](https://github.com/luyongkang777/oc-workbench/actions) 看，
一次大约 3～4 分钟。成功后 `releases/latest/download/latest.json` 立即指向新版本。

> `npm run bump -- --tag` 会顺手建本地 tag，commit 之后再 `git push origin main --tags` 即可。

---

## 3. 流水线做了什么

`.github/workflows/release.yml`，`windows-latest`，只在推 `v*` tag 时触发：

1. **校验版本**：tag 去掉 `v` 必须等于 `package.json` 的 `version`，否则直接失败
2. `npm ci` → 前端测试（317 项）
3. `npm run build`：先出 `dist` —— 外壳的 `build.rs` 是**编译期**把 dist 嵌进二进制，没有 dist 连 `cargo test` 都编译不过
4. `cargo test --release`（96 项；用 release 是为了和后面共用一次编译）
5. `npm run build:exe`：前端 + 外壳 + 核对「dist 里每个 asset 都能在 exe 字节里找到」
6. `npm run release`：生成 `latest.json`（URL 指向本 tag 的资产）
7. `gh release create`：上传三个资产，最后回读一遍

---

## 4. 发布产物

一次 Release 里必须有三样，名字不能改：

| 资产 | 为什么必须叫这个 |
|---|---|
| `oc-workbench-<版本>-win64.exe` | `latest.json` 的 `url` 直接指向它 |
| `latest.json` | 客户端的检查入口（`releases/latest/download/latest.json`） |
| `oc-workbench-<版本>-win64.zip` | 给人手动下载的整包（含 README.txt / SHA256SUMS.txt） |

`latest.json` 长这样，客户端校验 `sha256` 与 `size`，任一不符就丢弃整个包：

```json
{
  "version": "1.1.2",
  "url": "https://github.com/luyongkang777/oc-workbench/releases/download/v1.1.2/oc-workbench-1.1.2-win64.exe",
  "sha256": "844b000e…",
  "size": 3497984,
  "notes": "- 发版自动化…",
  "publishedAt": "2026-11-13T04:28:58.000Z"
}
```

---

## 5. 手工发布（CI 不可用时）

```powershell
npm.cmd run build:exe
$env:OC_WORKBENCH_GITHUB = "luyongkang777/oc-workbench"
npm.cmd run release
# 产出：release/oc-workbench-<ver>-win64/{oc-workbench.exe, README.txt, SHA256SUMS.txt}
#       release/latest.json、release/oc-workbench-<ver>-win64.zip
```

然后建 tag 的 Release，把 exe **改名**成 `oc-workbench-<ver>-win64.exe` 再上传，
另外两个原样上传（`gh release create v1.1.3 改好名的.exe latest.json xxx.zip --notes-file RELEASE_NOTES.md`）。

换托管（不用 GitHub）也行：把 exe 和 `latest.json` 放任意静态目录，
`latest.json` 的 `url` 改成绝对地址，客户端更新源指向那个 `latest.json`。

---

## 6. 客户端侧行为

- **入口**：顶栏 `v1.1.2` 胶囊，有新版本时变品牌色 + 一颗点；点开是「版本与更新」
- **更新源优先级**：环境变量 `OC_WORKBENCH_UPDATE_URL` → `settings.json` 的 `updateUrl`
  （**空串 = 主动关闭**，不再检查）→ 内置默认 `releases/latest/download/latest.json`
- **跳过某个版本**：面板里点「跳过这个版本」，写进 `settings.json` 的 `skipVersion`；
  顶栏不再提示，但点开面板仍显示「已跳过」，可以随时「取消跳过」或直接更新。
  只记版本号，发下一个版本时自动失效，不用记得回来关
- **更新流程**：下载到 `%LOCALAPPDATA%\oc-workbench\update\` → 校验体积/SHA256/MZ →
  写 `apply-<pid>.cmd` → 本进程退出 → 脚本反复重试覆盖 exe → 启动新版本
- **为什么用脚本**：Windows 不允许运行中的 exe 覆盖自己。脚本**不等 PID 退出**，
  而是重试覆盖（能写进去就说明文件已释放）——`WaitForExit`/`tasklist` 两条路实测都不可靠
- **回退**：覆盖前会把旧文件留成 `oc-workbench.exe.bak`，改名回去即可
- **日志**：`%LOCALAPPDATA%\oc-workbench\gui-error.log`（启动/连接/崩溃），
  `…\update\update.log`（替换过程）

---

## 7. 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 流水线第一步失败「tag 与 package.json 不一致」 | 只改了一处版本 | `npm run bump -- <版本>` 会三处一起改 |
| 本地 `cargo build` 报「找不到前端产物 dist」 | build.rs 需要 dist | 先 `npm run build` |
| 客户端永远「已是最新」 | tag 与二进制版本不一致，或 Release 不是 latest | 核对 `latest.json` 的 version 和客户端版本；Release 不能是 draft |
| 下载 404 | 资产名不是 `oc-workbench-<版本>-win64.exe` | 按第 4 节改名后再上传 |
| 下载 401/403 | 仓库/Release 是私有的 | 改成公开，或用带 token 的私服 |
| 更新提示「程序所在目录不可写」 | exe 在 Program Files / 只读盘 | 挪到用户目录（如 `D:\Tools\`） |
| 点了更新，窗口关了没重启 | 覆盖失败（被杀软拦截/权限） | 看 `update\update.log` 的 `copy failed`；用 `.bak` 恢复 |
| 首次运行被 SmartScreen 拦 | 未做代码签名 | 「更多信息 → 仍要运行」 |
| 面板显示「连不上更新源」 | 网络/代理，或仓库名写错 | 面板里点「更改」换更新源 |

---

## 8. 发版前自测清单

```powershell
npx tsc --noEmit
npm test
cd shell; cargo test --release
cd ..; npm run build:exe        # 会自己核对嵌入
```

- [ ] 启动 exe，顶栏版本号是新的
- [ ] 打开更新面板，显示「已是最新」
- [ ] 换台机器（或清空 `%LOCALAPPDATA%\oc-workbench`）冷启动，首页能选目录

---

## 9. 文件速查

| 文件 | 作用 |
|---|---|
| `.github/workflows/release.yml` | tag → 测试 → 构建 → 发布 |
| `scripts/bump-version.mjs` | 三处版本一起改 + 生成 notes 草稿 |
| `scripts/build-exe.mjs` | 前端 + 外壳编译，并核对「dist 真的嵌进去了」 |
| `scripts/package-release.mjs` | 出发布目录 / zip / `latest.json` |
| `shell/src/update.rs` | 清单解析、版本比较、下载校验、替换脚本 |
| `src/components/UpdateEntry.tsx` | 顶栏版本号与更新面板 |
| `RELEASE_NOTES.md` | Release 正文 + 更新面板里的说明 |
| `docs/RELEASING.md` | 本文件 |
