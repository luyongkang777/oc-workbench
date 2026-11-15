package main

import (
	"errors"
	"time"
)

// 用户表：账号的增删改查。写操作一律走 withWriteLock（见 store.go）。

func (d *DB) UserByName(name string) (User, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	_ = d.reloadLocked()
	for _, u := range d.Users {
		if u.Username == name {
			return u, true
		}
	}
	return User{}, false
}

func (d *DB) UserByID(id int64) (User, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	_ = d.reloadLocked()
	for _, u := range d.Users {
		if u.ID == id {
			return u, true
		}
	}
	return User{}, false
}

func (d *DB) CreateUser(name, pwHash, role string) (User, error) {
	var created User
	err := d.withWriteLock(func() error {
		if err := d.reloadLocked(); err != nil {
			return err
		}
		var next int64 = 1
		for _, u := range d.Users {
			if u.Username == name {
				return errors.New("用户名已存在")
			}
			if u.ID >= next {
				next = u.ID + 1
			}
		}
		created = User{ID: next, Username: name, PW: pwHash, Role: role, CreatedAt: time.Now().Unix()}
		d.Users = append(d.Users, created)
		return d.saveLocked()
	})
	if err != nil {
		return User{}, err
	}
	return created, nil
}

func (d *DB) SetPassword(id int64, pwHash string) error {
	return d.withWriteLock(func() error {
		if err := d.reloadLocked(); err != nil {
			return err
		}
		for i := range d.Users {
			if d.Users[i].ID == id {
				d.Users[i].PW = pwHash
				return d.saveLocked()
			}
		}
		return errors.New("用户不存在")
	})
}

func (d *DB) SetRole(id int64, role string) error {
	return d.withWriteLock(func() error {
		if err := d.reloadLocked(); err != nil {
			return err
		}
		for i := range d.Users {
			if d.Users[i].ID == id {
				d.Users[i].Role = role
				return d.saveLocked()
			}
		}
		return errors.New("用户不存在")
	})
}

func (d *DB) ListUsers() []User {
	d.mu.Lock()
	defer d.mu.Unlock()
	_ = d.reloadLocked()
	out := make([]User, len(d.Users))
	copy(out, d.Users)
	return out
}

// ---------- 设备 ----------

// UpsertDevice 设备登记：已有就更新名字和 token（调用方要先校验 token 一致），
// 没有就分配一个空闲端口。
