# 一期任务拆分（远程访问 · 单实例跑通）

规则：一条 = 一次会话内能做完，≤5 个文件、≤ 300 行。做完一条、验收过，才开下一条。

顺序理由：先做**凭据持久化**（后面所有验收都依赖重启后链接仍有效），再做端口，最后动前端 base。

---

## T1 持久化远程凭据

- 现状：token 每次启动随机（`main.rs`），页面靠 IPC 取，重启即失效。
- 改法：
  - `update.rs`：`load_settings` / `save_settings` 从私有改为 `pub(crate)`
  - 新增 `shell/src/remote_auth.rs`：
    - `remote_token()`：从 settings.json 读 `remoteToken`，没有就用 `getrandom` 生成 32 字节 hex 落盘
    - `sign_session(token, instance_id, exp) -> String`、`verify_session(...) -> bool`
    - HMAC-SHA256 用已有 `sha2` 手写（约 30 行），不引新依赖
  - 启动日志打一次完整入口 URL（方便复制到手机）
- 文件：`shell/src/update.rs`、`shell/src/remote_auth.rs`(新)、`shell/src/main.rs`
- 验收：
  - 首次启动 settings.json 出现 `remoteToken`，32 字节 hex
  - 手动改坏 settings.json 不崩（沿用现有「坏文件当空对象」逻辑）
  - 同一个 token 签出的 cookie 在进程重启后仍验签通过

## T2 固定监听端口

- 现状：`main.rs:150` 传 `port: 0`，`server.rs:338` 绑 `127.0.0.1:0`。
- 改法：`server::start` 接受端口参数；端口从 settings.json 的 `remotePort` 读，默认 0。
- 文件：`shell/src/main.rs`、`shell/src/server.rs`
- 验收：
  - 不设 `remotePort` 时仍是随机端口，行为和现在完全一致
  - 设 17800 后固定，`curl 127.0.0.1:17800` 有响应
  - 17800 被占用时报错清楚、退出码非 0（不能静默换端口，隧道会指错）
  - `npm test` 全绿

## T3 后端支持路径前缀

- 现状：路由按 `/api/*`、`/local/*`、`/` 硬编码。
- 改法：新增 settings.json 键 `remoteBase`（如 `/u/7fk2m9xq`，默认空）：
  - 先剥前缀再匹配；设了前缀时，不带前缀的请求一律 404
  - `static_files` 同步剥前缀
- 文件：`shell/src/server.rs`、`shell/src/static_files.rs`、`shell/src/server_tests.rs`
- 验收：
  - `GET /u/abc/` 返回 index.html
  - `GET /u/abc/api/info` 正常
  - `GET /` 和 `GET /api/info` 返回 404
  - 不设 `remoteBase` 时行为与现在一致

## T4 前端支持可配 base

- 改法：
  - `vite.config.ts` 读 `OC_WORKBENCH_BASE`（构建期）作为 `base`
  - 前端所有硬编码绝对路径改用 `import.meta.env.BASE_URL`
  - `index.html` 资源引用交给 Vite，不写死 `/assets/`
- 文件：`vite.config.ts`、`src/api/client.ts`、`src/api/auth.ts`、`index.html`
- 验收：
  - `npm run build` 产物里资源引用带前缀
  - 加前缀启动后 Network 面板无 404
  - `npm run dev`（不带前缀）仍可用
- 先扫一遍绝对路径：`rg -n '/assets|href="/|src="/|fetch\("/' src`

## T5 加载地址与根路径跳转

- 现状：`main.rs:163` 返回 `http://127.0.0.1:{port}/`，这是 WebView2 打开的地址。
- 改法：拼上 `remoteBase`；设了前缀时 `GET /` 返回 302 到 `<base>/`。
- 文件：`shell/src/main.rs`、`shell/src/server.rs`
- 验收：
  - 设前缀后双击 exe **不白屏**，能正常进主界面
  - 不设前缀时行为和现在一致
- 说明：这条不做，T3 一上线本机就白屏。

## T6 入口 token 换 cookie

- 改法：新增 `shell/src/auth_gate.rs`
  - `GET <base>/?t=<token>`：比对 `remoteToken` → 签发 cookie（格式见 product.md）→ 302 `<base>/`
  - 错误 token → 401，不下发 cookie
  - `/api/*` 鉴权顺序：`x-oc-token` 头（原路径，WebView2 用）→ cookie（浏览器用）
  - 响应头加 `Referrer-Policy: no-referrer`
- 文件：`shell/src/auth_gate.rs`(新)、`shell/src/server.rs`
- 验收：
  - 带 `?t=` 访问 → 302 + Set-Cookie 正确（HttpOnly、Path=base、SameSite=Lax）
  - 之后不带 token 的 `/api/*` 用 cookie 能通
  - 伪造/过期 cookie → 401
  - WebView2 外壳原有 IPC 流程不受影响

## T7 服务器加 7800 单入口

- 改法：新建 `/www/server/panel/vhost/nginx/remote-web-7800.conf`（独立 server 块，不是 extension 目录）
  - `listen 7800`
  - `location = /u/<id> { return 301 /u/<id>/; }`
  - `location ^~ /u/<id>/ { proxy_pass http://127.0.0.1:17801; }` ← **结尾不带斜杠，不剥前缀**
  - `proxy_set_header Host 127.0.0.1:17800;` ← 关键，绕过后端 Host 校验
  - 抄 `remote-mcp-7810.conf` 的 SSE 参数（`proxy_buffering off`、3600s、Upgrade）
  - `access_log off`
  - 在配置里写注释：不要加统一登录、不要给 proxy_pass 加尾斜杠
- 验收：
  - `nginx -t` 通过
  - 服务器本地 `curl -I http://127.0.0.1:7800/u/<id>/` 正常
  - **从本机（非服务器）连 7800 成功**（确认轻量防火墙已放行）
  - `curl -I http://81.70.181.82/`、`:3900`、`:7810`、`:7820` 全部无变化

## T8 隧道 + 看门狗

- 改法：`scripts/remote-tunnel.ps1` + `scripts/tunnel-watchdog.ps1`
  - 隧道：`-N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -R 127.0.0.1:17801:127.0.0.1:17800 tiku`
  - 看门狗：进程在 **且** 服务器侧 17801 真实连通才算活；只看端口会被别的程序骗
  - 脚本 UTF-8 带 BOM（PowerShell 5.1 必需）
- 文件：`scripts/remote-tunnel.ps1`(新)、`scripts/tunnel-watchdog.ps1`(新)
- 验收：杀掉隧道 60 秒内自动恢复，日志有明确记录

## T9 端到端验收

- 手机切 4G，走完 `product.md` 的 13 条验收标准。
- 重点：流式回复不缓冲、锁屏 1 分钟回来仍可用、重启 exe 后链接仍有效、用 A 的 cookie 打 B 的路径必须 401。

---

## 待评估（不在一期内）

- 二期：第二台机器接入，验证多实例隔离（cookie 不串、资源不串）。
- 二期：ssh -R 换成自研连接器（给别人用时不能发服务器账号）。
- 二期：HTTPS（需要域名 + 泛解析）。
- 二期：同机多实例（`single.rs` 的互斥体加 profile 后缀）。
- 三期：聚合面板（跨实例会话列表）。
- 实例 ID 自动分配与回收。
- cookie 吊销（手机丢了踢掉）。
