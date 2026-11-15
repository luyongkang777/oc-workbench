package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
)

// 设备配置片段的落点（被 remote-web-7800.conf include 进去）。
const defaultDevicesConf = "/www/server/panel/vhost/nginx/ocw-devices.inc"

// NginxDevices 负责把设备表翻译成 nginx location，并在变更后热加载。
//
// 必须有锁：两台设备并发认领时，各自「读旧文件 → 写 → nginx -t → 可能回滚」会交错，
// 后回滚的那个会把别人刚写好的配置覆盖回去。
type NginxDevices struct {
	mu   sync.Mutex
	path string
}

func NewNginxDevices(path string) *NginxDevices {
	if path == "" {
		path = defaultDevicesConf
	}
	return &NginxDevices{path: path}
}

func deviceBlock(id string, port int) string {
	common := fmt.Sprintf(`        proxy_pass http://127.0.0.1:%d;
        proxy_http_version 1.1;
        proxy_set_header Host              127.0.0.1:17800;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;`, port)

	return fmt.Sprintf(`
    # 少尾斜杠（手输/复制漏斜杠）跳到带斜杠的路径，否则落到 location / 变 404
    location = /u/%[1]s { return 301 /u/%[1]s/$is_args$args; }

    # 静态资源：开缓冲才能 gzip + 长缓存（文件名带 hash）
    location ^~ /u/%[1]s/assets/ {
%[2]s
        proxy_buffering on;
        gzip on;
        gzip_proxied any;
        gzip_min_length 1024;
        gzip_comp_level 5;
        gzip_types text/javascript application/javascript text/css;
        expires 30d;
    }

    location ^~ /u/%[1]s/ {
        # 入口 URL 带 ?t=<设备凭据>，不写 access_log 就会把凭据记进日志
        access_log off;
        # exe 的 iframe 导航带不了 Authorization 头，跨源也拿不到 SameSite cookie：
        # 先把 ?tk= 换成账号 cookie，再回设备页面。
        if ($arg_tk) {
            return 302 /portal/api/tk?tk=$arg_tk&t=$arg_t&next=$uri&back=$arg_back;
        }
        # 账号会话 + 设备归属校验（子请求打网关 /portal/api/authcheck）
        auth_request /_gw_auth;

%[2]s

        # SSE：必须关缓冲，否则流式回复被攒住
        proxy_buffering off;
        proxy_cache off;
        gzip on;
        gzip_proxied any;
        gzip_min_length 1024;
        gzip_comp_level 5;
        gzip_types application/json application/javascript text/css text/plain application/xml image/svg+xml;

        proxy_connect_timeout 10s;
        proxy_send_timeout    3600s;
        proxy_read_timeout    3600s;
    }
`, id, common)
}

func (n *NginxDevices) render(devices []Device) string {
	var b strings.Builder
	b.WriteString("# 由远程网关自动生成，别手改。\n# 每台设备一段：/u/<设备ID>/ → 127.0.0.1:<回环端口>\n")
	for _, dev := range devices {
		b.WriteString(deviceBlock(dev.ID, dev.Port))
	}
	return b.String()
}

// Apply 写片段并 reload。nginx -t 失败时回滚，避免把线上打挂。
func (n *NginxDevices) Apply(devices []Device) (bool, string) {
	n.mu.Lock()
	defer n.mu.Unlock()

	next := n.render(devices)
	old, _ := os.ReadFile(n.path)
	if string(old) == next {
		return true, "unchanged"
	}
	if err := os.WriteFile(n.path, []byte(next), 0o644); err != nil {
		return false, err.Error()
	}

	if out, err := exec.Command("nginx", "-t").CombinedOutput(); err != nil {
		if len(old) > 0 {
			_ = os.WriteFile(n.path, old, 0o644)
		} else {
			_ = os.Remove(n.path)
		}
		return false, "nginx -t 失败: " + strings.TrimSpace(string(out))
	}
	if out, err := exec.Command("nginx", "-s", "reload").CombinedOutput(); err != nil {
		return false, "reload 失败: " + strings.TrimSpace(string(out))
	}
	return true, "reloaded"
}
