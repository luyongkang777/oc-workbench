# OpenCode v2 API 实测笔记（v2.2.5）

全部结论来自 2026-11-08 真实请求，服务地址 `http://127.0.0.1:28894`。

## 0. 认证（最关键）

- 浏览器打开配对链接（**必须带 `Accept: text/html`**）：
  `GET /auth/connect/<code>` → `302 Location: /` +
  `Set-Cookie: opencode_session_<端口>=<token>; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax`
- 不带 `Accept: text/html` 时返回 JSON：`{"token":"..."}`（这个 token 不能当 Bearer 用，实测三种头全 401）
- 之后所有 `/api/*` 请求带 Cookie 即可，200。
- cookie 名里的端口跟服务端口绑定，换端口就要重新配对。
- 取配对链接：`opencode pair`（输出里 `http://127.0.0.1:<port>/auth/connect/...`）。
- 结论：**自己的客户端在服务端取一次配对链接 → 拿 Set-Cookie → 代理层注入 Cookie**，前端不用管认证。

## 1. 列目录 `GET /api/fs/list`

```
/api/fs/list?location[directory]=F%3A%5Copencode%5Cworkbench
```

返回：

```json
{ "location": { "directory": "F:\\opencode\\workbench" },
  "data": [ { "path": "specs\\", "type": "directory" } ] }
```

- `location` 是对象，query 序列化规则是 `location[directory]=...`（对象展开成方括号形式）。
- `path` 是**相对 location 的路径，用反斜杠**，目录带尾部 `\`。
- 不传 `path` 就是列根目录。

## 2. 读文件 `GET /api/fs/read/<相对路径>?location[directory]=...`

```
/api/fs/read/specs%5Cworkbench%5Cproduct.md?location[directory]=F%3A%5Copencode%5Cworkbench
```

- 返回**原始文本**（不是 JSON）。注意 `content-type` 不可靠：`.ts` 文件可能被识别成 `video/mp2t`（MPEG-TS），前端一律按文本读，不要按 content-type 判断。
- 中文正常（UTF-8），PowerShell 控制台显示乱码只是终端编码问题。
- 文件不存在：`404 {"_tag":"FileNotFoundError","path":"...","message":"File not found: ..."}`

## 3. 写文件 `POST /api/experimental/fs/write?location[directory]=...&path=<相对路径>`

- **body 是文件原始内容（binaryBody），不是 JSON**，`content-type: application/octet-stream`
- 成功返回：

```json
{ "location": { "directory": "F:\\opencode\\workbench" },
  "data": { "path": "F:\\opencode\\workbench\\_probe.txt" } }
```

- 实测：写 `hello-probe` → 读回 `hello-probe` → 磁盘一致。
- 坑：`path` 必须是 query 参数，放进 body 会报 `Missing key at ["path"]`。

## 4. 会话

- 建会话 `POST /api/session`，body：

  ```json
  { "title": "workbench-probe",
    "location": { "directory": "F:\\opencode\\workbench" } }
  ```

  返回 `{ "data": { "id": "ses_..." } }`

- 发消息 `POST /api/session/<id>/prompt`，body `{ "text": "只回复 OK" }`
  返回用户消息对象：
  `{"data":{"id":"msg_...","sessionID":"ses_...","time":{"created":1794141453784},"type":"user","payload":{"text":"只回复 OK"},"delivery":"steer"}}`

- 取消息 `GET /api/session/<id>/message` 返回：

  ```json
  { "data": [
      { "type": "idle", "outcome": "succeeded" },
      { "type": "assistant", "agent": "build",
        "model": { "id": "commandcode/deepseek/deepseek-v4.1-flash", "providerID": "magpie" },
        "content": [ { "type": "text", "text": "OK" } ],
        "tokens": { "input": 3127, "output": 2, "reasoning": 0, "cache": { "read": 32768, "write": 0 } },
        "cost": 0 },
      { "type": "user", "text": "只回复 OK" } ],
    "cursor": { "previous": "...", "next": "..." } }
  ```

- 删除 `DELETE /api/session/<id>` → 204。

## 5. 事件流 `GET /api/event`

- SSE，但没有 `event:` 行，**类型在 data JSON 的 `type` 字段里**：

  ```
  data: {"id":"evt_...","type":"server.connected","data":{}}

  : heartbeat

  data: {"id":"evt_...","created":...,"type":"session.step.started","location":{...},"data":{"sessionID":"..."}}
  ```

- 解析方式：按行读，忽略 `:` 开头的心跳，`data: {json}` 里的 `type` 做分派。
- 已见类型：`server.connected`、`session.step.started`，其余按前缀 `session.*` 分派。

## 6. 终端 PTY

- 建：`POST /api/pty?location[directory]=...`，body：

  ```json
  { "command": "cmd.exe", "args": ["/c","echo hello-pty"],
    "cwd": "F:\\opencode\\workbench", "title": "probe" }
  ```

  返回 `{"data":{"id":"pty_...","status":"running","pid":70948}}`

- 查：`GET /api/pty/<id>?location[...]` → `{"data":{...,"status":"exited","exitCode":0}}`
- 删：`DELETE /api/pty/<id>` → 204
- **输出内容不在 REST 里**，要 `GET /api/pty/<id>/connect-token` 后走 WebSocket（T6 再确认协议）。

## 7. 其它有用端点

- `/api/vcs/status`、`/api/vcs/diff` — Git 状态与 diff
- `/api/session/<id>/diff` — 该会话产生的改动
- `/api/fs/find?query=&type=&limit=` — 文件名搜索（文件树快速定位）
- `/api/experimental/fs/watch` — 文件变化通知
- `/api/model`、`/api/provider` — 可选模型
- `/api/command` — 命令列表

## 8. 踩过的坑

1. `opencode api` CLI 传 `--param path=...` 无效（服务端仍报 Missing key），POST 直接用浏览器/Node fetch。
2. PowerShell 里 `curl -d '{"a":1}'` 双引号会被剥掉，改用 `--data-binary "@文件"`。
3. `location` 不是字符串，是对象；写成 `location=F:\x` 会报 `Expected object | undefined at ["location"]`。
4. 配对链接是一次性的，5 分钟过期；生成后立刻用。
5. `opencode pair --url <别的端口>` 只是改显示地址，code 仍属于默认服务，拿去访问别的端口会 401 expired。
