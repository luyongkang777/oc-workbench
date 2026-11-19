/**
 * 红队计分与交接工具。
 *
 * score_hit 只接受规则表里的 code（未知 code 必须显式给 points，避免瞎编）。
 * score_list 按「同 code+target 取最高、再逐项封顶」汇总。
 * handoff 生成给下一个角色的标准交接段：目标范围、已得什么、还缺什么、下一步派谁。
 */
import { Ledger } from "./store.mts";
import { CODES, RULES, pointsFor, totalize, type Hit } from "./score.mts";

const text = (s: string) => ({ content: s });

const TIERS = ["admin", "ordinary", "unauthorized", "node", "primary", "secondary", "bonus"] as const;

export function registerScoreTools(ledger: Ledger, add: (t: any) => void): void {
  add({
    name: "redteam_score_hit",
    description:
      "记一次得分。code 必须是规则表里的项（server-host / web-app / db-credential / central-system / bigdata-system / " +
      "netdev / boundary-logical / boundary-strong 等），tier 选 admin/ordinary/unauthorized/node/bonus。" +
      "同一 target 同一 code 只按最高分计一次；规则外的情况才显式给 points。",
    input: {
      type: "object",
      properties: {
        code: { type: "string", description: "规则码；可先调 redteam_score_list 带 codesOnly=true 查全表" },
        tier: { type: "string", enum: TIERS },
        target: { type: "string", description: "计分对象，如 10.0.0.5 或 https://oa.x.com:8080" },
        points: { type: "number", description: "可选：显式分值，仅在规则外情况使用" },
        refId: { type: "string", description: "关联资产/漏洞/会话 id" },
        note: { type: "string", description: "计分依据，写清哪个站哪个账号哪档权限" },
      },
      required: ["code", "target"],
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        const code = String(input.code);
        const tier = String(input.tier || "admin");
        const pts = pointsFor(code, tier, typeof input.points === "number" ? input.points : null);
        if (pts === null) {
          return text(`错误：未知规则码 "${code}"，且没给 points。可选码：\n${CODES.join(", ")}`);
        }
        const rec = await ledger.add("score", {
          code,
          tier,
          target: String(input.target),
          points: pts,
          refId: input.refId ?? "",
          note: input.note ?? "",
        });
        const rule = RULES[code];
        const capNote = rule?.cap ? `（本项封顶 ${rule.cap}）` : "";
        return text(`已记 ${Ledger.describe("score", rec)}${capNote}`);
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });

  add({
    name: "redteam_score_list",
    description:
      "汇总得分：总分、各项去重后分值、是否被封顶。codesOnly=true 时只返回规则码与分值表，不查台账。" +
      "报告里的分数只能用这里的数，不能自己加。",
    input: {
      type: "object",
      properties: {
        codesOnly: { type: "boolean", description: "只列规则表" },
      },
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        if (input?.codesOnly) {
          const lines = CODES.map((c) => {
            const r = RULES[c];
            const parts = Object.entries(r.tiers).map(([k, v]) => `${k}=${v}`).join(" / ");
            return `${c}：${r.name} 【${parts}】${r.cap ? ` 封顶 ${r.cap}` : ""}`;
          });
          return text("规则码表：\n" + lines.join("\n"));
        }
        const rows = await ledger.list("score");
        const hits: Hit[] = rows.map((r) => ({ code: String(r.code), target: String(r.target || ""), points: Number(r.points) || 0, refId: String(r.refId || "") }));
        const t = totalize(hits);
        if (!t.items.length) return text("还没有得分记录。");
        const lines = t.items.map((i) => {
          const capped = i.cap > 0 && i.raw > i.cap ? `（原始 ${i.raw}，封顶 ${i.cap}）` : "";
          return `${i.code} ${i.name}：${i.capped} 分${capped} · ${i.hits} 条`;
        });
        return text(`总分：${t.total}\n` + lines.join("\n"));
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });

  add({
    name: "redteam_handoff",
    description:
      "生成给下一个角色的交接段：当前阶段、已得成果、未核实证据、剩余未测资产、下一步建议。" +
      "派子 agent 时把这段贴进 prompt，别让它自己重新翻台账。",
    input: {
      type: "object",
      properties: {
        next: { type: "string", description: "下一个角色：recon/assess/vuln-scan/exploit/internal" },
      },
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        const [meta, assets, vulns, evs, sess, scores] = await Promise.all([
          ledger.meta(),
          ledger.list("asset"),
          ledger.list("vuln"),
          ledger.list("ev"),
          ledger.list("sess"),
          ledger.list("score"),
        ]);
        const hits: Hit[] = scores.map((r) => ({ code: String(r.code), target: String(r.target || ""), points: Number(r.points) || 0 }));
        const total = totalize(hits).total;
        const untested = assets.filter((a) => !["tested", "no_surface", "abandoned"].includes(String(a.status)));
        const high = assets.filter((a) => a.priority === "high" && !["tested", "abandoned"].includes(String(a.status)));
        const unverified = evs.filter((e) => e.confidence === "claimed" || e.confidence === "inferred").length;
        const confirmed = vulns.filter((v) => ["confirmed", "exploited"].includes(String(v.status))).length;
        const activeSess = sess.filter((s) => s.status === "active").length;
        const lines = [
          `## 交接（→ ${input.next || "下一角色"}）`,
          `靶标：${meta.engagement || "未命名"}`,
          `总分：${total}；已确认漏洞 ${confirmed}；可用会话 ${activeSess}；未核实证据 ${unverified}`,
          `资产：共 ${assets.length}，未测 ${untested.length}，高优先级待打 ${high.length}`,
        ];
        if (high.length) lines.push("高优先级待打：\n" + high.slice(0, 10).map((a) => "- " + Ledger.describe("asset", a)).join("\n"));
        if (unverified) lines.push(`⚠ ${unverified} 条证据未核实，汇报时说"据称"，不许说"已拿到"。`);
        if (activeSess) {
          const act = sess.filter((s) => s.status === "active").slice(0, 5);
          lines.push("可用入口：\n" + act.map((s) => `- ${Ledger.describe("sess", s)} listen=${s.listen || "-"}`).join("\n"));
        }
        return text(lines.join("\n"));
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });

  add({
    name: "redteam_status",
    description: "红队台账总览：靶标、各表数量、总分、未核实证据、可用会话。开新会话先调这个。",
    input: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      try {
        const [meta, counts, scores, evs, sess] = await Promise.all([
          ledger.meta(),
          ledger.counts(),
          ledger.list("score"),
          ledger.list("ev"),
          ledger.list("sess"),
        ]);
        const hits: Hit[] = scores.map((r) => ({ code: String(r.code), target: String(r.target || ""), points: Number(r.points) || 0 }));
        const total = totalize(hits).total;
        const unverified = evs.filter((e) => e.confidence === "claimed" || e.confidence === "inferred").length;
        const activeSess = sess.filter((s) => s.status === "active").length;
        return text(
          [
            `靶标：${meta.engagement || "未命名"}`,
            `总分：${total}`,
            `资产 ${counts.asset} / 漏洞 ${counts.vuln} / 凭证 ${counts.cred} / 会话 ${counts.sess} / 证据 ${counts.ev} / 链条 ${counts.chain} / 得分 ${counts.score}`,
            `可用会话 ${activeSess} 个；未核实证据 ${unverified} 条`,
          ].join("\n"),
        );
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });

  add({
    name: "redteam_engagement_open",
    description: "设定/查看当前靶标名称。只影响台账标题，不影响计分。",
    input: {
      type: "object",
      properties: { name: { type: "string", description: "靶标单位名称；留空则只查看" } },
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        const name = String(input?.name || "").trim();
        if (name) await ledger.setEngagement(name);
        const meta = await ledger.meta();
        return text(`当前靶标：${meta.engagement || "未命名"}（创建于 ${meta.createdAt}）`);
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });
  add({
    name: "redteam_reset",
    description:
      "清空红队台账（资产/漏洞/凭证/会话/证据/链条/得分 + 靶标名）。必须传 confirm=\"RESET\"，" +
      "用于开新靶标或清理验证数据。不可撤销，调用前先确认用户真的要清。",
    input: {
      type: "object",
      properties: {
        confirm: { type: "string", description: "必须写 RESET" },
      },
      required: ["confirm"],
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        if (String(input?.confirm) !== "RESET") return text("未清空：confirm 必须写 RESET");
        const kinds = ["asset", "vuln", "cred", "sess", "ev", "chain", "score"] as const;
        for (const k of kinds) await ledger.st.set(`redteam/${k}`, {});
        await ledger.st.set("redteam/meta", {
          engagement: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return text("已清空红队台账。");
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });
}
