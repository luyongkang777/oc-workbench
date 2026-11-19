# 多模型路由（model-router）

## 目标

在工作台里配一套「主脑 / 执行体 / 审核体」三件套，一键生成 opencode 的 agent 配置，
然后把会话切到主脑，让：

1. 主脑只思考、只出方案，不碰文件和工具；
2. 执行体（便宜的/审查弱的模型）去跑工具（含 IDA 等 MCP），只返回结构化摘要；
3. 审核体按主脑给的验收标准判定 PASS/FAIL，不通过就回主脑、由主脑决定是否让执行体修。

收益：主模型上下文只吃摘要（省 token、降审查面），工具副作用集中在执行体，审核与生成分离。

## 不做什么

- 不做工作台自建的编排循环（不自己发 prompt、自己串模型）——执行交给 opencode 原生 agent/subagent
- 不做硬编码的重试状态机——循环靠主脑 prompt + `steps` 上限
- v1 不做全局配置（只写项目级 `.opencode/agents/`）
- 不改 opencode 本体
- 不做「用户直接对话子模型、子模型再转给主脑」的反向流程（见下）

## 关键决策

1. **入口必须是主脑（primary），不是执行体。**
   opencode 的 subagent 只能由父会话拉起，用户无法直接对话。若把执行体做成 primary、主脑做成
   subagent，主脑会变成独立子会话、拿不到完整对话上下文，用户也看不到它的推理。
   所以「先跟便宜模型说话」这条在 opencode 模型下不成立；正确的分配是：主脑当父，执行体/审核体当子。

2. **三件套固定命名**：`router-main`（primary）、`router-worker`（subagent）、
   `router-reviewer`（subagent）。固定命名才能让面板可靠判定「是否已启用」。

3. **审核体必须与执行体不同模型**（面板默认强制），否则是自审自。

4. **配置落在项目级** `.opencode/agents/`：已实测服务端热识别、增删即时生效；
   且路径在项目根内，可直接复用现有 `/local/fs/write`，不需要外壳新增接口。

5. **主脑物理上没有改文件的权限**。不靠 prompt 自觉：`edit`/`shell` 一律 deny，
   只留 `read`/`glob`/`grep`/`subagent`，想动手就必须派子任务。

## 验收标准

1. 面板里给三个角色各选一个模型，点「生成配置」后，
   `<root>/.opencode/agents/` 出现 `router-main.md`、`router-worker.md`、`router-reviewer.md`；
   `GET /api/agent?location[directory]=<root>` 能列出这三个 id，且 `router-main.mode == primary`。
2. 面板能回显已有配置（重新打开工作台后三个下拉仍是上次选的模型），并能「删除配置」后回到未启用态。
3. 在会话头部选 `router-main`，发一个需要改文件的任务：
   - 子智能体面板出现 `router-worker` 会话，文件确实被改；
   - 随后出现 `router-reviewer` 会话，输出带 PASS/FAIL；
   - 主脑最终输出总结，且主脑自己的工具记录里没有任何 edit/shell 调用。
4. 审核体返回 FAIL 时，主脑会再派一次 worker 去修，而不是自己动手。
5. 执行体模型与审核体模型相同时，面板阻止保存并提示。

## 前置条件

- opencode ≥ 2.3.2，agent 支持 frontmatter `model` / `mode` / `permissions`
- 项目根可写（`.opencode/agents/` 由工作台创建）
- 已有能力：`GET /api/agent`、`GET /api/model`、`POST /api/session/<id>/agent`、
  `/local/fs/read|write`

## 非功能要求

- 生成配置 ≤ 1 次写盘，失败不改动已有文件
- 面板不阻塞聊天；模型列表走现有 `/api/model` 缓存
- 配置里不写任何密钥

## 约束

- 单文件 ≤ 300 行，单函数 ≤ 50 行
- 新增纯函数模块不 import React/fetch，node 直接可测
- 生成的文件必须能被 opencode 解析（YAML frontmatter 不出现未转义冒号）

## 假设（待确认）

- 假设配置跟着仓库走（`.opencode/agents/` 进 git）是可接受的；若要隔离再加 gitignore 开关
- 假设 v1 只支持 3 个角色，不支持自定义角色数量
- 假设用户能接受「入口是主脑」而不是「入口是便宜模型」

## 变更记录

- 2026-11-19 初版
