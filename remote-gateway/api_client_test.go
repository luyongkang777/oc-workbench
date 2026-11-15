package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeReloader 顶替 NginxDevices：单测不应该去执行 nginx -t。
type fakeReloader struct {
	calls int
	fail  bool
}

func (f *fakeReloader) Apply(devices []Device) (bool, string) {
	f.calls++
	if f.fail {
		return false, "fake: nginx -t 失败"
	}
	return true, "fake: reloaded"
}

func newAPIServer(t *testing.T) (*server, *fakeReloader) {
	t.Helper()
	fr := &fakeReloader{}
	return &server{
		db:       newTestDB(t),
		auth:     NewAuthenticator("api-test-secret"),
		limiter:  newLimiter(6),
		regLimit: newLimiter(10),
		nginx:    fr,
		enroll:   "test-enroll",
	}, fr
}

// callAPI 发一个请求；body 为空串表示不带请求体。
func callAPI(t *testing.T, fn http.HandlerFunc, method, path, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	fn(rec, r)
	return rec
}

func decodeMap(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("响应不是 JSON: %v（body=%s）", err, rec.Body.String())
	}
	return out
}

// mustCreateUser 建一个带真实口令哈希的用户。
func mustCreateUser(t *testing.T, db *DB, name, password, role string) User {
	t.Helper()
	hash, err := HashPassword(password)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	u, err := db.CreateUser(name, hash, role)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	return u
}

// shortLivedToken 手工签一张指定剩余时长的 token（用来测滑动续期）。
func shortLivedToken(a *Authenticator, uid int64, ttl time.Duration) string {
	exp := time.Now().Add(ttl).Unix()
	return formatToken(uid, exp, a.sign(uid, exp))
}

// ---------- 登录 ----------

func TestAPILoginOK(t *testing.T) {
	s, _ := newAPIServer(t)
	mustCreateUser(t, s.db, "alice", "password123", "user")

	rec := callAPI(t, s.apiLogin, http.MethodPost, "/portal/api/login",
		`{"username":"alice","password":"password123"}`, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，实际 %d（%s）", rec.Code, rec.Body.String())
	}
	out := decodeMap(t, rec)
	if out["token"] == "" || out["token"] == nil {
		t.Fatal("没有返回 token")
	}
	if out["username"] != "alice" {
		t.Fatalf("username 应回 alice，实际 %v", out["username"])
	}
	if exp, ok := out["expires"].(float64); !ok || int64(exp) <= time.Now().Unix() {
		t.Fatalf("expires 应是未来时间，实际 %v", out["expires"])
	}
}

func TestAPILoginWrongPassword(t *testing.T) {
	s, _ := newAPIServer(t)
	mustCreateUser(t, s.db, "alice", "password123", "user")

	rec := callAPI(t, s.apiLogin, http.MethodPost, "/portal/api/login",
		`{"username":"alice","password":"wrong"}`, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("错密码应 401，实际 %d", rec.Code)
	}
}

func TestAPILoginUnknownUser(t *testing.T) {
	s, _ := newAPIServer(t)
	rec := callAPI(t, s.apiLogin, http.MethodPost, "/portal/api/login",
		`{"username":"nobody","password":"whatever1"}`, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("不存在的用户应 401，实际 %d", rec.Code)
	}
}

func TestAPILoginBadJSON(t *testing.T) {
	s, _ := newAPIServer(t)
	rec := callAPI(t, s.apiLogin, http.MethodPost, "/portal/api/login", `{oops`, "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("坏 JSON 应 400，实际 %d", rec.Code)
	}
}

// 限流必须对「每次都计数」生效：前 6 次走到验密码，第 7 次直接 429。
func TestAPILoginRateLimited(t *testing.T) {
	s, _ := newAPIServer(t)
	mustCreateUser(t, s.db, "alice", "password123", "user")

	for i := 0; i < 6; i++ {
		rec := callAPI(t, s.apiLogin, http.MethodPost, "/portal/api/login",
			`{"username":"alice","password":"wrong"}`, "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("第 %d 次应 401，实际 %d", i+1, rec.Code)
		}
	}
	rec := callAPI(t, s.apiLogin, http.MethodPost, "/portal/api/login",
		`{"username":"alice","password":"wrong"}`, "")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("第 7 次应 429，实际 %d", rec.Code)
	}
}

