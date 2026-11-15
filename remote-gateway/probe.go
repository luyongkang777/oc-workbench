package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// 在线判断：必须探到「那台电脑上的工作台」，不能只看隧道端口。
//
// 为什么不能用 TCP 探测：每台设备的链路是 sshd 监听 127.0.0.1:<port> ← ssh -R ← 设备 17800。
// 工作台 exe 退出后 **ssh 隧道进程还在**，端口照样能连上 —— 于是永远显示在线。
// 所以这里发一个真实的 HTTP 请求（带设备自己的 token）：
// 只要拿到响应（200/403 都算 —— 403 说明工作台活着、只是 token 不匹配）就是在线；
// 502/504（隧道在但 exe 没起）和连接失败算离线。
//
// 顺带取「有没有会话在跑」（`busy`）：手机顶部的设备条靠它显示黄灯/绿灯，
// 用户不打开那台电脑也知道它是不是正在干活。
//
// 回环 + 隧道一次往返约 20~60ms，20~30 台并发探测 + 3 秒缓存完全够用。

const probeTimeout = 1500 * time.Millisecond
const probeCacheTTL = 3 * time.Second

var probeClient = &http.Client{Timeout: probeTimeout}

// probeState 是一台设备的探测结果。
type probeState struct {
	Online bool
	Busy   bool
}

func probeDevice(dev Device) probeState {
	// 带实例前缀才能拿到 JSON：远程模式下裸 `/api/state` 会被当成未知路径直接 404，
	// 那时只能判在线、拿不到 busy。
	target := fmt.Sprintf("/u/%s/api/state", dev.ID)
	if state, ok := probePath(dev, target); ok {
		return state
	}
	// 老设备（没有 remoteBase 前缀）退回裸路径：只判在线，busy 保持 false。
	state, _ := probePath(dev, "/api/state")
	return state
}

// probePath 探一个路径。第二个返回值表示「拿到了可解析的状态 JSON」
// （只有这种情况 busy 才有意义）。
func probePath(dev Device, path string) (probeState, bool) {
	url := fmt.Sprintf("http://127.0.0.1:%d%s", dev.Port, path)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return probeState{}, false
	}
	// 设备端 host_allowed() 只认 127.0.0.1:17800，直连隧道时 Host 是 127.0.0.1:<回环端口>，
	// 不改写就会被 403。
	req.Host = "127.0.0.1:17800"
	req.Header.Set("x-oc-token", dev.Token)

	resp, err := probeClient.Do(req)
	if err != nil {
		return probeState{}, false
	}
	defer resp.Body.Close()
	// 必须读完再关：不读干净的话 Go 不会把连接放回池子，
	// 每 3 秒一轮探测都会新建 TCP 连接，设备多了会堆 TIME_WAIT。
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	// 502/504 = 隧道在但设备没起（ssh 转发失败）；其它状态码（200/403…）说明工作台活着
	if resp.StatusCode == http.StatusBadGateway || resp.StatusCode == http.StatusGatewayTimeout {
		return probeState{Online: false}, false
	}
	state := probeState{Online: true}
	var payload struct {
		Busy bool `json:"busy"`
	}
	if json.Unmarshal(body, &payload) == nil && resp.StatusCode == http.StatusOK {
		state.Busy = payload.Busy
		return state, true
	}
	return state, false
}

type probeCacheEntry struct {
	at   time.Time
	data map[string]probeState
}

var (
	probeMu    sync.Mutex
	probeCache = map[string]probeCacheEntry{}
)

// probeAll 返回 deviceID -> 探测结果。结果缓存 3 秒，刷新列表不会每点一次就扫一遍。
func probeAll(devices []Device) map[string]probeState {
	// key 必须带上回环端口：设备被删除后重建会换端口（17801~17840 里找空位），
	// 只看 ID 会在 3 秒缓存内把旧端口的探测结果当成新设备的，灯是错的。
	key := ""
	for _, dev := range devices {
		key += fmt.Sprintf("%s:%d,", dev.ID, dev.Port)
	}

	probeMu.Lock()
	if entry, ok := probeCache[key]; ok && time.Since(entry.at) < probeCacheTTL {
		out := entry.data
		probeMu.Unlock()
		return out
	}
	probeMu.Unlock()

	result := make(map[string]probeState, len(devices))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, dev := range devices {
		device := dev
		wg.Add(1)
		go func() {
			defer wg.Done()
			state := probeDevice(device)
			mu.Lock()
			result[device.ID] = state
			mu.Unlock()
		}()
	}
	wg.Wait()

	probeMu.Lock()
	if len(probeCache) > 32 {
		probeCache = map[string]probeCacheEntry{}
	}
	probeCache[key] = probeCacheEntry{at: time.Now(), data: result}
	probeMu.Unlock()
	return result
}
