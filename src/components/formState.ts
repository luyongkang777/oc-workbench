/** 表单（question 工具）答案的纯计算：初始化、勾选、完整性判断、转成 API 载荷。 */
import type { FormField } from '../api/chat'

export type AnswerValue = string | number | boolean | string[]
export type Answers = Record<string, AnswerValue | undefined>
/** 每个字段的「其他」自定义输入（多选时追加到数组里） */
export type CustomText = Record<string, string>

export function emptyAnswers(fields: FormField[]): Answers {
  const out: Answers = {}
  for (const field of fields) {
    out[field.key] = field.type === 'multiselect' ? [] : undefined
  }
  return out
}

export function isFieldAnswered(field: FormField, value: AnswerValue | undefined, custom = ''): boolean {
  if (field.type === 'multiselect') {
    const list = Array.isArray(value) ? value : []
    return list.length > 0 || custom.trim().length > 0
  }
  if (field.type === 'boolean') return typeof value === 'boolean'
  if (field.type === 'number' || field.type === 'integer') {
    return typeof value === 'number' && Number.isFinite(value)
  }
  if (custom.trim()) return true
  return typeof value === 'string' && value.trim().length > 0
}

export function formComplete(fields: FormField[], answers: Answers, custom: CustomText = {}): boolean {
  return fields.every((field) => isFieldAnswered(field, answers[field.key], custom[field.key] ?? ''))
}

/** 单选/多选点击：单选直接覆盖，多选切换某一项。 */
export function toggleChoice(
  field: FormField,
  value: AnswerValue | undefined,
  option: string,
): AnswerValue {
  if (field.type !== 'multiselect') return option
  const list = Array.isArray(value) ? value : []
  return list.includes(option) ? list.filter((item) => item !== option) : [...list, option]
}

/** 转成 POST /form/:id/reply 的 answer：多选数组、数字转 number、自定义文字优先。 */
export function toReply(
  fields: FormField[],
  answers: Answers,
  custom: CustomText = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    const value = answers[field.key]
    const text = (custom[field.key] ?? '').trim()
    if (field.type === 'multiselect') {
      const list = Array.isArray(value) ? [...value] : []
      if (text) list.push(text)
      const unique = Array.from(new Set(list.map((item) => String(item)).filter(Boolean)))
      if (unique.length) out[field.key] = unique
      continue
    }
    if (field.type === 'number' || field.type === 'integer') {
      if (typeof value === 'number' && Number.isFinite(value)) {
        out[field.key] = field.type === 'integer' ? Math.trunc(value) : value
      }
      continue
    }
    if (field.type === 'boolean') {
      if (typeof value === 'boolean') out[field.key] = value
      continue
    }
    const answer = text || (typeof value === 'string' ? value.trim() : '')
    if (answer) out[field.key] = answer
  }
  return out
}