// ---------- 设备列表 ----------

func TestAPIDevicesRequiresToken(t *testing.T) {
	s, _ := newAPIServer(t)
	rec := callAPI(t, s.apiDevices, http.MethodGet, "/portal/api/devices", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无 token 应 401，实际 %d", rec.Code)
	}
	rec = callAPI(t, s.apiDevices, http.MethodGet, "/portal/api/devices", "", "bad.token.here")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("坏 token 应 401，实际 %d", rec.Code)
	}
}

func TestAPIDevicesFiltersByOwner(t *testing.T) {
	s, _ := newAPIServer(t)
	alice := mustCreateUser(t, s.db, "alice", "password123", "user")
	bob := mustCreateUser(t, s.db, "bob", "password123", "user")

	s.db.UpsertDevice("dev-a", "A", "ta")
	s.db.UpsertDevice("dev-b", "B", "tb")
	s.db.ClaimDevice("dev-a", alice.ID)
	s.db.ClaimDevice("dev-b", bob.ID)

	rec := callAPI(t, s.apiDevices, http.MethodGet, "/portal/api/devices", "", s.auth.Make(alice.ID))
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", rec.Code)
	}
	out := decodeMap(t, rec)
	devices := out["devices"].([]any)
	if len(devices) != 1 {
		t.Fatalf("alice 应只看到 1 台，实际 %d", len(devices))
	}
	first := devices[0].(map[string]any)
	if first["id"] != "dev-a" {
		t.Fatalf("应看到 dev-a，实际 %v", first["id"])
	}
	// URL 里必须带设备 token 和一次性票据
	u := first["url"].(string)
	if !strings.Contains(u, "t=ta") || !strings.Contains(u, "tk=") {
		t.Fatalf("url 缺 t 或 tk: %q", u)
	}
}

// 剩余不足 2 天时顺带下发新 token（滑动续期）。
func TestAPIDevicesSlidingRenewal(t *testing.T) {
	s, _ := newAPIServer(t)
	alice := mustCreateUser(t, s.db, "alice", "password123", "user")

	nearExpiry := shortLivedToken(s.auth, alice.ID, time.Hour)
	rec := callAPI(t, s.apiDevices, http.MethodGet, "/portal/api/devices", "", nearExpiry)
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", rec.Code)
	}
	out := decodeMap(t, rec)
	if out["token"] == nil || out["token"] == "" {
		t.Fatal("剩余不足 2 天时应下发新 token")
	}
	if out["token"] == nearExpiry {
		t.Fatal("下发的新 token 不该和旧的相同")
	}
}

// 有效期还长的时候不要每次都换 token（否则客户端每轮都要写盘）。
func TestAPIDevicesNoRenewalWhenFresh(t *testing.T) {
	s, _ := newAPIServer(t)
	alice := mustCreateUser(t, s.db, "alice", "password123", "user")

	rec := callAPI(t, s.apiDevices, http.MethodGet, "/portal/api/devices", "", s.auth.Make(alice.ID))
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", rec.Code)
	}
	if out := decodeMap(t, rec); out["token"] != nil {
		t.Fatalf("7 天有效期不该续期，实际带回了 %v", out["token"])
	}
}

// ---------- 认领 ----------

