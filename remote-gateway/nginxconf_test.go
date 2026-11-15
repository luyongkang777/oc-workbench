package main

import (
	"strings"
	"testing"
)

// 设备表渲染成 nginx 片段：每台设备都要有自己的 location + 正确的回环端口。
func TestNginxRenderContainsEveryDevice(t *testing.T) {
	n := NewNginxDevices("/tmp/never-written.inc")
	out := n.render([]Device{
		{ID: "dev-a", Port: 17801},
		{ID: "dev-b", Port: 17802},
	})

	for _, want := range []string{
		"location ^~ /u/dev-a/ {",
		"location ^~ /u/dev-b/ {",
		"proxy_pass http://127.0.0.1:17801;",
		"proxy_pass http://127.0.0.1:17802;",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("片段里缺少 %q\n---\n%s", want, out)
		}
	}
}

// 空设备表也要产出合法片段（不能留空文件头 / 半截 location）。
func TestNginxRenderEmpty(t *testing.T) {
	n := NewNginxDevices("/tmp/never-written.inc")
	out := n.render(nil)
	if strings.Contains(out, "location ^~") {
		t.Fatalf("空表不该有 location:\n%s", out)
	}
	if !strings.Contains(out, "自动生成") {
		t.Fatal("应保留「自动生成」标记，提醒不要手改")
	}
}

// 每台设备的 location 都必须挂上 auth_request，漏一个就等于那台设备不需要登录。
func TestNginxRenderEveryDeviceHasAuth(t *testing.T) {
	n := NewNginxDevices("/tmp/never-written.inc")
	devices := []Device{
		{ID: "dev-a", Port: 17801},
		{ID: "dev-b", Port: 17802},
		{ID: "dev-c", Port: 17803},
	}
	out := n.render(devices)

	if got, want := strings.Count(out, "auth_request"), len(devices); got < want {
		t.Fatalf("每台设备都要 auth_request：期望 ≥%d，实际 %d\n%s", want, got, out)
	}
	for _, dev := range devices {
		if !strings.Contains(out, "location ^~ /u/"+dev.ID+"/ {") {
			t.Fatalf("%s 缺少 location", dev.ID)
		}
	}
}

// tk 换 cookie 的入口只能放在 /u/ 前缀下（不能变成全站 302）。
func TestNginxRenderTicketRedirectScoped(t *testing.T) {
	n := NewNginxDevices("/tmp/never-written.inc")
	out := n.render([]Device{{ID: "dev-a", Port: 17801}})

	if !strings.Contains(out, "$arg_tk") {
		t.Fatal("缺少 tk 换 cookie 的 302 规则")
	}
	if !strings.Contains(out, "/portal/api/tk") {
		t.Fatal("302 目标应是 /portal/api/tk")
	}
}
