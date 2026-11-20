# 第三方 API 接入 · 进度

当前任务：T-FREE 接入 OpenCode 自带免费模型（已过审，待发布）

## 已完成

- T1 纯函数层 `src/api/providerFormat.ts`：地址规范化 / 密钥掩码 / 草稿校验 / 模型合并与解析。
  单测 `scripts/providerFormat.test.mjs` 8 条全绿。
- T2 外壳接口 `shell/src/provider.rs` + `provider_store.rs`：
  `status` / `models` / `test` / `save` / `remove` 五个路由；备份 + 原子写 + 顶层键自检。
  单测 13 条全绿（其中 store 8 条）。路由在 `server.rs` 里排在 fsapi 之前。
- T3 dev 同款 `scripts/dev-local-provider.mjs`：与 Rust 同路径同语义；单测 `providerStore.test.mjs` 6 条全绿。
- T4 前端 `src/api/provider.ts` + `components/providerForm.ts` + `ProviderPanel.tsx` + `styles/provider.css`。
  表单纯函数单测 `providerForm.test.mjs` 9 条全绿。
- T5 接线：TopBar 插头按钮、App/AppContext 的 `providerOpen`、AppShell 挂 `<ProviderPanel>`。

## 实测结论（2026-11-16）

- 真实 DeepSeek 官方 `GET https://api.deepseek.com/v1/models` 返回当前两个模型：
  `deepseek-flash`、`deepseek-v4-pro`（不是 `deepseek-chat`，界面按接口实际返回显示）。
- 假 key 的错误原样透出：`上游返回 HTTP 401：Authentication Fails, Your api key: ****beef is invalid`。
- 真机验收 `scripts/verify-provider.mjs`：dev 5274 + Edge CDP 9234，**10/10 PASS**，
  覆盖「列表不含明文 key / 预设填充 / 401 原文 / 拉模型默认全选 / 保存后提示」。
- 写盘核对：`model` / `mcp` / `instructions` 一字未变，另一个 provider 原样保留，
  生成一份 `opencode.json.bak-<时间戳>`，新模型自动补 `limit {context:128000, output:8192}`。

## 2026-11-16 追加：三个预设 + 官方图标

- 预设（点击即填 id/名称/地址）：
  * DeepSeek 官方 `https://api.deepseek.com/v1`
  * OpenCode Go `https://opencode.ai/zen/v1`（实测 `GET /models` 免 key 就 200）
  * Command Code `https://api.commandcode.ai/provider/v1`（`/v1` 是 404，必须带 `/provider`）
- 图标取自官方站点，存 `src/assets/providers/`：DeepSeek favicon.ico（转 64px PNG）、
  opencode.ai favicon.svg、commandcode 192px 图标。列表条目按 baseURL 的 host 复用同一套图标，
  自定义域名显示首字母占位。
- 图标映射单独在 `src/components/providerPresets.ts`（`providerForm.ts` 要能被 Node 单测直接跑，
  不能 import 图片）。
- 真机验收升到 **13/13 PASS**（新增「三个预设都在 / 名称正确 / 图标全部加载」三条）；
  Node 全量 547 项、Rust 247 项、生产构建均通过。

## 2026-11-16 独立审查后的修复（1🔴 / 5🟡 / 6🟢）

