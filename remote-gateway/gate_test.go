package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

func newTestServerForGate(t *testing.T) *server {
	t.Helper()
	return &server{
		db:   newTestDB(t),
		auth: NewAuthenticator("gate-test-secret"),
	}
}

func resetUsedTickets() {
	usedTickets.mu.Lock()
	usedTickets.used = map[string]int64{}
	// 置零 = 「很久没清理过」，让下一次 consume 立刻走清理分支。
	usedTickets.lastSweep = time.Time{}
	usedTickets.mu.Unlock()
}

// 同一秒内为同一设备取两次票必须不同，否则第二张会被当成「已使用」。
func TestMakeTicketHasNonce(t *testing.T) {
	s := newTestServerForGate(t)
	a := s.MakeTicket(1, "dev-a")
	b := s.MakeTicket(1, "dev-a")
	if a == b {
		t.Fatal("同一秒两张票相同：nonce 没生效")
	}
	if n := len(strings.Split(a, ".")); n != 5 {
		t.Fatalf("票据应为 5 段，实际 %d 段（%q）", n, a)
	}
}

func TestVerifyTicketRoundTrip(t *testing.T) {
	s := newTestServerForGate(t)
	tk := s.MakeTicket(7, "dev-a")
	uid, dev, exp, ok := s.verifyTicket(tk)
	if !ok {
		t.Fatal("正常票据应该验过")
	}
	if uid != 7 || dev != "dev-a" || exp <= time.Now().Unix() {
		t.Fatalf("字段不对: uid=%d dev=%q exp=%d", uid, dev, exp)
	}
}

func TestVerifyTicketRejectsTampering(t *testing.T) {
	s := newTestServerForGate(t)
	tk := s.MakeTicket(7, "dev-a")
	parts := strings.Split(tk, ".")

	cases := map[string]string{
		"改 uid":   "8." + strings.Join(parts[1:], "."),
		"改设备":     parts[0] + ".dev-b." + strings.Join(parts[2:], "."),
		"改 nonce": parts[0] + "." + parts[1] + "." + parts[2] + ".deadbeef." + parts[4],
		"改签名":     tk + "x",
		"少一段":     strings.Join(parts[:4], "."),
		"空串":      "",
		"别的密钥生成的": (&server{auth: NewAuthenticator("other")}).MakeTicket(7, "dev-a"),
	}
	for label, bad := range cases {
		if _, _, _, ok := s.verifyTicket(bad); ok {
			t.Fatalf("%s 应被拒", label)
		}
	}
}

func TestVerifyTicketExpires(t *testing.T) {
	s := newTestServerForGate(t)
	// 手工拼一张已经过期的票：nonce 随便给，但签名必须对
	exp := time.Now().Add(-time.Minute).Unix()
	nonce := "abcd1234"
	tk := formatTicket(7, "dev-a", exp, nonce, s.signTicket(7, "dev-a", exp, nonce))
	if _, _, _, ok := s.verifyTicket(tk); ok {
		t.Fatal("过期票据应被拒")
	}
}

func formatTicket(uid int64, deviceID string, exp int64, nonce, sig string) string {
	return strconv.FormatInt(uid, 10) + "." + deviceID + "." +
		strconv.FormatInt(exp, 10) + "." + nonce + "." + sig
}

// 一次性：同一张票换过 cookie 就不能再用。
func TestTicketConsumedOnce(t *testing.T) {
	resetUsedTickets()
	tk := "1.dev-a.9999999999.nonce.sig"
	exp := time.Now().Add(time.Minute).Unix()

	if !usedTickets.consume(tk, exp) {
		t.Fatal("第一次应该成功")
	}
	if usedTickets.consume(tk, exp) {
		t.Fatal("第二次应该失败")
	}
}

