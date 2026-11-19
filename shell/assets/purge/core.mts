/**
 * purge 插件共享逻辑：配置、路径、提示词解析。
 * 扩展名必须是 .mts —— TUI 侧对 .ts 只做类型剥离，命名导出会丢（见 opencode 技能坑 1）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Config = {
  enabled: boolean;
  /** 没有专属配置的模型是否也注入默认正文；false = 只有 perModel 里点名的模型才注入 */
  injectDefault: boolean;
  promptFile: string;
  /** 模型 id（或其后缀）→ 提示词文件；用于「一个模型一份破甲」 */
  perModel: Record<string, string>;
  /** 关键词 → 提示词文件：模型 id 里带这个词就用对应正文；优先级低于 perModel */
  keywordMap: Record<string, string>;
  temperature: number | null;
  maxTokens: number | null;
  tools: { deny: string[] };
  verbose: boolean;
};

const DEFAULTS: Config = {
  enabled: true,
  injectDefault: true,
  promptFile: "prompt-inject.md",
  perModel: {},
  keywordMap: {
    glm: "prompts/glm.md",
    gpt: "prompts/gpt.md",
    deepseek: "prompts/deepseek.md",
    claude: "prompts/claude.md",
    grok: "prompts/grok.md",
    gemini: "prompts/gemini.md",
  },
  temperature: null,
  maxTokens: null,
  tools: { deny: [] },
  verbose: false,
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 最近一次读 config.json 的解析错误；空串表示正常。供 /purge 状态展示。 */
let configError = "";
export function readConfigError(): string {
  return configError;
}

export function dataDir(): string {
  return path.join(os.homedir(), ".config", "opencode", "purge");
}

export function configPath(): string {
  return path.join(dataDir(), "config.json");
}

export function statePath(): string {
  return path.join(dataDir(), "state.json");
}

export function logPath(): string {
  return path.join(dataDir(), "purge.log");
}

/** 内置默认提示词（随插件走，用户没自建 prompt-inject.md 时用它） */
export function bundledPromptPath(): string {
  return path.join(MODULE_DIR, "prompts", "default.md");
}

/** 提示词文件的绝对路径：绝对路径原样用，相对路径相对 dataDir */
export function promptPath(cfg: Config): string {
  const raw = String(cfg.promptFile || DEFAULTS.promptFile).trim();
  if (!raw) return path.join(dataDir(), DEFAULTS.promptFile);
  return path.isAbsolute(raw) ? raw : path.join(dataDir(), raw);
}

function coerceNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 关键词表：默认五项（glm/gpt/deepseek/claude/grok），配置里可以覆盖、加新词，
 * 也可以把某一项设成空串/null 来单独关掉（`keywordMap: false` 全部关掉）。
 * key 统一转小写，匹配时对模型 id 也转小写，避免 GLM-5.3 / glm-5.3 这类大小写差异。
 */
function normalizeKeywordMap(raw: any): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULTS.keywordMap };
  if (raw === false) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim().toLowerCase();
    if (!key) continue;
    if (v === null || v === "" || v === false) delete out[key];
    else if (typeof v === "string" && v.trim()) out[key] = v;
  }
  return out;
}

function normalize(raw: any): Config {
  const src = raw && typeof raw === "object" ? raw : {};
  const tools = src.tools && typeof src.tools === "object" ? src.tools : {};
  const deny = Array.isArray(tools.deny) ? tools.deny.map((x: any) => String(x)) : [];
  const perModel: Record<string, string> = {};
  if (src.perModel && typeof src.perModel === "object") {
    for (const [k, v] of Object.entries(src.perModel)) {
      if (typeof v === "string" && v.trim()) perModel[String(k)] = v;
    }
  }
  return {
    enabled: src.enabled === undefined ? DEFAULTS.enabled : src.enabled !== false && src.enabled !== "false",
    injectDefault:
      src.injectDefault === undefined ? DEFAULTS.injectDefault : src.injectDefault !== false && src.injectDefault !== "false",
    promptFile: typeof src.promptFile === "string" && src.promptFile.trim() ? src.promptFile : DEFAULTS.promptFile,
    perModel,
    keywordMap: normalizeKeywordMap(src.keywordMap),
    temperature: coerceNumber(src.temperature),
    maxTokens: coerceNumber(src.maxTokens),
    tools: { deny },
    verbose: src.verbose === true || src.verbose === "true",
  };
}