| 级别 | 问题 | 修法 |
|---|---|---|
| 🔴 | 读失败被当成空配置 → 整份文件被覆盖 | 只有 NotFound 当空，其它读失败一律拒写（Rust + dev 各一条测试） |
| 🟡 | 并发保存互踩临时文件、丢更新 | 进程内 Mutex + 唯一临时文件名（Rust 8 线程并发测试） |
| 🟡 | 四键重建丢掉 env/blacklist/自定义 npm | 以旧条目为底，只覆盖 name/options/models |
| 🟡 | 掩码查找按全库扫（可借出别人的 key）+ 两套实现分叉 | 只按同一个 id 查，掩码必须与真 key 对得上 |
| 🟡 | 拉模型在途时切换对象会把 A 的模型写进 B | 响应落地前校验 id/baseURL/apiKey 未变；busy 期间禁用「编辑」 |
| 🟡 | 保存重排整份 JSON 键序 | `serde_json` 开 `preserve_order`，并加键序测试 |
| 🟢 | 验收声称查磁盘但没查 | `verify-provider.mjs` 真读 `opencode.json` 断言 |
| 🟢 | 保存后明文 key 留在输入框 | 保存成功后换回磁盘掩码 |
| 🟢 | 空串被当掩码 → key 清不掉 | `is_masked` 要求非空 |
| 🟢 | 备份命名/轮转不一致、备份失败被吞 | 轮转按 mtime；备份失败直接放弃保存 |
| 🟢 | baseURL 大小写、id 长度、models 非字符串三处口径分叉 | 三端对齐 |
| 🟢 | 上游错误体回显（截 200 字） | 保留（DeepSeek 只回通用文案），已在文档标注 |

回归：Rust 252 项、Node 549 项、`tsc --noEmit`、`vite build` 全绿。

## 实际接入记录（2026-11-16）

- 用面板同一套 dev 写盘逻辑写进真实 `~/.config/opencode/opencode.json`：
  * `opencode`（OpenCode Go，`https://opencode.ai/zen/v1`）12 个模型
  * `commandcode`（`https://api.commandcode.ai/provider/v1`）100 个模型
- 写入前后核对：顶层键一致、原有 `mimo`/`purge` 都在、`mcp`/`instructions`/`model` 未变、键序未变、备份已生成。
- **opencode 会热加载配置**：写完后 `GET /api/model` 立刻出现
  `opencode`（89 个，内置目录 ∪ 配置）与 `commandcode`（102 个），不需要重启服务。
- 修掉一个自己引入的 bug：dev 备份轮转把完整路径又 join 了一次 → 删除静默失败，
  备份堆到 42 份。已修并补「连写 13 次只剩 10 份」的回归测试。

## 2026-11-16 追加：只加载勾选模型 + 额度显示

- 实测：内置 ID（opencode/opencode-go/commandcode/deepseek）会被 opencode 合并自家模型目录，
  `whitelist`/`blacklist` 均不生效（写 12 → 显示 89；blacklist 后仍是 102）。
- 改用不冲突的自定义 ID 后精确生效：`deepseek-official` 2 个、`opencode-zen` 12 个、`command-code` 100 个，
  与配置里写的数量完全一致。
- 真实配置已迁移：`opencode` → `opencode-zen`、`commandcode` → `command-code`，
  并新增 `deepseek-official`（用余额胶囊那把 key，2 个模型）。
- 额度接口 `GET /local/provider/quota?id=`（外壳 + dev 双实现）：
  DeepSeek 走官方余额接口返回金额；另两家如实返回 `kind: "console"` + 控制台地址。
- 本机累计消耗从 `/api/experimental/session/stats` 按 providerID 汇总（tokens/费用），
  面板列表里显示成「本机已用 52.9M tokens」。
- 验收：真机 12/12 PASS（新增额度行与真实余额两条）。

## 2026-11-16 追加：逆出控制台额度 + 全选

**OpenCode**（可读到真实额度）
- 控制台 API 前缀是 `/console/api`（`/api` 全是 404 HTML）。
- `GET https://opencode.ai/console/api/go/status` 带 `Authorization: Bearer oc_sk_...` 返回
  `access.meters.{fiveHour,week,month}`，各含 `limitMicroCents/usedMicroCents/resetsAt`，1 美元 = 1e8。
- 界面显示 `5 小时 $0/12 · 本周 $0.01/30 · 本月 $10.63/60`（标题里带最近重置时间）。

**Command Code**（接上了，但需要它自己的 API key）

- 从 npm 包 `command-code` 的 `dist/cli.mjs` 挖到它 `/usage` 的真实调用：
  `/alpha/whoami?limits=1` → `org.id`，再 `/alpha/billing/credits`、`/alpha/billing/subscriptions`、
  `/alpha/usage/summary`，认证 `Authorization: Bearer <API key>`，**不需要浏览器登录**。