// 过期的已用记录要清掉，否则 map 只涨不消。
func TestTicketStorePrunesExpired(t *testing.T) {
	resetUsedTickets()
	now := time.Now().Unix()

	usedTickets.consume("old", now-10) // exp 已经过去
	usedTickets.consume("new", now+600)
	// 清理是低频的（每分钟一次）：把间隔拨回去，再写一条来触发清理分支。
	usedTickets.mu.Lock()
	usedTickets.lastSweep = time.Time{}
	usedTickets.mu.Unlock()
	usedTickets.consume("trigger", now+600)

	usedTickets.mu.Lock()
	_, hasOld := usedTickets.used["old"]
	_, hasNew := usedTickets.used["new"]
	usedTickets.mu.Unlock()

	if hasOld {
		t.Fatal("过期的已用记录应被清掉")
	}
	if !hasNew {
		t.Fatal("未过期的记录不该被清掉")
	}
}

// ---------- gwAuth（nginx auth_request 子请求） ----------

func TestGwAuthRejectsWithoutOriginalURI(t *testing.T) {
	s := newTestServerForGate(t)
	rec := httptest.NewRecorder()
	s.gwAuth(rec, httptest.NewRequest(http.MethodGet, "/portal/api/authcheck", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("取不到 X-Original-URI 时应 fail-closed，实际 %d", rec.Code)
	}
}

func TestGwAuthRejectsAnonymous(t *testing.T) {
	s := newTestServerForGate(t)
	s.db.UpsertDevice("dev-a", "A", "t")

	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/portal/api/authcheck", nil)
	r.Header.Set("X-Original-URI", "/u/dev-a/")
	s.gwAuth(rec, r)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("未登录应 401，实际 %d", rec.Code)
	}
}

func TestGwAuthRejectsOtherOwner(t *testing.T) {
	s := newTestServerForGate(t)
	s.db.UpsertDevice("dev-a", "A", "t")
	// CreateUser 的 ID 从 1 开始递增，必须用真实的 ID 而不是手写常量
	owner, _ := s.db.CreateUser("user1", "h", "user")
	s.db.ClaimDevice("dev-a", owner.ID)
	u, _ := s.db.CreateUser("user2", "h", "user")

	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/portal/api/authcheck", nil)
	r.Header.Set("X-Original-URI", "/u/dev-a/")
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: s.auth.Make(u.ID)})
	s.gwAuth(rec, r)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("不是自己的设备应 403，实际 %d", rec.Code)
	}
}

func TestGwAuthAllowsOwner(t *testing.T) {
	s := newTestServerForGate(t)
	s.db.UpsertDevice("dev-a", "A", "t")
	u, _ := s.db.CreateUser("user1", "h", "user")
	s.db.ClaimDevice("dev-a", u.ID)

	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/portal/api/authcheck", nil)
	r.Header.Set("X-Original-URI", "/u/dev-a/assets/app.js")
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: s.auth.Make(u.ID)})
	s.gwAuth(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("owner 应 200，实际 %d", rec.Code)
	}
}

// ---------- tkToCookie ----------

func TestTkToCookieSetsCookieAndRedirects(t *testing.T) {
	resetUsedTickets()
	s := newTestServerForGate(t)
	s.db.UpsertDevice("dev-a", "A", "t")
	u, _ := s.db.CreateUser("u", "h", "user")
	s.db.ClaimDevice("dev-a", u.ID)

	tk := s.MakeTicket(u.ID, "dev-a")
	q := url.Values{}
	q.Set("tk", tk)
	q.Set("next", "/u/dev-a/")
	q.Set("t", "devtoken")

	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/portal/api/tk?"+q.Encode(), nil)
	s.tkToCookie(rec, r)

	if rec.Code != http.StatusSeeOther {
		t.Fatalf("应 303，实际 %d（body=%s）", rec.Code, rec.Body.String())
	}
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 || cookies[0].Name != sessionCookie {
		t.Fatal("应设置会话 cookie")
	}
	loc := rec.Header().Get("Location")
	if !strings.HasPrefix(loc, "/u/dev-a/") || !strings.Contains(loc, "t=devtoken") {
		t.Fatalf("跳转地址不对: %q", loc)
	}

	// 同一张票再来一次必须 401
	rec2 := httptest.NewRecorder()
	r2 := httptest.NewRequest(http.MethodGet, "/portal/api/tk?"+q.Encode(), nil)
	s.tkToCookie(rec2, r2)
	if rec2.Code != http.StatusUnauthorized {
		t.Fatalf("票据应一次性，第二次 401，实际 %d", rec2.Code)
	}
}

