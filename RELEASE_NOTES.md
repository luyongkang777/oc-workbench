第三方 API 接入：DeepSeek 官方 / OpenCode Go / Command Code 一键接入，模型自动获取，换电脑登录账号即同步配置

## 第三方 API 接入面板

- 顶栏新增插头按钮：在界面里直接配模型服务商，不用再手改 `opencode.json`。
- 三个内置预设（各带官方图标）：**DeepSeek 官方**、**OpenCode Go**、**Command Code**；
  也可以自定义任意 OpenAI 兼容端点。
- 点一次「获取模型」自动拉取上游模型列表，全选/取消全选批量处理。
- 每个模型可以单独设置**上下文长度**与**输出上限**：默认用上游给的（`limit.context` /
  `context_length` / `context_window`），1M 的模型就显示 1M；也能自己改，保存即生效。
- 模型名统一成「模型名 (商家名)」，例如 `DeepSeek V4.1 Flash (OpenCode Go)`，
  不再是一串 `deepseek/deepseek-v4.1-flash`。
- 只加载勾选的模型：换用不冲突的自定义 provider ID，配置里写几个下拉里就是几个。
- 写配置前自动备份、原子写入；只改 `provider` 这一段，`mcp` / `instructions` / 其它 provider
  一个字不动；坏 JSON 会拒绝写而不是覆盖。

## 额度显示

- **DeepSeek 官方**：显示真实余额（`user/balance`）。
- **OpenCode Go**：控制台接口（`/console/api/go/status`）读出 5 小时 / 本周 / 本月三个窗口的
  已用与上限，例如 `5 小时 $0/12 · 本周 $0.01/30 · 本月 $10.63/60`。
- **Command Code**：用它的 API key 读 `/alpha/billing/credits` 与 `/alpha/usage/summary`，
  显示剩余额度、已用金额和 5 小时/周两个滚动窗口。
- 界面另外按 provider 汇总**本机累计消耗**（tokens / 费用），拿不到额度时也不会瞎编数字。

## 账号级同步

- 登录账号后，第三方 API 配置（含 key）与默认模型会存到账号下；
  换一台电脑登录同一账号，启动后自动拉取并写进本地配置，不用重新填。
- provider 面板顶部显示同步状态，可手动「上传到账号 / 从账号恢复」，也能直接选默认模型。
- 云端配置只限本人读写（Bearer 校验），单份上限 512KB。

## 聊天输入框

- 输入框固定在聊天面板最底部；会话统计条移到输入框上方，新会话也不会浮在中间。

## 其它

- 前端 561 项单测、Rust 258 项、网关单测、`tsc --noEmit` 与打包全部通过。
