package main

import (
	"encoding/json"
	"os"
	"sync"
)

// 存储层核心：类型定义、原子落盘、跨进程写锁。
//
// 网关有「常驻服务」和「CLI（adduser/seed/passwd/rmdevice）」两类进程同时写同一个 JSON，
// 各自持内存副本会互相覆盖。这里用两层锁：
//   1. d.mu：进程内互斥；
//   2. withWriteLock 里的文件锁（flock / LockFileEx）：跨进程串行化「读-改-写」。
//
// 用户 / 设备 / 配对码的读写分别在 store_users.go / store_devices.go / store_pairs.go。

type User struct {
	ID        int64  `json:"id"`
	Username  string `json:"username"`
	PW        string `json:"pw"`
	Role      string `json:"role"`
	CreatedAt int64  `json:"created_at"`
}

type Device struct {
	ID        string `json:"id"`
	OwnerID   int64  `json:"owner_id"`
	Name      string `json:"name"`
	Port      int    `json:"port"`
	Token     string `json:"token"`
	LastSeen  int64  `json:"last_seen"`
	CreatedAt int64  `json:"created_at"`
}

type Pair struct {
	Code      string `json:"code"`
	DeviceID  string `json:"device_id"`
	ExpiresAt int64  `json:"expires_at"`
}

// Invite 注册邀请码（当前注册流程已改为开放注册，保留代码供以后切回邀请制）。

// Invite 注册邀请码（当前注册流程已改为开放注册，保留代码供以后切回邀请制）。
type Invite struct {
	Code      string `json:"code"`
	ExpiresAt int64  `json:"expires_at"`
	UsedBy    string `json:"used_by,omitempty"`
}

type DB struct {
	mu      sync.Mutex
	path    string
	Users   []User   `json:"users"`
	Devices []Device `json:"devices"`
	Pairs   []Pair   `json:"pairs"`
	Invites []Invite `json:"invites"`
}

const (
	portMin = 17801
	portMax = 17840
)

// DeviceIDPattern 设备 ID 的合法字符集。
//
// 这个 ID 会被拼进 nginx 配置片段（location ^~ /u/<id>/），必须是保守字符：
// 一旦混进空格 / 花括号 / 分号，nginx -t 会失败，设备行还留在库里，
// 之后每次 Apply 都渲染到它 —— 所有设备的注册和认领永久 500，且原本没有删除入口。

func OpenDB(path string) (*DB, error) {
	db := &DB{path: path}
	if err := db.reloadLocked(); err != nil {
		return nil, err
	}
	// 只在文件还不存在时建一次空文件。
	//
	// 原来这里无条件 saveLocked()：多进程同时启动（比如一次跑 3 个 adduser）
	// 时，每个进程都用自己的旧快照覆盖磁盘，实测会丢数据。
	// 文件已存在就什么都不做，格式清理交给后面的写操作。
	if _, err := os.Stat(path); os.IsNotExist(err) {
		_ = db.withWriteLock(func() error { return db.saveLocked() })
	}
	return db, nil
}

func (d *DB) reloadLocked() error {
	raw, err := os.ReadFile(d.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if len(raw) == 0 {
		return nil
	}
	var tmp DB
	if err := json.Unmarshal(raw, &tmp); err != nil {
		return err
	}
	d.Users, d.Devices, d.Pairs, d.Invites = tmp.Users, tmp.Devices, tmp.Pairs, tmp.Invites
	return nil
}

// saveLocked 原子落盘：先写临时文件再改名，避免断电留下半个 JSON。
// nil 切片统一成空数组（否则序列化成 null，读的时候要到处兜底）。

// saveLocked 原子落盘：先写临时文件再改名，避免断电留下半个 JSON。
// nil 切片统一成空数组（否则序列化成 null，读的时候要到处兜底）。
func (d *DB) saveLocked() error {
	if d.Users == nil {
		d.Users = []User{}
	}
	if d.Devices == nil {
		d.Devices = []Device{}
	}
	if d.Pairs == nil {
		d.Pairs = []Pair{}
	}
	if d.Invites == nil {
		d.Invites = []Invite{}
	}
	raw, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	tmp := d.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, d.path)
}

// withWriteLock 把「读磁盘 → 改 → 写回」整段串行化：进程内锁 + 文件锁。
//
// 拿不到文件锁（只读盘 / 权限问题）时退化成只用进程内锁 —— 宁可保住可用性，
// 也不能因为锁文件建不出来就让网关完全不能写。

// withWriteLock 把「读磁盘 → 改 → 写回」整段串行化：进程内锁 + 文件锁。
//
// 拿不到文件锁（只读盘 / 权限问题）时退化成只用进程内锁 —— 宁可保住可用性，
// 也不能因为锁文件建不出来就让网关完全不能写。
func (d *DB) withWriteLock(fn func() error) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	unlock, err := lockFile(d.path)
	if err != nil {
		return fn()
	}
	defer unlock()
	return fn()
}

// ---------- 用户 ----------