func TestAPIClaimCreatesDevice(t *testing.T) {
	s, fr := newAPIServer(t)
	alice := mustCreateUser(t, s.db, "alice", "password123", "user")
	token := s.auth.Make(alice.ID)

	rec := callAPI(t, s.apiClaim, http.MethodPost, "/portal/api/claim",
		`{"id":"dev-a","name":"我的电脑","token":"devtok"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，实际 %d（%s）", rec.Code, rec.Body.String())
	}
	if fr.calls == 0 {
		t.Fatal("认领后应触发 nginx 片段重写")
	}
	dev, ok := s.db.DeviceByID("dev-a")
	if !ok || dev.OwnerID != alice.ID {
		t.Fatalf("设备归属不对: %+v", dev)
	}
}

// 谁登录归谁：同一个 token 换个账号登录，归属直接转移（不是 409）。
func TestAPIClaimTransfersOwnership(t *testing.T) {
	s, _ := newAPIServer(t)
	alice := mustCreateUser(t, s.db, "alice", "password123", "user")
	bob := mustCreateUser(t, s.db, "bob", "password123", "user")

	s.db.UpsertDevice("dev-a", "A", "devtok")
	s.db.ClaimDevice("dev-a", alice.ID)

	rec := callAPI(t, s.apiClaim, http.MethodPost, "/portal/api/claim",
		`{"id":"dev-a","name":"A","token":"devtok"}`, s.auth.Make(bob.ID))
	if rec.Code != http.StatusOK {
		t.Fatalf("换账号认领应 200，实际 %d（%s）", rec.Code, rec.Body.String())
	}
	dev, _ := s.db.DeviceByID("dev-a")
	if dev.OwnerID != bob.ID {
		t.Fatalf("归属应转移给 bob(%d)，实际 %d", bob.ID, dev.OwnerID)
	}
}

// token 就是所有权证明：对不上不能抢。
func TestAPIClaimRejectsWrongToken(t *testing.T) {
	s, _ := newAPIServer(t)
	alice := mustCreateUser(t, s.db, "alice", "password123", "user")
	s.db.UpsertDevice("dev-a", "A", "real-token")
	s.db.ClaimDevice("dev-a", alice.ID)

	rec := callAPI(t, s.apiClaim, http.MethodPost, "/portal/api/claim",
		`{"id":"dev-a","name":"A","token":"attacker-token"}`, s.auth.Make(alice.ID))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("错 token 应 403，实际 %d", rec.Code)
	}
}

func TestAPIClaimRejectsBadID(t *testing.T) {
	s, _ := newAPIServer(t)
	alice := mustCreateUser(t, s.db, "alice", "password123", "user")
	token := s.auth.Make(alice.ID)

	for _, bad := range []string{"bad id", "a/b", "a;b", ""} {
		rec := callAPI(t, s.apiClaim, http.MethodPost, "/portal/api/claim",
			`{"id":"`+bad+`","name":"x","token":"t"}`, token)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("坏 ID %q 应 400，实际 %d", bad, rec.Code)
		}
	}
}

func TestAPIClaimRejectsMissingFields(t *testing.T) {
	s, _ := newAPIServer(t)
	alice := mustCreateUser(t, s.db, "alice", "password123", "user")
	token := s.auth.Make(alice.ID)

	for _, body := range []string{`{}`, `{"id":"dev-a"}`, `{"token":"t"}`} {
		rec := callAPI(t, s.apiClaim, http.MethodPost, "/portal/api/claim", body, token)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("缺字段 %s 应 400，实际 %d", body, rec.Code)
		}
	}
}

func TestAPIClaimRequiresLogin(t *testing.T) {
	s, _ := newAPIServer(t)
	rec := callAPI(t, s.apiClaim, http.MethodPost, "/portal/api/claim",
		`{"id":"dev-a","name":"x","token":"t"}`, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("未登录应 401，实际 %d", rec.Code)
	}
}

// nginx 写失败要显式 500，不能假装成功让用户以为认领到了。
func TestAPIClaimReportsNginxFailure(t *testing.T) {
	s, fr := newAPIServer(t)
	alice := mustCreateUser(t, s.db, "alice", "password123", "user")
	fr.fail = true

	rec := callAPI(t, s.apiClaim, http.MethodPost, "/portal/api/claim",
		`{"id":"dev-a","name":"x","token":"t"}`, s.auth.Make(alice.ID))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("nginx 失败应 500，实际 %d", rec.Code)
	}
}

// ---------- whoami / logout ----------

func TestAPIWhoami(t *testing.T) {
	s, _ := newAPIServer(t)
	alice := mustCreateUser(t, s.db, "alice", "password123", "admin")

	if rec := callAPI(t, s.apiWhoami, http.MethodGet, "/portal/api/whoami", "", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("未登录应 401，实际 %d", rec.Code)
	}

	rec := callAPI(t, s.apiWhoami, http.MethodGet, "/portal/api/whoami", "", s.auth.Make(alice.ID))
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", rec.Code)
	}
	out := decodeMap(t, rec)
	if out["username"] != "alice" || out["role"] != "admin" {
		t.Fatalf("whoami 返回不对: %v", out)
	}
}

// 退出登录后同一张 token 立刻不可用（不是只删本地副本）。
func TestAPILogoutRevokesToken(t *testing.T) {
	s, _ := newAPIServer(t)
	alice := mustCreateUser(t, s.db, "alice", "password123", "user")
	token := s.auth.Make(alice.ID)

	if rec := callAPI(t, s.apiDevices, http.MethodGet, "/portal/api/devices", "", token); rec.Code != http.StatusOK {
		t.Fatalf("登出前应 200，实际 %d", rec.Code)
	}
	if rec := callAPI(t, s.apiLogout, http.MethodPost, "/portal/api/logout", "", token); rec.Code != http.StatusOK {
		t.Fatalf("logout 应 200，实际 %d", rec.Code)
	}
	if rec := callAPI(t, s.apiDevices, http.MethodGet, "/portal/api/devices", "", token); rec.Code != http.StatusUnauthorized {
		t.Fatalf("登出后应 401，实际 %d", rec.Code)
	}
}

// 一张 token 被吊销不该影响另一张（比如手机和电脑同时登录）。
func TestAPILogoutOnlyRevokesThatToken(t *testing.T) {
	s, _ := newAPIServer(t)
	alice := mustCreateUser(t, s.db, "alice", "password123", "user")
	// 两张票必须用不同的 exp：会话 token 是「uid.exp.hmac(uid.exp)」，
	// 同一秒里给同一用户签两次会得到完全相同的字符串（没有 nonce）。
	// 想模拟「手机 + 电脑两个会话」就得让过期时间不同。
	phone := shortLivedToken(s.auth, alice.ID, 7*24*time.Hour)
	desktop := shortLivedToken(s.auth, alice.ID, 6*24*time.Hour)
	if phone == desktop {
		t.Fatal("测试前提不成立：两张票不应相同")
	}

	callAPI(t, s.apiLogout, http.MethodPost, "/portal/api/logout", "", phone)
	if rec := callAPI(t, s.apiDevices, http.MethodGet, "/portal/api/devices", "", phone); rec.Code != http.StatusUnauthorized {
		t.Fatalf("被吊销的应 401，实际 %d", rec.Code)
	}
	if rec := callAPI(t, s.apiDevices, http.MethodGet, "/portal/api/devices", "", desktop); rec.Code != http.StatusOK {
		t.Fatalf("另一张 token 不该受影响，实际 %d", rec.Code)
	}
}

// ---------- CORS / Bearer 解析 ----------

func TestCORSPreflight(t *testing.T) {
	s, _ := newAPIServer(t)
	h := cors(s.apiLogin)

	rec := callAPI(t, h, http.MethodOptions, "/portal/api/login", "", "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("预检应 204，实际 %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("Allow-Origin 不对: %q", got)
	}
	if !strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Fatal("必须允许 Authorization 头，否则 exe 的 Bearer 过不了预检")
	}
}

func TestCORSHeadersOnNormalResponse(t *testing.T) {
	s, _ := newAPIServer(t)
	h := cors(s.apiWhoami)
	rec := callAPI(t, h, http.MethodGet, "/portal/api/whoami", "", "")
	if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatal("普通响应也要带 CORS 头")
	}
}

func TestBearerTokenParsing(t *testing.T) {
	s, _ := newAPIServer(t)
	alice := mustCreateUser(t, s.db, "alice", "password123", "user")
	token := s.auth.Make(alice.ID)

	cases := []struct {
		header string
		want   string
	}{
		{"Bearer " + token, token},
		{"bearer " + token, ""}, // 只认大写 Bearer
		{token, ""},             // 没有前缀
		{"", ""},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		if c.header != "" {
			r.Header.Set("Authorization", c.header)
		}
		if got := s.bearerToken(r); got != c.want {
			t.Fatalf("header=%q 应解析出 %q，实际 %q", c.header, c.want, got)
		}
	}

	if got := s.bearerID(httptest.NewRequest(http.MethodGet, "/", nil)); got != 0 {
		t.Fatalf("没有头应返回 0，实际 %d", got)
	}
}
