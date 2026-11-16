# 对话断线重试 · 第二层验收（模型调用 429 自动重投）

> 功能本身在 1.8.2（c38245b）已交付。这份记录是「第二层」端到端验收的结论，
> 以及验收过程中发现并修掉的一个真 bug。

## 两层重试各管什么

| 层 | 代码 | 管什么 |
|---|---|---|
| 第一层（投递） | `Chat.tsx` 的 `sendWithRetry` + `api/chatRetry.ts` | POST `/prompt` 本身没成功（网络/5xx/429） |
| 第二层（模型调用） | `hooks/useChatAutoRetry.ts` + `components/chatAutoRetry.ts` | 服务端收下了，但模型调用失败（写一条 `idle/outcome=failed`） |

## 验收方法（可复现）

```powershell
node scripts/verify-retry-429.mjs            # 失败 1 次→重投 1 次→成功
node scripts/verify-retry-429.mjs --fail=2   # 连续失败 2 次→重投 2 次→成功
node scripts/verify-retry-429.mjs --fail=8   # 一直失败→重试 5 次后放弃（脚本按「应成功」断言，这档会报未通过，属预期）
```

脚本自带全部环境，不碰用户的 `opencode.json` 和在跑的服务：
1. `scripts/retry429Services.mjs`：假 OpenAI 端点（主对话第一次返回 429，带
   `x-should-retry:false` 让 opencode 立刻放弃而不是自己重试十来次）+ 补 Basic 认证的转发代理；
2. 独立 opencode 实例：`XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` 全指向
   `.tmp/retry-429/`，配置里只有一个假 provider；
3. 第二个 vite dev（5274）用 `OC_WORKBENCH_TARGET` 指向代理；
4. CDP 起无头 Edge 驱动真实页面：发消息 → 断言「提示出现 → 同 id 重投 → 收到回复」。

产物：`.tmp/retry-429/report.json`、`retry-429.png`、`opencode.log`、`dev.log`。

## 实测结果（2026-11-16）

| 场景 | main 模型调用序列 | /prompt 次数 | 界面 |
|---|---|---|---|
| fail=1 | 429 → 200 | 2（同 id） | 提示 1/5 后收到回复 |
| fail=2 | 429 → 429 → 200 | 3（同 id） | 提示 1/5、2/5 后收到回复 |
| fail=8 | 429 × 6 | 6（同 id） | 提示 1/5…5/5，随后「已重试 5 次仍然失败」 |

## 验收发现并修掉的真 bug

**现象**：工作台重投了（`/prompt` 确实又发了一次），但模型完全没被调用，界面停在
「重投已发出，等待模型响应」，这一轮再也不会好。

**根因**：opencode 2.3 的 `POST /session/{id}/prompt` 对**已存在的 message id** 只返回
已有消息、不再调度模型。实测对比：

| 重投方式 | 模型调用序列 | 结论 |
|---|---|---|
| 同 id + `resume:true`（原实现） | 429（没变） | 假重试：服务端还把这一轮标成 succeeded |
| 同 id + `resume:false` / 缺省 | 429（没变） | 不重跑 |
| 同 id + 先 revert 再发 | 429 → 200 | ✅ 历史干净 |
| 新 id + `resume:true` | 429 → 200 | 能跑，但用户消息出现两条 |
| `/synthetic` 新 id | 429 → 200 | 能跑，但历史里多一条 synthetic |

**修法**：重投前先 `revert/stage {messageID, files:false}` + `revert/commit`，删掉失败那一轮
（只删消息、不动文件），再用同一个 message id 重发。`Chat.tsx` 里 `suspended` 增加
`Boolean(revert)`，用户手动暂存了回撤时自动重投让位。

**连带修的两个计数问题**（回撤会让服务端失败次数每次归零）：
- 重试次数改成按 message id 本地记账（`orderedByMessage`），键用「已排过几次」，
  否则第二轮就和第一轮的键撞上、直接不再重投；
- 提示文案按真实失败次数显示：`failures = max(服务端计数, ordered + 1)`。

**兜底**：回撤成功但重投没发出去时，把原文还给输入框（`onRestoreDraft`），
不让用户以为消息丢了；用户已经打了新内容则不覆盖。

## 已知限制

- 回撤会删掉这一轮的用户消息再重发，服务端消息 id 不变但 `time.created` 会变新。
- TUI / 别的客户端同时看这个会话时，会看到这一轮短暂消失再出现。
- 附件重投要完整还原（base64 大附件会重传一次）；还原不出来时不自动重投，直接提示用户重发。

## 2026-11-16 第二轮：独立审查后的修复

独立审查报了 2 条 🔴，都是「重投排上之后不再复核」：

1. 定时器触发后直接用旧结论去删消息。等待窗口里这一轮可能被服务端自己救回、
   被别的客户端/TUI 接手、或者用户点了停止 —— 那时再 commit 就是删掉有效回复。
2. `stage → commit → sendPrompt` 三个 HTTP 往返全程不检查会话是否切走、用户是否停止。
   最长约 45 秒，切走后会静默把旧会话那一轮删掉并重投（还烧 token）。

