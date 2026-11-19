/**
 * 红队行动工具：凭证 / 会话 / 攻击链。
 *
 * 凭据只记引用（secretRef），不记明文口令 —— 台账可能被同步、截图、交接。
 * 会话记的是"从哪进、能到哪、走什么通道"，不是具体 exploit 代码。
 */
import { Ledger } from "./store.mts";

const text = (s: string) => ({ content: s });

const CRED_KIND = ["password", "hash", "key", "token", "cookie", "ticket"] as const;
const SESS_KIND = ["webshell", "reverse-shell", "tunnel", "rdp", "ssh", "database", "other"] as const;
const SESS_STATUS = ["active", "stale", "dead"] as const;
const STAGE = ["recon", "internet", "boundary", "internal", "target"] as const;

export function registerOpsTools(ledger: Ledger, add: (t: any) => void): void {
  add({
    name: "redteam_credential_add",
    description:
      "记一条凭证。只记来源与引用，secretRef 写保存位置（文件名/条目名/备注键），不要贴明文口令。" +
      "kind 选 password/hash/key/token/cookie/ticket；hash 类要写算法（NTLM/NetNTLMv2）。",
    input: {
      type: "object",
      properties: {
        kind: { type: "string", enum: CRED_KIND },
        username: { type: "string" },
        source: { type: "string", description: "来源：配置泄露/注入点/口令复用/默认口令/凭据填充" },
        tool: { type: "string", description: "获取工具" },
        secretRef: { type: "string", description: "保存位置引用，不写明文" },
        hashType: { type: "string", description: "hash 类型，如 NTLM/NetNTLMv2" },
        note: { type: "string" },
      },
      required: ["kind", "username", "source"],
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        const rec = await ledger.add("cred", {
          kind: input.kind,
          username: String(input.username),
          source: String(input.source),
          tool: input.tool ?? "",
          secretRef: input.secretRef ?? "",
          hashType: input.hashType ?? "",
          note: input.note ?? "",
        });
        return text(`已记 ${Ledger.describe("cred", rec)}`);
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });

  add({
    name: "redteam_credential_list",
    description: "列凭证。按 kind 或来源过滤。",
    input: {
      type: "object",
      properties: {
        kind: { type: "string", enum: CRED_KIND },
        keyword: { type: "string" },
      },
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        let rows = await ledger.list("cred");
        if (input.kind) rows = rows.filter((r) => r.kind === input.kind);
        const kw = String(input.keyword || "").toLowerCase();
        if (kw) rows = rows.filter((r) => [r.username, r.source, r.note].map((v) => String(v ?? "").toLowerCase()).some((v) => v.includes(kw)));
        if (!rows.length) return text("没有符合条件的凭证。");
        return text(`共 ${rows.length} 条：\n` + rows.map((r) => Ledger.describe("cred", r)).join("\n"));
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });

  add({
    name: "redteam_session_add",
    description:
      "记一个已拿到的会话或通道：webshell / 反弹 shell / 隧道 / RDP / SSH / 数据库。" +
      "entry 写入口（WebShell URL 或跳板），reach 写可达范围，listen 写本地监听地址（如 127.0.0.1:1080）。" +
      "只有自己 VPS 上能连、到不了目标内网的，entryKind 写 self-only，不算边界突破。",
    input: {
      type: "object",
      properties: {
        kind: { type: "string", enum: SESS_KIND },
        target: { type: "string", description: "目标资产" },
        entry: { type: "string", description: "入口地址/URL" },
        entryKind: { type: "string", description: "target-http / self-only / vpn / other" },
        reach: { type: "string", description: "可达范围" },
        listen: { type: "string", description: "本地监听，如 127.0.0.1:1080" },
        command: { type: "string", description: "起通道的命令（脱敏）" },
        status: { type: "string", enum: SESS_STATUS },
        note: { type: "string" },
      },
      required: ["kind", "target"],
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        const rec = await ledger.add("sess", {
          kind: input.kind,
          target: String(input.target),
          entry: input.entry ?? "",
          entryKind: input.entryKind ?? "",
          reach: input.reach ?? "",
          listen: input.listen ?? "",
          command: input.command ?? "",
          status: input.status ?? "active",
          note: input.note ?? "",
        });
        return text(`已记 ${Ledger.describe("sess", rec)}`);
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });

  add({
    name: "redteam_session_list",
    description: "列会话/通道。status=active 的才是可用入口；stale/dead 的别当还能用。",
    input: {
      type: "object",
      properties: {
        kind: { type: "string", enum: SESS_KIND },
        status: { type: "string", enum: SESS_STATUS },
      },
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        let rows = await ledger.list("sess");
        if (input.kind) rows = rows.filter((r) => r.kind === input.kind);
        if (input.status) rows = rows.filter((r) => r.status === input.status);
        if (!rows.length) return text("没有符合条件的会话。");
        const active = rows.filter((r) => r.status === "active").length;
        return text(`共 ${rows.length} 条，可用 ${active} 条：\n` + rows.map((r) => Ledger.describe("sess", r)).join("\n"));
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });

  add({
    name: "redteam_chain_add",
    description:
      "记一步攻击链：阶段 + 工具 + 命令原文 + 结果摘要。stage 用 recon/internet/boundary/internal/target，" +
      "对应 侦察/拿到互联网资产权限/边界突破/内网资产权限/拿下靶标。" +
      "命令原文照抄（脱敏口令），下次复现靠它。",
    input: {
      type: "object",
      properties: {
        stage: { type: "string", enum: STAGE },
        tool: { type: "string", description: "实际工具/命令，如 nuclei -t xxx.yaml -u http://x" },
        result: { type: "string", description: "结果摘要" },
        target: { type: "string" },
        note: { type: "string" },
      },
      required: ["stage", "tool", "result"],
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        const rec = await ledger.add("chain", {
          stageCode: input.stage,
          tool: String(input.tool),
          result: String(input.result),
          target: input.target ?? "",
          note: input.note ?? "",
        });
        return text(`已记 ${Ledger.describe("chain", rec)}`);
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });

  add({
    name: "redteam_chain_list",
    description: "按时间列攻击链。stage 可过滤。",
    input: {
      type: "object",
      properties: {
        stage: { type: "string", enum: STAGE },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    execute: async (input: any) => {
      try {
        let rows = await ledger.list("chain");
        if (input.stage) rows = rows.filter((r) => r.stageCode === input.stage);
        const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));
        if (!rows.length) return text("链条为空。");
        return text(`共 ${rows.length} 步：\n` + rows.slice(-limit).map((r) => Ledger.describe("chain", r)).join("\n"));
      } catch (e: any) {
        return text(`错误：${e?.message || String(e)}`);
      }
    },
  });
}
