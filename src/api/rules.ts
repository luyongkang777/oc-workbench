import { localRequest } from './client'

/**
 * 强制规则（rules）的接口层。
 *
 * 规则是条目（单行 / 标题+内容），不是一大块正文。
 * 判定不在前端也不在外壳 —— 由 `~/.config/opencode/plugins/rules` 插件
 * 在每次模型请求和每次工具执行前读文件校验，所以工作台关掉也照样生效。
 *
 * 类型与纯函数在 `components/rulesFormat.ts`（那边没有 client 依赖，能单测）。
 */
export type { RuleDraft, RuleItem, RuleScope, RuleSource, RulesStatus } from '../components/rulesFormat'
export { coverageText, normalizeItems, toDrafts } from '../components/rulesFormat'

import type { RuleDraft, RuleItem, RulesStatus } from '../components/rulesFormat'

export async function getRulesStatus(directory: string, signal?: AbortSignal): Promise<RulesStatus> {
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : ''
  return localRequest<RulesStatus>(`/local/rules/status${query}`, signal)
}

/** 整份覆盖保存某一级规则。空内容条目会被后端丢掉。 */
export async function saveRule(
  scope: 'global' | 'local',
  directory: string,
  items: Array<RuleItem | RuleDraft>,
): Promise<RulesStatus> {
  return localRequest<RulesStatus>('/local/rules/save', undefined, 20_000, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope, directory, items }),
  })
}
