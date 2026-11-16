# 远程访问网关（账号 + 设备配对）

给「多个用户、每人多台电脑」用的入口层。它决定**谁能看到哪几台设备**，
并校验「这台设备的入口归不归你」；设备 cookie 仍由各工作台用**自己的 `remoteToken`** 签名。

注意：网关为了让账号面板能生成 `?t=` 入口链接，**会保存一份设备 token**。
所以它是「可信的凭据中心」，不是哑管道 —— 详见文末「安全边界」。

## 架构

```
手机/浏览器
  → http://81.70.181.82:7800/                    ← 登录 / 我的设备（Go 网关 127.0.0.1:17900）
  → http://81.70.181.82:7800/u/<设备ID>/?t=<token> ← 各设备自己的入口（nginx → 回环端口 → SSH 隧道）
```

- 网关：`/opt/ocw-gateway/ocw-gateway`（systemd `ocw-gateway.service`）
- 数据：`/var/lib/ocw-gateway/`
  - `gateway.json` 用户/设备/配对码
  - `secret` 会话 cookie 签名密钥
  - `enroll` 设备注册密钥（`pair.ps1` 用）
- nginx：
  - `/www/server/panel/vhost/nginx/remote-web-7800.conf`（server 块，`location /` 指向网关）
  - `/www/server/panel/vhost/nginx/ocw-devices.inc`（**由网关自动生成**，每台设备一段 location）
    - 注意后缀是 `.inc`：宝塔会用 `include .../vhost/nginx/*.conf` 把这个目录当独立站点引入，
      放 `.conf` 会让 `location` 出现在 http 层而报错。

## 代码结构

按职责分文件（同包，Go 的多文件即可）：

| 文件 | 职责 |
| --- | --- |
| `main.go` | 参数解析、启动流程、路由注册 |
| `cli.go` | `-mode adduser/passwd/users/setrole/invite/rmdevice/sync-nginx/seed` |
| `handlers.go` | 门户页面：首页/登录/登出/配对/打开/解绑 |
| `signup.go` | 开放注册 |
| `device_register.go` | 设备登记（`pair.ps1` 调用）+ 配对码生成 |
| `api_client.go` | 给 exe 用的 JSON API（Bearer + CORS） |
| `profile_api.go` + `store_profile.go` | 账号级客户端配置（provider/SK/模型选择）读写，见下 |
| `gate.go` | nginx `auth_request` 校验 + 一次性票据换 cookie |
| `store.go` | 类型定义、原子落盘、跨进程写锁 |
| `store_users.go` / `store_devices.go` / `store_pairs.go` | 用户 / 设备 / 配对码与邀请码 |
| `auth.go` | PBKDF2 口令、会话 token、吊销表、限流 |
| `views.go` | 内联 HTML（移动优先） |
| `nginxconf.go` | 设备表 → nginx 片段 + `nginx -t` + reload |
| `probe.go` | 在线探测（打 `/api/state`，不是探端口） |
| `lock_unix.go` / `lock_windows.go` | 跨进程文件锁 |

## 账号级配置同步（`/portal/api/profile`）

