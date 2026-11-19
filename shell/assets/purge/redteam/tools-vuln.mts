/**
 * 红队漏洞与证据工具。
 *
 * 证据分级（上游口径，不许混用）：
 *   claimed   自称成功，未核实
 *   inferred  从别人结果推断
 *   derived   从原始数据推导，需给原始请求
 *   observed  实测观察，带完整请求/响应
 * 只有 observed 能直接写"拿到了"；其余必须写"据称/推断"。
 */
import crypto from "node:crypto";
import { Ledger } from "./store.mts";

const SEVERITY = ["critical", "high", "medium", "low", "info"] as const;
const VULN_STATUS = ["candidate", "confirmed", "exploited", "failed"] as const;
const CONFIDENCE = ["claimed", "inferred", "derived", "observed"] as const;

const text = (s: string) => ({ content: s });

function digest(s: string): string {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
}

export function registerVulnTools(ledger: Ledger, add: (t: any) => void): void {
  add({
    name: "redteam_vuln_add",
    description:
      "记一条漏洞。confidence 默认 claimed（未核实）；只有实测通过才写 confirmed/exploited。" +
      "跟得分无关的信息泄露、目录遍历、版本泄露、CORS/CSRF 也记，但 severity 写 info/low，别当战果。",
    input: {
      type: "object",
      properties: {
        title: { type: "string" },
        severity: { type: "string", enum: SEVERITY },
        cve: { type: "string", description: "CVE 编号或组件名+版本" },
        target: { type: "string", description: "实际 URL / IP:端口" },
        evidence: { type: "string", description: "实际回显、响应摘要或复现命令" },
        confidence: { type: "string", enum: CONFIDENCE },
        status: { type: "string", enum: VULN_STATUS },
        assetId: { type: "string", description: "关联资产 id，如 A3" },
        agent: { type: "string", description: "记录者角色，如 vuln-scan / exploit" },
      },
      required: ["title", "target"],
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        const rec = await ledger.add("vuln", {
          title: String(input.title),
          severity: input.severity ?? "medium",
          cve: input.cve ?? "",
          target: String(input.target),
          evidence: input.evidence ?? "",
          confidence: input.confidence ?? "claimed",
          status: input.status ?? "candidate",
          assetId: input.assetId ?? "",
          agent: input.agent ?? "",
        });
        return text(`已记 ${Ledger.describe("vuln", rec)}（可信度=${rec.confidence}）`);
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });

  add({
    name: "redteam_vuln_query",
    description: "查漏洞。按状态/严重度/目标过滤，keyword 模糊匹配标题与 target。",
    input: {
      type: "object",
      properties: {
        status: { type: "string", enum: VULN_STATUS },
        severity: { type: "string", enum: SEVERITY },
        keyword: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        let rows = await ledger.list("vuln");
        if (input.status) rows = rows.filter((r) => r.status === input.status);
        if (input.severity) rows = rows.filter((r) => r.severity === input.severity);
        const kw = String(input.keyword || "").toLowerCase();
        if (kw) {
          rows = rows.filter((r) =>
            [r.title, r.target, r.cve, r.evidence].map((v) => String(v ?? "").toLowerCase()).some((v) => v.includes(kw)),
          );
        }
        const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));
        if (!rows.length) return text("没有符合条件的漏洞。");
        return text(`共 ${rows.length} 条，显示 ${Math.min(limit, rows.length)} 条：\n` + rows.slice(0, limit).map((r) => Ledger.describe("vuln", r)).join("\n"));
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });

  add({
    name: "redteam_vuln_update",
    description: "更新漏洞状态或补充证据。claimed → confirmed 必须附实测证据；利用成功后写 status=exploited。",
    input: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: VULN_STATUS },
        confidence: { type: "string", enum: CONFIDENCE },
        evidence: { type: "string", description: "追加证据，会拼在原有内容后" },
        note: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        const cur = await ledger.get("vuln", String(input.id));
        if (!cur) return text(`错误：没有漏洞 ${input.id}`);
        const patch: Record<string, any> = {};
        if (input.status) patch.status = input.status;
        if (input.confidence) patch.confidence = input.confidence;
        if (input.note !== undefined) patch.note = input.note;
        if (input.evidence) {
          const prev = String(cur.evidence || "");
          patch.evidence = prev ? `${prev}\n${input.evidence}` : String(input.evidence);
        }
        const rec = await ledger.update("vuln", String(input.id), patch);
        return text(`已更新 ${Ledger.describe("vuln", rec!)}`);
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });

  add({
    name: "redteam_evidence_add",
    description:
      "记一条证据：原始请求/响应摘要 + 结论。会自动算内容 hash 便于核对。" +
      "confidence 默认 claimed；实测通过写 observed。请求里不要放明文口令，用占位符。",
    input: {
      type: "object",
      properties: {
        kind: { type: "string", description: "类型：http / shell / login / screenshot / dump" },
        target: { type: "string" },
        request: { type: "string", description: "原始请求：方法、URL、关键头、body 摘要" },
        response: { type: "string", description: "原始响应摘要：状态码、关键 body" },
        summary: { type: "string", description: "结论：说明能证明什么" },
        confidence: { type: "string", enum: CONFIDENCE },
        refId: { type: "string", description: "关联资产/漏洞 id" },
      },
      required: ["kind", "target", "summary"],
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        const req = String(input.request || "");
        const res = String(input.response || "");
        const rec = await ledger.add("ev", {
          kind: String(input.kind),
          target: String(input.target),
          request: req,
          response: res,
          summary: String(input.summary),
          confidence: input.confidence ?? "claimed",
          refId: input.refId ?? "",
          hash: digest(`${req}\n---\n${res}\n---\n${input.summary}`),
        });
        return text(`已记 ${Ledger.describe("ev", rec)} hash=${rec.hash}`);
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });

  add({
    name: "redteam_evidence_list",
    description: "列证据并统计未核实数量。confidence=claimed 的条目在汇报时不能当已得手说。",
    input: {
      type: "object",
      properties: {
        confidence: { type: "string", enum: CONFIDENCE },
        refId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        let rows = await ledger.list("ev");
        if (input.refId) rows = rows.filter((r) => r.refId === input.refId);
        const unverified = rows.filter((r) => r.confidence === "claimed" || r.confidence === "inferred").length;
        if (input.confidence) rows = rows.filter((r) => r.confidence === input.confidence);
        const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));
        const head = `证据共 ${rows.length} 条，未核实 ${unverified} 条。`;
        if (!rows.length) return text(head);
        return text(head + "\n" + rows.slice(0, limit).map((r) => `${Ledger.describe("ev", r)} — ${String(r.summary).slice(0, 100)}`).join("\n"));
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });

  add({
    name: "redteam_evidence_verify",
    description:
      "把一条 claimed 证据升为 observed：必须给出本次实测的结果摘要，工具会把旧结论与新结果一起记下。" +
      "没有实测别调这个工具。",
    input: {
      type: "object",
      properties: {
        id: { type: "string" },
        verifiedResult: { type: "string", description: "本次实测得到的实际结果" },
      },
      required: ["id", "verifiedResult"],
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        const cur = await ledger.get("ev", String(input.id));
        if (!cur) return text(`错误：没有证据 ${input.id}`);
        const verified = String(input.verifiedResult || "").trim();
        if (!verified) return text("错误：verifiedResult 不能为空");
        const rec = await ledger.update("ev", String(input.id), {
          confidence: "observed",
          verifiedResult: verified,
          verifiedAt: new Date().toISOString(),
          verifyHash: digest(verified),
        });
        return text(`已核实 ${Ledger.describe("ev", rec!)}（原结论=${String(cur.summary).slice(0, 60)}）`);
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });
}
