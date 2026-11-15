package main

import (
	"crypto/rand"
	"math/big"
	"time"
)

// 配对码（临时）与邀请码（保留，当前注册流程未使用）。

func (d *DB) PutPair(code, deviceID string, ttl time.Duration) error {
	return d.withWriteLock(func() error {
		if err := d.reloadLocked(); err != nil {
			return err
		}
		now := time.Now().Unix()
		kept := d.Pairs[:0]
		for _, p := range d.Pairs {
			if p.ExpiresAt > now && p.Code != code {
				kept = append(kept, p)
			}
		}
		d.Pairs = append(kept, Pair{Code: code, DeviceID: deviceID, ExpiresAt: now + int64(ttl.Seconds())})
		return d.saveLocked()
	})
}

// TakePair 取出并作废一个配对码。

// TakePair 取出并作废一个配对码。
func (d *DB) TakePair(code string) (string, bool) {
	var deviceID string
	found := false
	_ = d.withWriteLock(func() error {
		if err := d.reloadLocked(); err != nil {
			return err
		}
		now := time.Now().Unix()
		for i, p := range d.Pairs {
			if p.Code == code && p.ExpiresAt >= now {
				deviceID, found = p.DeviceID, true
				d.Pairs = append(d.Pairs[:i], d.Pairs[i+1:]...)
				return d.saveLocked()
			}
		}
		return nil
	})
	return deviceID, found
}

// ---------- 邀请码（保留，当前注册流程未使用） ----------

const inviteAlphabet = "abcdefghijkmnpqrstuvwxyz23456789"

func randomInvite() (string, error) {
	out := make([]byte, 10)
	for i := range out {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(inviteAlphabet))))
		if err != nil {
			return "", err
		}
		out[i] = inviteAlphabet[n.Int64()]
	}
	return string(out), nil
}

// NewInvites 生成 n 个邀请码（24 小时有效）。

// NewInvites 生成 n 个邀请码（24 小时有效）。
func (d *DB) NewInvites(n int) ([]string, error) {
	var codes []string
	err := d.withWriteLock(func() error {
		if err := d.reloadLocked(); err != nil {
			return err
		}
		now := time.Now().Unix()
		kept := d.Invites[:0]
		for _, inv := range d.Invites {
			if inv.ExpiresAt > now && inv.UsedBy == "" {
				kept = append(kept, inv)
			}
		}
		d.Invites = kept
		for i := 0; i < n; i++ {
			code, err := randomInvite()
			if err != nil {
				return err
			}
			codes = append(codes, code)
			d.Invites = append(d.Invites, Invite{Code: code, ExpiresAt: now + 24*3600})
		}
		return d.saveLocked()
	})
	return codes, err
}

// ListInvites 返回当前可用的邀请码。

// ListInvites 返回当前可用的邀请码。
func (d *DB) ListInvites() []Invite {
	d.mu.Lock()
	defer d.mu.Unlock()
	_ = d.reloadLocked()
	now := time.Now().Unix()
	var out []Invite
	for _, inv := range d.Invites {
		if inv.ExpiresAt > now && inv.UsedBy == "" {
			out = append(out, inv)
		}
	}
	return out
}

// TakeInvite 用掉一个邀请码（注册成功后调用）。

// TakeInvite 用掉一个邀请码（注册成功后调用）。
func (d *DB) TakeInvite(code, username string) bool {
	ok := false
	_ = d.withWriteLock(func() error {
		if err := d.reloadLocked(); err != nil {
			return err
		}
		now := time.Now().Unix()
		for i := range d.Invites {
			inv := &d.Invites[i]
			if inv.Code == code && inv.ExpiresAt >= now && inv.UsedBy == "" {
				inv.UsedBy = username
				ok = true
				return d.saveLocked()
			}
		}
		return nil
	})
	return ok
}