换电脑后不想重新填 key：客户端把「第三方 API 接入」里的 provider（含 SK、baseURL、
模型与上下文）和默认模型存到账号下，另一台电脑登录同一账号后自动拉取并写进本地
`opencode.json`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/portal/api/profile` | 返回 `{"profile": <对象或 null>}`，只能读自己那份 |
| POST | `/portal/api/profile` | 覆盖保存，body 必须是 JSON 对象，上限 512KB |

几点约定：
- **响应必须固定包一层 `{profile: ...}`**。曾经有数据时回裸对象、没数据时回
  `{profile:null}`，客户端按 `data.profile` 取值，于是每次都判成「云端为空」，
  反手把本机配置覆盖上去（实测踩过，换机后不但没恢复还丢了云端数据）。
- 网关**不解析**内容，原样存取；以后客户端加字段不用改服务端。
- 存在 `gateway.json` 的 `profiles`（键是 `u<userID>`），与用户/设备同一把写锁。

## 测试

```bash
cd remote-gateway
go vet ./...
go test ./... -count=1     # 56 个用例，约 1.5 秒，不依赖 nginx / 网络
```

CI：`.github/workflows/ci.yml` 在每次 push/PR 跑「前端 tsc + 单测」和
「网关 vet + 单测 + linux 交叉编译」；发版时 `release.yml` 也会先跑一遍网关测试。


## 自助注册（开放）

登录页底部「没有账号？注册」→ 填用户名 + 密码（≥8 位）即可，**不需要邀请码**。
注册成功直接登录。新账号没有任何设备；在任意一台电脑上用这个账号登录工作台，本机会自动登记过来（配对码只用于远程代管别人的电脑）。

防滥用（都在代码里，不用配）：

- 登录：同一 IP 5 分钟内 6 次尝试即锁（每次尝试都计数，成功后清零）
- 注册 / 设备登记 / 配对：各自独立的桶，5 分钟 10 次
- 账号总数上限 200（`signup.go` 的 `maxAccounts`），满了返回「注册用户已满」
- 用户名 2~32 字符、密码至少 8 位、重名直接拒绝

> 之前做过邀请码模式，现在改成开放注册。`-mode invite` 命令和 `/portal/admin/invite`
> 路由还在，但注册流程已经不用它们了；想恢复邀请码只要把 `handleSignup` 里的
> `TakeInvite` 校验加回去。

### 把某个账号提成管理员

```bash
/opt/ocw-gateway/ocw-gateway -mode setrole -u admin -role admin -data /var/lib/ocw-gateway
```

## 加一个人

```bash
/opt/ocw-gateway/ocw-gateway -mode adduser -u zhangsan -p '初始密码至少8位' -data /var/lib/ocw-gateway
/opt/ocw-gateway/ocw-gateway -mode users -data /var/lib/ocw-gateway      # 看现有账号
/opt/ocw-gateway/ocw-gateway -mode passwd -u zhangsan -p '新密码' -data /var/lib/ocw-gateway
```

## 加一台电脑

1. 电脑上确认工作台已启动过（生成 `remoteBase` / `remoteToken`）
2. 把 `scripts/pair.ps1` + `scripts/gateway.config.json` 放到该机器的
   `工作台目录\scripts\`
3. 运行 `powershell -ExecutionPolicy Bypass -File scripts\pair.ps1`
4. 记下 8 位配对码，手机登录后输入（自己的电脑通常不需要：登录即自动认领）
5. 隧道脚本（`remote-tunnel.ps1`）会自动读 `settings.json` 的 `relayPort`

网关会自动写 nginx 片段并 reload，**不需要手工加 location**。

## 安全自测（压测）

```bash
# 在服务器上跑（只打 127.0.0.1:7800，不影响公网带宽）
python3 /tmp/gw-pentest2.py '<admin密码>'
# 或者把仓库里的 pentest.py 传上去执行
```

覆盖 36 项：未登录访问、伪造 Bearer/cookie、路径穿越、设备入口鉴权、设备登记鉴权、
注册输入校验、XSS 转义、畸形 JSON、2MB 请求体、CORS、40 并发、会话过期、
登录爆破限流、注册限流。

**注意**：最后两项会锁住本机 IP 的登录 5 分钟，跑完执行
`systemctl restart ocw-gateway` 清空内存计数即可解锁。

2026-11-15 实测结果：36 项全过，修掉两处真实问题：

1. **远程入口的静态资源不鉴权**：任何人请求 `/u/<id>/` 都能拿到页面框架（API 虽然 403）。
   修法在 `shell/src/server.rs`：`!ctx.base.is_empty() && !token_allowed(...)` 时返回 401。
2. **注册接口不计次**：只在进入时检查限流，失败不计数 → 等于不限流，可被脚本刷爆 CPU。
   修法：注册每次尝试都计数（5 分钟 10 次），设备登记同样限流；
   并把登录/注册/设备登记拆成三个桶，互不牵连。

## 安全边界（必须知道）

- 现在**没有 HTTPS**（只有 IP，没有域名/证书）。同一 WiFi 下抓包能拿到 cookie 和 `?t=` token，
  等于能完整控制对方那台电脑。**只在自己信任的网络里用**，公共 WiFi 不要用。
- 因此会话 cookie 只给 **7 天**（桌面版是 30 天），登录失败 5 分钟内 6 次即锁。
- `gateway.config.json` 里的 `enroll` 等于「注册权限」，别外传；泄露了就重新生成
  （删掉服务器上的 `/var/lib/ocw-gateway/enroll`，重启网关）。
- 每台设备的 `remoteToken` 设备上有一份，网关为了签发入口链接也存一份（`gateway.json`）。
  所以**网关服务器被攻破 = 所有设备入口暴露**（这是「账号面板能列出并打开设备」的代价）。

## 运维

```bash
systemctl status ocw-gateway
journalctl -u ocw-gateway -n 50 --no-pager
systemctl restart ocw-gateway
/opt/ocw-gateway/ocw-gateway -mode sync-nginx -data /var/lib/ocw-gateway   # 设备表 → nginx 片段
```

## 本地开发

```powershell
cd remote-gateway
go build -o dist\ocw-gateway.exe .
$env:GOOS='linux'; $env:GOARCH='amd64'; $env:CGO_ENABLED='0'
go build -trimpath -ldflags "-s -w" -o dist\ocw-gateway .
scp dist\ocw-gateway tiku:/opt/ocw-gateway/ocw-gateway   # 先 systemctl stop
```
