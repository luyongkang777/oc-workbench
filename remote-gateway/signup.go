package main

import (
	"fmt"
	"net/http"
	"strings"
)

// 开放注册的账号总量上限（自己人用，200 足够；被刷时能兜住）
const maxAccounts = 200

func (s *server) handleRegisterPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	fmt.Fprint(w, registerPage(r.URL.Query().Get("err")))
}

func (s *server) handleSignup(w http.ResponseWriter, r *http.Request) {
	// 注册单独计数：登录被锁不该连带注册不可用（反之亦然）。
	// 注意：每次「尝试」都要记一次（成功也记），否则注册接口等于不限流，
	// 会被脚本刷出大量账号、把 PBKDF2 的 CPU 打满。
	ip := "register:" + clientIP(r)
	if !s.regLimit.reserve(ip) {
		http.Redirect(w, r, "/portal/register?err="+queryEscape("尝试次数太多，5 分钟后再试"), http.StatusSeeOther)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Redirect(w, r, "/portal/register?err="+queryEscape("请求格式不对"), http.StatusSeeOther)
		return
	}
	name := strings.TrimSpace(r.PostFormValue("username"))
	pass := r.PostFormValue("password")
	// 开放注册：不再要邀请码，但加总量上限，防止被刷出几万个空账号
	if len(s.db.ListUsers()) >= maxAccounts {
		redirectRegisterErr(w, r, "注册用户已满，请联系管理员")
		return
	}

	switch {
	case len(name) < 2 || len(name) > 32:
		redirectRegisterErr(w, r, "用户名要 2~32 个字符")
		return
	case len(pass) < 8:
		redirectRegisterErr(w, r, "密码至少 8 位")
		return
	}
	if _, exists := s.db.UserByName(name); exists {
		redirectRegisterErr(w, r, "这个用户名已经有人用了")
		return
	}
	hash, err := HashPassword(pass)
	if err != nil {
		redirectRegisterErr(w, r, "服务器内部错误")
		return
	}
	u, err := s.db.CreateUser(name, hash, "user")
	if err != nil {
		redirectRegisterErr(w, r, err.Error())
		return
	}
	s.auth.SetCookie(w, u.ID)
	http.Redirect(w, r, "/?ok="+queryEscape("注册成功，欢迎"), http.StatusSeeOther)
}

func redirectRegisterErr(w http.ResponseWriter, r *http.Request, msg string) {
	http.Redirect(w, r, "/portal/register?err="+queryEscape(msg), http.StatusSeeOther)
}

func (s *server) handleMintInvite(w http.ResponseWriter, r *http.Request) {
	u, ok := s.currentUser(r)
	if !ok || u.Role != "admin" {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	codes, err := s.db.NewInvites(1)
	if err != nil {
		http.Redirect(w, r, "/?err="+queryEscape(err.Error()), http.StatusSeeOther)
		return
	}
	http.Redirect(w, r, "/?ok="+queryEscape("新邀请码："+codes[0]), http.StatusSeeOther)
}
