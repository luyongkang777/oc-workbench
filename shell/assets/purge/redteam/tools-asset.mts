/**
 * 红队资产工具：redteam_asset_add / _query / _assess / _test
 *
 * 只做记录与判据，不内置扫描器。扫描用现成的 nmap/fscan/gogo/httpx 等，
 * 扫完把结果按字段灌进来，后续角色才有一致的资产视图。
 */
import { Ledger, type Rec } from "./store.mts";

const SCOPE = ["internet", "internal", "boundary", "target"] as const;
const PROVENANCE = ["passive", "active"] as const;
const STATUS = ["untested", "testing", "tested", "no_surface", "blocked", "abandoned"] as const;
const PRIORITY = ["high", "medium", "low"] as const;

const assetInput = {
  type: "object",
  properties: {
    ip: { type: "string", description: "IP 或主机名" },
    port: { type: "integer", description: "端口" },
    service: { type: "string", description: "服务名，如 http / ssh" },
    product: { type: "string", description: "产品名，如 nginx / 通达OA" },
    version: { type: "string", description: "版本号" },
    banner: { type: "string", description: "原始 banner 摘要" },
    url: { type: "string", description: "可访问 URL，含协议与端口" },
    title: { type: "string", description: "页面标题或系统名" },
    scope: { type: "string", enum: SCOPE, description: "台账范围；内网主机用 internal" },
    provenance: { type: "string", enum: PROVENANCE, description: "被动收集=passive，主动探测=active" },
    tool: { type: "string", description: "数据来源工具，如 fofa / httpx / gogo / fscan" },
    notes: { type: "string", description: "补充说明" },
  },
  required: ["ip"],
  additionalProperties: false,
} as const;

const queryInput = {
  type: "object",
  properties: {
    scope: { type: "string", enum: SCOPE },
    status: { type: "string", enum: STATUS },
    priority: { type: "string", enum: PRIORITY },
    keyword: { type: "string", description: "在 ip/url/title/product 里模糊匹配" },
    sort: { type: "string", enum: ["id", "priority", "todo"], description: "todo = 只列未测且有优先级的" },
    limit: { type: "integer", minimum: 1, maximum: 200, description: "默认 30" },
  },
  additionalProperties: false,
} as const;

function text(s: string) {
  return { content: s };
}

function matchKeyword(a: Rec, kw: string): boolean {
  if (!kw) return true;
  const k = kw.toLowerCase();
  return ["ip", "url", "title", "product", "notes", "banner", "service"]
    .map((f) => String(a[f] ?? "").toLowerCase())
    .some((v) => v.includes(k));
}

