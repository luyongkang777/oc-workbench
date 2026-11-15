package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	sessionCookie = "oc_user"
	sessionTTL    = 7 * 24 * time.Hour // 明文链路上别给 30 天
	pbkdf2Iter    = 210000
)

// readOrCreate 读一个密钥文件，没有就生成（0600）。secret / enroll 都走这里。
func readOrCreate(dataDir, name string, nbytes int) (string, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dataDir, name)
	if raw, err := os.ReadFile(path); err == nil {
		if v := strings.TrimSpace(string(raw)); v != "" {
			return v, nil
		}
	}
	buf := make([]byte, nbytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	value := hex.EncodeToString(buf)
	if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
		return "", err
	}
	return value, nil
}

// ---------- 口令（PBKDF2-HMAC-SHA256，标准库手写，无需第三方包） ----------

func pbkdf2SHA256(password, salt []byte, iter, keyLen int) []byte {
	mac := hmac.New(sha256.New, password)
	mac.Write(salt)
	mac.Write([]byte{0, 0, 0, 1})
	u := mac.Sum(nil)
	out := make([]byte, len(u))
	copy(out, u)
	for i := 1; i < iter; i++ {
		mac.Reset()
		mac.Write(u)
		u = mac.Sum(nil)
		for j := range out {
			out[j] ^= u[j]
		}
	}
	return out[:keyLen]
}

// HashPassword 返回 "pbkdf2$迭代$盐$哈希"，参数写进字符串，以后调参不影响老密码。
func HashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	sum := pbkdf2SHA256([]byte(password), salt, pbkdf2Iter, 32)
	return fmt.Sprintf("pbkdf2$%d$%s$%s", pbkdf2Iter, hex.EncodeToString(salt), hex.EncodeToString(sum)), nil
}

func VerifyPassword(password, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter <= 0 {
		return false
	}
	salt, err1 := hex.DecodeString(parts[2])
	want, err2 := hex.DecodeString(parts[3])
	if err1 != nil || err2 != nil {
		return false
	}
	got := pbkdf2SHA256([]byte(password), salt, iter, len(want))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// ---------- 会话 cookie（自包含签名，不存会话表） ----------

type Authenticator struct {
	secret string

	// revoked 是「已退出登录」的 token 指纹。会话是自包含签名的（服务端不存会话表），
	// 不吊销的话「退出」只是删掉本地副本 —— 同一张 token 还能再用 7 天。
	// 明文 HTTP 下 token 很容易被同网段抓走，所以退出必须真的让它失效。
	mu      sync.Mutex
	revoked map[string]int64 // 指纹 -> token 自身的过期时间
}

func NewAuthenticator(secret string) *Authenticator {
	return &Authenticator{secret: secret, revoked: map[string]int64{}}
}

// tokenKey token 指纹：只存哈希，不存原值（内存 dump 也拿不到可用的票）。
func tokenKey(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:16]
}

// Revoke 让一张 token 立刻失效。exp 用于以后清理。
func (a *Authenticator) Revoke(value string) {
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now().Unix()
	for k, until := range a.revoked {
		if until < now {
			delete(a.revoked, k)
		}
	}
	a.revoked[tokenKey(value)] = exp
}

func (a *Authenticator) isRevoked(value string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	_, ok := a.revoked[tokenKey(value)]
	return ok
}

func (a *Authenticator) sign(uid, exp int64) string {
	mac := hmac.New(sha256.New, []byte(a.secret))
	fmt.Fprintf(mac, "%d.%d", uid, exp)
	return hex.EncodeToString(mac.Sum(nil))[:32]
}

func (a *Authenticator) Make(uid int64) string {
	exp := time.Now().Add(sessionTTL).Unix()
	return fmt.Sprintf("%d.%d.%s", uid, exp, a.sign(uid, exp))
}

// Read 返回用户 id；签名不对或过期返回 0。
func (a *Authenticator) Read(value string) int64 {
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return 0
	}
	uid, err1 := strconv.ParseInt(parts[0], 10, 64)
	exp, err2 := strconv.ParseInt(parts[1], 10, 64)
	if err1 != nil || err2 != nil || exp < time.Now().Unix() {
		return 0
	}
	if subtle.ConstantTimeCompare([]byte(parts[2]), []byte(a.sign(uid, exp))) != 1 {
		return 0
	}
	if a.isRevoked(value) {
		return 0
	}
	return uid
}

func (a *Authenticator) SetCookie(w http.ResponseWriter, uid int64) {
	if uid == 0 {
		http.SetCookie(w, &http.Cookie{
			Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode,
		})
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: a.Make(uid), Path: "/",
		MaxAge: int(sessionTTL.Seconds()), HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
}

// Expiry 返回 token 里的过期时间戳；格式不对返回 0。
// 续期判断要用它（剩余不足 2 天就换一张新的）。
func (a *Authenticator) Expiry(value string) int64 {
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return 0
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return 0
	}
	return exp
}

func (a *Authenticator) UserID(r *http.Request) int64 {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return 0
	}
	return a.Read(c.Value)
}

// ---------- 限流（内存即可） ----------

const limiterWindow = 5 * time.Minute

type limiter struct {
	mu        sync.Mutex
	fails     map[string][]time.Time
	max       int
	lastPrune time.Time
}

// newLimiter 的 max 是窗口内允许的次数：登录严一点（6），注册宽松但每次尝试也计数（10）。
func newLimiter(max int) *limiter {
	return &limiter{fails: map[string][]time.Time{}, max: max}
}

// reserve 原子地「检查 + 记一次」，返回 false 表示超出窗口额度。
//
// 原来是 allowed() 与 fail() 分开调用：并发请求能全部先通过检查、再各自计数，
// 6 次的限制在并发下等于没有。登录接口每次尝试都要算 PBKDF2（210000 轮），
// 放过去就是 CPU 打满，所以检查和计数必须一步完成。
func (l *limiter) reserve(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	l.pruneLocked(now)

	cutoff := now.Add(-limiterWindow)
	kept := l.fails[ip][:0]
	for _, t := range l.fails[ip] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.max {
		l.fails[ip] = kept
		return false
	}
	l.fails[ip] = append(kept, now)
	return true
}

// ok 清掉某个来源的计数（登录 / 配对成功时调用）。
func (l *limiter) ok(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.fails, ip)
}

// pruneLocked 清掉全表的过期记录。
//
// 以前只清当前 ip 的那一条，而且 allowed() 读一次就会给这个 ip 建一个空条目：
// 攻击者每换一个来源 IP（伪造 X-Real-IP / 用 IPv6 大段）就能让 map 无限增长，
// 网关内存被慢慢吃掉。每 30 秒扫一次全表，条目规模本来就只有几十个，代价可忽略。
func (l *limiter) pruneLocked(now time.Time) {
	if now.Sub(l.lastPrune) < 30*time.Second {
		return
	}
	l.lastPrune = now
	cutoff := now.Add(-limiterWindow)
	for key, times := range l.fails {
		kept := times[:0]
		for _, t := range times {
			if t.After(cutoff) {
				kept = append(kept, t)
			}
		}
		if len(kept) == 0 {
			delete(l.fails, key)
			continue
		}
		l.fails[key] = kept
	}
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return v
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}
