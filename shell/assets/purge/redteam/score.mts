/**
 * 红队得分规则：数值抄自上游 dsh-purge v1.1.89 的 lib/redteam/score-rules.js。
 *
 * 三条硬口径（与上游一致）：
 *   G1 同一系统/主机/数据库只按最高权限计一次
 *   G3 每项有封顶，超过封顶不再累加
 *   G7 边界突破/网络设备需要控制截图或路由表证据
 */

export type Tier = "admin" | "ordinary" | "unauthorized" | "node" | "primary" | "secondary" | "bonus";

export type Rule = {
  code: string;
  name: string;
  /** 每档分值；调用时按 tier 取，取不到用 admin/ordinary 兜底 */
  tiers: Partial<Record<Tier, number>>;
  /** 该项封顶，0 = 不封顶 */
  cap: number;
  note?: string;
};

export const RULES: Record<string, Rule> = {
  "domain-control": {
    code: "domain-control",
    name: "域控权限",
    tiers: { primary: 50, secondary: 20 },
    cap: 400,
    note: "主域 50 / 子域 20，按域类型计",
  },
  "terminal-access": {
    code: "terminal-access",
    name: "终端权限（PC/手机/平板/打印机/摄像头/无线路由）",
    tiers: { ordinary: 10, secondary: 5 },
    cap: 600,
    note: "打印机/无线路由 5 分每台；PC/平板/手机/摄像头/电子屏 10 分每台",
  },
  "server-host": {
    code: "server-host",
    name: "服务器主机权限（含 WebShell）",
    tiers: { ordinary: 10, admin: 50 },
    cap: 600,
    note: "同一主机按最高权限计一次（G1）",
  },
  "db-credential": {
    code: "db-credential",
    name: "数据库账号凭据（含 SQL 注入）",
    tiers: { ordinary: 10, admin: 50, unauthorized: 10 },
    cap: 400,
    note: "redis 等空密码/未授权统一 10 分",
  },
  "web-app": {
    code: "web-app",
    name: "邮件/OA/业务生产/其他 Web 应用系统权限",
    tiers: { ordinary: 50, admin: 100 },
    cap: 2000,
    note: "每系统按最高权限计一次；只记 host:port 的登录也归这里",
  },
  "central-system": {
    code: "central-system",
    name: "集权系统权限（运维/身份/网络/终端管理台）",
    tiers: { ordinary: 50, admin: 500 },
    cap: 4000,
    note: "被集权系统管理的普通主机/终端按普通条目计，不得套 500 分",
  },
  "bigdata-system": {
    code: "bigdata-system",
    name: "大数据系统权限",
    tiers: { ordinary: 100, admin: 1000 },
    cap: 4000,
    note: "数据量低于 5 亿行或 1TB 按普通数据库（db-credential）计",
  },
  netdev: {
    code: "netdev",
    name: "网络设备权限（防火墙/路由/交换/网闸/VPN）",
    tiers: { ordinary: 100, admin: 200, bonus: 200 },
    cap: 2000,
    note: "网络重定向/业务劫持 +200；植入远控并成功后续攻击 1000；需路由表或连接数证据（G7）",
  },
  iiot: {
    code: "iiot",
    name: "工业互联网系统权限",
    tiers: { admin: 200, node: 10 },
    cap: 2000,
    note: "联网设备每台 10 分，逐台单独记分",
  },
  "cloud-platform": {
    code: "cloud-platform",
    name: "云管理平台（含 K8s/OpenShift）",
    tiers: { admin: 500, node: 10 },
    cap: 2000,
    note: "不足 100 节点按普通 Web 应用计，不给节点分",
  },
  "iot-platform": {
    code: "iot-platform",
    name: "物联网设备管理平台",
    tiers: { admin: 200, node: 10 },
    cap: 2000,
    note: "经 IoT 终端进核心网并控制重要系统另记 +5000，不受本项封顶",
  },
  secdev: {
    code: "secdev",
    name: "安全设备权限（IPS/IDS/审计/WAF）",
    tiers: { admin: 200 },
    cap: 1000,
    note: "仅限非集权类安全设备",
  },
  "file-storage": {
    code: "file-storage",
    name: "文件存储系统（FTP/对象存储/NAS/企业网盘）",
    tiers: { admin: 50, ordinary: 10 },
    cap: 500,
    note: "空系统或只有测试数据按 10 分",
  },
  "ai-agent": {
    code: "ai-agent",
    name: "模型 Agent / 技能等可驱动攻击的智能体",
    tiers: { admin: 500, ordinary: 100 },
    cap: 4000,
    note: "100–500 分区间，按控制与操作深度定档",
  },
  "model-compute": {
    code: "model-compute",
    name: "算力管理平台 / 训练数据与知识库系统",
    tiers: { admin: 500 },
    cap: 4000,
    note: "数据量超 1 亿行或 10TB 翻倍；知识库系统翻倍（G5）",
  },
  "model-data": {
    code: "model-data",
    name: "模型相关数据系统",
    tiers: { admin: 500 },
    cap: 4000,
    note: "不含知识库翻倍；超大数据量翻倍（G5）",
  },
  "computepower-admin": {
    code: "computepower-admin",
    name: "算力基础设施 · 管理员权限",
    tiers: { admin: 500 },
    cap: 2000,
  },
  "computepower-cards": {
    code: "computepower-cards",
    name: "算力基础设施 · 算力卡资源",
    tiers: { node: 10 },
    cap: 2000,
    note: "每卡 10 分，与管理员权限共享本项 2000 封顶",
  },
  "boundary-logical": {
    code: "boundary-logical",
    name: "进入逻辑隔离业务内网",
    tiers: { admin: 1000 },
    cap: 0,
    note: "同一类边界对整个目标单位只计一次；需隔离设备控制截图 + 内网访问截图（G7）",
  },
  "boundary-strong": {
    code: "boundary-strong",
    name: "进入逻辑强隔离业务内网",
    tiers: { admin: 10000 },
    cap: 0,
    note: "需强隔离设备的控制证据（G7）",
  },
};

