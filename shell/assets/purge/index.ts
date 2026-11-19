/**
 * purge — OpenCode 服务端插件，dsh-purge 的插件层等价实现。
 *
 * 做三件事：
 *   1. 每个模型请求把操作者正文注入系统提示（context hook）
 *   2. 按配置放宽生成参数（temperature / maxTokens）
 *   3. 按配置摘除工具（tools.deny）
 *
 * 命令：/purge [status|on|off|edit|reload]、/purge-on、/purge-off、/purge-edit、/purge-reload
 *
 * 不做源码补丁（opencode 是 Bun 单文件 exe，没有可改的 JS），也不做演练台。
 */
import { Plugin } from "@opencode/plugin";
import * as fs from "node:fs";
import * as core from "./core.mts";
import { registerRedteam } from "./redteam/index.mts";

/** temperature 超出 [0,2] 会被 provider 400；这里先夹住，别把整次请求搞挂 */
function clampTemperature(v: number): number {
  return Math.min(2, Math.max(0, v));
}

/** maxTokens 必须是正整数；上限交给 provider，这里只挡 0/负数/小数 */
function clampMaxTokens(v: number): number {
  return Math.max(1, Math.floor(v));
}

export default Plugin.define({
  id: "purge",

  async setup(ctx: any) {
    const options = ctx?.options;

    // 红队模式：注册 redteam_* 工具与 /redteam 命令。失败不挡破甲注入。
    try {
      await registerRedteam(ctx);
    } catch (e: any) {
      console.log("purge redteam init failed:", e?.message || String(e));
    }

    // ---- 配置缓存：按 mtime 失效，避免每个请求都读盘解析
    let cfgCache = { at: 0, mtime: -1, cfg: core.readConfig(options) };
    function cfg(): core.Config {
      if (Date.now() - cfgCache.at > 5000) {
        let mtime = -1;
        try {
          mtime = fs.statSync(core.configPath()).mtimeMs;
        } catch {
          mtime = -1;
        }
        if (mtime !== cfgCache.mtime) cfgCache = { at: Date.now(), mtime, cfg: core.readConfig(options) };
        else cfgCache.at = Date.now();
      }
      return cfgCache.cfg;
    }

    // ---- 首次启动把内置提示词落到数据目录（用户之后改这个文件）
    const seeded = core.seedPromptIfMissing(cfg());

    // ---- 运行时统计（内存 + 节流落盘，供 /purge 查看）
    const prev = core.readState();
    const stats = {
      requests: Number(prev.requests) || 0,
      injects: Number(prev.injects) || 0,
      lastSource: String(prev.lastSource || ""),
      lastBytes: Number(prev.lastBytes) || 0,
      lastAt: Number(prev.lastAt) || 0,
      seeded: seeded.seeded,
      bootedAt: Date.now(),
    };
    let lastPersist = 0;
    function persist(force = false) {
      const now = Date.now();
      if (!force && now - lastPersist < 2000) return;
      lastPersist = now;
      core.writeState({ ...stats, updatedAt: now });
    }
    persist(true);

    const LOG_MAX = 512 * 1024;
    function log(...parts: any[]) {
      if (!cfg().verbose) return;
      try {
        const fp = core.logPath();
        try {
          if (fs.statSync(fp).size > LOG_MAX) fs.rmSync(fp, { force: true });
        } catch {
          /* 文件还不存在 */
        }
        const line = `[${new Date().toISOString()}] ${parts
          .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
          .join(" ")}\n`;
        fs.appendFileSync(fp, line, "utf8");
      } catch {
        /* 日志失败不挡注入 */
      }
    }

    // ---- 注入：每个模型请求前调用（agent loop 的每一步）
    await ctx.session.hook("context", (event: any) => {
      // hook 里抛异常会让这一轮请求直接失败，整段兜住
      try {
        const c = cfg();
        stats.requests++;

        // 参数与工具闸门不依赖 system，先做
        if (c.enabled && event?.options && typeof event.options === "object") {
          if (c.temperature !== null) event.options.temperature = clampTemperature(c.temperature);
          if (c.maxTokens !== null) event.options.maxTokens = clampMaxTokens(c.maxTokens);
        }
        if (c.enabled && event?.tools && typeof event.tools === "object") {
          for (const name of c.tools.deny) {
            try {
              delete event.tools[name];
            } catch {
              /* 工具不存在就算了 */
            }
          }
        }

        if (!c.enabled) {
          persist();
          return;
        }
        const modelRef = {
          providerID: String(event?.model?.providerID ?? ""),
          id: String(event?.model?.id ?? event?.model?.modelID ?? ""),
        };
        const resolved = core.resolvePrompt(c, modelRef);
        if (!resolved.text) {
          persist();
          return;
        }
        if (!Array.isArray(event?.system)) {
          log("inject skipped: event.system is not an array");
          return;
        }
        event.system.push({ type: "text", text: resolved.text });
        stats.injects++;
        stats.lastSource = resolved.source;
        stats.lastBytes = resolved.bytes;
        stats.lastAt = Date.now();
        persist();
        log("inject", {
          source: resolved.source,
          bytes: resolved.bytes,
          temp: c.temperature,
          model: modelRef.id,
          file: resolved.path.replace(/^.*[\\/]/, ""),
        });
      } catch (e) {
        try {
          log("hook error", String((e as any)?.message || e));
        } catch {
          /* 兜底 */
        }
      }
    });

    // ---- 命令
    async function say(sessionID: string, text: string) {
      try {
        await ctx.session.synthetic({ sessionID, text, description: "purge" });
      } catch (e) {
        log("synthetic failed", String((e as any)?.message || e));
      }
    }

    function statusText(): string {
      const c = cfg();
      const r = core.resolvePrompt(c);
      const when = stats.lastAt ? new Date(stats.lastAt).toLocaleString() : "从未";
      const lines = [
        `purge: ${c.enabled ? "开" : "关"}`,
        `提示词来源: ${r.source === "file" ? "磁盘文件" : r.source === "bundled" ? "内置默认" : "无（不注入）"}`,
        `文件: ${r.path}`,
        `大小: ${r.bytes} 字符`,
        `参数: temperature=${c.temperature ?? "默认"} maxTokens=${c.maxTokens ?? "默认"}`,
        `摘除工具: ${c.tools.deny.length ? c.tools.deny.join(", ") : "无"}`,
        `模型专属: ${Object.keys(c.perModel).length ? Object.keys(c.perModel).join(", ") : "无（全部走默认）"}`,
        `关键词: ${Object.keys(c.keywordMap || {}).length ? Object.entries(c.keywordMap).map(([k, v]) => `${k}→${v}`).join(", ") : "无"}`,
        `注入范围: ${c.injectDefault ? "默认正文对所有模型生效" : "只对上面点名的模型 / 关键词命中的模型生效"}`,
        `注入次数: ${stats.injects}（最近 ${when}）`,
      ];
      const bad = core.readConfigError();
      if (bad) lines.push(`⚠ ${bad}`);
      if (stats.seeded) lines.push(`首次启动已把内置提示词写入 ${r.path}`);
      return lines.join("\n");
    }

    const CMD_DESC = "破甲注入：查看状态、开关、显示提示词文件路径";

    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "purge",
        description: CMD_DESC,
        execute: async ({ sessionID, prompt }: any) => {
          const sid = String(sessionID);
          const arg = String(prompt?.text ?? "").trim().toLowerCase();
          if (!arg || arg === "status") return say(sid, statusText());
          if (arg === "on") {
            core.writeConfig({ enabled: true });
            cfgCache.at = 0;
            return say(sid, "purge 已开启（下一条消息生效）");
          }
          if (arg === "off") {
            core.writeConfig({ enabled: false });
            cfgCache.at = 0;
            return say(sid, "purge 已关闭（下一条消息生效，已注入的内容不会撤回）");
          }
          if (arg === "edit" || arg === "path") return say(sid, `提示词文件：\n${core.promptPath(cfg())}`);
          if (arg === "reload") {
            cfgCache.at = 0;
            return say(sid, "配置与提示词按需读取：改完文件即生效，无需重启。\n" + statusText());
          }
          return say(sid, `未知参数 "${arg}"。用法：/purge [status|on|off|edit|reload]`);
        },
      });

      editor.add({
        name: "purge-on",
        description: "开启破甲注入",
        execute: async ({ sessionID }: any) => {
          core.writeConfig({ enabled: true });
          cfgCache.at = 0;
          await say(String(sessionID), "purge 已开启（下一条消息生效）");
        },
      });

      editor.add({
        name: "purge-off",
        description: "关闭破甲注入",
        execute: async ({ sessionID }: any) => {
          core.writeConfig({ enabled: false });
          cfgCache.at = 0;
          await say(String(sessionID), "purge 已关闭（下一条消息生效）");
        },
      });

      editor.add({
        name: "purge-edit",
        description: "显示提示词文件路径（改完立即生效）",
        execute: async ({ sessionID }: any) => {
          await say(String(sessionID), `提示词文件：\n${core.promptPath(cfg())}\n改完直接生效，不需要重启。`);
        },
      });

      editor.add({
        name: "purge-reload",
        description: "重新读取配置并打印状态",
        execute: async ({ sessionID }: any) => {
          cfgCache.at = 0;
          await say(String(sessionID), statusText());
        },
      });
    });

    return () => {
      persist(true);
    };
  },
});
