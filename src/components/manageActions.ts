/**
 * `/mcps`、`/skills` 面板里可以单测的纯逻辑。
 *
 * 抽出来是因为组件是 .tsx（带 JSX），node --experimental-strip-types 跑不了；
 * 这里只放「状态 → 能做什么」「技能 → 提示词」这类没有副作用的函数。
 */
import type { McpStatus } from './mcpStatus'
import type { SkillInfo } from './skillList'

export type McpAction = { kind: 'connect' | 'disconnect'; label: string }

/**
 * 按 MCP 状态决定能做什么。
 *   disabled      → 连接
 *   failed/授权   → 重连（真的再试一次）+ 断开（停止重试）
 *   unknown       → 同上，给用户一个手动重试的入口
 *   connected/…   → 断开
 */
export function actionsFor(status: McpStatus): McpAction[] {
  if (status === 'disabled') return [{ kind: 'connect', label: '连接' }]
  if (status === 'failed' || status === 'needs_auth' || status === 'unknown') {
    return [
      { kind: 'connect', label: '重连' },
      { kind: 'disconnect', label: '断开' },
    ]
  }
  return [{ kind: 'disconnect', label: '断开' }]
}

/** 让模型真的去加载这个技能的提示词。 */
export function insertPrompt(skill: SkillInfo): string {
  return skill.path
    ? `请用 skill 工具加载技能「${skill.name}」（${skill.path}）`
    : `请用 skill 工具加载技能「${skill.name}」`
}
