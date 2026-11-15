package main

import (
	"fmt"
	"html"
	"strings"
)

// CSS/HTML 直接内联：网关只有一个可执行文件，不要额外的静态目录。
const pageCSS = `
:root{--bg0:#15171d;--bg1:#1c1f27;--bg2:#252935;--line:#2f3442;--text:#e8eaef;--dim:#9aa3b2;--accent:#2f81f7;--ok:#2ea043;--bad:#d9534f}
@media (prefers-color-scheme: light){:root{--bg0:#f7f8fa;--bg1:#fff;--bg2:#f1f3f7;--line:#d9dee6;--text:#1a1d23;--dim:#5f6875;--accent:#0e639c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg0);color:var(--text);font:16px/1.6 -apple-system,'Segoe UI','Microsoft YaHei',system-ui,sans-serif;-webkit-text-size-adjust:100%}
.wrap{max-width:560px;margin:0 auto;padding:24px 16px 40px}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:16px;margin:0 0 10px}
.sub{color:var(--dim);font-size:15px;margin:0 0 18px}
.card{background:var(--bg1);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:12px}
label{display:block;font-size:15px;color:var(--dim);margin:0 0 6px}
input{width:100%;height:46px;padding:0 14px;border-radius:10px;border:1px solid var(--line);background:var(--bg0);color:var(--text);font-size:16px;margin-bottom:14px}
input:focus{outline:2px solid var(--accent);outline-offset:-2px}
button{min-height:46px;padding:0 16px;border-radius:10px;border:1px solid var(--line);background:var(--bg2);color:var(--text);font-size:16px;font-family:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;width:100%}
button.link{background:transparent;border:none;color:var(--dim);font-size:15px;min-height:44px;padding:0}
.row{display:flex;align-items:center;gap:12px}
.dev{justify-content:space-between}
.dev-main{min-width:0}
.dev-name{font-size:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dev-meta{color:var(--dim);font-size:14px;margin-top:2px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#4a5160;margin-right:6px;vertical-align:middle;box-shadow:0 0 0 1px rgba(0,0,0,.25)}
.dot.on{background:#22c55e;box-shadow:0 0 6px rgba(34,197,94,.55)}
.dot.busy{background:#f59e0b;box-shadow:0 0 8px rgba(245,158,11,.65);animation:dotbreath 1.6s ease-in-out infinite}
@keyframes dotbreath{0%,100%{opacity:1}50%{opacity:.35}}
.dev-actions{display:flex;gap:8px;flex-shrink:0}
.err{background:rgba(217,83,79,.14);border:1px solid rgba(217,83,79,.45);padding:10px 12px;border-radius:10px;font-size:15px;margin-bottom:14px}
.ok{background:rgba(46,160,67,.14);border:1px solid rgba(46,160,67,.45);padding:10px 12px;border-radius:10px;font-size:15px;margin-bottom:14px}
.empty{color:var(--dim);text-align:center;padding:26px 8px;font-size:15px;line-height:1.8}
.code{font:600 30px/1.3 ui-monospace,Consolas,monospace;letter-spacing:8px;text-align:center;padding:10px 0}
.foot{display:flex;justify-content:space-between;align-items:center;margin-top:16px;color:var(--dim);font-size:14px}
.muted{color:var(--dim);font-size:14px;margin-top:10px;text-align:center}
.muted a{color:var(--accent);text-decoration:none;min-height:44px;display:inline-block;line-height:44px}
code{background:var(--bg2);padding:2px 6px;border-radius:6px;font-size:14px}
.inv{font:600 18px/1.8 ui-monospace,Consolas,monospace;letter-spacing:2px}
.inv-list{display:flex;flex-wrap:wrap;gap:8px}
.inv-list code{font-size:15px}
`