/** 写文件：先写临时文件再改名，避免读的一方读到半截 */
function writeAtomic(fp: string, text: string): void {
  const tmp = `${fp}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, fp);
}

function readRawConfig(): any {
  configError = "";
  let raw = "";
  try {
    raw = fs.readFileSync(configPath(), "utf8");
  } catch {
    return {};
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    configError = `config.json 不是合法 JSON（${String((e as any)?.message || e)}），已按默认值运行`;
    return {};
  }
}

export function readConfig(options?: any): Config {
  const fromFile = readRawConfig();
  // opencode.json 里的 plugin options 优先于配置文件（方便按项目覆盖）
  const merged = { ...fromFile, ...(options && typeof options === "object" ? options : {}) };
  return normalize(merged);
}

/**
 * 只写 config.json，且以磁盘现有内容为基准合并。
 * 注意：不要拿 readConfig() 的结果回写 —— 那会把 plugin options 的值固化进文件，
 * 之后 /purge on|off 就盖不动 options 了。
 */
export function writeConfig(patch: Partial<Config>): Config {
  const disk = readRawConfig();
  if (configError) {
    // 坏文件先备份，再覆盖，避免用户手改的其余字段被直接吞掉
    try {
      fs.copyFileSync(configPath(), `${configPath()}.invalid`);
    } catch {
      /* 备份失败不挡写入 */
    }
  }
  const next = normalize({ ...normalize(disk), ...patch });
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    writeAtomic(configPath(), JSON.stringify(next, null, 2) + "\n");
  } catch {
    /* 写不进去不抛：调用方回报状态即可 */
  }
  return next;
}

/** 剥掉 dsh 的 ChatML 信封；用户把原版提示词直接粘进来也不会出现第二套信封 */
export function stripChatml(text: string): string {
  return String(text || "")
    .replace(/^\s*<\|im_start\|>\s*system\s*:\s*/i, "")
    .replace(/<\|im_end\|>/g, "")
    .replace(/^\s*<\/?project_instructions>\s*$/gim, "")
    .trim();
}

export type Resolved = {
  text: string;
  source: "file" | "bundled" | "none";
  path: string;
  bytes: number;
};

export type ModelRef = { providerID?: string; id?: string };

/** 模型专属提示词的文件路径：绝对路径原样；`prompts/` 开头先找插件自带，再找数据目录 */
export function promptPathFor(cfg: Config, file: string): string {
  const raw = String(file || "").trim();
  if (!raw) return promptPath(cfg);
  if (path.isAbsolute(raw)) return raw;
  const bundled = path.join(MODULE_DIR, raw);
  if (fs.existsSync(bundled)) return bundled;
  return path.join(dataDir(), raw);
}

/**
 * 按模型挑提示词：`perModel` 的 key 支持三种写法 ——
 *   `providerID/modelID`、`modelID`、以及 modelID 的后缀（如 `workbuddy/deepseek-v4.1-flash`）。
 * 返回空串表示这个模型没有专属配置，走默认。
 */
export function perModelPrompt(cfg: Config, ref?: ModelRef): string {
  const map = cfg.perModel || {};
  const keys = Object.keys(map);
  if (!keys.length) return "";
  const pid = String(ref?.providerID || "");
  const mid = String(ref?.id || "");
  if (!pid && !mid) return "";
  const full = pid && mid ? `${pid}/${mid}` : mid;
  for (const k of keys) if (k === full || k === mid) return map[k];
  for (const k of keys) if (mid && (mid.endsWith(k) || full.endsWith(k))) return map[k];
  return "";
}

// 提示词缓存：按 mtime + size 失效。14KB 正文每个请求重读一次没必要，
// 也缩短了「正好在写文件时读到半截」的窗口。
let promptCache: { key: string; resolved: Resolved } | null = null;

function readPromptFile(fp: string): Resolved | null {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(fp);
  } catch {
    return null;
  }
  const key = `${fp}\u0000${stat.mtimeMs}\u0000${stat.size}`;
  if (promptCache && promptCache.key === key) return promptCache.resolved;
  try {
    const text = stripChatml(fs.readFileSync(fp, "utf8"));
    if (!text) return null;
    const resolved: Resolved = { text, source: "file", path: fp, bytes: text.length };
    promptCache = { key, resolved };
    return resolved;
  } catch {
    return null;
  }
}

/**
 * 关键词命中：模型 id（不含 provider）里包含哪个关键词，就用它对应的文件。
 * 大小写不敏感，长关键词优先（自定义短词不会抢掉 deepseek 这类长词）。
 * 返回空串表示没命中。
 */
export function keywordPrompt(cfg: Config, ref?: ModelRef): string {
  const map = cfg.keywordMap || {};
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  if (!keys.length) return "";
  const mid = String(ref?.id || "").toLowerCase();
  if (!mid) return "";
  for (const key of keys) if (mid.includes(key)) return map[key];
  return "";
}

/** 模型专属提示词 > 关键词 > 磁盘文件 > 内置默认 > 空。 */
export function resolvePrompt(cfg: Config, ref?: ModelRef): Resolved {
  const per = perModelPrompt(cfg, ref);
  if (per) {
    const fromPer = readPromptFile(promptPathFor(cfg, per));
    if (fromPer) return fromPer;
  }
  const kw = keywordPrompt(cfg, ref);
  if (kw) {
    const fromKeyword = readPromptFile(promptPathFor(cfg, kw));
    if (fromKeyword) return fromKeyword;
  }
  if (!cfg.injectDefault) return { text: "", source: "none", path: promptPath(cfg), bytes: 0 };
  const fp = promptPath(cfg);
  const fromDisk = fp === bundledPromptPath() ? null : readPromptFile(fp);
  if (fromDisk) return fromDisk;
  const bundled = readPromptFile(bundledPromptPath());
  if (bundled) return { ...bundled, path: bundledPromptPath() };
  return { text: "", source: "none", path: fp, bytes: 0 };
}

/** 首次启动把内置提示词落到 dataDir，用户之后可以直接改这个文件 */
export function seedPromptIfMissing(cfg: Config): { seeded: boolean; path: string } {
  const fp = promptPath(cfg);
  if (fs.existsSync(fp)) return { seeded: false, path: fp };
  try {
    const text = fs.readFileSync(bundledPromptPath(), "utf8");
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    writeAtomic(fp, text);
    return { seeded: true, path: fp };
  } catch {
    return { seeded: false, path: fp };
  }
}

export function readState(): any {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}

export function writeState(state: any): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    writeAtomic(statePath(), JSON.stringify(state, null, 2) + "\n");
  } catch {
    /* ignore */
  }
}
