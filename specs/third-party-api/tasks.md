# 第三方 API 接入 · 小需求清单

> 一条 ≤5 文件 / ≤300 行 / 一次会话内完成。做完一条才开下一条。

## T1 纯函数层 `src/api/providerFormat.ts`

- [ ] `normalizeBaseURL`：去尾部斜杠、补 `/v1`、只接受 http/https
- [ ] `maskKey`：`sk-9fc…e0ff`，短 key 全部打星
- [ ] `validateDraft`：id 规则（字母数字 . _ -）、baseURL、key
- [ ] `mergeModelIds`：拉到的模型 ∪ 已启用的模型，去重排序
- 验收：`npm test` 里 `providerFormat.test.mjs` 全绿

## T2 外壳接口 `shell/src/provider.rs` + `provider_store.rs`

- [ ] `GET  /local/provider/status`：读 `opencode.json`，回 provider 列表（key 掩码）+ 配置文件路径/错误
- [ ] `POST /local/provider/models`：`{baseURL, apiKey}` → 拉 `{baseURL}/models`，回 id 列表
- [ ] `POST /local/provider/save`：`{provider:{...}, models:[...]}` 精确写一条，其余字段原样
- [ ] `POST /local/provider/remove`：`{id}` 只删一条
- [ ] 备份 + 原子写 + 写前后自检（`provider` 之外的顶层键必须全在）
- 验收：`cargo test --release` 里 provider 单测全绿

## T3 dev 同款 `scripts/dev-local-provider.mjs` + vite 注册

- [ ] 三个路由与 Rust 同路径同语义同字段
- 验收：dev 下 curl 三接口通

## T4 前端 `src/api/provider.ts` + `src/components/ProviderPanel.tsx` + `styles/provider.css`

- [ ] 抽屉面板：列表 / 新增 / 编辑 / 删除 / 获取模型 / 勾选模型 / 保存
- [ ] DeepSeek 官方预设按钮
- 验收：`tsc --noEmit` 通过，界面能打开

## T5 接线

- [ ] `TopBar` 加插头按钮；`App`/`AppShell` 加 `providerOpen`；`appContext` 加字段
- [ ] 保存成功后提示「已写入配置，重启 OpenCode 服务后生效」
- 验收：`node scripts/build-exe.mjs` + CDP 验收
