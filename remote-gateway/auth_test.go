package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ---------- 口令 ----------

func TestPasswordRoundTrip(t *testing.T) {
	hash, err := HashPassword("正确的密码123")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if !VerifyPassword("正确的密码123", hash) {
		t.Fatal("正确密码应该验过")
	}
	if VerifyPassword("错误的密码", hash) {
		t.Fatal("错误密码不该验过")
	}
}

// 同一密码两次哈希必须不同（盐是随机的），否则相同密码能互相冒用。
func TestPasswordSalted(t *testing.T) {
	a, _ := HashPassword("same-password")
	b, _ := HashPassword("same-password")
	if a == b {
		t.Fatal("两次哈希相同：盐没生效")
	}
	if !VerifyPassword("same-password", a) || !VerifyPassword("same-password", b) {
		t.Fatal("两个哈希都应能验过")
	}
}

func TestVerifyPasswordRejectsBadFormat(t *testing.T) {
	for _, bad := range []string{"", "plain", "pbkdf2$abc$x$y", "md5$1$aa$bb", "pbkdf2$0$aa$bb", "pbkdf2$1$zz$zz"} {
		if VerifyPassword("x", bad) {
			t.Fatalf("坏格式 %q 不该通过", bad)
		}
	}
}

// 迭代次数写在哈希串里，以后调参不影响老密码。
func TestPasswordKeepsIterationInHash(t *testing.T) {
	hash, _ := HashPassword("pw")
	if got := len(hash); got == 0 || hash[:7] != "pbkdf2$" {
		t.Fatalf("哈希前缀不对: %q", hash)
	}
}

// ---------- 会话 token ----------

func newAuth() *Authenticator { return NewAuthenticator("test-secret-for-unit-tests") }

func TestTokenRoundTrip(t *testing.T) {
	a := newAuth()
	tk := a.Make(42)
	if got := a.Read(tk); got != 42 {
		t.Fatalf("Read 应返回 42，实际 %d", got)
	}
}

func TestTokenRejectsTampering(t *testing.T) {
	a := newAuth()
	tk := a.Make(42)

	cases := map[string]string{
		"改 uid": "43" + tk[2:],
		"改 exp": tk[:3] + "9999999999" + tk[8:],
		"改签名":   tk + "x",
		"空串":    "",
		"缺字段":   "42.123",
		"多余段":   tk + ".extra",
		"别的密钥":  NewAuthenticator("another-secret").Make(42),
	}
	for label, bad := range cases {
		if got := a.Read(bad); got != 0 {
			t.Fatalf("%s 应被拒，实际返回 %d", label, got)
		}
	}
}

func TestTokenExpires(t *testing.T) {
	a := newAuth()
	// 手工构造一张已经过期的票（exp 在 1 分钟前）
	exp := time.Now().Add(-time.Minute).Unix()
	stale := a.sign(7, exp)
	tk := formatToken(7, exp, stale)
	if got := a.Read(tk); got != 0 {
		t.Fatalf("过期 token 应被拒，实际 %d", got)
	}
}

func formatToken(uid, exp int64, sig string) string {
	return strconv.FormatInt(uid, 10) + "." + strconv.FormatInt(exp, 10) + "." + sig
}

func TestTokenExpiryReader(t *testing.T) {
	a := newAuth()
	tk := a.Make(1)
	exp := a.Expiry(tk)
	if exp <= time.Now().Unix() {
		t.Fatalf("Expiry 应返回未来时间，实际 %d", exp)
	}
	if a.Expiry("bad") != 0 {
		t.Fatal("坏格式的 Expiry 应返回 0")
	}
}

// 退出登录必须真的让 token 失效（自包含签名的会话只能靠吊销表）。
func TestRevokeMakesTokenDead(t *testing.T) {
	a := newAuth()
	tk := a.Make(42)
	if a.Read(tk) != 42 {
		t.Fatal("吊销前应该有效")
	}
	a.Revoke(tk)
	if got := a.Read(tk); got != 0 {
		t.Fatalf("吊销后应返回 0，实际 %d", got)
	}
	// 别的 token 不受影响
	other := a.Make(43)
	if a.Read(other) != 43 {
		t.Fatal("吊销一张不该影响另一张")
	}
}