func TestTkToCookieRejectsBadNext(t *testing.T) {
	resetUsedTickets()
	s := newTestServerForGate(t)
	s.db.UpsertDevice("dev-a", "A", "t")
	u, _ := s.db.CreateUser("u", "h", "user")
	s.db.ClaimDevice("dev-a", u.ID)

	for _, next := range []string{"/etc/passwd", "/u/../x/", "http://evil.com/"} {
		q := url.Values{}
		q.Set("tk", s.MakeTicket(u.ID, "dev-a"))
		q.Set("next", next)
		rec := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/portal/api/tk?"+q.Encode(), nil)
		s.tkToCookie(rec, r)
		if rec.Code != http.StatusBadRequest && rec.Code != http.StatusForbidden {
			t.Fatalf("next=%q 应被拒，实际 %d", next, rec.Code)
		}
	}
}

// 关键：坏请求不能把票烧掉。先校验 next / owner，最后才 consume。
func TestTkToCookieDoesNotBurnTicketOnBadNext(t *testing.T) {
	resetUsedTickets()
	s := newTestServerForGate(t)
	s.db.UpsertDevice("dev-a", "A", "t")
	u, _ := s.db.CreateUser("u", "h", "user")
	s.db.ClaimDevice("dev-a", u.ID)

	tk := s.MakeTicket(u.ID, "dev-a")

	// 1) 先打一个 next 不匹配的请求
	q1 := url.Values{}
	q1.Set("tk", tk)
	q1.Set("next", "/u/other-device/")
	rec1 := httptest.NewRecorder()
	s.tkToCookie(rec1, httptest.NewRequest(http.MethodGet, "/portal/api/tk?"+q1.Encode(), nil))
	if rec1.Code != http.StatusForbidden {
		t.Fatalf("next 不匹配应 403，实际 %d", rec1.Code)
	}

	// 2) 同一张票还得能用（说明上一步没有 consume）
	q2 := url.Values{}
	q2.Set("tk", tk)
	q2.Set("next", "/u/dev-a/")
	rec2 := httptest.NewRecorder()
	s.tkToCookie(rec2, httptest.NewRequest(http.MethodGet, "/portal/api/tk?"+q2.Encode(), nil))
	if rec2.Code != http.StatusSeeOther {
		t.Fatalf("坏请求不该烧掉票，应 303，实际 %d", rec2.Code)
	}
}

// 设备已经转给别人时，旧票不能换出 cookie。
func TestTkToCookieRejectsAfterOwnerChange(t *testing.T) {
	resetUsedTickets()
	s := newTestServerForGate(t)
	s.db.UpsertDevice("dev-a", "A", "t")
	u1, _ := s.db.CreateUser("u1", "h", "user")
	s.db.ClaimDevice("dev-a", u1.ID)

	tk := s.MakeTicket(u1.ID, "dev-a")
	// 票发出后又转移给了别人
	s.db.ClaimDevice("dev-a", 999)

	q := url.Values{}
	q.Set("tk", tk)
	q.Set("next", "/u/dev-a/")
	rec := httptest.NewRecorder()
	s.tkToCookie(rec, httptest.NewRequest(http.MethodGet, "/portal/api/tk?"+q.Encode(), nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("设备已换主应 403，实际 %d", rec.Code)
	}
}
