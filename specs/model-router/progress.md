# progress — 多模型路由

## 当前任务

**T1–T5 已完成；审查 0 个 🔴 遗留，压测全过。待决定是否发版。**

## 记录

- 2026-11-19 立项。实测结论：项目级 `.opencode/agents/*.md` 被服务端热识别（增删即时生效，无需重启），
  frontmatter `model` 正确解析为 `{id, providerID}`；agent 权限默认 allow *（.env 读为 ask、browser deny）。
  因此功能做在「生成配置 + 切换 agent」，不自建编排循环。

- 2026-11-19 T1 完成：`routerConfig.ts` 纯函数 + 22 项单测。主脑权限物理上禁掉 edit/shell，
  只允许 read/glob/grep/todo/question + 派两个指定子代理。

- 2026-11-19 T2 完成：`api/agents.ts` + `useRouterConfig`。写盘闭环走 `mkdir → create → write`；
  失败时按备份回滚。**不删 agents 目录**（外壳 delete 对目录是 remove_dir_all）。

- 2026-11-19 T3 完成：`RouterPanel` + 聊天头部「路由」按钮。`verify-router.mjs` 12/12 PASS。

- 2026-11-19 T4 完成：`verify-router-e2e.mjs` 真跑一轮：
  main=command-code/gemini-3.8-flash，worker=deepseek-flash，reviewer=command-code/deepseek-v4.1-flash。
  12s 派 worker → 18s worker 完成 → 27s 派 reviewer → 54s reviewer 完成；
  reviewer 输出 `VERDICT: PASS` 并给出字节级证据，worker 按四段式摘要汇报。

- 2026-11-19 T5 审查 + 压测。发现并修掉：
  1. 🔴 **运行中删配置会把会话打死**：删掉 agent 文件后 `subagent` 调用直接 error，父会话 failed，
     之后也恢复不了。修法：删除前先扫会话，有 busy 的拒绝并提示，其余自动切回 `build`；
     删除按钮改二次确认。
  2. 🟡 `saveRouterFiles` 在 `create` 成功、`write` 失败时留下空文件：改成先登记再写。
  3. 🟡 模型下拉选回「选择模型…」（空 value）会被 `Number('')` 误当成第 0 个模型：加空值守卫。
  4. 🟡 手机端头部按钮统一 32px，新按钮是 26px：补进 `mobile-tuning.css` 的高度组。

- 2026-11-19 压测数据：
  - S1 反复生成/删除 20 轮：0 失败、0 残留，每轮 363~515ms（中位 496ms）。
  - S2 热识别延迟：写入 → `/api/agent` 可见 ≈ 195~214ms；删除 → 消失 ≈ 170~256ms。
  - S3 5 个并发写：最终三文件完整、无解析失败；并发不保证原子性（可能三文件来自不同写者），已知限制。
  - S4 运行中删配置（修复后流程）：busy 被拦 → interrupt → 切 build → 删文件 → 再发消息 `succeeded`。
  - 手机 390×844：路由按钮可见、高 32、头部与整页均无横向溢出、面板铺满 390×844。

- 2026-11-19 踩坑：第一版 e2e 用「父会话 outcome 出现」判断结束，结果父会话派完 worker 就先 idle，
  脚本提前退出、reviewer 根本没派。正确判据是「父空闲 + 子会话全非 running + 稳定 8 秒」。

- 2026-11-19 踩坑：`node --experimental-strip-types` 跑 `.mjs` 测试时，TS 的非空断言 `!` 会语法报错
  （`.mjs` 不经过类型剥离）。测试文件里不要写 TS 专有语法。
