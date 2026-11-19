/**
 * 多模型路由的 agent 配置生成/解析（纯函数，不 import React / fetch，node 直接可测）。
 *
 * 产物是 opencode 认的 Markdown agent 文件：
 *   <root>/.opencode/agents/router-main.md      mode: primary
 *   <root>/.opencode/agents/router-worker.md    mode: subagent
 *   <root>/.opencode/agents/router-reviewer.md  mode: subagent
 *
 * 这里只负责「文本 → 文本」，读写盘在 api/agents.ts，界面在 RouterPanel。
 */

export type RouterModel = {
  providerID: string
  id: string
  /** 推理档位（high / max …），没有就不写 */
  variant?: string
}

export type RouterRole = 'main' | 'worker' | 'reviewer'

export type RouterModels = Record<RouterRole, RouterModel>

/** 三个角色的固定 agent id。改这里要同步 RouterPanel 与验收脚本。 */
export const ROUTER_AGENT_NAMES: Record<RouterRole, string> = {
  main: 'router-main',
  worker: 'router-worker',
  reviewer: 'router-reviewer',
}

export const ROUTER_ROLES: RouterRole[] = ['main', 'worker', 'reviewer']

/** 角色中文名，报错和界面共用。 */
export const ROLE_LABELS: Record<RouterRole, string> = {
  main: '主脑',
  worker: '执行体',
  reviewer: '审核体',
}

/** `provider/model#variant`，空模型返回空串。 */
export function modelRef(model: RouterModel | undefined): string {
  if (!model || !model.providerID || !model.id) return ''
  const base = `${model.providerID}/${model.id}`
  return model.variant ? `${base}#${model.variant}` : base
}

/** 反解 `provider/model#variant`；按第一个 `/` 切 provider，剩余都算 model id。 */
export function parseModelRef(ref: string): RouterModel | undefined {
  const text = (ref ?? '').trim()
  if (!text) return undefined
  const hash = text.lastIndexOf('#')
  const variant = hash > 0 ? text.slice(hash + 1).trim() : ''
  const body = hash > 0 ? text.slice(0, hash) : text
  const slash = body.indexOf('/')
  if (slash <= 0 || slash === body.length - 1) return undefined
  const providerID = body.slice(0, slash).trim()
  const id = body.slice(slash + 1).trim()
  if (!providerID || !id) return undefined
  return variant ? { providerID, id, variant } : { providerID, id }
}

/** 两个模型是不是同一个（不看档位）。 */
export function sameModel(left: RouterModel | undefined, right: RouterModel | undefined): boolean {
  if (!left || !right) return false
  return left.providerID === right.providerID && left.id === right.id
}

// ---------------------------------------------------------------- 校验

/** 保存前校验；返回人话错误，空数组表示可以保存。 */
export function validateRouterModels(models: RouterModels): string[] {
  const errors: string[] = []
  for (const role of ROUTER_ROLES) {
    const model = models[role]
    if (!model || !model.providerID || !model.id) {
      errors.push(`请给「${ROLE_LABELS[role]}」选择一个模型`)
    }
  }
  if (models.worker?.providerID && models.reviewer?.providerID && sameModel(models.worker, models.reviewer)) {
    errors.push('审核体不能和执行体用同一个模型（等于自己审自己）')
  }
  return errors
}

// ---------------------------------------------------------------- 生成

/** 固定给每个角色加一条彩色，面板和 opencode 的 agent 列表里好认。 */
const ROLE_COLORS: Record<RouterRole, string> = {
  main: '#4dabf7',
  worker: '#69db7c',
  reviewer: '#ffa94d',
}

const ROLE_STEPS: Record<RouterRole, number> = { main: 60, worker: 80, reviewer: 40 }

const ROLE_DESCRIPTIONS: Record<RouterRole, string> = {
  main: '路由主脑：只思考、出方案、派子任务，不直接改文件也不跑命令',
  worker: '路由执行体：按主脑给的任务跑工具（含 IDA 等 MCP），只回结构化摘要',
  reviewer: '路由审核体：按主脑给的验收清单判定 PASS/FAIL，不改代码',
}

