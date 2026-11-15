package main

import (
	"fmt"
	"log"
)

// runCLI 处理所有非 serve 的 -mode。返回 true 表示已处理完，调用方应退出。
func runCLI(o *options, db *DB, srv *server) bool {
	switch o.mode {
	case "adduser":
		cliAddUser(db, o)
		return true
	case "passwd":
		cliSetPassword(db, o)
		return true
	case "invite":
		cliInvite(db, o)
		return true
	case "setrole":
		cliSetRole(db, o)
		return true
	case "users":
		cliUsers(db)
		return true
	case "rmdevice":
		cliRmDevice(db, srv, o)
		return true
	case "sync-nginx":
		cliSyncNginx(db, srv)
		return true
	case "seed":
		cliSeed(db, srv, o)
		return true
	}

	// serve 故意不写 case：它是默认行为，靠「不匹配任何 case」走到这里返回 false。
	// 这里只拦真正拼错的值（如 seedd），否则会静默走进 serve、抢 17900 端口。
	if o.mode != "serve" {
		log.Fatalf("未知 -mode %q（可用：serve adduser passwd users setrole invite rmdevice sync-nginx seed）", o.mode)
	}
	return false
}

// passwordHash 校验用户名/密码参数并返回哈希（adduser 与 passwd 共用）。
func passwordHash(o *options) string {
	if o.username == "" || len(o.password) < 8 {
		log.Fatal("用户名必填，密码至少 8 位")
	}
	hash, err := HashPassword(o.password)
	if err != nil {
		log.Fatal(err)
	}
	return hash
}

func cliAddUser(db *DB, o *options) {
	hash := passwordHash(o)
	u, err := db.CreateUser(o.username, hash, o.role)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("已创建用户 %s (id=%d)\n", u.Username, u.ID)
}

func cliSetPassword(db *DB, o *options) {
	hash := passwordHash(o)
	u, ok := db.UserByName(o.username)
	if !ok {
		log.Fatal("用户不存在")
	}
	if err := db.SetPassword(u.ID, hash); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("已重置 %s 的密码\n", u.Username)
}

func cliInvite(db *DB, o *options) {
	codes, err := db.NewInvites(o.count)
	if err != nil {
		log.Fatal(err)
	}
	for _, c := range codes {
		fmt.Println(c)
	}
}

func cliSetRole(db *DB, o *options) {
	u, ok := db.UserByName(o.username)
	if !ok {
		log.Fatal("用户不存在")
	}
	if o.role != "user" && o.role != "admin" {
		log.Fatal("role 只能是 user 或 admin")
	}
	if err := db.SetRole(u.ID, o.role); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("已把 %s 设为 %s\n", u.Username, o.role)
}

func cliUsers(db *DB) {
	devices := db.AllDevices()
	for _, u := range db.ListUsers() {
		n := 0
		for _, dev := range devices {
			if dev.OwnerID == u.ID {
				n++
			}
		}
		fmt.Printf("%d\t%s\t%d 台设备\n", u.ID, u.Username, n)
	}
}

func cliRmDevice(db *DB, srv *server, o *options) {
	if o.rmdevice == "" {
		log.Fatal("-mode rmdevice 需要 -rmdevice <设备ID>")
	}
	if !db.DeleteDevice(o.rmdevice) {
		log.Fatal("设备不存在")
	}
	if ok, msg := srv.nginx.Apply(db.AllDevices()); !ok {
		log.Fatalf("nginx 更新失败: %s", msg)
	}
	fmt.Println("已删除设备", o.rmdevice)
}

func cliSyncNginx(db *DB, srv *server) {
	ok, msg := srv.nginx.Apply(db.AllDevices())
	fmt.Println(ok, msg)
}

func cliSeed(db *DB, srv *server, o *options) {
	if o.devID == "" || o.devToken == "" {
		log.Fatal("seed 需要 -device 和 -token")
	}
	name := o.devName
	if name == "" {
		name = "未命名设备"
	}
	dev, isNew, err := db.UpsertDevice(o.devID, name, o.devToken)
	if err != nil {
		log.Fatal(err)
	}
	if ok, msg := srv.nginx.Apply(db.AllDevices()); !ok {
		log.Fatalf("nginx 更新失败: %s", msg)
	}
	fmt.Printf("设备 %s 端口 %d 新增=%v\n", dev.ID, dev.Port, isNew)
}
