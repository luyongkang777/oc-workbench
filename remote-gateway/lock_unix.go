//go:build !windows

package main

import (
	"os"
	"syscall"
)

// lockFile 对 gateway.json 加排他锁（阻塞到拿到为止）。
//
// 为什么需要：store.go 的 sync.Mutex 只保护同一进程；CLI（adduser/seed/rmdevice）
// 是独立进程，和服务进程各自 reload→改→写，会互相覆盖。
// 用 flock 让两边的「读-改-写」串起来；进程崩溃时内核自动释放，不会留死锁。
func lockFile(path string) (func(), error) {
	f, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		_ = f.Close()
		return nil, err
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}
