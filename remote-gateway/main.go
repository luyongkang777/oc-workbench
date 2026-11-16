package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// deviceReloader 是 server 对「设备表 → nginx 片段」这一步的最小依赖。
//
// 抽成接口只为一个目的：HTTP 层（apiClaim / handleRegister）在单测里可以注入 fake，
// 不必真的去执行 nginx -t。生产实现仍然是 NginxDevices，行为完全不变。
type deviceReloader interface {
	Apply(devices []Device) (bool, string)
}

type server struct {
	db       *DB
	auth     *Authenticator
	limiter  *limiter // 登录：5 分钟 6 次失败即锁
	regLimit *limiter // 注册 / 设备登记 / 配对：5 分钟 10 次（每次尝试都计数）
	claimLimit *limiter // 认领设备：5 分钟 30 次（NAT 后面可能有几台机器）
	nginx    deviceReloader
	enroll   string
	dataDir  string
}

// options 集中承载所有命令行参数。
//
// 拆出来是为了让 main() 只表达「启动流程」，不被 13 个 flag 定义淹没；
// 默认值和说明与拆分前逐字一致（CLI 行为不能变）。
type options struct {
	mode      string
	addr      string
	dataDir   string
	nginxConf string
	username  string
	password  string
	devID     string
	devName   string
	devToken  string
	role      string
	rmdevice  string
	count     int
}

func parseOptions() *options {
	o := &options{}
	flag.StringVar(&o.mode, "mode", "serve", "serve | adduser | passwd | users | sync-nginx | seed")
	flag.StringVar(&o.addr, "addr", "127.0.0.1:17900", "监听地址")
	flag.StringVar(&o.dataDir, "data", "/var/lib/ocw-gateway", "数据目录")
	flag.StringVar(&o.nginxConf, "nginx", defaultDevicesConf, "设备 nginx 片段路径")
	flag.StringVar(&o.username, "u", "", "用户名")
	flag.StringVar(&o.password, "p", "", "密码")
	flag.StringVar(&o.devID, "device", "", "设备 ID（= remoteBase 里那段）")
	flag.StringVar(&o.devName, "name", "", "设备显示名")
	flag.StringVar(&o.devToken, "token", "", "设备 remoteToken")
	flag.IntVar(&o.count, "n", 1, "生成邀请码数量（-mode invite）")
	flag.StringVar(&o.role, "role", "user", "角色：user | admin（-mode adduser/setrole）")
	flag.StringVar(&o.rmdevice, "rmdevice", "", "删除一台设备并释放端口（清端口池用）")
	flag.Parse()
	return o
}

func main() {
	o := parseOptions()

	if err := os.MkdirAll(o.dataDir, 0o755); err != nil {
		log.Fatalf("创建数据目录失败: %v", err)
	}
	db, err := OpenDB(filepath.Join(o.dataDir, "gateway.json"))
	if err != nil {
		log.Fatalf("读取数据失败: %v", err)
	}
	secret, err := readOrCreate(o.dataDir, "secret", 32)
	if err != nil {
		log.Fatalf("读取密钥失败: %v", err)
	}
	enroll, err := readOrCreate(o.dataDir, "enroll", 32)
	if err != nil {
		log.Fatalf("读取注册密钥失败: %v", err)
	}
	srv := &server{
		db:       db,
		auth:     NewAuthenticator(secret),
		limiter:  newLimiter(6),
		regLimit: newLimiter(10),
		claimLimit: newLimiter(30),
		nginx:    NewNginxDevices(o.nginxConf),
		enroll:   enroll,
		dataDir:  o.dataDir,
	}

	// 非 serve 模式跑完就退出，不会进到下面的监听逻辑。
	if runCLI(o, db, srv) {
		return
	}

	log.Printf("网关启动 %s（数据 %s，nginx 片段 %s）", o.addr, o.dataDir, o.nginxConf)
	httpSrv := &http.Server{
		Addr:              o.addr,
		Handler:           newMux(srv),
		ReadHeaderTimeout: 10 * time.Second,
	}
	if err := httpSrv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

// newMux 注册所有路由。
func newMux(srv *server) *http.ServeMux {
	mux := http.NewServeMux()

	// 门户页面
	mux.HandleFunc("GET /", srv.handleHome)
	mux.HandleFunc("POST /portal/login", srv.handleLogin)
	mux.HandleFunc("POST /portal/logout", srv.handleLogout)
	mux.HandleFunc("GET /portal/register", srv.handleRegisterPage)
	mux.HandleFunc("POST /portal/register", srv.handleSignup)
	mux.HandleFunc("POST /portal/admin/invite", srv.handleMintInvite)
	mux.HandleFunc("POST /portal/pair", srv.handlePair)
	mux.HandleFunc("GET /portal/open/{id}", srv.handleOpen)
	mux.HandleFunc("POST /portal/unbind/{id}", srv.handleUnbind)
	mux.HandleFunc("POST /portal/api/register", srv.handleRegister)

	// 客户端（exe/浏览器账号面板）用的 JSON API：跨源 + Bearer token
	// 设备入口的账号校验：nginx auth_request 子请求 + iframe 的 ?tk= 换 cookie
	mux.HandleFunc("GET /portal/api/authcheck", srv.gwAuth)
	mux.HandleFunc("GET /portal/api/tk", srv.tkToCookie)
	mux.HandleFunc("POST /portal/api/login", cors(srv.apiLogin))
	mux.HandleFunc("GET /portal/api/devices", cors(srv.apiDevices))
	mux.HandleFunc("GET /portal/api/whoami", cors(srv.apiWhoami))
	mux.HandleFunc("POST /portal/api/claim", cors(srv.apiClaim))
	mux.HandleFunc("POST /portal/api/logout", cors(srv.apiLogout))
	mux.HandleFunc("POST /portal/api/tunnelkey", cors(srv.apiTunnelKey))
	// 账号级配置（provider/SK/模型选择）同步：换电脑登录后自动拉取
	mux.HandleFunc("GET /portal/api/profile", cors(srv.apiProfileGet))
	mux.HandleFunc("POST /portal/api/profile", cors(srv.apiProfilePut))
	mux.HandleFunc("OPTIONS /portal/api/", cors(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("GET /portal/health", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "ok")
	})

	return mux
}
