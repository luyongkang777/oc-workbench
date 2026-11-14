# 进度

## 当前状态

**端到端跑通**：公网浏览器实测显示「已连接」，项目树、输入框、后端全部正常。

## 关键标识

| 项 | 值 |
| --- | --- |
| 入口 | `http://81.70.181.82:7800/u/645a6a9ede23f047/` |
| 首次打开 | 需带 `?t=<remoteToken>`，之后靠 localStorage 记住 |
| 本机端口 | `127.0.0.1:17800` |
| 服务器回环 | `127.0.0.1:17801` |
| 云实例 | `lhins-0d8jxh1q`（4 核 4G，**带宽 3Mbps**，流量包 300GB/月） |

## 已完成

### T1~T8 核心改造 ✅

- 凭据持久化（HMAC-SHA256 cookie，跨重启有效）
- 固定端口 17800
- 后端路径前缀 + 剥前缀路由
- 前端运行时 base（构建产物 `./assets/`）
- 加载 URL 拼前缀
- 入口 `?t=` 换 cookie
- nginx 7800 单入口（Host 改写回环）
- 隧道 + 看门狗（1 秒自愈）

### T9 公网链路 ✅

- 腾讯云防火墙已放行 7800（控制台操作）
- 根路径 404、前缀 200、资源 200
- 无凭据/错 token/伪造 cookie 均 403

### T10 浏览器版可用性 ✅

| 问题 | 根因 | 修法 |
| --- | --- | --- |
| 页面显示「连接本地服务失败」 | 检测不到 WebView2 IPC 就判失败 | 用 `chrome.webview` 区分，浏览器直接 ready |
| 项目清单为空 | 只走 IPC | 新增 `GET/POST /local/projects`，前端无 IPC 时走 HTTP |
| 手机 403 `缺少或错误的 x-oc-token` | 手机浏览器存不住 cookie | 入口 `#t=` 存进 localStorage，请求带 header；cookie 保留双保险 |
| `ERR_TOO_MANY_REDIRECTS` | 302 保留 `?t=` 导致自循环 | 改用 `#t=`（浏览器不把 `#` 发给服务器）+ `no-store` |
| 界面「未连接」 | **代理转发用了带前缀的原始 URL**，opencode 收到 `/u/<id>/api/...` 返回 SPA HTML | 改用剥前缀的 `path` + 原样接回 query，并加回归测试 |

最后一条是 T3 引入的回归，桌面端因前缀为空从未暴露。

## 测试

| 套件 | 数量 |
| --- | --- |
| Rust | 207 passed |
| 前端 | 469 passed |

## 待做

- 手机 4G 实测（用户）
- 代码审查（change-review-gate）→ 提交 → 推 GitHub 开 PR
- 隧道自启动（现在要手动跑 `scripts/remote-tunnel.ps1`）
- 二期：HTTPS（需要域名）、聚合面板、自研连接器替代 ssh

## 安全提醒

- 链接即钥匙：拿到完整入口链接就能操作这台电脑
- 换 `settings.json` 里的 `remoteToken` 并重启即可让旧链接失效
- 目前是明文 HTTP，公共 WiFi 下有被中间人看到的风险
