/**
 * 红队模式挂载点：注册全部 redteam_* 工具与 /redteam 命令。
 *
 * 工具用 ctx.tool.transform 动态注册；台账落在 ctx.storage（插件作用域持久 JSON）。
 * 角色在 ~/.config/opencode/agents/redteam-*.md，用 subagent 工具拉起。
 */
import { Ledger } from "./store.mts";
import { registerAssetTools } from "./tools-asset.mts";
import { registerVulnTools } from "./tools-vuln.mts";
import { registerOpsTools } from "./tools-ops.mts";
import { registerScoreTools } from "./tools-score.mts";
import { totalize, type Hit } from "./score.mts";

export async function registerRedteam(ctx: any): Promise<void> {
  const ledger = new Ledger(ctx.storage);

  await ctx.tool.transform((editor: any) => {
    const add = (tool: any) => editor.add(tool);
    registerAssetTools(ledger, add);
    registerVulnTools(ledger, add);
    registerOpsTools(ledger, add);
    registerScoreTools(ledger, add);
  });

  await ctx.command.transform((cmd: any) => {
    cmd.add({
      name: "redteam",
      description: "红队台账：状态 / 设靶标 / 得分 / 交接",
      execute: async ({ sessionID, prompt }: any) => {
        const arg = String(prompt?.text ?? "").trim();
        const [head, ...rest] = arg.split(/\s+/);
        const tail = rest.join(" ").trim();
        let out = "";
        try {
          if (!head || head === "status") {
            out = await renderStatus(ledger);
          } else if (head === "open") {
            if (tail) await ledger.setEngagement(tail);
            out = await renderStatus(ledger);
          } else if (head === "score") {
            out = await renderScore(ledger);
          } else if (head === "handoff") {
            out = await renderHandoff(ledger, tail || "下一角色");
          } else {
            out = "用法：/redteam [status|open <靶标>|score|handoff [角色]]";
          }
        } catch (e: any) {
          out = `错误：${e?.message || String(e)}`;
        }
        try {
          await ctx.session.synthetic({ sessionID, text: out, description: "redteam" });
        } catch {
          /* 回报失败不挡台账 */
        }
      },
    });
  });
}

async function renderStatus(ledger: Ledger): Promise<string> {
  const [meta, counts, evs, sess, scores] = await Promise.all([
    ledger.meta(),
    ledger.counts(),
    ledger.list("ev"),
    ledger.list("sess"),
    ledger.list("score"),
  ]);
  const hits: Hit[] = scores.map((r) => ({
    code: String(r.code),
    target: String(r.target || ""),
    points: Number(r.points) || 0,
  }));
  const unverified = evs.filter((e) => e.confidence === "claimed" || e.confidence === "inferred").length;
  const active = sess.filter((s) => s.status === "active").length;
  return [
    `靶标：${meta.engagement || "未命名"}`,
    `总分：${totalize(hits).total}`,
    `资产 ${counts.asset} / 漏洞 ${counts.vuln} / 凭证 ${counts.cred} / 会话 ${counts.sess} / 证据 ${counts.ev} / 链条 ${counts.chain} / 得分 ${counts.score}`,
    `可用会话 ${active}；未核实证据 ${unverified}`,
    "角色：redteam-recon / redteam-assess / redteam-vuln-scan / redteam-exploit / redteam-internal",
  ].join("\n");
}

async function renderScore(ledger: Ledger): Promise<string> {
  const rows = await ledger.list("score");
  const hits: Hit[] = rows.map((r) => ({
    code: String(r.code),
    target: String(r.target || ""),
    points: Number(r.points) || 0,
  }));
  const t = totalize(hits);
  if (!t.items.length) return "还没有得分记录。";
  const lines = t.items.map((i) => {
    const capped = i.cap > 0 && i.raw > i.cap ? `（原始 ${i.raw}，封顶 ${i.cap}）` : "";
    return `${i.code} ${i.name}：${i.capped} 分${capped}`;
  });
  return `总分：${t.total}\n` + lines.join("\n");
}

async function renderHandoff(ledger: Ledger, next: string): Promise<string> {
  const [meta, assets, ec] = await Promise.all([ledger.meta(), ledger.list("asset"), ledger.list("ev")]);
  const high = assets.filter((a) => a.priority === "high" && !["tested", "abandoned"].includes(String(a.status)));
  const unverified = ec.filter((e) => e.confidence === "claimed" || e.confidence === "inferred").length;
  const lines = [
    `交接 → ${next}`,
    `靶标：${meta.engagement || "未命名"}；资产 ${assets.length}；高优先级待打 ${high.length}；未核实证据 ${unverified}`,
  ];
  if (high.length) lines.push("待打：\n" + high.slice(0, 10).map((a) => "- " + Ledger.describe("asset", a)).join("\n"));
  return lines.join("\n");
}