- 面板会显示「剩余 $X · 已用 $Y · 5 小时 $a/b · 周 $c/d」（接口给什么显示什么）。
- 用户给的 `user_...` 不是 API key（`Invalid 'Authorization' header or token`），
  所以现在仍降级为控制台入口；换成 Studio 生成的 key 后自动出数字。
- 早前逆到的 `/internal/*` 只认登录 cookie，是死路。

**旧记录**
- 前端 `assets/constants-*.js` 的 `INTERNAL` 常量里有
  `/internal/billing/credits`、`/internal/billing/subscriptions`、`/internal/usage/summary`、
  `/internal/usage/by-model`（base `https://api.commandcode.ai`）。
- 全部 `401 {"code":"UNAUTHORIZED","message":"You're logged out."}`：只认 Studio 登录 cookie，
  API key 不行。所以界面仍是「额度：到控制台查看」。

**全选 / 取消全选**
- 模型列表头部两个按钮，范围是「界面上能看到的模型」（远端 ∪ 已勾选），
  手填的模型不会被全选踢掉；单测覆盖。

## 2026-11-16 实测：Command Code 额度跑通

- 用真实 API key（`user_2oJH...`）验证：`/alpha/whoami` 返回个人账号（org=null）。
- **个人账号不传 orgId**：空 `orgId` → 400 Invalid UUID；传 user.id → 403。去掉参数就 200。
- `/alpha/billing/credits` → `credits.{monthlyCredits:19.35, purchased:0, free:0}`、
  `windowLimits.{fiveHour:{used:0.01,cap:14}, weekly:{used:19.04,cap:35}}`。
- `/alpha/billing/subscriptions` → `planId: individual-goat`、status active、周期 11-03 ~ 12-03。
- `/alpha/usage/summary` → `totalCost: 51.10`。
- 面板显示：`剩余 $19.34 · 已用 $51.10 · 5 小时 $0.03/14 · 本周 $19.05/35`。
- 该 key 推理也通（`deepseek/deepseek-v4-flash` 返回 200；claude 系要走 `/provider/v1/messages`）。
- 期间发现配置被 UI 操作改过（purge/mimo 被删、模型数被删到 1~2 个），已从 12:57 的完整备份恢复，
  只保留新 key；恢复前另存了 `opencode.json.bak-manual-*`。

## 2026-11-16 追加：上下文 / 显示名

- `/models` 现在返回 `{id, name, context, output}`：context 依次取
  `limit.context` / `context_length` / `context_window`；output 取 `limit.output` / `max_output_tokens`。
- 保存时按勾选项写 `models.<id>.limit = {context, output?}`；**output 未知就不写**
  （写死 8192 会截断 64k 输出的模型）。
- 面板每个模型一行：勾选 + 名称 + 「上下文 / 输出」可编辑输入；名称占一行、输入换第二行。
- 模型名统一成 `模型名 (商家名)`，例：`Claude Sonnet 5.5 (Command Code)`、
  `DeepSeek V4.1 Flash (OpenCode Go)`。
- 已按上游重写现有配置：
  * deepseek-official 2 个（1,048,576）
  * opencode-zen 12 个（10 个 ≥1M；free 版 200k）
  * command-code 100 个（72 个 ≥1M）
- 单测：新增 prettyModelName / modelDisplayName / 上下文覆盖 / output 未知不写等用例；
  Node 561 项、Rust 258 项、`tsc`、打包全绿。

## 2026-11-16 追加：账号级同步

- 网关：`GET/POST /portal/api/profile`（Bearer，自有数据，512KB 上限，存 `gateway.json.profiles`），
  已编译部署到 81.70.181.82（systemd `ocw-gateway`，旧二进制留了 `ocw-gateway.bak-*`）。
