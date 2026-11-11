/**
 * 选择模式：渲染 question 工具弹出的表单。
 *
 * 单选题点选项即可；多选题可多选；custom 字段给一个「其他（自己输入）」。
 * 所有字段都有答案才能提交，提交走 POST /form/:id/reply。
 */
import { useEffect, useMemo, useState } from 'react'
import type { FormField, FormInfo } from '../api/chat'
import {
  emptyAnswers,
  formComplete,
  toReply,
  toggleChoice,
  type Answers,
  type CustomText,
} from './formState'

type Props = {
  form: FormInfo
  onSubmit: (answer: Record<string, unknown>) => Promise<void>
  onSkip: () => void
}

export default function QuestionForm({ form, onSubmit, onSkip }: Props) {
  const [answers, setAnswers] = useState<Answers>(() => emptyAnswers(form.fields))
  const [custom, setCustom] = useState<CustomText>({})
  const [openCustom, setOpenCustom] = useState<Record<string, boolean>>({})
  const [submitting, setSubmitting] = useState(false)

  // 表单 id 变了才重置，避免每次轮询把用户已选的答案冲掉
  useEffect(() => {
    setAnswers(emptyAnswers(form.fields))
    setCustom({})
    setOpenCustom({})
    setSubmitting(false)
  }, [form.id])

  const complete = useMemo(
    () => formComplete(form.fields, answers, custom),
    [form.fields, answers, custom],
  )

  function setValue(key: string, value: Answers[string]) {
    setAnswers((current) => ({ ...current, [key]: value }))
  }

  function setCustomText(key: string, text: string) {
    setCustom((current) => ({ ...current, [key]: text }))
  }

  function pick(field: FormField, option: string) {
    setValue(field.key, toggleChoice(field, answers[field.key], option))
    // 单选选了选项就把「其他」收起来，避免自定义文字覆盖选项
    if (field.type !== 'multiselect') {
      setCustomText(field.key, '')
      setOpenCustom((current) => ({ ...current, [field.key]: false }))
    }
  }

  function toggleCustom(field: FormField) {
    setOpenCustom((current) => ({ ...current, [field.key]: !current[field.key] }))
  }

  async function submit() {
    if (!complete || submitting) return
    setSubmitting(true)
    try {
      await onSubmit(toReply(form.fields, answers, custom))
    } finally {
      setSubmitting(false)
    }
  }

  function renderField(field: FormField) {
    const value = answers[field.key]
    const text = custom[field.key] ?? ''
    const open = openCustom[field.key] === true

    if (field.type === 'boolean') {
      return (
        <div className="chat-form-options inline">
          {[true, false].map((option) => (
            <button
              key={String(option)}
              type="button"
              className={`chat-form-option compact${value === option ? ' selected' : ''}`}
              onClick={() => setValue(field.key, option)}
            >
              <span className="chat-form-option-mark">{value === option ? '●' : '○'}</span>
              {option ? '是' : '否'}
            </button>
          ))}
        </div>
      )
    }

    if (field.type === 'number' || field.type === 'integer') {
      return (
        <input
          className="chat-form-input"
          type="number"
          step={field.type === 'integer' ? 1 : 'any'}
          value={typeof value === 'number' ? String(value) : ''}
          placeholder={field.placeholder ?? '输入数字'}
          onChange={(event) => {
            const raw = event.target.value
            setValue(field.key, raw === '' ? undefined : Number(raw))
          }}
        />
      )
    }

    if (!field.options || field.options.length === 0) {
      return (
        <input
          className="chat-form-input"
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder ?? '输入答案'}
          onChange={(event) => setValue(field.key, event.target.value)}
        />
      )
    }

    const multiple = field.type === 'multiselect'
    const selected = multiple ? (Array.isArray(value) ? value : []) : [value]

    return (
      <>
        <div className="chat-form-options">
          {field.options.map((option) => {
            const on = selected.includes(option.value)
            return (
              <button
                key={option.value}
                type="button"
                className={`chat-form-option${on ? ' selected' : ''}`}
                onClick={() => pick(field, option.value)}
              >
                <span className="chat-form-option-mark">{on ? (multiple ? '✓' : '●') : multiple ? '' : '○'}</span>
                <span className="chat-form-option-text">
                  <span className="chat-form-option-label">{option.label}</span>
                  {option.description ? (
                    <span className="chat-form-option-desc">{option.description}</span>
                  ) : null}
                </span>
              </button>
            )
          })}
          {field.custom ? (
            <button
              type="button"
              className={`chat-form-option custom${open ? ' selected' : ''}`}
              onClick={() => toggleCustom(field)}
            >
              <span className="chat-form-option-mark">{open ? '✎' : '+'}</span>
              <span className="chat-form-option-text">其他（自己输入）</span>
            </button>
          ) : null}
        </div>
        {field.custom && open ? (
          <input
            className="chat-form-input"
            value={text}
            autoFocus
            placeholder={multiple ? '输入自定义选项，可多选其他项后再填' : '输入自定义答案'}
            onChange={(event) => setCustomText(field.key, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
          />
        ) : null}
      </>
    )
  }

  const title = form.title && form.title !== 'Questions' ? form.title : '模型在等你的选择'

  return (
    <div className="chat-form">
      <div className="chat-form-head">
        <span className="chat-form-badge">选择模式</span>
        <span className="chat-form-title" title={title}>
          {title}
        </span>
      </div>

      {form.fields.map((field) => (
        <div className="chat-form-field" key={field.key}>
          <div className="chat-form-label">
            <span className="chat-form-label-text">{field.title}</span>
            {field.description ? <span className="chat-form-desc">{field.description}</span> : null}
          </div>
          {renderField(field)}
        </div>
      ))}

      <div className="chat-form-actions">
        <button
          type="button"
          className="chat-form-submit"
          disabled={!complete || submitting}
          onClick={() => void submit()}
          title={complete ? '提交选择' : '每个问题都要先选一个答案'}
        >
          {submitting ? '提交中…' : '提交选择'}
        </button>
        <button type="button" className="chat-form-skip" onClick={onSkip} disabled={submitting}>
          跳过
        </button>
      </div>
    </div>
  )
}
