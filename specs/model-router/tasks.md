# tasks — 多模型路由

规则：一次只做一条，做完验证通过才开下一条。每条 ≤ 5 个文件、≤ 300 行。

## T1 ✅ 配置生成/解析纯函数 + 单测

- 范围：`src/components/routerConfig.ts`、`scripts/routerConfig.test.mjs`、`package.json`
- 完成信号：单测 22 项全过；`tsc --noEmit` 干净；`npm test` 715 项全过（2026-11-19）

## T2 ✅ 接线：读现有配置 + 写盘 + 删除

- 范围：`src/api/agents.ts`、`src/hooks/useRouterConfig.ts`
- 关键结论：外壳 `delete` 对目录是 `remove_dir_all`，永远不删 `.opencode/agents` 目录
- 完成信号：dev「写 → 读回 → 删除」闭环通过（2026-11-19）

## T3 ✅ 路由配置面板

- 范围：`src/components/RouterPanel.tsx`、`src/styles/router.css`、`ChatHeader.tsx`、`Chat.tsx`、`main.tsx`
- 完成信号：`scripts/verify-router.mjs` 12/12 PASS（2026-11-19）

## T4 ✅ 真机编排验收

- 范围：`scripts/verify-router-e2e.mjs`
- 完成信号：worker + reviewer 都生成、reviewer 输出 `VERDICT: PASS`、文件字节正确（2026-11-19）
- 坑：**主脑 idle ≠ 任务结束**，等待条件必须是「父空闲 + 所有子非 running + 稳定 8 秒」。

## T5 ✅ 审查 + 压力测试

- 范围：`src/hooks/useRouterConfig.ts`、`src/api/agents.ts`、`src/components/RouterPanel.tsx`、
  `src/styles/mobile-tuning.css`、`scripts/verify-router.mjs`
- 分级：高（新增链路 + 文件删除 + 写盘回滚）
- 修复：
  - 🔴 运行中删配置导致会话 failed → 删除前扫会话，busy 拒绝、其余切回 build
  - 🟡 write 失败留下空文件 → 先登记再写
  - 🟡 空 value 误选第 0 个模型 → 加守卫
  - 🟡 手机端按钮高度不一致 → 归入 32px 组
- 压测：S1 20 轮 0 失败；S2 热识别 ≈200ms；S3 并发写完整；S4 修复后链路通过；手机 6/6
- 完成信号：`tsc` 干净、`npm test` 715 全过、`verify-router.mjs` 12/12、e2e PASS（2026-11-19）

## 待评估

- 全局配置（`~/.config/opencode/agents/`）：需要外壳新增 root 之外的写接口
- 自定义角色数量（>3）
- 一键把当前会话切到 `router-main`（现在要手动在模式下拉里选）
- `.opencode/agents/` 是否加 gitignore 开关
- 跨客户端并发保存：目前不保证原子性（可能三文件来自不同写者），如需强一致要加文件锁
