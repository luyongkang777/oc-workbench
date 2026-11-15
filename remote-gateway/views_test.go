package main

import (
	"strings"
	"testing"
)

// 设备名是用户可控的（电脑名/认领时传的 name），必须转义，否则能往门户页注入脚本。
func TestDevicesPageEscapesUserInput(t *testing.T) {
	evil := `<script>alert(1)</script>`
	html := devicesPage(
		`<img src=x onerror=alert(2)>`,
		false,
		[]Device{{ID: "dev-a", Name: evil, Port: 17801}},
		map[string]probeState{"dev-a": {Online: true}},
		nil,
		`<b>notice</b>`,
		`<i>err</i>`,
	)

	for _, raw := range []string{evil, `<img src=x onerror=alert(2)>`, `<b>notice</b>`, `<i>err</i>`} {
		if strings.Contains(html, raw) {
			t.Fatalf("页面里出现了未转义的内容: %q", raw)
		}
	}
	// 转义后的实体应该在
	if !strings.Contains(html, "&lt;script&gt;") {
		t.Fatal("设备名没有被转义")
	}
}

// 回归：配对码从 6 位改成 8 位时漏改了界面（maxlength=6 会把输入截断，永远绑不上）。
func TestDevicesPagePairInputIsEightDigits(t *testing.T) {
	html := devicesPage("u", false, nil, map[string]probeState{}, nil, "", "")

	if !strings.Contains(html, `maxlength="8"`) {
		t.Fatal("配对码输入框应是 maxlength=8")
	}
	if strings.Contains(html, `maxlength="6"`) {
		t.Fatal("还残留 maxlength=6")
	}
	if !strings.Contains(html, "8 位配对码") {
		t.Fatal("文案应写 8 位配对码")
	}
	if strings.Contains(html, "6 位配对码") {
		t.Fatal("还残留「6 位配对码」文案")
	}
}

// 在线/离线状态要能在页面上区分出来（灯的颜色由 CSS 类控制）。
func TestDevicesPageOnlineDot(t *testing.T) {
	html := devicesPage("u", false,
		[]Device{{ID: "dev-a", Name: "A"}, {ID: "dev-b", Name: "B"}},
		map[string]probeState{"dev-a": {Online: true}},
		nil, "", "")

	if !strings.Contains(html, `class="dot on"`) {
		t.Fatal("在线设备应有 dot on")
	}
	if strings.Count(html, `class="dot"`) != 1 {
		t.Fatalf("离线设备应有且仅有一个 dot，实际 %d", strings.Count(html, `class="dot"`))
	}
}

func TestDevicesPageEmptyState(t *testing.T) {
	html := devicesPage("u", false, nil, map[string]probeState{}, nil, "", "")
	if !strings.Contains(html, "还没有绑定电脑") {
		t.Fatal("空列表应给出提示")
	}
	if !strings.Contains(html, "0 台设备") {
		t.Fatal("应显示设备数量")
	}
}

// 登录页/注册页要把回显的错误信息转义（err 来自 query string）。
func TestLoginAndRegisterPageEscape(t *testing.T) {
	evil := `<script>alert(3)</script>`
	for name, html := range map[string]string{
		"login":    loginPage(evil, evil),
		"register": registerPage(evil),
	} {
		if strings.Contains(html, evil) {
			t.Fatalf("%s 页出现了未转义的错误信息", name)
		}
	}
}
