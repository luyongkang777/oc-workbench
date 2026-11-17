把 OpenCode Go 的地址约束写进代码注释与测试，避免以后被改回按量付费接口。

## 说明

- 上一版（1.12.1）已把「OpenCode Go」预设的接口地址改成套餐端点 `https://opencode.ai/inference/go/openai/v1`。这一版只是把「为什么不能用 `/zen/v1`」「为什么 id 不能改成 `opencode-go`」写进源码注释，并把预设测试的标题与断言补齐，防止以后回归。
- 功能行为与 1.12.1 完全一致，没有接口变化，不装也可以。

## 其它

- `tsc --noEmit` 与 Node 592 项测试全部通过。
