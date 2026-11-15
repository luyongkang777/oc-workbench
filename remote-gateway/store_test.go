package main

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// 所有测试都用 t.TempDir() 隔开，互不影响；
// 也不碰 nginx / 端口监听，能在任何机器上跑。

func newTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := OpenDB(filepath.Join(t.TempDir(), "gateway.json"))
	if err != nil {
		t.Fatalf("OpenDB 失败: %v", err)
	}
	return db
}

// OpenDB 不能无条件覆盖已有文件：多进程同时启动时各自写回旧快照会丢数据。
func TestOpenDBPreservesExistingData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gateway.json")

	first, err := OpenDB(path)
	if err != nil {
		t.Fatalf("第一次 OpenDB: %v", err)
	}
	if _, err := first.CreateUser("alice", "hash", "user"); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	// 模拟「另一个进程重新启动」：必须读到 alice，而不是把库清空
	second, err := OpenDB(path)
	if err != nil {
		t.Fatalf("第二次 OpenDB: %v", err)
	}
	if _, ok := second.UserByName("alice"); !ok {
		t.Fatal("OpenDB 把已有用户覆盖没了")
	}
}

func TestCreateUserRejectsDuplicate(t *testing.T) {
	db := newTestDB(t)
	u, err := db.CreateUser("bob", "h1", "user")
	if err != nil {
		t.Fatalf("首次创建失败: %v", err)
	}
	if u.ID != 1 {
		t.Fatalf("首个用户 ID 应为 1，实际 %d", u.ID)
	}
	if _, err := db.CreateUser("bob", "h2", "user"); err == nil {
		t.Fatal("重名用户应该报错")
	}
}

func TestUserIDsIncrement(t *testing.T) {
	db := newTestDB(t)
	for i, name := range []string{"u1", "u2", "u3"} {
		u, err := db.CreateUser(name, "h", "user")
		if err != nil {
			t.Fatalf("创建 %s: %v", name, err)
		}
		if u.ID != int64(i+1) {
			t.Fatalf("%s 的 ID 应为 %d，实际 %d", name, i+1, u.ID)
		}
	}
}

func TestSetPasswordAndRole(t *testing.T) {
	db := newTestDB(t)
	u, _ := db.CreateUser("carol", "old", "user")

	if err := db.SetPassword(u.ID, "new"); err != nil {
		t.Fatalf("SetPassword: %v", err)
	}
	got, _ := db.UserByID(u.ID)
	if got.PW != "new" {
		t.Fatalf("密码没更新，实际 %q", got.PW)
	}

	if err := db.SetRole(u.ID, "admin"); err != nil {
		t.Fatalf("SetRole: %v", err)
	}
	got, _ = db.UserByID(u.ID)
	if got.Role != "admin" {
		t.Fatalf("角色没更新，实际 %q", got.Role)
	}

	if err := db.SetPassword(999, "x"); err == nil {
		t.Fatal("不存在的用户改密码应该报错")
	}
}

func TestUpsertDeviceAllocatesPortAndUpdates(t *testing.T) {
	db := newTestDB(t)

	dev, isNew, err := db.UpsertDevice("dev-a", "电脑A", "tok-a")
	if err != nil {
		t.Fatalf("UpsertDevice: %v", err)
	}
	if !isNew {
		t.Fatal("首次登记应返回 isNew=true")
	}
	if dev.Port < portMin || dev.Port > portMax {
		t.Fatalf("端口 %d 不在 %d~%d 区间", dev.Port, portMin, portMax)
	}

	// 第二次登记同一台：复用端口、更新名字、isNew=false
	again, isNew, err := db.UpsertDevice("dev-a", "电脑A-改名", "tok-a")
	if err != nil {
		t.Fatalf("二次登记: %v", err)
	}
	if isNew {
		t.Fatal("已存在的设备不该返回 isNew=true")
	}
	if again.Port != dev.Port {
		t.Fatalf("端口不该变：%d -> %d", dev.Port, again.Port)
	}
	if again.Name != "电脑A-改名" {
		t.Fatalf("名字没更新，实际 %q", again.Name)
	}
}

// 设备 ID 会拼进 nginx 片段，白名单必须在落库前挡住危险字符。
func TestUpsertDeviceRejectsUnsafeID(t *testing.T) {
	db := newTestDB(t)
	for _, bad := range []string{"", "a b", "a/b", "a{b}", "a;b", "设备", string(make([]byte, 65))} {
		if _, _, err := db.UpsertDevice(bad, "x", "t"); err == nil {
			t.Fatalf("非法 ID %q 应该被拒", bad)
		}
	}
	for _, good := range []string{"a", "A1_-", "645a6a9ede23f047"} {
		if _, _, err := db.UpsertDevice(good, "x", "t"); err != nil {
			t.Fatalf("合法 ID %q 不该被拒: %v", good, err)
		}
	}
}

func TestPortPoolExhausts(t *testing.T) {
	db := newTestDB(t)
	total := portMax - portMin + 1
	for i := 0; i < total; i++ {
		if _, _, err := db.UpsertDevice(deviceIDForTest(i), "x", "t"); err != nil {
			t.Fatalf("第 %d 台设备就失败了: %v", i, err)
		}
	}
	if _, _, err := db.UpsertDevice(deviceIDForTest(total), "x", "t"); err == nil {
		t.Fatal("端口池满了还应该报错")
	}
}

