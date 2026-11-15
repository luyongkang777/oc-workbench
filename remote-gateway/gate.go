package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 设备入口的账号校验。
//
// 目标：/u/<设备ID>/ 不再「有 token 就能进」，必须有网关账号会话，且这台设备属于该账号。
//
// 两个凭据来源：
//  1. cookie oc_user —— 手机/浏览器从门户登录后有（Path=/，同站请求会带）
//  2. ticket（?tk=）—— 给 exe 的 iframe 用：exe 的账号是 Bearer 存在 localStorage，
//     iframe 导航带不了 header，跨源又拿不到 SameSite 的 cookie，所以由网关签一个
//     短期（10 分钟）票据放进 URL，进页面时换成 cookie。
//
// nginx 侧：设备 location 加 auth_request /_gw_auth，再对带 tk 的请求先 302 到 /portal/api/tk 换 cookie。

const ticketTTL = 10 * time.Minute

// usedTickets 记录已经换过 cookie 的票据。
//
// 之前注释写「一次性票据」但没有任何记录：同一个 URL 在 10 分钟内可以反复换取
// 7 天会话。票据会出现在 nginx access log / 浏览器历史里，所以必须真正一次性。
type ticketStore struct {
	mu   sync.Mutex
	used map[string]int64 // ticket -> 过期时间
}

var usedTickets = &ticketStore{used: map[string]int64{}}

// consume 标记票据已用；已用过返回 false。顺手清掉过期的条目。
func (t *ticketStore) consume(ticket string, exp int64) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now().Unix()
	for key, until := range t.used {
		if until < now {
			delete(t.used, key)
		}
	}
	if _, ok := t.used[ticket]; ok {
		return false
	}
	t.used[ticket] = exp
	return true
}

var devicePathRe = regexp.MustCompile(`^/u/([^/]+)`)

func (s *server) signTicket(uid int64, deviceID string, exp int64, nonce string) string {
	mac := hmac.New(sha256.New, []byte(s.auth.secret))
	fmt.Fprintf(mac, "tk.%d.%s.%d.%s", uid, deviceID, exp, nonce)
	return hex.EncodeToString(mac.Sum(nil))[:32]
}