修法：

- 定时器触发时先校验「会话没切 + 没被 suspended」，再重新跑一次
  `pendingRetry(cb.current.messages)`；消息变了就什么都不做。
- async 里 stage 前、stage 后 commit 前各校验一次；**commit 之后不再校验**——
  那时服务端已经删了，不发就等于丢消息。
- `suspended` 增加 `runningApi.running`（服务端还在跑时不动回撤）。
- `clearRevert` 前比对 `staged.messageID === retry.userMessageID`，不碰用户的回撤。
- 失败时把本地 ordered 计数退回去（不再多算）；已 commit 但没发出去时调
  `onResync` 让界面和服务端对齐，并把原文回填输入框。
- 新增 `dropFromMessage`：`mergeMessages` 只增不删，服务端删掉的那一轮会留在界面上，
  重投前后都要按边界先截断再合并。
- 计数口径抽成 `failureCount(serverAttempts, ordered)`（retryPolicy.ts），带单测。
- 两处矛盾注释改口径：同 id 重投不会重新调度模型，必须先回撤。

## 验收矩阵（2026-11-16 全绿）

| 场景 | 命令 | 关键断言 |
|---|---|---|
| 失败 1 次 | `node scripts/verify-retry-429.mjs` | main=429,200；prompt=2 同 id；stage/commit 各 1 次且 files:false；界面 1 条用户消息 |
| 连续失败 2 次 | `... --fail=2` | main=429,429,200；prompt=3；stage/commit 各 2 次；提示 1/5→2/5 |
| 到上限放弃 | `... --fail=6 --expect=giveup` | prompt=6；stage/commit 各 5 次；「已重试 5 次仍然失败」；不无限重试 |
| 切会话安全 | `... --expect=cancel` | 重试排期后切走：prompt=1、stage=0、commit=0（不偷偷删消息） |
| 生成期竞态 | `... --delay=3000` | 成功响应拖 3 秒：仍只 stage/commit 各 1 次，没有二次删除 |

另外：`tsc --noEmit` 通过，`npm test` 520 通过 / 0 失败。

## 2026-11-16 第三轮：复审后的收口

第二轮复审又报 1 条 🔴：**已回撤但投递失败时，原文会真的丢**。
`onRestoreDraft` 在输入框已有内容时直接丢弃、且不带会话 id，用户等重试期间
随手打的字会让原文无家可归，提示却还写「已放回输入框」。

修法：

- `onRestoreDraft(sessionID, text)` 改为**追加**而不是覆盖（`prev + "\n\n" + text`）；
  已经切走时写回那个会话的草稿（`saveDraft`），不污染当前会话；
  返回 boolean，hook 按真实结果写文案（没放回就明说「请手动重发」）。
- 这条提示改成 `tone: 'fail'`：这一轮在服务端已经没了，不能被
  「这一轮已恢复」的清理逻辑一闪而过。
- 第二道 `clearRevert` 也加守卫：读回 `session.revert` 比对边界，
  只清自己 stage 的那次，不碰用户手动暂存的回撤。
- timer 内 `pendingRetry` 返回 null 时补 `forget(key)`（消息短暂对不上后还能再来）。

同时：
- 拆分以守住 300 行：`hooks/retryOnce.ts`（只做「回撤+重发」一次动作）、
  `scripts/retry429Checks.mjs`（断言构造）、`scripts/retry429Ui.mjs`（浏览器驱动）。
- 代理支持故障注入：`promptFail`（重投的 /prompt 直接 500）、`stageDelay`
  （stage 在飞时切走），把两条以前只能靠读码判断的路径变成自动化用例。
- 新增场景 `--expect=restore`（原文回填）与 `--expect=midstage`（stage 后切走）。

## 验收矩阵（最终，2026-11-16 全绿）

| 场景 | 命令 | 关键断言 |
|---|---|---|
| 失败 1 次 | `npm run verify:retry` | main=429,200；prompt=2 同 id；stage/commit 各 1 次且 files:false；界面 1 条用户消息 |
| 连续失败 2 次 | `... --fail=2` | main=429,429,200；prompt=3；stage/commit 各 2 次；提示 1/5→2/5 |
| 到上限放弃 | `... --fail=6 --expect=giveup` | prompt=6；stage/commit 各 5 次；「已重试 5 次仍然失败」 |
| 重试前切走 | `... --expect=cancel` | prompt=1、stage=0、commit=0 |
| stage 在飞时切走 | `... --expect=midstage --stage-delay=2000` | stage=1、commit=0、prompt=1 |
| 回撤后投递失败 | `... --expect=restore --fail-prompt=1` | 提示如实；用户已打的字不覆盖；原文追加回输入框；界面不残留 |
| 生成期竞态 | `... --delay=3000` | 成功响应拖 3 秒：仍只 stage/commit 各 1 次 |

`tsc --noEmit` 通过，`npm test` 520 通过 / 0 失败。
