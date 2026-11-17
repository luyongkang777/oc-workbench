OpenCode Go 预设改成套餐专用接口，有套餐的人不会再被当成按量付费报「余额不足」。

## 修复

- 接口地址接错：模型面板里「OpenCode Go」预设原来填的是 `https://opencode.ai/zen/v1`（按量付费 credits 网关），有 Go 套餐的请求打到那里会被判成 pay-as-you-go，直接回 402 `Insufficient balance`，提示里还写着「OpenCode Go covers only requests to the OpenCode Go provider」，看着像套餐过期，其实是地址不对。
- 现在预设填的是套餐端点 `https://opencode.ai/inference/go/openai/v1`。用同一把 API Key 请求，上游会在响应里标 `billing_source: "go"`，走的就是套餐额度。

## 注意

- 已经保存过的 OpenCode Go 配置不会自动改：那条 provider 的地址还是旧的 `zen/v1`。在模型面板里编辑它、把地址换成上面的套餐端点再保存即可；或者重新选一次预设。
- 免费模型（`opencode/*-free`）仍是另一条通道，按出口 IP 计额度，用光了会报 `FreeUsageLimitError`，和套餐无关。

## 其它

- `tsc --noEmit` 与 Node 592 项测试全部通过。
