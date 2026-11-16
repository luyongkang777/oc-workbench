package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// 账号级配置同步：鉴权、隔离、大小上限、坏 JSON。

// 只用于测试解析的最小结构。
type SyncProfileForTest struct {
	Providers []struct {
		ID      string `json:"id"`
		APIKey  string `json:"apiKey"`
		BaseURL string `json:"baseURL"`
	} `json:"providers"`
	Model string `json:"model"`
}

func TestProfileRequiresAuth(t *testing.T) {
	srv, _ := newAPIServer(t)
	if rec := callAPI(t, srv.apiProfileGet, http.MethodGet, "/portal/api/profile", "", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("未登录读：期望 401，实际 %d", rec.Code)
	}
	if rec := callAPI(t, srv.apiProfilePut, http.MethodPost, "/portal/api/profile", `{"a":1}`, ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("未登录写：期望 401，实际 %d", rec.Code)
	}
}

func TestProfileRoundTripAndIsolation(t *testing.T) {
	srv, _ := newAPIServer(t)
	u1, err := srv.db.CreateUser("alice", "hash", "user")
	if err != nil {
		t.Fatal(err)
	}
	u2, err := srv.db.CreateUser("bob", "hash", "user")
	if err != nil {
		t.Fatal(err)
	}
	tok1 := srv.auth.Make(u1.ID)
	tok2 := srv.auth.Make(u2.ID)

	body := `{"providers":[{"id":"command-code","baseURL":"https://api.commandcode.ai/provider/v1","apiKey":"user_x","models":[{"id":"m","context":1000000}]}],"model":"command-code/m"}`
	if rec := callAPI(t, srv.apiProfilePut, http.MethodPost, "/portal/api/profile", body, tok1); rec.Code != http.StatusOK {
		t.Fatalf("写入：期望 200，实际 %d (%s)", rec.Code, rec.Body.String())
	}

	rec := callAPI(t, srv.apiProfileGet, http.MethodGet, "/portal/api/profile", "", tok1)
	if rec.Code != http.StatusOK {
		t.Fatalf("读取：期望 200，实际 %d", rec.Code)
	}
	// 内容原样返回（外面包一层 {profile: ...}；字段值不能变）
	var got struct {
		Profile SyncProfileForTest `json:"profile"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("读回的不是 JSON：%v (%s)", err, rec.Body.String())
	}
	if len(got.Profile.Providers) != 1 || got.Profile.Providers[0].ID != "command-code" {
		t.Fatalf("读回的 provider 不对：%+v", got.Profile)
	}
	if got.Profile.Providers[0].APIKey != "user_x" || got.Profile.Model != "command-code/m" {
		t.Fatalf("读回的字段不对：%+v", got.Profile)
	}

	// 另一个账号读不到
	rec = callAPI(t, srv.apiProfileGet, http.MethodGet, "/portal/api/profile", "", tok2)
	if rec.Code != http.StatusOK {
		t.Fatalf("bob 读取：期望 200，实际 %d", rec.Code)
	}
	var wrap map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &wrap); err != nil {
		t.Fatalf("bob 响应不是 JSON：%v", err)
	}
	if wrap["profile"] != nil {
		t.Fatalf("bob 不应该看到 alice 的配置：%v", wrap["profile"])
	}
}

func TestProfileRejectsBadJSONAndNonObject(t *testing.T) {
	srv, _ := newAPIServer(t)
	u, err := srv.db.CreateUser("carol", "hash", "user")
	if err != nil {
		t.Fatal(err)
	}
	tok := srv.auth.Make(u.ID)
	for _, body := range []string{`not json`, `[]`, `"x"`, `  `} {
		if rec := callAPI(t, srv.apiProfilePut, http.MethodPost, "/portal/api/profile", body, tok); rec.Code != http.StatusBadRequest {
			t.Fatalf("body=%q 期望 400，实际 %d", body, rec.Code)
		}
	}
}

func TestProfileTooLarge(t *testing.T) {
	srv, _ := newAPIServer(t)
	u, err := srv.db.CreateUser("dave", "hash", "user")
	if err != nil {
		t.Fatal(err)
	}
	tok := srv.auth.Make(u.ID)
	huge := `{"pad":"` + strings.Repeat("x", maxProfileBytes) + `"}`
	if rec := callAPI(t, srv.apiProfilePut, http.MethodPost, "/portal/api/profile", huge, tok); rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("超大配置：期望 413，实际 %d", rec.Code)
	}
}