func TestRevokeIgnoresBadInput(t *testing.T) {
	a := newAuth()
	a.Revoke("")
	a.Revoke("not-a-token")
	a.Revoke("1.2")
	// 不应 panic；合法 token 仍然可用
	if a.Read(a.Make(1)) != 1 {
		t.Fatal("坏输入不该影响正常 token")
	}
}

// ---------- cookie ----------

func TestSetCookieRoundTrip(t *testing.T) {
	a := newAuth()
	rec := httptest.NewRecorder()
	a.SetCookie(rec, 5)

	cookies := rec.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("应设置 1 个 cookie，实际 %d", len(cookies))
	}
	c := cookies[0]
	if c.Name != sessionCookie {
		t.Fatalf("cookie 名应为 %q，实际 %q", sessionCookie, c.Name)
	}
	if !c.HttpOnly {
		t.Fatal("会话 cookie 必须 HttpOnly")
	}
	if c.SameSite != http.SameSiteLaxMode {
		t.Fatal("SameSite 应为 Lax")
	}
	if got := a.Read(c.Value); got != 5 {
		t.Fatalf("cookie 值读回应为 5，实际 %d", got)
	}
}

func TestSetCookieZeroClears(t *testing.T) {
	a := newAuth()
	rec := httptest.NewRecorder()
	a.SetCookie(rec, 0)
	c := rec.Result().Cookies()[0]
	if c.MaxAge >= 0 {
		t.Fatalf("退出登录应设 MaxAge<0，实际 %d", c.MaxAge)
	}
}

func TestUserIDFromRequest(t *testing.T) {
	a := newAuth()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if a.UserID(r) != 0 {
		t.Fatal("没 cookie 应返回 0")
	}
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: a.Make(9)})
	if got := a.UserID(r); got != 9 {
		t.Fatalf("应返回 9，实际 %d", got)
	}
}

// ---------- 限流 ----------

func TestLimiterBlocksAfterMax(t *testing.T) {
	l := newLimiter(3)
	for i := 0; i < 3; i++ {
		if !l.reserve("ip") {
			t.Fatalf("第 %d 次应该放行", i+1)
		}
	}
	if l.reserve("ip") {
		t.Fatal("超过上限应该拒绝")
	}
	// 不同来源互不影响
	if !l.reserve("other-ip") {
		t.Fatal("别的来源不该被连带拒绝")
	}
}

func TestLimiterOkResets(t *testing.T) {
	l := newLimiter(1)
	if !l.reserve("ip") {
		t.Fatal("第一次应放行")
	}
	if l.reserve("ip") {
		t.Fatal("第二次应拒绝")
	}
	l.ok("ip")
	if !l.reserve("ip") {
		t.Fatal("ok 之后应该恢复")
	}
}

// 窗口外的旧记录要被清掉，否则一次失败就永久锁死。
func TestLimiterPrunesOldEntries(t *testing.T) {
	l := newLimiter(1)

	l.mu.Lock()
	l.fails["ip"] = []time.Time{time.Now().Add(-time.Hour)} // 1 小时前，早出窗口
	l.lastPrune = time.Time{}                               // 强制下次扫描
	l.mu.Unlock()

	if !l.reserve("ip") {
		t.Fatal("窗口外的记录应被清掉，这次应该放行")
	}
}

// pruneLocked 必须清掉**其它** IP 的过期条目，否则 map 无限增长。
func TestLimiterPruneClearsOtherKeys(t *testing.T) {
	l := newLimiter(5)
	l.mu.Lock()
	for i := 0; i < 50; i++ {
		l.fails["spam-"+strconv.Itoa(i)] = []time.Time{time.Now().Add(-time.Hour)}
	}
	l.lastPrune = time.Time{}
	l.mu.Unlock()

	l.reserve("fresh")

	l.mu.Lock()
	left := len(l.fails)
	l.mu.Unlock()

	// 只剩刚写进去的那一个（可能还有 fresh 自己）
	if left > 2 {
		t.Fatalf("过期条目没清干净，还剩 %d 条", left)
	}
}

// 并发请求必须只放行 max 个：allowed()+fail() 两步会被并发绕过。
func TestLimiterConcurrentRespectsMax(t *testing.T) {
	const max = 5
	const workers = 40
	l := newLimiter(max)

	var okCount int32
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if l.reserve("same-ip") {
				atomic.AddInt32(&okCount, 1)
			}
		}()
	}
	wg.Wait()

	if got := int(okCount); got != max {
		t.Fatalf("并发下应恰好放行 %d 次，实际 %d", max, got)
	}
}
