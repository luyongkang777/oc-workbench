package main

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// 客户端（oc-workbench exe / 浏览器里的账号面板）用的 JSON API。
//
// 为什么不复用 cookie：exe 的页面在 127.0.0.1，网关在 81.70.181.82，属于跨源，
// cookie 带不过去（SameSite）。所以这里用 Bearer token，并放开 CORS ——
// token 只是网关会话的签名值，拿到它也只能看到「这个账号自己的设备」。

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// cors 允许客户端跨源调用（只放行 GET/POST/OPTIONS + Authorization）。
func cors(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

// bearerToken 从 Authorization: Bearer <token> 里取原始 token。
func (s *server) bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
}

// bearerID 从 Authorization: Bearer <token> 里解析用户 id。
func (s *server) bearerID(r *http.Request) int64 {
	return s.auth.Read(s.bearerToken(r))
}

type apiLoginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type apiLoginResp struct {
	Token    string `json:"token"`
	Username string `json:"username"`
	Expires  int64  `json:"expires"`
}

func (s *server) apiLogin(w http.ResponseWriter, r *http.Request) {
	ip := "login:" + clientIP(r)
	// reserve 里已经记过这一次，下面验证失败不需要再 fail()
	if !s.limiter.reserve(ip) {
		writeErr(w, http.StatusTooManyRequests, "尝试次数太多，5 分钟后再试")
		return
	}
	var req apiLoginReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	u, ok := s.db.UserByName(strings.TrimSpace(req.Username))
	if !ok || !VerifyPassword(req.Password, u.PW) {
		writeErr(w, http.StatusUnauthorized, "用户名或密码不对")
		return
	}
	s.limiter.ok(ip)
	writeJSON(w, http.StatusOK, apiLoginResp{
		Token:    s.auth.Make(u.ID),
		Username: u.Username,
		Expires:  time.Now().Add(sessionTTL).Unix(),
	})
}

type apiDevice struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Port   int    `json:"port"`
	Online bool   `json:"online"`
	// Busy = 这台电脑上有工作台会话正在生成。手机顶部的设备条据此显示黄灯/绿灯。
	Busy     bool  `json:"busy"`
	LastSeen int64 `json:"lastSeen"`
	// URL 带 ?t=<token>：客户端直接 iframe/新窗口打开，由设备自己签发 cookie。
	URL string `json:"url"`
}

func (s *server) apiDevices(w http.ResponseWriter, r *http.Request) {
	uid := s.bearerID(r)
	if uid == 0 {
		writeErr(w, http.StatusUnauthorized, "未登录或登录已过期")
		return
	}
	u, ok := s.db.UserByID(uid)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "账号不存在")
		return
	}
	devices := s.db.DevicesOf(u.ID)
	online := probeAll(devices)
	out := make([]apiDevice, 0, len(devices))
	for _, dev := range devices {
		state := online[dev.ID]
		out = append(out, apiDevice{
			ID:       dev.ID,
			Name:     dev.Name,
			Port:     dev.Port,
			Online:   state.Online,
			Busy:     state.Busy,
			LastSeen: dev.LastSeen,
			URL:      s.deviceOpenURL(u.ID, dev),
		})
	}
	resp := map[string]any{
		"username": u.Username,
		"devices":  out,
	}
	// 滑动续期：剩余有效期不足 2 天就顺带给一张新的，客户端换掉本地存的。
	// 这样只要每两天内用过一次，就永远不会被迫重新输密码。
	if token := s.bearerToken(r); token != "" {
		if exp := s.auth.Expiry(token); exp > 0 && exp-time.Now().Unix() < 2*24*3600 {
			resp["token"] = s.auth.Make(u.ID)
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

type claimReq struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Token string `json:"token"`
}

// apiClaim 让「exe 登录账号」这一步顺手把这台电脑认领到当前账号下。
//
// 以前要靠 pair.ps1 生成 8 位配对码再在门户里输入；但 exe 本身就是一台电脑，
// 它自己带着 remoteToken（所有权证明），登录后直接认领才符合直觉。
func (s *server) apiClaim(w http.ResponseWriter, r *http.Request) {
	uid := s.bearerID(r)
	if uid == 0 {
		writeErr(w, http.StatusUnauthorized, "未登录或登录已过期")
		return
	}
	u, ok := s.db.UserByID(uid)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "账号不存在")
		return
	}
	var req claimReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	id := strings.TrimSpace(req.ID)
	token := strings.TrimSpace(req.Token)
	if id == "" || token == "" {
		writeErr(w, http.StatusBadRequest, "缺少设备 id / token")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = id
	}

	// 已经是自己的设备：幂等返回，不占限流额度（打开账号面板每次都会 claim 一次）。
	if existing, ok := s.db.DeviceByID(id); ok && existing.OwnerID == uid &&
		subtle.ConstantTimeCompare([]byte(existing.Token), []byte(token)) == 1 {
		writeJSON(w, http.StatusOK, map[string]any{
			"id":    existing.ID,
			"name":  existing.Name,
			"port":  existing.Port,
			"owner": u.Username,
		})
		return
	}
	// 认领会分配回环端口（池里只有 40 个）并触发一次 nginx reload，必须限流。
	if !s.claimLimit.reserve("claim:" + clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "认领太频繁，5 分钟后再试")
		return
	}

	// 设备已存在时，请求里的 token 必须和库里一致：token 就是所有权证明，
	// 否则任意登录用户只要知道 id 就能把别人的设备抢到自己名下（双向 DoS）。
	// 新设备（首次登记）还没有记录，允许任意 token 建立归属。
	if existing, ok := s.db.DeviceByID(id); ok &&
		subtle.ConstantTimeCompare([]byte(existing.Token), []byte(token)) != 1 {
		writeErr(w, http.StatusForbidden, "设备令牌不匹配，不能认领这台电脑")
		return
	}

	dev, _, err := s.db.UpsertDevice(id, name, token)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	// 谁登录就归谁：认领要求请求体里带本机的 remoteToken（只有这台机器的 settings.json 有），
	// 等于所有权证明，所以直接转移 owner，不做「固定绑定」。
	// 之前这里是「已被别人绑定就 409」，结果是换账号登录就永远看不到自己的电脑。
	s.db.ClaimDevice(id, uid)
	dev.OwnerID = uid
	if ok, msg := s.nginx.Apply(s.db.AllDevices()); !ok {
		writeErr(w, http.StatusInternalServerError, "nginx 配置更新失败: "+msg)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":    dev.ID,
		"name":  dev.Name,
		"port":  dev.Port,
		"owner": u.Username,
	})
}

// apiLogout 让客户端「退出登录」真的把 token 作废，而不是只删本地副本。
func (s *server) apiLogout(w http.ResponseWriter, r *http.Request) {
	if tk := s.bearerToken(r); tk != "" {
		s.auth.Revoke(tk)
	}
	// 顺手把门户的 cookie 也清掉（同一个浏览器里可能还挂着网页会话）
	s.auth.SetCookie(w, 0)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// apiWhoami 让客户端校验 token 还有没有效（可选调用）。
func (s *server) apiWhoami(w http.ResponseWriter, r *http.Request) {
	uid := s.bearerID(r)
	if uid == 0 {
		writeErr(w, http.StatusUnauthorized, "未登录")
		return
	}
	u, ok := s.db.UserByID(uid)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "账号不存在")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"username": u.Username, "role": u.Role})
}
