package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIRSuJn2dCOjItCdgtEuur93bl56LxM/fx0zNn/1UA8E ocw-226"

func withTempKeys(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	old := tunnelKeysPath
	tunnelKeysPath = filepath.Join(dir, "authorized_keys")
	t.Cleanup(func() { tunnelKeysPath = old })
}

func TestNormalizeTunnelKey(t *testing.T) {
	cases := []struct {
		name string
		in   string
		ok   bool
	}{
		{"正常", sampleKey, true},
		{"没有注释", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIRSuJn2dCOjItCdgtEuur93bl56LxM/fx0zNn/1UA8E", true},
		{"带换行取第一行", sampleKey + "\r\nssh-rsa AAAA", true},
		{"带选项的旧行", "restrict " + sampleKey, false},
		{"注入换行", "ssh-ed25519 AAAA\nroot:*", false},
		{"字段不足", "ssh-ed25519", false},
		{"类型不对", "ssh-dss AAAA", false},
		{"base64 含空格", "ssh-ed25519 AAA BBB", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, err := normalizeTunnelKey(c.in)
			if c.ok && err != nil {
				t.Fatalf("应当通过，却报错：%v", err)
			}
			if !c.ok && err == nil {
				t.Fatalf("应当拒绝，却通过了：%s", out)
			}
			if c.ok && !strings.HasPrefix(out, "ssh-ed25519 ") && !strings.HasPrefix(out, "ssh-rsa ") {
				t.Fatalf("规整后格式不对：%s", out)
			}
		})
	}
}

func TestAppendTunnelKeyIsIdempotentAndRestricted(t *testing.T) {
	withTempKeys(t)
	line, err := normalizeTunnelKey(sampleKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := appendTunnelKey(line); err != nil {
		t.Fatal(err)
	}
	if err := appendTunnelKey(line); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(tunnelKeysPath)
	if err != nil {
		t.Fatal(err)
	}
	content := strings.TrimSpace(string(raw))
	if got := strings.Count(content, "AAAAC3NzaC1lZDI1NTE5"); got != 1 {
		t.Fatalf("同一把 key 应当只存一条，实际 %d 条：\n%s", got, content)
	}
	if !strings.HasPrefix(content, "restrict,port-forwarding ssh-ed25519 ") {
		t.Fatalf("必须带上 restrict,port-forwarding 前缀：%s", content)
	}
}

func TestAppendTunnelKeyUpgradesOldLine(t *testing.T) {
	withTempKeys(t)
	// 模拟历史数据：没有选项前缀的裸 key。
	if err := os.WriteFile(tunnelKeysPath, []byte(sampleKey+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	line, _ := normalizeTunnelKey(sampleKey)
	if err := appendTunnelKey(line); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(tunnelKeysPath)
	content := strings.TrimSpace(string(raw))
	if strings.Count(content, "ssh-ed25519") != 1 {
		t.Fatalf("升级不应产生重复行：%s", content)
	}
	if !strings.HasPrefix(content, "restrict,port-forwarding ") {
		t.Fatalf("旧行应当被补上前缀：%s", content)
	}
}

func TestAppendTunnelKeyRejectsWhenFull(t *testing.T) {
	withTempKeys(t)
	lines := make([]string, 0, tunnelKeyMaxLine)
	for i := 0; i < tunnelKeyMaxLine; i++ {
		lines = append(lines, tunnelKeyPrefix+"ssh-ed25519 AAAA"+strings.Repeat("A", 20)+" k"+string(rune('a'+i%26)))
	}
	if err := os.WriteFile(tunnelKeysPath, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	line, _ := normalizeTunnelKey(sampleKey)
	if err := appendTunnelKey(line); err != errTooManyKeys {
		t.Fatalf("达到上限应当返回 errTooManyKeys，实际：%v", err)
	}
}
