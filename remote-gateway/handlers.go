package main

import (
	"fmt"
	"net/http"
	"strings"
)

// ---------- 页面 ----------

func (s *server) currentUser(r *http.Request) (User, bool) {
	uid := s.auth.UserID(r)
	if uid == 0 {
		return User{}, false
	}
	return s.db.UserByID(uid)
}

func (s *server) handleHome(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")

	u, ok := s.currentUser(r)
	if !ok {
		fmt.Fprint(w, loginPage("", r.URL.Query().Get("notice")))
		return
	}
	isAdmin := u.Role == "admin"
	devices := s.db.DevicesOf(u.ID)
	// invites 是旧邀请码面板的参数，门户已改开放注册，这里不再查表。
	fmt.Fprint(w, devicesPage(u.Username, isAdmin, devices, probeAll(devices), nil, r.URL.Query().Get("ok"), r.URL.Query().Get("err")))
}

func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	ip := "login:" + clientIP(r)
	if !s.limiter.reserve(ip) {
		renderLogin(w, "尝试次数太多，5 分钟后再试")
		return
	}
	if err := r.ParseForm(); err != nil {
		renderLogin(w, "请求格式不对")
		return
	}
	name := strings.TrimSpace(r.PostFormValue("username"))
	pass := r.PostFormValue("password")
	u, ok := s.db.UserByName(name)
	if !ok || !VerifyPassword(pass, u.PW) {
		renderLogin(w, "用户名或密码不对")
		return
	}
	s.limiter.ok(ip)
	s.auth.SetCookie(w, u.ID)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *server) handleLogout(w http.ResponseWriter, r *http.Request) {
	// 只清 cookie 不够：token 本身还能用 7 天，必须服务端吊销
	if c, err := r.Cookie(sessionCookie); err == nil {
		s.auth.Revoke(c.Value)
	}
	s.auth.SetCookie(w, 0)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *server) handlePair(w http.ResponseWriter, r *http.Request) {
	u, ok := s.currentUser(r)
	if !ok {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	// 配对码必须限流：不然可以对着数字空间暴力猜（命中就直接拿到那台设备）。
	pairKey := "pair:" + clientIP(r)
	if !s.regLimit.reserve(pairKey) {
		http.Redirect(w, r, "/?err="+queryEscape("配对尝试太频繁，5 分钟后再试"), http.StatusSeeOther)
		return
	}
	_ = r.ParseForm()
	code := strings.TrimSpace(r.PostFormValue("code"))
	// 先只查不删：确认设备存在、归属没冲突，再真正消费配对码。
	// 否则输错一次（或设备还没登记）就白烧一个码，得回本机重新生成。
	peekID, found := s.db.PeekPair(code)
	if !found {
		http.Redirect(w, r, "/?err="+queryEscape("配对码无效或已过期（5 分钟内有效）"), http.StatusSeeOther)
		return
	}
	dev, exists := s.db.DeviceByID(peekID)
	if !exists {
		http.Redirect(w, r, "/?err="+queryEscape("这台电脑还没登记，先在电脑上运行 pair.ps1"), http.StatusSeeOther)
		return
	}
	if dev.OwnerID != 0 && dev.OwnerID != u.ID {
		http.Redirect(w, r, "/?err="+queryEscape("这台电脑已被其他人绑定，请先让原主解绑"), http.StatusSeeOther)
		return
	}
	// 校验都过了才消费；并发下只有一个请求能拿到这个码。
	deviceID, taken := s.db.TakePair(code)
	if !taken || deviceID != peekID {
		http.Redirect(w, r, "/?err="+queryEscape("配对码已被使用，请重新生成"), http.StatusSeeOther)
		return
	}
	s.db.ClaimDevice(deviceID, u.ID)
	// 配对成功要清零：否则连绑 10 台自己的电脑就会被锁 5 分钟
	s.regLimit.ok(pairKey)
	http.Redirect(w, r, "/?ok="+queryEscape("已绑定："+dev.Name), http.StatusSeeOther)
}

func (s *server) handleOpen(w http.ResponseWriter, r *http.Request) {
	u, ok := s.currentUser(r)
	if !ok {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	id := r.PathValue("id")
	dev, exists := s.db.DeviceByID(id)
	if !exists || dev.OwnerID != u.ID {
		http.Redirect(w, r, "/?err="+queryEscape("设备不存在或不属于你"), http.StatusSeeOther)
		return
	}
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	// 会话 cookie 由设备自己签发（Path 限定在该设备前缀下），这里只负责把带 token 的地址交出去
	http.Redirect(w, r, fmt.Sprintf("/u/%s/?t=%s", id, dev.Token), http.StatusSeeOther)
}

func (s *server) handleUnbind(w http.ResponseWriter, r *http.Request) {
	u, ok := s.currentUser(r)
	if !ok {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	id := r.PathValue("id")
	if s.db.ReleaseDevice(id, u.ID) {
		http.Redirect(w, r, "/?ok="+queryEscape("已解绑"), http.StatusSeeOther)
		return
	}
	http.Redirect(w, r, "/?err="+queryEscape("解绑失败"), http.StatusSeeOther)
}

func renderLogin(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	fmt.Fprint(w, loginPage(msg, ""))
}

// queryEscape 只用于把提示文案塞进 query string（保留中文以外的可读字符）。
func queryEscape(s string) string {
	var b strings.Builder
	for _, r := range []byte(s) {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			b.WriteByte(r)
		} else {
			fmt.Fprintf(&b, "%%%02X", r)
		}
	}
	return b.String()
}