- 外壳：`/local/provider/export`（带真 key）+ `/local/provider/apply`（一次写多个 provider + 默认模型）。
- 前端：`api/providerSync.ts` + `hooks/useProviderSync.ts`；面板顶部显示同步状态、上传/恢复按钮、
  以及「默认模型」下拉（含当前值兜底项）。
- 行为：登录后启动 1.2s 拉一次；本地保存/删除 provider 后防抖 800ms 上传；云端为空时用本机配置做种子。
- 实测（模拟新机器）：删掉 `deepseek-official`/`command-code`/`opencode-zen` → 重启 → 自动恢复 5 个 provider，
  模型数与 key 长度全部对上，`mcp`(30) / `instructions`(6) 未动。
- 修复：GET 响应统一包 `{profile}`（原先后两种形状导致每次启动都判成云端为空并覆盖）；
  apply 写默认模型前检查 provider 是否存在（换机场景）。

## 2026-11-20 T-FREE：接入 OpenCode 自带免费模型（已完成）

需求：面板加一条「OpenCode 免费模型」，只列免费模型，上下文可改。

### 做了什么

- 新预设 `opencode-free`：地址 `https://opencode.ai/inference/openai/v1`，key 字面量 `public`。
  它和 Go 套餐**同一个 host、只差一段路径**，因此 `presetForBaseURL` 里按路径区分
  （`/inference/openai/` → 免费池；其余 opencode.ai → Go 套餐）。
- 新增 `src/api/providerFree.ts`（判定与过滤纯函数）：
  * `isFreeModel` 只认上游 `free` 标记；
  * `isChatModel` 排掉 `image` / `realtime` / `decision`；
  * `filterModels(models, 'free')` 两个条件同时满足才留；
  * `fetchModelsMessage` 统一「拉到 N 个 / 只留 M 个 / 一个没剩」三种文案。
- 上游解析层补 `free` 与 `type` 两个字段（Rust `provider_models.rs` + dev `dev-local-provider-models.mjs`，
  两侧同口径）：**没有 `cost` 字段一律算不免费**，否则 DeepSeek / Command Code 会被整份误判。
- 表单带 `filter` 字段：`applyRemoteModels` 拉完先过滤；**过滤模式下不并旧清单**
  （旧清单可能躺着付费模型），并收敛 `picked`，防止看不见的付费模型被一起保存。
- 为守 300 行墙拆出两个文件：`components/providerPresetsData.ts`（预设数据与地址反查）、
  `hooks/providerController.ts`（面板契约类型）。

### 实测（2026-11-20）

- 免费池 `GET /models` 现在**能拉**（91 个）——技能 `opencode-zen-free-proxy` 里记的「404」已过时。
- 91 个里只有 14 个 `cost` 全 0；其中 `gpt-live-1`(realtime) / `grok-imagine-image-2.0`(image) /
  `jev-1.13-free`(decision) 不能做对话 → 最终 11 个 chat 免费模型。
- 真实配置已写入 `opencode-free` 11 个模型，`limit` 带真实上下文（200k~1M）。
  `GET /api/model` 立刻热加载出现，不需要重启。
- 手改上下文验证过：把 200000 改成 131072 → 配置文件与 opencode 模型列表都变成 131072，
  `output` 传 0 时不写该字段（避免截断大输出模型）。
- 顶层键 / `mcp` / `instructions` / 其它 provider 一字未动（写前自动备份）。

### 修掉的真 bug（dev 与外壳口径分叉）

- dev 的 `save` 只收**字符串数组**的 models，把 `{id,name,context,output}` 对象整份丢掉 →
  面板勾完点保存，**模型一个都没写进去**，而 Rust 侧 `parse_models` 两种都认，
  所以只有 exe 里正常、dev 验收看不出来。
- 修法：dev 抽出 `parseSaveModels`（两种写法都收、无有效 id 的对象丢弃），并补两条回归测试。

### 审查结论

REVIEW: 中 | 🔴0 🟡2 🟢3 | 结论: Approve