// MakeTicket 生成给 iframe 用的短期票据：绑定「用户 + 这台设备」。
//
// 必须带随机 nonce：exp 只精确到秒，同一用户在同一秒内为同一设备取两次票时，
// 票据字符串会完全一样 —— 而票据是一次性的，第二次打开直接 401。
// nonce 必须参与签名，否则攻击者改掉 nonce 就能把已用票据当新票据重放。
func (s *server) MakeTicket(uid int64, deviceID string) string {
	exp := time.Now().Add(ticketTTL).Unix()
	buf := make([]byte, 8)
	nonce := ""
	if _, err := rand.Read(buf); err == nil {
		nonce = hex.EncodeToString(buf)
	} else {
		// crypto/rand 失败极罕见；用纳秒兜底，保证同一秒内也不会重复
		nonce = strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return fmt.Sprintf("%d.%s.%d.%s.%s", uid, deviceID, exp, nonce, s.signTicket(uid, deviceID, exp, nonce))
}

func (s *server) verifyTicket(ticket string) (int64, string, int64, bool) {
	// 格式：uid.deviceID.exp.nonce.sign（5 段）
	parts := strings.Split(ticket, ".")
	if len(parts) != 5 {
		return 0, "", 0, false
	}
	uid, err1 := strconv.ParseInt(parts[0], 10, 64)
	exp, err2 := strconv.ParseInt(parts[2], 10, 64)
	if err1 != nil || err2 != nil || exp < time.Now().Unix() {
		return 0, "", 0, false
	}
	deviceID := parts[1]
	nonce := parts[3]
	if !hmac.Equal([]byte(parts[4]), []byte(s.signTicket(uid, deviceID, exp, nonce))) {
		return 0, "", 0, false
	}
	return uid, deviceID, exp, true
}

// gwAuth 是 nginx auth_request 的子请求：2xx 放行、401 未登录、403 不属于你。
func (s *server) gwAuth(w http.ResponseWriter, r *http.Request) {
	original := r.Header.Get("X-Original-URI")
	match := devicePathRe.FindStringSubmatch(original)
	if match == nil {
		// 取不到设备路径说明 nginx 那边没把 X-Original-URI 传过来（配置被改坏/被复用到别处）。
		// 这种情况宁可拒绝：放行等于所有设备入口的账号校验静默失效，而且不会有任何报错。
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	deviceID := match[1]

	uid := s.auth.UserID(r)
	if uid == 0 {
		// exe iframe：URL 里带的一次性票据
		if tk := r.URL.Query().Get("tk"); tk != "" {
			// 这里只校验、不消费：真正的消费点在 tkToCookie（签发 cookie 的那一步）。
			if ticketUID, ticketDev, _, ok := s.verifyTicket(tk); ok && ticketDev == deviceID {
				uid = ticketUID
			}
		}
	}
	if uid == 0 {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	dev, ok := s.db.DeviceByID(deviceID)
	if !ok || dev.OwnerID != uid {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// tkToCookie 把 ?tk= 换成 oc_user cookie，再 302 回设备页面。
// 只允许跳回 /u/ 开头，避免变成开放重定向。
func (s *server) tkToCookie(w http.ResponseWriter, r *http.Request) {
	ticket := r.URL.Query().Get("tk")
	next := r.URL.Query().Get("next") // 路径，如 /u/<id>/
	devToken := r.URL.Query().Get("t")
	if !strings.HasPrefix(next, "/u/") || strings.Contains(next, "..") {
		http.Error(w, "next 不合法", http.StatusBadRequest)
		return
	}
	// 设备端拿到 ?t= 会 302 到 #<query>，back 一起进 fragment，前端从 hash 里读
	back := r.URL.Query().Get("back")
	target := next
	query := url.Values{}
	if devToken != "" {
		query.Set("t", devToken)
	}
	if back != "" {
		query.Set("back", back)
	}
	if len(query) > 0 {
		target = next + "?" + query.Encode()
	}
	uid, deviceID, exp, ok := s.verifyTicket(ticket)
	if !ok {
		http.Error(w, "票据无效或已过期，请重新登录", http.StatusUnauthorized)
		return
	}
	// 所有校验都必须在 consume 之前：票据是一次性的，如果先烧掉再发现「next 不匹配」
	// 或「设备不是你的」，攻击者只要拿别人的 tk 打一次就能把票据废掉（DoS）。
	// 票据只能换自己设备的页面
	if !strings.Contains(next, "/u/"+deviceID+"/") {
		http.Error(w, "票据与目标设备不匹配", http.StatusForbidden)
		return
	}
	dev, exists := s.db.DeviceByID(deviceID)
	if !exists || dev.OwnerID != uid {
		http.Error(w, "设备不属于该账号", http.StatusForbidden)
		return
	}
	// 一次性：换过 cookie 就作废，防止同一条 URL 在 10 分钟内反复换取新会话。
	// 放在最后是因为它会把票据从内存里删掉；前面任何一步失败都不该消耗票据。
	if !usedTickets.consume(ticket, exp) {
		http.Error(w, "票据已使用过，请重新从设备列表进入", http.StatusUnauthorized)
		return
	}
	// 同站（81.70.181.82 下所有路径）签发，Path=/ 覆盖 /u/<id>/
	s.auth.SetCookie(w, uid)
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, target, http.StatusSeeOther)
}

// deviceOpenURL 给客户端 iframe 用的地址：带设备 token + 一次性票据。
func (s *server) deviceOpenURL(uid int64, dev Device) string {
	return fmt.Sprintf("/u/%s/?t=%s&tk=%s", dev.ID, dev.Token, url.QueryEscape(s.MakeTicket(uid, dev.ID)))
}
