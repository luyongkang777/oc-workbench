package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"log"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ---------- 设备注册（电脑端 pair.ps1 调用） ----------

type registerReq struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Token string `json:"token"`
}

type registerResp struct {
	ID    string `json:"id"`
	Port  int    `json:"port"`
	Code  string `json:"code,omitempty"`
	Bound bool   `json:"bound"`
}

func (s *server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Enroll")), []byte(s.enroll)) != 1 {
		http.Error(w, "enroll secret 不对", http.StatusForbidden)
		return
	}
	// enroll 泄露后不能让人无限刷设备登记（会重写 token / 写 nginx）
	devIP := "device:" + clientIP(r)
	if !s.regLimit.reserve(devIP) {
		http.Error(w, "登记太频繁，5 分钟后再试", http.StatusTooManyRequests)
		return
	}
	var req registerReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		http.Error(w, "请求体不是合法 JSON", http.StatusBadRequest)
		return
	}
	req.ID = strings.TrimSpace(req.ID)
	if req.ID == "" || req.Token == "" {
		http.Error(w, "缺少 id 或 token", http.StatusBadRequest)
		return
	}
	if !ValidDeviceID(req.ID) {
		http.Error(w, "设备 ID 只能包含字母、数字、下划线和短横线（1~64 位）", http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = req.ID
	}

	// 已有设备必须 token 一致：enroll 是很多台机器共享的密钥，一旦泄露，
	// 任何人拿它调一次 register 就能把别人的设备 token 改成自己的 ——
	// 随后 claim / 打开设备全部落到他手里。这里和 apiClaim 保持同一套判据。
	if existing, exists := s.db.DeviceByID(req.ID); exists && existing.Token != req.Token {
		http.Error(w, "设备已登记且令牌不匹配，如需更换请先在门户解绑", http.StatusForbidden)
		return
	}

	dev, _, err := s.db.UpsertDevice(req.ID, name, req.Token)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if ok, msg := s.nginx.Apply(s.db.AllDevices()); !ok {
		log.Printf("nginx 更新失败: %s", msg)
		http.Error(w, "nginx 配置更新失败: "+msg, http.StatusInternalServerError)
		return
	}

	resp := registerResp{ID: dev.ID, Port: dev.Port, Bound: dev.OwnerID != 0}
	if dev.OwnerID == 0 {
		code := randomCode()
		if err := s.db.PutPair(code, dev.ID, 5*time.Minute); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		resp.Code = code
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(resp)
}

// randomCode 生成 8 位配对码。
//
// 用 crypto/rand 而不是 math/rand：后者以 UnixNano 播种，拿到时间就能反推序列；
// 位数从 6 提到 8 也是为了在限流之外多一层空间。
func randomCode() string {
	const digits = "0123456789"
	out := make([]byte, 8)
	for i := range out {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(digits))))
		if err != nil {
			// crypto/rand 失败极罕见；退回时间戳，保证功能不中断（有 5 分钟 TTL 兜底）
			return strconv.FormatInt(time.Now().UnixNano()%100000000, 10)
		}
		out[i] = digits[n.Int64()]
	}
	return string(out)
}
