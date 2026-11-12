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

- **消息是分页的，默认只回最新 50 条**。`limit` 最大 200（传 500 报 400
  `Expected a value less than or equal to 200`）。翻更早的页必须把响应里的
  `cursor.next` 原样当 `cursor` 传回去；传 `cursor.previous`、裸消息 id、
  `before=` 都是空页或 400（`InvalidCursorError`）。`cursor` 不能和 `order` 同时传
  （400 `Cursor cannot be combined with order`）。到底时仍会给一个 `next`，
  但下一页为空——以「本页为空」判断终点。
  客户端不翻页的话，长会话看起来就是「聊多了以前的记录丢了」（实测一条会话 656 条，
  只看到 50 条）。
- 上下文用量：最近一条 assistant 的 `tokens`。`input` 只是未命中缓存的部分，
  真实提示词 ≈ `input + cache.read + cache.write`，再加 `output` 就是下一次请求
  会带上的上下文规模。上限取 `/api/model` 里该模型的 `limit.context`
  （如 262144 / 1048576）。

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

## 9. 工作台本地文件通道 `/local/fs/*`（不是 opencode 的接口）

外壳自己实现，直接读磁盘，解决 opencode `/api/fs/read` 只能整份返回、大文件卡死的问题。
除 `Host` 外同样要求 `x-oc-token`（页面经 IPC 拿到），路径限定在 `root` 目录内。

| 端点 | 参数 | 返回 |
|---|---|---|
| `GET /local/fs/list` | `root`, `path` | `{ entries: [{ path, type, size }] }`，目录在前、名字升序，目录 path 带尾部 `\` |
| `GET /local/fs/stat` | `root`, `path`, `encoding`（可选） | `{ size, mtimeMs, lineCount, encoding, binary }`；首次会扫描建行索引 |
| `GET /local/fs/read` | `root`, `path`, `start`, `lines`, `encoding`（可选） | `{ start, text, next, eof, lineCount }`，按整行返回、CRLF 归一，单窗口 ≤512KB |
| `GET /local/fs/text` | `root`, `path`, `maxBytes`, `encoding`（可选） | `{ text }`；超过上限 413（给 Markdown 预览用） |
| `GET /local/fs/raw` | `root`, `path` | 原始字节 + 按扩展名的 content-type（图片预览） |
| `GET /local/fs/hex` | `root`, `path`, `offset`, `bytes` | `{ text }` 十六进制转储，默认 4KB、上限 64KB |
| `GET /local/fs/search` | `root`, `path`, `q`, `limit`, `from`, `case`, `encoding`（可选） | `{ matches: [{ line, text }], truncated, lineCount }`；整文件按行搜索，0 基行号，默认最多 200 条 |
| `PUT /local/fs/write` | `root`, `path`, `expectedMtimeMs`（可选）, `encoding`（可选） | 请求体是整份纯文本（≤8MB）；`encoding` 取 `utf8` / `utf16le` / `utf16be` / `gbk`，不传沿用原编码；返回 `{ size, mtimeMs, lineCount, encoding }` |
| `POST /local/fs/mkdir` | `root`, `path` | 新建文件夹（父目录必须已存在）；`{ ok, path }`，同名 409 |
| `POST /local/fs/create` | `root`, `path` | 新建空文件；同名 409 |
| `POST /local/fs/rename` | `root`, `path`, `to` | 重命名 / 同盘移动；目标已存在 409 |
| `POST /local/fs/delete` | `root`, `path` | 删除文件，或递归删除目录；不能删根 |
| `GET /local/fs/find` | `root`, `name` | `{ matches: [{ path, type }] }`；按文件名（basename，大小写不敏感）在工作区里定位，浅层优先，跳过 `node_modules` / `.git` / `dist` / `target` 等重目录，最多 50 条 |

- 编码：UTF-8（含 BOM）、UTF-16LE/BE（按 BOM）；没有 BOM 时先按「合法 UTF-8」判，不是合法 UTF-8
  再按 GB18030 严格解一次——解得动就当 GBK（`enc = "gbk"`），否则仍按 UTF-8 lossy 显示。
  单字节编码（UTF-8 / GBK）前 8KB 有 NUL 判为二进制。
- 行号是 0 基；`lineCount` 按实际文本行数算（末尾有换行时不额外多算一行）。
- `encoding` 覆盖（「以 X 编码重新打开」）：GET 系列的 `encoding` 表示「按这个编码解」，
  会连行索引一起按该编码重建（缓存键是 `路径#编码`，与自动探测那份互不干扰）；
  不认识的名字回 400。`read` 的行布局随编码变化（UTF-16 与单字节编码的行边界不同）。
- 索引缓存 8 份，按 path + size + mtime 失效；命中后读任意页都是 seek + 最多跳 4096 行。
- **返回行数可能少于 `lines`**：单窗口字节上限 512KB、单行上限 256KB（超出截断）。
  调用方必须按 `next` 续拉，不能假设「一页 200 行」；`eof` 为真时不要再往下补页。
- `start` 超过实际行数时返回空窗口 + `eof`，且 `next >= start`。
- **保存（PUT）**：只能改已存在的文件；请求体是纯 UTF-8 文本（非法字节 400，>8MB 413）。
  `expectedMtimeMs` 与磁盘 mtime 不一致回 409（别处改过）；二进制文件回 415（编辑器写回文本会毁掉原字节）。
  `encoding` 不传就沿用文件原编码；传了就按目标编码写（UTF-16 一定补 BOM，否则下次认不出来）。
  写盘是「同目录临时文件 + rename」，写一半失败不会截断原文件；BOM（同编码时）与 CRLF 会保留。
  GBK 走 Windows 代码页 54936；dev 中间件用 TextDecoder 反推的 GB18030 表，四字节字符（emoji）在 dev 下会 400。
- **结构操作（POST）**：`mkdir` / `create` / `rename` / `delete` 只接受 POST。
  最后一段名字按 Windows 规则校验（`<>:"/\|?*`、控制字符、尾随空格/点、CON/PRN 等保留名都拒）；
  父目录必须已存在且落在 root 内（不帮忙建多级目录）；`delete` 对目录是递归删除，`path` 为空直接 400。
- **`find` 为什么存在**：聊天里的工具详情常常只写裸文件名（`Status.h`、`Protocol.h`），
  真实文件往往在 `src\` 下。页面若拿这个名字直接 `stat` 会按 root 拼路径得到
  `404 文件不存在`（截图里那个报错）。所以点开裸文件名时先 `find` 定位真实相对路径，
  找不到再提示并刷新文件树。搜索受深度（8 层）与访问量（2 万条目）上限保护，不会扫爆 `target/`。

### dev 中间件（scripts/dev-local-fs.mjs）的已知差异

- 没有 `x-oc-token` 校验（只监听 loopback、只用于开发）；生产 exe 一定校验。
- UTF-16 文件 >64MB 直接 413；生产 Rust 版本仍可分页。
- 页读是「Node 解码后按行切」，字节边界与 Rust 的 `BufReader` 窗口可能不同，
  但 `{text,next,eof,lineCount}` 的续拉语义一致。
- 排序/目录 size 已与 Rust 对齐（目录 size=null、名字小写码点比较）。