const MAIN_SYSTEM = `你是这套多模型路由的**主脑**。你只做决策，不碰文件、不跑命令。

<硬约束>
- 你没有 edit / shell 权限，想动手只能派 \`${ROUTER_AGENT_NAMES.worker}\`，想复核只能派 \`${ROUTER_AGENT_NAMES.reviewer}\`。
- 不要假装自己执行过：没有子代理的返回结果，就不要声称文件已改、命令已跑。
- 派活前先把任务写成自包含的一段：目标、涉及文件、验收标准。执行体没有你这轮对话的上下文。
</硬约束>

<工作流>
1. 读懂需求，列出 3~6 条**可机检**的验收标准（能写成命令或断言）。
2. 派 \`${ROUTER_AGENT_NAMES.worker}\` 执行，把验收标准一起给它。
3. 拿到摘要后派 \`${ROUTER_AGENT_NAMES.reviewer}\`，要求逐条判定 PASS/FAIL 并给文件:行号。
4. 判定 PASS：总结改了什么、怎么验证的，结束。
5. 判定 FAIL：把具体问题原样转给 \`${ROUTER_AGENT_NAMES.worker}\` 修，再重复第 3 步。
   最多 3 轮；到上限仍 FAIL 就如实汇报卡在哪，不要自己上手改。
</工作流>

<输出>
- 给用户的最终回复要短：结论 → 改动清单 → 验收结果。
- 过程细节留在子代理的会话里，不要复述它们的全文。`

const WORKER_SYSTEM = `你是这套多模型路由的**执行体**。你只执行，不做方案决策。

<职责>
- 按主脑给的任务动手：读写文件、跑命令、调 MCP（含 IDA 等）。
- 拿真实结果说话：跑过的命令给退出码和关键输出，改过的文件给路径。
- 遇到任务描述不清，选**最保守**的解释先做，并在摘要里写明你的假设。
</职责>

<禁止>
- 不要派子代理（你没有这个权限）。
- 不要长篇解释、不要复述整段代码、不要贴大段日志。
</禁止>

<输出格式>
固定四段，每段不超过 5 行：
1. 做了什么
2. 改了哪些文件（绝对路径或相对根路径）
3. 关键输出 / 结果（命令退出码、测试通过数、报错原文）
4. 风险或未完成项（没有就写「无」）`

const REVIEWER_SYSTEM = `你是这套多模型路由的**审核体**。你不改代码，只做判定。

<职责>
- 按主脑给的验收标准逐条核对，能跑命令就用命令验证，不能跑就读代码。
- 第一条输出必须是 \`VERDICT: PASS\` 或 \`VERDICT: FAIL\`，不要写别的开头。
- 每条结论后面给依据：命令输出摘要，或 \`文件:行号\`。
</职责>

<禁止>
- 不要修改任何文件（你没有 edit 权限）。
- 不要提「建议这样重构」这类方案性内容，只回答「符合/不符合」。
</禁止>

<输出格式>
VERDICT: PASS|FAIL
- [通过|不通过] <验收项> — <依据>
...（逐条）
不通过时最后加一行：FIX: <最小修复点>`

function systemFor(role: RouterRole): string {
  if (role === 'main') return MAIN_SYSTEM
  if (role === 'worker') return WORKER_SYSTEM
  return REVIEWER_SYSTEM
}

/** 主脑的权限：物理上拿不到 edit/shell，只能读和派子任务。 */
const MAIN_PERMISSIONS = `  - action: "*"
    resource: "*"
    effect: deny
  - action: read
    resource: "*"
    effect: allow
  - action: glob
    resource: "*"
    effect: allow
  - action: grep
    resource: "*"
    effect: allow
  - action: todo
    resource: "*"
    effect: allow
  - action: question
    resource: "*"
    effect: allow
  - action: skill
    resource: "*"
    effect: allow
  - action: subagent
    resource: "*"
    effect: deny
  - action: subagent
    resource: ${ROUTER_AGENT_NAMES.worker}
    effect: allow
  - action: subagent
    resource: ${ROUTER_AGENT_NAMES.reviewer}
    effect: allow`

