package main

import (
	"encoding/json"
	"errors"
	"time"
)

// 账号级配置（provider + SK + 模型选择）的存储。
//
// 为什么放 gateway.json 里而不是单独文件：DB 已经是「读-改-写 + 文件锁」的唯一入口，
// 单开一个文件要再复制一套锁逻辑，容易在两个进程（服务/CLI）之间丢写。
// profiles 只是个 map，加进来不影响既有字段的 unmarshal。
//
// 内容由客户端决定（当前是 {providers:[...], model:"..."}），网关**不解析**，
// 只做大小校验和原样存取 —— 以后客户端加字段不用改服务端。

// 单账号上限：100 个 provider × 若干模型，512KB 足够；不让它撑爆 gateway.json。
const maxProfileBytes = 512 << 10

// ErrProfileTooLarge 让 handler 能区分「太大」和「JSON 不合法」。
var ErrProfileTooLarge = errors.New("profile too large")

// GetProfile 返回该账号存的原始 JSON；没有就返回 nil。
func (d *DB) GetProfile(userID int64) (json.RawMessage, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	_ = d.reloadLocked()
	raw, ok := d.Profiles[profileKey(userID)]
	if !ok || len(raw) == 0 {
		return nil, false
	}
	return raw, true
}

// PutProfile 覆盖写入并返回更新时间。
func (d *DB) PutProfile(userID int64, raw json.RawMessage) (int64, error) {
	if len(raw) > maxProfileBytes {
		return 0, ErrProfileTooLarge
	}
	updated := time.Now().Unix()
	err := d.withWriteLock(func() error {
		if err := d.reloadLocked(); err != nil {
			return err
		}
		if d.Profiles == nil {
			d.Profiles = map[string]json.RawMessage{}
		}
		// 存一份拷贝：调用方的切片可能来自请求缓冲，不能让它被后面的读写改掉
		copied := make(json.RawMessage, len(raw))
		copy(copied, raw)
		d.Profiles[profileKey(userID)] = copied
		return d.saveLocked()
	})
	if err != nil {
		return 0, err
	}
	return updated, nil
}

func profileKey(userID int64) string {
	return "u" + itoa(userID)
}

// 小工具：避免为了一个整数引入 strconv 之外的东西（strconv 本来就没引入）。
func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
