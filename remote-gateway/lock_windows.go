//go:build windows

package main

import (
	"os"
	"time"
)

// Windows 上标准库没有导出 LockFileEx（在 x/sys/windows 里，不想为零依赖引入），
// 这里用锁文件实现：O_EXCL 创建，拿不到就重试；超过 10 秒视为僵尸锁强制接管。
//
// 生产环境是 Linux（flock 实现，见 lock_unix.go），这条只服务于本机开发/测试。
func lockFile(path string) (func(), error) {
	lockPath := path + ".lock"
	deadline := time.Now().Add(3 * time.Second)
	for {
		f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_ = f.Close()
			return func() { _ = os.Remove(lockPath) }, nil
		}
		// 上一个进程崩了会留下锁文件：超过 10 秒就当成僵尸锁清掉
		if info, statErr := os.Stat(lockPath); statErr == nil && time.Since(info.ModTime()) > 10*time.Second {
			_ = os.Remove(lockPath)
			continue
		}
		if time.Now().After(deadline) {
			return nil, err
		}
		time.Sleep(20 * time.Millisecond)
	}
}
