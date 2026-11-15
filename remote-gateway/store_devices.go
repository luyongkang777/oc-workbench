package main

import (
	"errors"
	"regexp"
	"sort"
	"time"
)

// 设备表：登记、端口分配、归属转移、删除。
//
// 设备 ID 会被拼进 nginx 片段，白名单在 UpsertDevice 入口强制校验。

// DeviceIDPattern 设备 ID 的合法字符集。
//
// 这个 ID 会被拼进 nginx 配置片段（location ^~ /u/<id>/），必须是保守字符：
// 一旦混进空格 / 花括号 / 分号，nginx -t 会失败，设备行还留在库里，
// 之后每次 Apply 都渲染到它 —— 所有设备的注册和认领永久 500，且原本没有删除入口。
var DeviceIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// ValidDeviceID 供各入口（register / claim / seed）落地前校验。

// ValidDeviceID 供各入口（register / claim / seed）落地前校验。
func ValidDeviceID(id string) bool { return DeviceIDPattern.MatchString(id) }

// UpsertDevice 设备登记：已有就更新名字和 token（调用方要先校验 token 一致），
// 没有就分配一个空闲端口。
func (d *DB) UpsertDevice(id, name, token string) (Device, bool, error) {
	if !ValidDeviceID(id) {
		return Device{}, false, errors.New("设备 ID 只能包含字母、数字、下划线和短横线（1~64 位）")
	}
	var (
		dev   Device
		isNew bool
	)
	err := d.withWriteLock(func() error {
		if err := d.reloadLocked(); err != nil {
			return err
		}
		now := time.Now().Unix()
		for i := range d.Devices {
			if d.Devices[i].ID == id {
				d.Devices[i].Name = name
				d.Devices[i].Token = token
				d.Devices[i].LastSeen = now
				dev, isNew = d.Devices[i], false
				return d.saveLocked()
			}
		}
		port, err := d.freePortLocked()
		if err != nil {
			return err
		}
		dev = Device{ID: id, Name: name, Port: port, Token: token, LastSeen: now, CreatedAt: now}
		d.Devices = append(d.Devices, dev)
		isNew = true
		return d.saveLocked()
	})
	if err != nil {
		return Device{}, false, err
	}
	return dev, isNew, nil
}

func (d *DB) freePortLocked() (int, error) {
	used := map[int]bool{}
	for _, dev := range d.Devices {
		used[dev.Port] = true
	}
	for p := portMin; p <= portMax; p++ {
		if !used[p] {
			return p, nil
		}
	}
	return 0, errors.New("回环端口池已满（17801~17840），先用 -mode rmdevice 清掉不用的设备")
}

func (d *DB) DeviceByID(id string) (Device, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	_ = d.reloadLocked()
	for _, dev := range d.Devices {
		if dev.ID == id {
			return dev, true
		}
	}
	return Device{}, false
}

func (d *DB) DevicesOf(owner int64) []Device {
	d.mu.Lock()
	defer d.mu.Unlock()
	_ = d.reloadLocked()
	var out []Device
	for _, dev := range d.Devices {
		if dev.OwnerID == owner {
			out = append(out, dev)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastSeen > out[j].LastSeen })
	return out
}

func (d *DB) AllDevices() []Device {
	d.mu.Lock()
	defer d.mu.Unlock()
	_ = d.reloadLocked()
	out := make([]Device, len(d.Devices))
	copy(out, d.Devices)
	sort.Slice(out, func(i, j int) bool { return out[i].Port < out[j].Port })
	return out
}

func (d *DB) ClaimDevice(id string, owner int64) bool {
	ok := false
	_ = d.withWriteLock(func() error {
		if err := d.reloadLocked(); err != nil {
			return err
		}
		for i := range d.Devices {
			if d.Devices[i].ID == id {
				d.Devices[i].OwnerID = owner
				ok = true
				return d.saveLocked()
			}
		}
		return nil
	})
	return ok
}

func (d *DB) ReleaseDevice(id string, owner int64) bool {
	ok := false
	_ = d.withWriteLock(func() error {
		if err := d.reloadLocked(); err != nil {
			return err
		}
		for i := range d.Devices {
			if d.Devices[i].ID == id && d.Devices[i].OwnerID == owner {
				d.Devices[i].OwnerID = 0
				ok = true
				return d.saveLocked()
			}
		}
		return nil
	})
	return ok
}

// DeleteDevice 彻底删掉一台设备（连带释放回环端口）。
//
// ReleaseDevice 只清 owner、保留端口，而端口池只有 17801~17840：
// 任意注册用户可以连发 40 个假设备把池子占满，之后所有人登记都报「端口池已满」。
// 给运维一个显式命令（-mode rmdevice）来清理。
func (d *DB) DeleteDevice(id string) bool {
	ok := false
	_ = d.withWriteLock(func() error {
		if err := d.reloadLocked(); err != nil {
			return err
		}
		for i := range d.Devices {
			if d.Devices[i].ID == id {
				d.Devices = append(d.Devices[:i], d.Devices[i+1:]...)
				ok = true
				return d.saveLocked()
			}
		}
		return nil
	})
	return ok
}

// ---------- 配对码 ----------