- 🟡 已修：`fetchModels` 的 `useCallback` 依赖漏了 `form.filter`，可能用旧过滤模式算提示。
- 🟡 已修：过滤后一个模型都没剩时只报数字，用户看不出该干什么 → 补「切自定义手动勾选」的指引。
- 🟢 验收脚本的套餐额度 SKIP 条件写错（只判空数组），把「key 401」误报成 FAIL，已改成按实际是否有百分比判定。

## 2026-11-20 复审（第二轮，中等档）

第一轮报 🔴0 🟡2 🟢3 之后又按「高一级」重审了一遍，**多抓出 2 个真 bug + 1 处数据安全风险**。

### 🔴 上游没带 `free` 标记时会把配置里的模型删光（已修）

- **现象**：`filter='free'` 时如果上游某次没带 `free` / `cost` 标记（接口变更、走了镜像），
  或直接返回空清单，`applyRemoteModels` 会把表单清成 **0 个模型**，
  用户接着点「保存」→ 配置里那条 provider 的 `models` 被整段删空，模型凭空消失。
- **根因**：过滤结果直接当写回结果，没有「一个都没剩」的保护分支。
- **修法**：过滤模式下「过滤后 0 个 + 表单原本有模型」直接 `return form` 原样返回。
  同时修了配套文案：这种情况不再说「只保留 0 个」，改成「已保留现有 N 个配置，没有改动」。
- **回归测试**：`providerFree.test.mjs` 的「上游没带 free 标记时不能把已配模型清空」，
  断言 `toSaveModels` 仍然写出 2 个（而不是 0 个）。

### 🟡 上游改名后界面永远显示旧名（已修）

- **现象**：上游把 `DeepSeek V4.1 Flash Free` 改成 `DeepSeek V4.1 Flash Free 2`，
  界面不动。实测确认。
- **根因**：名字保留条件是 `existing.name !== existing.id`——本意是「用户改过名就保留」，
  但**保存进配置的名字永远带「(商家名)」后缀**，条件永远成立，于是永久锁定旧名。
- **修法**：改成「名字以上游为准」（`item.name || existing?.name || prettyModelName(id)`）。
  配置里的名字本来就是保存时自动拼的，不是用户的创作，跟着上游变才对。
- **回归测试**：「上游改名后界面要跟着更新」。

### 🟢 验收脚本把环境问题报成 FAIL（已修）

- `opencode-zen` 的 key 已失效（401）、DeepSeek 余额为负，导致「额度行百分比」两条一直 FAIL。
- 原判定只看数组是否为空，改成「真的查到百分比才断言，否则 SKIP 并说明原因」。
- 现在真机验收是 **17/17 PASS + 2 SKIP**（无 FAIL）。

### 实测数据（2026-11-20 复审时重拉）

- 免费池 `/models` 这次返回 **103 个**（上次 91 个）→ **上游模型数会漂移，不能写死数字**。
- `type` 分布比预想多：`chat` 83 / `embedding` 12 / `decision` 4 / `image` 3 / `realtime` 1。
  `isChatModel` 是**白名单**（只认 `chat`），所以 `embedding` 这类新类型自动被排掉，
  上游以后再加类型也不会漏进来。
- 免费判定实测仍然准确：12 个免费，排掉 `decision` 后 **11 个 chat**。
- `cost.text.input` 有三种形状（`{price,cache}` / `{price}` / `{price,cache,overrides}`），
  部分模型带 `overrides`（超上下文翻倍计价）——都是非零价，不影响免费判定。

### 一个环境干扰（要记住）

复审期间发现配置里 `opencode-free` 从 11 个模型变成 1 个，追查后确认：

- 有一个**旧版 `oc-workbench-shell.exe`**（`%LOCALAPPDATA%\opencode\worktree\c0149a\...`，
  15:50 启动，占 17800 端口，标题「OpenCode 工作台」）一直在后台运行。
- 它用的是旧代码，在界面上操作时会按旧口径写配置（写进去的那条是
  `context=1000000 / output=38400`，既不是上游值也不是我的值）。
- **不是本次改动引入的 bug**。已从备份 `opencode.json.bak-1795176495-801` 恢复成 11 个模型，
  其它 provider 与顶层键都没动。