/** 子代理：默认全开，但不能再派子代理、也不能问用户（用户看不到子会话）。 */
const CHILD_PERMISSIONS = `  - action: "*"
    resource: "*"
    effect: allow
  - action: subagent
    resource: "*"
    effect: deny
  - action: question
    resource: "*"
    effect: deny`

/** 审核体额外禁掉 edit，防止它「顺手修一下」。 */
const REVIEWER_PERMISSIONS = `${CHILD_PERMISSIONS}
  - action: edit
    resource: "*"
    effect: deny`

function yamlString(value: string): string {
  // 我们自己控制文案，不含单引号；仍然转义一次，避免以后改文案踩坑。
  return `'${value.replace(/'/g, "''")}'`
}

export type RouterAgentFile = {
  role: RouterRole
  /** 文件名（不含 .md） */
  name: string
  /** 完整 Markdown 内容 */
  content: string
}

/** 生成三个 agent 文件。模型不全时仍会生成，但调用方应先跑 validate。 */
export function buildRouterAgents(models: RouterModels): RouterAgentFile[] {
  return ROUTER_ROLES.map((role) => {
    const name = ROUTER_AGENT_NAMES[role]
    const ref = modelRef(models[role])
    const frontmatter = [
      '---',
      `description: ${yamlString(ROLE_DESCRIPTIONS[role])}`,
      `mode: ${role === 'main' ? 'primary' : 'subagent'}`,
      ...(ref ? [`model: ${ref}`] : []),
      `color: "${ROLE_COLORS[role]}"`,
      `steps: ${ROLE_STEPS[role]}`,
      'permissions:',
      role === 'main' ? MAIN_PERMISSIONS : role === 'reviewer' ? REVIEWER_PERMISSIONS : CHILD_PERMISSIONS,
      '---',
      '',
      systemFor(role),
      '',
    ].join('\n')
    return { role, name, content: frontmatter }
  })
}

// ---------------------------------------------------------------- 解析

export type ParsedRouterAgent = {
  name: string
  description?: string
  mode?: string
  model?: RouterModel
}

/** 只解析我们关心的 frontmatter 字段；解析不出就是 undefined，不抛。 */
export function parseRouterAgent(name: string, content: string): ParsedRouterAgent {
  const parsed: ParsedRouterAgent = { name }
  const text = content ?? ''
  const first = text.indexOf('---')
  if (first < 0) return parsed
  const second = text.indexOf('---', first + 3)
  if (second < 0) return parsed
  const body = text.slice(first + 3, second)
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if (!key || !value) continue
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1).replace(/''/g, "'")
    }
    if (key === 'description') parsed.description = value
    else if (key === 'mode') parsed.mode = value
    else if (key === 'model') parsed.model = parseModelRef(value)
  }
  return parsed
}

// ---------------------------------------------------------------- 状态

export type RouterStatus = {
  present: Record<RouterRole, boolean>
  /** 三个都在才叫 ready */
  ready: boolean
  missing: RouterRole[]
}

/** 传进来的可以是 agent id 列表，也可以是已解析的文件列表。 */
export function routerStatus(items: Array<string | { name: string }>): RouterStatus {
  const names = new Set(
    items
      .map((item) => (typeof item === 'string' ? item.trim() : item?.name?.trim() ?? ''))
      .filter(Boolean),
  )
  const present = {
    main: names.has(ROUTER_AGENT_NAMES.main),
    worker: names.has(ROUTER_AGENT_NAMES.worker),
    reviewer: names.has(ROUTER_AGENT_NAMES.reviewer),
  }
  const missing = ROUTER_ROLES.filter((role) => !present[role])
  return { present, ready: missing.length === 0, missing }
}

/** 从已解析的 agent 列表里挑出三个角色的模型，用于面板回显。 */
export function modelsFromAgents(agents: ParsedRouterAgent[]): Partial<RouterModels> {
  const result: Partial<RouterModels> = {}
  for (const agent of agents) {
    for (const role of ROUTER_ROLES) {
      if (agent.name === ROUTER_AGENT_NAMES[role] && agent.model) result[role] = agent.model
    }
  }
  return result
}
