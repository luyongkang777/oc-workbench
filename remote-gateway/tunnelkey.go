package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// 隧道账号：专门的受限用户，只能做 ssh 端口转发。
//
// 为什么不让客户端直接写 root 的 authorized_keys：那等于把服务器 shell 交给
// 任何一个注册用户。用独立账号 + 每把 key 前缀 `restrict,port-forwarding`，
// 即使 key 泄露也只能 `-R` 转发，不能执行命令、不能开 pty、不能代理转发。
var (
	tunnelUser       = "ocw-tunnel"
	tunnelKeysPath   = "/home/ocw-tunnel/.ssh/authorized_keys"
	tunnelKeyPrefix  = "restrict,port-forwarding "
	tunnelKeyMaxLine = 500
)

// 只接受这几种公钥；base64 部分限定字符集，避免把换行/注释注入到 authorized_keys。
var tunnelKeyRe = regexp.MustCompile(`^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) ([A-Za-z0-9+/]{32,1000}) ?([A-Za-z0-9._-]{0,40})?$`)

var tunnelKeyMu sync.Mutex

type tunnelKeyReq struct {
	Key string `json:"key"`
}

// apiTunnelKey 让登录后的客户端上传自己的 ssh 公钥，网关负责装到受限账号。
//
// 这样用户在新电脑上只需要「打开工作台 + 登录账号」，隧道就能自己建起来，
// 不用手写 ~/.ssh/config、也不用把私钥拷来拷去。
func (s *server) apiTunnelKey(w http.ResponseWriter, r *http.Request) {
	if s.bearerID(r) == 0 {
		writeErr(w, http.StatusUnauthorized, "未登录或登录已过期")
		return
	}
	ip := "tunnelkey:" + clientIP(r)
	if !s.limiter.reserve(ip) {
		writeErr(w, http.StatusTooManyRequests, "操作太频繁，稍后再试")
		return
	}
	var req tunnelKeyReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	line, err := normalizeTunnelKey(req.Key)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.limiter.ok(ip)

	tunnelKeyMu.Lock()
	defer tunnelKeyMu.Unlock()

	if err := appendTunnelKey(line); err != nil {
		if err == errTooManyKeys {
			writeErr(w, http.StatusConflict, "服务器上的隧道公钥数量已达上限，请联系管理员清理")
			return
		}
		writeErr(w, http.StatusInternalServerError, "写入公钥失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "user": tunnelUser})
}

var errTooManyKeys = fmt.Errorf("too many keys")

// normalizeTunnelKey 校验并规整成一行 `类型 base64 注释`。
func normalizeTunnelKey(raw string) (string, error) {
	text := strings.TrimSpace(raw)
	// 客户端有时会把整个 .pub 文件内容带过来（最后以换行结束），只取第一行。
	if idx := strings.IndexAny(text, "\r\n"); idx >= 0 {
		text = strings.TrimSpace(text[:idx])
	}
	if len(text) > 512 {
		return "", fmt.Errorf("公钥太长")
	}
	m := tunnelKeyRe.FindStringSubmatch(text)
	if m == nil {
		return "", fmt.Errorf("公钥格式不对（只支持 ssh-ed25519 / ssh-rsa / ecdsa）")
	}
	comment := m[3]
	if comment == "" {
		comment = "ocw"
	}
	return m[1] + " " + m[2] + " " + comment, nil
}

// appendTunnelKey 幂等追加：同一把 key（按 base64 部分比）不会重复写。
func appendTunnelKey(plain string) error {
	existing, err := os.ReadFile(tunnelKeysPath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	keyBody := keyBodyOf(plain)
	lines := []string{}
	if len(existing) > 0 {
		for _, line := range strings.Split(string(existing), "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			if keyBody != "" && strings.Contains(line, keyBody) {
				// 已经装过：顺手把旧的无前缀版本升级成带 restrict 的写法。
				line = tunnelKeyPrefix + stripOptions(line)
			}
			lines = append(lines, line)
		}
	}
	already := false
	for _, line := range lines {
		if strings.Contains(line, keyBody) {
			already = true
			break
		}
	}
	if !already {
		if len(lines) >= tunnelKeyMaxLine {
			return errTooManyKeys
		}
		lines = append(lines, tunnelKeyPrefix+plain)
	}

	if err := os.MkdirAll(filepath.Dir(tunnelKeysPath), 0o700); err != nil {
		return err
	}
	tmp := tunnelKeysPath + ".tmp"
	content := strings.Join(lines, "\n")
	if content != "" {
		content += "\n"
	}
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return err
	}
	// 网关以 root 跑，写出来的文件属主是 root；sshd 会用 ocw-tunnel 身份去读，
	// 600 权限下读不到。必须改回该用户。
	if u, err := user.Lookup(tunnelUser); err == nil {
		if uid, err := strconv.Atoi(u.Uid); err == nil {
			if gid, err := strconv.Atoi(u.Gid); err == nil {
				_ = os.Chown(tmp, uid, gid)
			}
		}
	}
	return os.Rename(tmp, tunnelKeysPath)
}

// keyBodyOf 取 `类型 base64` 两段，用来做去重。
func keyBodyOf(line string) string {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return ""
	}
	return fields[0] + " " + fields[1]
}

// stripOptions 去掉行首已有的 authorized_keys 选项（`restrict,... `）。
func stripOptions(line string) string {
	if idx := strings.Index(line, "ssh-"); idx > 0 {
		return line[idx:]
	}
	if idx := strings.Index(line, "ecdsa-"); idx > 0 {
		return line[idx:]
	}
	return line
}