export function registerAssetTools(ledger: Ledger, add: (t: any) => void): void {
  add({
    name: "redteam_asset_add",
    description:
      "把一条资产记入红队台账（IP/端口/服务/版本/URL/标题/来源工具）。" +
      "被动收集的资产 provenance=passive，主动探测的为 active；内网主机 scope=internal。" +
      "同一主机多个端口应各记一条，别合并。",
    input: assetInput,
    execute: async (input: any) => {
      try {
        const ip = String(input.ip || "").trim();
        if (!ip) return text("错误：ip 不能为空");
        const rec = await ledger.add("asset", {
          ip,
          port: input.port ?? null,
          service: input.service ?? "",
          product: input.product ?? "",
          version: input.version ?? "",
          banner: input.banner ?? "",
          url: input.url ?? "",
          title: input.title ?? "",
          scope: input.scope ?? "internet",
          provenance: input.provenance ?? "active",
          tool: input.tool ?? "",
          notes: input.notes ?? "",
          status: "untested",
          priority: "",
          potential: "",
          reason: "",
          testNotes: "",
          blockedCount: 0,
        });
        return text(`已记 ${Ledger.describe("asset", rec)}`);
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });

  add({
    name: "redteam_asset_query",
    description:
      "查询红队台账里的资产。sort=todo 只返回还没测、且已评估过优先级的资产（侦察角色交接给评估角色的标准视图）。" +
      "limit 默认 30，最大 200。",
    input: queryInput,
    execute: async (input: any) => {
      try {
        let rows = await ledger.list("asset");
        if (input.scope) rows = rows.filter((r) => r.scope === input.scope);
        if (input.status) rows = rows.filter((r) => r.status === input.status);
        if (input.priority) rows = rows.filter((r) => r.priority === input.priority);
        rows = rows.filter((r) => matchKeyword(r, String(input.keyword || "")));
        if (input.sort === "todo") {
          rows = rows.filter((r) => !["tested", "no_surface", "abandoned"].includes(String(r.status)) && r.priority);
        }
        if (input.sort === "priority") {
          const rank: Record<string, number> = { high: 0, medium: 1, low: 2, "": 3 };
          rows.sort((a, b) => (rank[String(a.priority)] ?? 3) - (rank[String(b.priority)] ?? 3));
        }
        const limit = Math.min(200, Math.max(1, Number(input.limit) || 30));
        const shown = rows.slice(0, limit);
        if (!shown.length) return text("台账里没有符合条件的资产。");
        const lines = shown.map((r) => Ledger.describe("asset", r));
        return text(`共 ${rows.length} 条，显示 ${shown.length} 条：\n` + lines.join("\n"));
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });

  add({
    name: "redteam_asset_assess",
    description:
      "给资产写评估结论：优先级 high/medium/low、预期产出 potential、判断理由 reason。" +
      "potential 写预期能拿到的东西（管理员权限/WebShell/RCE/数据库权限/敏感信息/边界突破/核心系统）。",
    input: {
      type: "object",
      properties: {
        id: { type: "string", description: "资产 id，如 A3" },
        priority: { type: "string", enum: PRIORITY },
        potential: { type: "string", description: "预期产出" },
        reason: { type: "string", description: "判断依据：版本 Nday、暴露面、未授权接口、默认口令等" },
      },
      required: ["id", "priority"],
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        const rec = await ledger.update("asset", String(input.id), {
          priority: input.priority,
          potential: input.potential ?? "",
          reason: input.reason ?? "",
        });
        if (!rec) return text(`错误：没有资产 ${input.id}`);
        return text(`已评估 ${Ledger.describe("asset", rec)} 预期=${rec.potential || "-"} 理由=${rec.reason || "-"}`);
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });

  add({
    name: "redteam_asset_test",
    description:
      "更新资产的测试状态：status（testing/tested/no_surface/blocked/abandoned）、test 追加结论、surface 剩余可测面。" +
      "同一目标累计受阻超过 3 次应置 blocked=true 并转下一个目标。",
    input: {
      type: "object",
      properties: {
        id: { type: "string", description: "资产 id" },
        status: { type: "string", enum: STATUS },
        test: { type: "string", description: "测试结论，追加式记录" },
        surface: { type: "string", description: "还剩什么可测" },
        blocked: { type: "boolean", description: "是否被拦截" },
      },
      required: ["id", "status"],
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        const cur = await ledger.get("asset", String(input.id));
        if (!cur) return text(`错误：没有资产 ${input.id}`);
        const prev = String(cur.testNotes || "");
        const chunk = String(input.test || "").trim();
        const testNotes = chunk ? (prev ? `${prev}\n- ${chunk}` : `- ${chunk}`) : prev;
        const blockedCount = input.blocked === true ? Number(cur.blockedCount || 0) + 1 : Number(cur.blockedCount || 0);
        const patch: Record<string, any> = { status: input.status, testNotes, blockedCount };
        if (input.surface !== undefined) patch.surface = input.surface;
        if (input.blocked === true) patch.blocked = true;
        const rec = await ledger.update("asset", String(input.id), patch);
        return text(`已更新 ${Ledger.describe("asset", rec!)} 受阻次数=${blockedCount}`);
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });
}
