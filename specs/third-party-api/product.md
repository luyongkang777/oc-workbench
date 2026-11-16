# 第三方 API 接入（provider 面板）

## 目标

在 OpenCode 工作台里直接配置模型服务商，不用手改 `~/.config/opencode/opencode.json`：

1. 内置三个预设，点一下填好 id / 名称 / 地址，只需要补密钥：
   * **DeepSeek 官方** `https://api.deepseek.com/v1`
   * **OpenCode Go** `https://opencode.ai/zen/v1`
   * **Command Code** `https://api.commandcode.ai/provider/v1`
2. 支持**自定义**任意 OpenAI 兼容端点（id、显示名、baseURL、apiKey 全可填）。
3. 保存后能**自动获取模型列表**（`GET {baseURL}/models`），勾选要启用的模型写进 provider。

## 只加载勾选的模型（2026-11-16 追加）

opencode 对**内置 ID**（`opencode` / `opencode-go` / `commandcode` / `deepseek` …）会把它自己那份
模型目录合并进来：写 12 个模型会显示 89 个，`whitelist` / `blacklist` 都不生效（都实测过）。
所以三个预设改用**不冲突的自定义 ID**：`deepseek-official` / `opencode-zen` / `command-code`。
实测结果：配置写 12 个就显示 12 个、写 100 个就显示 100 个，没勾选的不会出现。

## 额度显示（2026-11-16 追加）

| 服务商 | 能否拿到剩余额度 | 界面显示 |
|---|---|---|
| DeepSeek 官方 | 能（`GET /user/balance`） | 余额 ¥16.50 |
| OpenCode Go | 不能（`/zen/v1/usage`、`/me`、`/billing` 全 404，响应头也没有配额字段） | 「额度：到控制台查看」+ 打开控制台按钮 |
| Command Code | 不能（`/provider/v1/usage|credits|limits|billing` 全 404） | 同上（Studio） |

不编造数字：拿不到就明确写「到控制台查看」。同时从
`/api/experimental/session/stats` 按 provider 汇总**本机累计消耗**（tokens / 费用），
让用户至少知道这个 provider 用掉多少。

## 不做什么

- 不做支付/充值（DeepSeek 只在官网扫码充值）。
- 不做「重启 OpenCode 服务」（会打断正在跑的会话，只提示用户）。
- 不写 magpie 或其它反代的配置，只碰 `opencode.json` 的 `provider` 段。
- 不支持非 OpenAI 兼容协议（npm 固定 `@ai-sdk/openai-compatible`）。

## 验收标准

0. 三个预设按钮各带官方图标（DeepSeek 站点 favicon / opencode.ai favicon.svg / commandcode 官方 192px 图标），
   图标加载不出来就算不通过；列表里的条目按 baseURL 的 host 复用同一套图标。
1. 顶栏出现插头按钮，点开右侧抽屉，列出 `opencode.json` 里已有的 provider（**apiKey 只显示掩码**）。
2. 点「DeepSeek 官方」预设 → 地址自动填 `https://api.deepseek.com/v1`，名称填「DeepSeek 官方」。
3. 填 key 点「获取模型」→ 列表出现官方接口当时返回的模型（2026-11-16 实测是 `deepseek-flash` / `deepseek-v4-pro`；真实接口返回什么就显示什么，不写死名单）。
4. 勾选后保存 → `~/.config/opencode/opencode.json` 里 `provider.<id>` 被写入，**其它 provider / mcp / instructions 一个字不动**；写盘前生成一份 `opencode.json.bak-<时间戳>`。
5. 删除某个 provider → 只删那一条，其余保留；`provider` 段删空后保留 `{}` 而不是整个键消失。
6. 配置文件不是合法 JSON 时**拒绝写**并说明原因（不能拿默认值覆盖用户手改内容）。
7. `npm test` 覆盖纯函数（baseURL 规范化、密钥掩码、草稿校验、模型合并）。

## 约束

- 单文件 ≤300 行、单函数 ≤50 行。
- dev（`npm run dev`）与外壳两套 `/local/*` 实现字段逐字一致。
- 密钥永不回显明文。