func page(title, body string) string {
	return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>` + html.EscapeString(title) + `</title>
<style>` + pageCSS + `</style></head>
<body><div class="wrap">` + body + `</div></body></html>`
}

func esc(s string) string { return html.EscapeString(s) }

// shortID 取设备 ID 后 6 位：两台电脑的计算机名经常一样（都是 DESKTOP-XXXX
// 或用户都叫「LU」），只显示名字分不清谁是谁，ID 才是唯一的。
func shortID(id string) string {
	if len(id) > 6 {
		return id[len(id)-6:]
	}
	return id
}

func loginPage(errMsg, notice string) string {
	body := `<h1>OpenCode 工作台</h1>
<p class="sub">登录后可以看到你自己的电脑</p>`
	if notice != "" {
		body += `<div class="ok">` + esc(notice) + `</div>`
	}
	if errMsg != "" {
		body += `<div class="err">` + esc(errMsg) + `</div>`
	}
	body += `<form class="card" method="post" action="/portal/login">
  <label for="u">用户名</label>
  <input id="u" name="username" autocomplete="username" autocapitalize="off" required>
  <label for="p">密码</label>
  <input id="p" name="password" type="password" autocomplete="current-password" required>
  <button class="primary" type="submit">登录</button>
</form>
<p class="muted">还没有账号？<a href="/portal/register">注册</a></p>`
	return page("登录 · OpenCode 工作台", body)
}

func registerPage(errMsg string) string {
	body := `<h1>注册</h1>
<p class="sub">填个用户名就能开始用</p>`
	if errMsg != "" {
		body += `<div class="err">` + esc(errMsg) + `</div>`
	}
	body += `<form class="card" method="post" action="/portal/register">
  <label for="u">用户名</label>
  <input id="u" name="username" autocomplete="username" autocapitalize="off" required minlength="2" maxlength="32">
  <label for="p">密码（至少 8 位）</label>
  <input id="p" name="password" type="password" autocomplete="new-password" required minlength="8">
  <button class="primary" type="submit">注册并登录</button>
</form>
<p class="muted">已有账号？<a href="/">去登录</a></p>`
	return page("注册 · OpenCode 工作台", body)
}

func devicesPage(username string, isAdmin bool, devices []Device, probed map[string]probeState, invites []Invite, notice, errMsg string) string {
	var cards strings.Builder
	for _, dev := range devices {
		state := probed[dev.ID]
		isOn := state.Online
		// 在跑（有会话正在生成）用黄灯呼吸：不点开也能看出这台电脑是不是在干活。
		when := "离线"
		if isOn {
			when = "在线"
		}
		if state.Busy {
			when = "在跑"
		}
		dot := ""
		if isOn {
			dot = " on"
		}
		if state.Busy {
			dot = " on busy"
		}
		cards.WriteString(fmt.Sprintf(`<div class="card row dev">
  <div class="dev-main">
    <div class="dev-name"><span class="dot%s"></span>%s</div>
    <div class="dev-meta">%s · %s</div>
  </div>
  <div class="dev-actions">
    <form method="get" action="/portal/open/%s"><button type="submit">打开</button></form>
    <form method="post" action="/portal/unbind/%s" onsubmit="return confirm('解绑后这台电脑不再出现在你的列表里，确定？')">
      <button type="submit" class="link">解绑</button>
    </form>
  </div>
</div>`, dot, esc(dev.Name), esc(when), esc(shortID(dev.ID)), esc(dev.ID), esc(dev.ID)))
	}
	if len(devices) == 0 {
		cards.WriteString(`<div class="card empty">还没有绑定电脑。<br>在电脑上运行 <code>scripts\\pair.ps1</code>，把显示的 8 位配对码填到下面。</div>`)
	}

	var banner string
	if notice != "" {
		banner += `<div class="ok">` + esc(notice) + `</div>`
	}
	if errMsg != "" {
		banner += `<div class="err">` + esc(errMsg) + `</div>`
	}

	// 开放注册后不再需要邀请码，管理员区块留空（参数保留，以后要加功能再用）
	var adminBlock string
	_ = isAdmin
	_ = invites

	body := `<h1>我的设备</h1>
<p class="sub">` + esc(username) + `</p>` + banner + cards.String() + `
<form class="card" method="post" action="/portal/pair">
  <label for="code">绑定新电脑（8 位配对码）</label>
  <input id="code" name="code" inputmode="numeric" maxlength="8" placeholder="12345678" autocomplete="one-time-code" required>
  <button class="primary" type="submit">绑定</button>
</form>` + adminBlock + `
<div class="foot">
  <span>` + fmt.Sprintf("%d 台设备", len(devices)) + `</span>
  <form method="post" action="/portal/logout"><button class="link" type="submit">退出登录</button></form>
</div>`
	return page("我的设备 · OpenCode 工作台", body)
}

func pairPage(code, deviceName string) string {
	body := `<h1>配对码</h1>
<p class="sub">` + esc(deviceName) + `</p>
<div class="card"><div class="code">` + esc(code) + `</div>
<p class="sub" style="margin:12px 0 0">5 分钟内有效。手机登录后输入这 8 位数字即可绑定这台电脑。</p></div>`
	return page("配对码 · OpenCode 工作台", body)
}
