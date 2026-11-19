/**
 * 红队台账：泛型 CRUD，落在 opencode 插件的 ctx.storage。
 *
 * 每类一张表，key = `redteam/<kind>`，value = { [id]: 记录 }。
 * id 形如 `A1` / `V3` / `E12`，序号从已有最大 id 推导，不额外维护计数器。
 * 插件被加载多份实例时共享同一 storage，最后写者胜 —— 只影响极端并发下的统计，不影响判据。
 */

export type Kind = "asset" | "vuln" | "cred" | "sess" | "ev" | "chain" | "score";

export type Rec = {
  id: string;
  createdAt: string;
  updatedAt: string;
  [k: string]: any;
};

export type Storage = {
  get(key: string): Promise<any>;
  set(key: string, value: any): Promise<void>;
};

const PREFIX: Record<Kind, string> = {
  asset: "A",
  vuln: "V",
  cred: "P",
  sess: "S",
  ev: "E",
  chain: "K",
  score: "H",
};

const KIND_LABEL: Record<Kind, string> = {
  asset: "资产",
  vuln: "漏洞",
  cred: "凭证",
  sess: "会话",
  ev: "证据",
  chain: "链条",
  score: "得分",
};

const table = (kind: Kind) => `redteam/${kind}`;
const metaKey = "redteam/meta";

function nowIso(): string {
  return new Date().toISOString();
}

/** 从已有 id 推导下一个序号：A1、A2…… 被删掉的号不复用 */
function nextId(kind: Kind, rows: Record<string, any>): string {
  const p = PREFIX[kind];
  let max = 0;
  for (const id of Object.keys(rows)) {
    const m = new RegExp(`^${p}(\\d+)$`).exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${p}${max + 1}`;
}

export class Ledger {
  constructor(private st: Storage) {}

  async all(kind: Kind): Promise<Record<string, Rec>> {
    const v = await this.st.get(table(kind));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  }

  async list(kind: Kind): Promise<Rec[]> {
    const rows = await this.all(kind);
    return Object.values(rows).sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  }

  async get(kind: Kind, id: string): Promise<Rec | undefined> {
    const rows = await this.all(kind);
    return rows[id];
  }

  async add(kind: Kind, fields: Record<string, any>): Promise<Rec> {
    const rows = await this.all(kind);
    const id = fields.id && !rows[fields.id] ? String(fields.id) : nextId(kind, rows);
    const at = nowIso();
    const rec: Rec = { ...fields, id, createdAt: at, updatedAt: at };
    rows[id] = rec;
    await this.st.set(table(kind), rows);
    return rec;
  }

  async update(kind: Kind, id: string, patch: Record<string, any>): Promise<Rec | undefined> {
    const rows = await this.all(kind);
    const cur = rows[id];
    if (!cur) return undefined;
    const next: Rec = { ...cur, ...patch, id, updatedAt: nowIso() };
    rows[id] = next;
    await this.st.set(table(kind), rows);
    return next;
  }

  async remove(kind: Kind, id: string): Promise<boolean> {
    const rows = await this.all(kind);
    if (!rows[id]) return false;
    delete rows[id];
    await this.st.set(table(kind), rows);
    return true;
  }

  async counts(): Promise<Record<Kind, number>> {
    const kinds: Kind[] = ["asset", "vuln", "cred", "sess", "ev", "chain", "score"];
    const out = {} as Record<Kind, number>;
    for (const k of kinds) out[k] = Object.keys(await this.all(k)).length;
    return out;
  }

  async meta(): Promise<{ engagement: string; createdAt: string; updatedAt: string }> {
    const m = await this.st.get(metaKey);
    const at = nowIso();
    if (!m || typeof m !== "object") {
      const fresh = { engagement: "", createdAt: at, updatedAt: at };
      await this.st.set(metaKey, fresh);
      return fresh;
    }
    return {
      engagement: String(m.engagement || ""),
      createdAt: String(m.createdAt || at),
      updatedAt: String(m.updatedAt || at),
    };
  }

  async setEngagement(name: string): Promise<void> {
    const m = await this.meta();
    await this.st.set(metaKey, { ...m, engagement: String(name || ""), updatedAt: nowIso() });
  }

  /** 人类可读的一行摘要，工具返回值与 handoff 共用 */
  static describe(kind: Kind, r: Rec): string {
    const tag = KIND_LABEL[kind] || kind;
    const id = String(r.id);
    switch (kind) {
      case "asset": {
        const addr = r.url ? String(r.url) : `${r.ip || "?"}${r.port ? ":" + r.port : ""}`;
        const bits = [r.priority && `P=${r.priority}`, r.status && `状态=${r.status}`, r.scope && `范围=${r.scope}`];
        return `${tag} ${id} ${addr}${r.title ? ` 「${r.title}」` : ""} ${bits.filter(Boolean).join(" ")}`.trim();
      }
      case "vuln":
        return `${tag} ${id} [${r.severity || "?"}/${r.status || "?"}] ${r.title || "?"} @ ${r.target || "?"}`;
      case "cred":
        return `${tag} ${id} ${r.kind || "?"} ${r.username || "?"}（来源=${r.source || "?"}）`;
      case "sess":
        return `${tag} ${id} ${r.kind || "?"} → ${r.reach || r.target || "?"}（${r.status || "?"}）`;
      case "ev":
        return `${tag} ${id} ${r.kind || "?"} ${r.target || "?"}（可信度=${r.confidence || "claimed"}）`;
      case "chain":
        return `${tag} ${id} [${r.stageCode || "?"}] ${r.tool || "?"} → ${String(r.result || "").slice(0, 80)}`;
      case "score":
        return `${tag} ${id} ${r.code || "?"} +${r.points || 0}（${r.refId || "无关联"}）`;
      default:
        return `${tag} ${id}`;
    }
  }
}