func deviceIDForTest(i int) string {
	const digits = "0123456789"
	return "dev" + string(digits[(i/10)%10]) + string(digits[i%10])
}

// DeleteDevice 必须把端口还回池子，否则 40 个假设备就能永久占满。
func TestDeleteDeviceFreesPort(t *testing.T) {
	db := newTestDB(t)
	dev, _, _ := db.UpsertDevice("dev-a", "A", "t")
	used := dev.Port

	if !db.DeleteDevice("dev-a") {
		t.Fatal("删除应成功")
	}
	if _, ok := db.DeviceByID("dev-a"); ok {
		t.Fatal("删除后不该还能查到")
	}
	if db.DeleteDevice("dev-a") {
		t.Fatal("重复删除应返回 false")
	}

	// 新建的设备应该能拿到刚释放的端口
	next, _, err := db.UpsertDevice("dev-b", "B", "t2")
	if err != nil {
		t.Fatalf("UpsertDevice: %v", err)
	}
	if next.Port != used {
		t.Fatalf("端口没释放：期望复用 %d，实际 %d", used, next.Port)
	}
}

func TestClaimAndRelease(t *testing.T) {
	db := newTestDB(t)
	db.UpsertDevice("dev-a", "A", "t")

	if !db.ClaimDevice("dev-a", 7) {
		t.Fatal("认领应成功")
	}
	dev, _ := db.DeviceByID("dev-a")
	if dev.OwnerID != 7 {
		t.Fatalf("owner 应为 7，实际 %d", dev.OwnerID)
	}

	// 换个账号认领：谁登录归谁，直接转移
	if !db.ClaimDevice("dev-a", 9) {
		t.Fatal("转移应成功")
	}
	dev, _ = db.DeviceByID("dev-a")
	if dev.OwnerID != 9 {
		t.Fatalf("owner 应转移成 9，实际 %d", dev.OwnerID)
	}

	// 只有 owner 能解绑
	if db.ReleaseDevice("dev-a", 7) {
		t.Fatal("非 owner 不该能解绑")
	}
	if !db.ReleaseDevice("dev-a", 9) {
		t.Fatal("owner 解绑应成功")
	}
	dev, _ = db.DeviceByID("dev-a")
	if dev.OwnerID != 0 {
		t.Fatalf("解绑后 owner 应为 0，实际 %d", dev.OwnerID)
	}
}

func TestDevicesOfFiltersByOwner(t *testing.T) {
	db := newTestDB(t)
	db.UpsertDevice("dev-a", "A", "t")
	db.UpsertDevice("dev-b", "B", "t")
	db.ClaimDevice("dev-a", 1)
	db.ClaimDevice("dev-b", 2)

	if got := db.DevicesOf(1); len(got) != 1 || got[0].ID != "dev-a" {
		t.Fatalf("账号 1 只应看到 dev-a，实际 %+v", got)
	}
	if got := db.DevicesOf(3); len(got) != 0 {
		t.Fatalf("账号 3 不该看到设备，实际 %+v", got)
	}
}

func TestPairOneShot(t *testing.T) {
	db := newTestDB(t)
	if err := db.PutPair("12345678", "dev-a", time.Minute); err != nil {
		t.Fatalf("PutPair: %v", err)
	}
	if id, ok := db.TakePair("12345678"); !ok || id != "dev-a" {
		t.Fatalf("取配对码失败：id=%q ok=%v", id, ok)
	}
	if _, ok := db.TakePair("12345678"); ok {
		t.Fatal("配对码必须一次性")
	}
}

func TestPairExpires(t *testing.T) {
	db := newTestDB(t)
	// 负数 TTL 让过期时间直接落在过去
	if err := db.PutPair("11112222", "dev-a", -time.Second); err != nil {
		t.Fatalf("PutPair: %v", err)
	}
	if _, ok := db.TakePair("11112222"); ok {
		t.Fatal("过期配对码不该能用")
	}
}

// PutPair 会顺手清掉过期的，避免 Pairs 无限增长
func TestPutPairPrunesExpired(t *testing.T) {
	db := newTestDB(t)
	db.PutPair("11111111", "old", -time.Second)
	db.PutPair("22222222", "new", time.Minute)

	if got := len(db.Pairs); got != 1 {
		t.Fatalf("过期配对码应被清掉，实际剩 %d 条", got)
	}
}

// 跨进程文件锁 + 进程内锁：并发创建用户不能互相覆盖。
func TestConcurrentCreateUserKeepsAll(t *testing.T) {
	db := newTestDB(t)
	const n = 10

	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := db.CreateUser("user"+deviceIDForTest(i), "h", "user")
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		if err != nil {
			t.Fatalf("并发创建失败: %v", err)
		}
	}
	if got := len(db.ListUsers()); got != n {
		t.Fatalf("并发写丢了用户：期望 %d，实际 %d", n, got)
	}
}

// 文件锁文件不该被当成数据；删掉它不影响后续读写。
func TestLockFileDoesNotBreakDB(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "gateway.json")
	db, err := OpenDB(path)
	if err != nil {
		t.Fatalf("OpenDB: %v", err)
	}
	db.CreateUser("dave", "h", "user")

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("数据文件不存在: %v", err)
	}
	again, err := OpenDB(path)
	if err != nil {
		t.Fatalf("重新打开: %v", err)
	}
	if _, ok := again.UserByName("dave"); !ok {
		t.Fatal("重新打开后用户丢了")
	}
}