- **教训**：在本机验证 provider 面板写入前，先确认没有别的旧实例在跑
  （`Get-Process | ? ProcessName -match 'workbench'`），否则两边会互相覆盖配置。

## 2026-11-20 第三轮：失败提示改成中文（截图驱动）

用户发来截图：免费额度用光时，界面显示
「这一轮没有跑完 / Free usage limit reached. Connect a provider or subscribe to OpenCode Go...」
外加一句「可以直接重新发送；临时故障恢复后也会自动重试」。三个问题：

1. **英文看不懂** —— 服务端原文直接贴给用户。
2. **误导** —— 说「会自动重试」，但免费额度按 IP 计、要等十几小时，重试毫无意义。
3. **不知所措** —— 没有任何「现在该干什么」的指引。

### 修法

- **新增 `src/components/failureText.ts`**（纯函数）：把失败归类成
  `free-limit` / `rate-limit` / `quota` / `auth` / `model-missing` / `context` /
  `network` / `server` / `unknown` 九类，每类给「中文标题 + 中文做法」，
  原始英文留在 `raw` 里进悬停提示。
- **判定顺序从具体到笼统**：免费额度必须排在普通 429 限流**前面**——
  两者都可能是 429，但结论完全不同（等十几小时 vs 稍等几秒）。
- **`humanizeWait` 把毫秒说成人话**：59181000ms → 「约 16 小时」。
- **`retryPolicy.ts` 加规则**：免费额度用光归入不可重试（不再白试 5 轮）。
  正则用 `/free[-_. ]?limit/i` 这类精确写法，不用裸 `/free\b/i`
  （后者会把 "the free plan has no access" 判死）。
- **`turns.ts` 把 `retryAfterMs` 带进 turn.failure**：界面才能说「约 X 小时后恢复」。
- **`MessageList.tsx` / `editor.css`**：三段式展示（标题 / 做法 / 原文），
  原文默认单行截断、悬停展开。

### 界面实际显示（实测截图确认）

```
免费模型的额度用光了
这类免费额度按 IP 计算，约 16 小时后恢复。现在可以换一个模型继续。
原文：Free usage limit reached. Connect a provider or subscribe to …   ← 单行截断
```

### 验收

- 单测：`failureText.test.mjs` 7 条（含「含 free 但不是额度不能被误判」边界）、
  `failureFlow.test.mjs` 3 条（端到端：真实 idle 消息 → turn.failure → 中文文案）。
- 真机：`verify-failure-text.mjs` 5/5 PASS（样式生效、原文截断、旧类名已清理）。
- 截图：`.tmp/failure-ui.png` 肉眼确认两种失败态的显示。
- 回归：Node **746** 项、Rust **309** 项、`tsc --noEmit`、`vite build` 全绿。

### 审查

REVIEW: 中 | 🔴0 🟡1 🟢2 | 结论: Approve

- 🟡 已修：悬停态原来写 `overflow: visible`，展开时整块高度会变，鼠标一挪内容上下跳。
  改成只放宽 `white-space`、保留 `overflow: hidden`。
- 🟢 实测确认 `nowrap` + `text-overflow: ellipsis` 不会撑破容器
  （558px 滚动宽度正确截到 391px，外层 420px 容器无溢出）。
- 🟢 实测确认新正则不误伤 "free plan" / "freely" / "freeway" 这类无关词。

## 已知边界

- 保存后 opencode 是否**热加载**配置未验证（面板文案写成「没出现就重启服务」）——实测会热加载。
- 不做服务重启（会打断正在跑的会话）。
- 不支持非 OpenAI 兼容协议，`npm` 固定 `@ai-sdk/openai-compatible`。
- **免费池有额度上限且按 IP 计**：本机 2026-11-20 已用光（429，约 16 小时后重置）。
  接入链路本身已验证（回 429 而不是 403，说明免费池的三道校验都通过了），
  但「真跑一轮对话」要等额度恢复才能验。
