WorkBuddy 原生登录接入工作台：不用 Magpie，登录后直接出模型、积分与每日自动签到

## WorkBuddy 接入

- 第三方 API 面板里 WorkBuddy 现在是一张和 DeepSeek 官方 / OpenCode Go / Command Code 同款的卡片，
  不再是单独一大块。
- 登录由工作台自己完成：点卡片 → 系统浏览器打开腾讯登录页 → 登完自动拿令牌，
  不经过 Magpie，令牌只存在本机。
- 卡片上直接显示 `积分 1600 · 连续 16 天 · 今日已签`，右侧有「刷新 / 签到 / 退出」。
- 已配置列表里的 WorkBuddy 条目同样显示积分、连续天数和今日签到状态。
- **自动签到**：打开面板、工作台启动时各检查一次；今天没签到就顺手签掉，
  每天最多一次、失败 10 分钟内不重复尝试。
- 模型走本机转发（`/local/workbuddy/v1`），端口每次启动自动校正，
  不会出现「第二天打开发消息连接失败」。

## 积分与额度

- 从 WorkBuddy 客户端里还原的签到接口：`checkin-activity-status` / `daily-checkin`，
  积分取签到活动的 `total_credits`。
- 其它服务商额度显示同步优化：OpenCode Go / Command Code 改成「剩余百分比」，
  细节（金额、重置时间、滚动窗口）放在悬停提示里。
- 面板顶部新增「刷新额度」，一次刷新所有服务商的额度与本机用量。

## 其它

- 模型上下文按上游真实值写入（1M 就是 1M），可手动改；输出上限未知时不写死 8k。
- 面板拆成 ProviderList / ProviderModelList / ProviderQuotaBox / ProviderSyncBlock / WorkBuddyCard，
  Rust 侧 WorkBuddy 拆成 store/http/util/models，单文件都回到 300 行内。
- Node 592 项、Rust 283 项、网关单测、`tsc --noEmit` 与打包全部通过。
