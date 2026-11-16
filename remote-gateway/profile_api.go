package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

// 账号级配置同步：GET/POST /portal/api/profile
//
// 用途：把「第三方 API 接入」里的 provider（含 SK、baseURL、模型与上下文）
// 以及默认模型存到账号下。换一台电脑登录同一账号，客户端拉下来直接写进本地
// opencode.json，不用再一个个填 key。
//
// 安全边界（与设备列表同级）：
//   * 必须带 Bearer token，且只能读写**自己**的那份；
//   * 网关原样存储，不解析内容；单份上限 512KB；
//   * 返回体也只在登录态下可读（不缓存：Cache-Control: no-store 由 writeJSON 负责）。

func (s *server) apiProfileGet(w http.ResponseWriter, r *http.Request) {
	uid := s.bearerID(r)
	if uid == 0 {
		writeErr(w, http.StatusUnauthorized, "未登录")
		return
	}
	raw, ok := s.db.GetProfile(uid)
	if !ok {
		// 没存过：profile 为 null，客户端据此判断「首次登录」并回传本机配置做种子
		writeJSON(w, http.StatusOK, map[string]any{"profile": nil})
		return
	}
	// **必须包一层 {profile: ...}**：客户端统一按 data.profile 取。
	// 曾经有数据时直接回裸对象、没数据时回 {profile:null}，两种形状让客户端永远读不到，
	// 表现是「每次启动都以为云端为空，然后把本机配置覆盖上去」。
	var profile any
	if err := json.Unmarshal(raw, &profile); err != nil {
		writeErr(w, http.StatusInternalServerError, "云端配置损坏")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"profile": profile})
}

func (s *server) apiProfilePut(w http.ResponseWriter, r *http.Request) {
	uid := s.bearerID(r)
	if uid == 0 {
		writeErr(w, http.StatusUnauthorized, "未登录")
		return
	}
	// 多读 1 字节用来区分「正好到上限」和「超了」
	body, err := readLimited(r, maxProfileBytes+1)
	if err != nil {
		if errors.Is(err, ErrProfileTooLarge) {
			writeErr(w, http.StatusRequestEntityTooLarge, "配置太大（上限 512KB）")
			return
		}
		writeErr(w, http.StatusBadRequest, "读取请求体失败")
		return
	}
	if len(body) > maxProfileBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "配置太大（上限 512KB）")
		return
	}
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" || !json.Valid([]byte(trimmed)) {
		writeErr(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	// 必须是对象：数组/标量存进去客户端也没法用
	var probe map[string]any
	if err := json.Unmarshal(body, &probe); err != nil {
		writeErr(w, http.StatusBadRequest, "配置必须是 JSON 对象")
		return
	}
	updated, err := s.db.PutProfile(uid, json.RawMessage(trimmed))
	if err != nil {
		if err == ErrProfileTooLarge {
			writeErr(w, http.StatusRequestEntityTooLarge, "配置太大（上限 512KB）")
			return
		}
		writeErr(w, http.StatusInternalServerError, "保存失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "updatedAt": updated})
}

// readLimited 读请求体，最多 limit 字节（读满就当作超限）。
func readLimited(r *http.Request, limit int64) ([]byte, error) {
	buf, err := io.ReadAll(io.LimitReader(r.Body, limit))
	if err != nil {
		return nil, err
	}
	if int64(len(buf)) >= limit {
		return nil, ErrProfileTooLarge
	}
	return buf, nil
}