export const CODES = Object.keys(RULES);

/** 未知 code 不猜分数：返回 null，由调用方回退到显式 points */
export function pointsFor(code: string, tier: string, explicit?: number | null): number | null {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  const rule = RULES[code];
  if (!rule) return null;
  const t = String(tier || "").trim() as Tier;
  const direct = rule.tiers[t];
  if (typeof direct === "number") return direct;
  if (typeof rule.tiers.admin === "number") return rule.tiers.admin;
  if (typeof rule.tiers.ordinary === "number") return rule.tiers.ordinary;
  return null;
}

export type Hit = { code: string; target: string; points: number; refId?: string };

export type Total = {
  /** 各项去重后的分与封顶后分 */
  items: Array<{ code: string; name: string; raw: number; capped: number; cap: number; hits: number }>;
  total: number;
};

/**
 * 汇总口径：
 *  - 同一 (code, target) 只取最高分（G1 的近似）
 *  - 按 code 求和后套封顶（G3）
 *  - target 缺省时退化为 refId，避免不同主机被压成一条
 */
export function totalize(hits: Hit[]): Total {
  const best = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const h of hits) {
    if (!h || !h.code) continue;
    const key = `${h.code}\u0000${h.target || h.refId || ""}`;
    const cur = best.get(key) ?? 0;
    if (h.points > cur) best.set(key, h.points);
    counts.set(h.code, (counts.get(h.code) ?? 0) + 1);
  }
  const raw = new Map<string, number>();
  for (const [key, pts] of best) {
    const code = key.split("\u0000")[0];
    raw.set(code, (raw.get(code) ?? 0) + pts);
  }
  const items: Total["items"] = [];
  let total = 0;
  for (const [code, value] of raw) {
    const rule = RULES[code];
    const cap = rule?.cap ?? 0;
    const capped = cap > 0 ? Math.min(value, cap) : value;
    items.push({ code, name: rule?.name ?? code, raw: value, capped, cap, hits: counts.get(code) ?? 0 });
    total += capped;
  }
  items.sort((a, b) => b.capped - a.capped);
  return { items, total };
}
