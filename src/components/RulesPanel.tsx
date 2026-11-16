import { useEffect, useMemo, useRef, useState } from 'react'
import { coverageText, toDrafts, type RuleDraft } from '../api/rules'
import type { RulesController } from '../hooks/useRules'

type Props = {
  controller: RulesController
  /** 当前项目目录，用于说明「目录规则会落到哪」 */
  directory: string
  open: boolean
  onClose: () => void
}

type Tab = 'local' | 'global'

/**
 * 规则面板（顶栏盾牌）。
 *
 * 规则是**条目**而不是一大块正文：
 *   * 只填内容 → 单行条目
 *   * 填了标题 → 标题 + 内容两行
 *
 * 三条口径必须在界面上说清：
 *   1. 强制，没有开关；清空全部条目才是取消约束。
 *   2. 两级同时生效：全局 + 当前目录。
 *   3. AI 也能写：会话里说「加一条规则」，模型会用 rules_add 写进同一份文件。
 */
export default function RulesPanel({ controller, directory, open, onClose }: Props) {
  const { status, loading, saving, error, save } = controller
  const [tab, setTab] = useState<Tab>('local')
  const [drafts, setDrafts] = useState<RuleDraft[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const savedItems = useMemo(() => {
    const source = tab === 'local' ? status?.local : status?.global
    return toDrafts(source?.items ?? [])
  }, [status, tab])

  // 草稿同步的判据是「和上次同步的基准比」而不是「和当前磁盘值比」。
  // 用磁盘值比会踩这个坑：首次渲染磁盘还没读回来（savedItems=[]），草稿也是 []，
  // 等数据回来时误判成"用户改过"，于是条目永远填不进列表（实测踩过）。
  const baselineRef = useRef<RuleDraft[]>([])
  const tabRef = useRef(tab)
  useEffect(() => {
    const baseline = baselineRef.current
    const dirtyNow = JSON.stringify(drafts) !== JSON.stringify(baseline)
    const switched = tabRef.current !== tab

    // 换页：直接载入目标页的磁盘值（上一页未保存的改动会被丢弃，先说一声）
    if (switched) {
      if (dirtyNow) setMessage('已切页：上一页未保存的修改被丢弃')
      tabRef.current = tab
      baselineRef.current = savedItems
      setDrafts(savedItems)
      return
    }

    // 磁盘没变（只是用户在打字）→ 什么都不做，绝不能在这里提示
    if (JSON.stringify(savedItems) === JSON.stringify(baseline)) return

    // 磁盘被外部改了：用户有未保存改动时只提示，不覆盖
    if (dirtyNow) {
      setMessage('磁盘上的规则已被修改；保存会覆盖它')
      return
    }
    baselineRef.current = savedItems
    setDrafts(savedItems)
  }, [savedItems, tab, drafts])

  // 打开时默认落在「当前目录」；没目录只能编全局
  useEffect(() => {
    if (!directory) setTab('global')
  }, [directory])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(null), 2600)
    return () => window.clearTimeout(timer)
  }, [message])

  const dirty = JSON.stringify(drafts) !== JSON.stringify(baselineRef.current)
  const filled = drafts.filter((item) => item.text.trim()).length
  const bytes = new TextEncoder().encode(JSON.stringify(drafts)).length
  const limit = status?.maxBytes ?? 64 * 1024
  const overLimit = bytes > limit
  const localDisabled = tab === 'local' && !directory
  const titleOnlyRows = drafts
    .map((item, index) => (item.title.trim() && !item.text.trim() ? index + 1 : 0))
    .filter(Boolean)
  const canSave = !saving && dirty && !overLimit && !localDisabled && titleOnlyRows.length === 0

  function patch(index: number, next: Partial<RuleDraft>) {
    setDrafts((prev) => prev.map((item, i) => (i === index ? { ...item, ...next } : item)))
  }

  function addRow(withTitle: boolean) {
    // 两种按钮只差「加完把焦点放标题还是内容」，条目结构一样（标题可选）
    setDrafts((prev) => [...prev, { title: '', text: '' }])
    setMessage(withTitle ? '新增一条：先写标题再写内容' : '新增一条单行规则')
    // 新增后把焦点放到刚加的输入框
    window.setTimeout(() => {
      const rows = document.querySelectorAll('.rules-item')
      const last = rows[rows.length - 1] as HTMLElement | undefined
      const target = withTitle
        ? (last?.querySelector('.rules-item-title') as HTMLInputElement | null)
        : (last?.querySelector('.rules-item-text') as HTMLTextAreaElement | null)
      target?.focus()
    }, 30)
  }

  function removeRow(index: number) {
    setDrafts((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleSave() {
    if (!canSave) return
    if (titleOnlyRows.length) {
      setMessage(`第 ${titleOnlyRows.join('、')} 条只填了标题，请补上内容（否则保存时会被丢掉）`)
      return
    }
    const ok = await save(tab, drafts)
    if (!ok || !aliveRef.current) return
    const normalized = drafts
      .filter((item) => item.text.trim())
      .map((item) => ({ title: item.title.trim(), text: item.text.trim() }))
    baselineRef.current = normalized
    setDrafts(normalized)
    setMessage(filled ? `已保存 ${filled} 条，下一次模型请求立即生效` : '已清空，这级规则不再约束')
  }

  return (
    <>
      {open ? <div className="rules-mask" onMouseDown={onClose} /> : null}
      <aside className={`rules-panel${open ? ' open' : ''}`} aria-hidden={!open} aria-label="强制规则">
        <header className="rules-head">
          <div className="rules-title">
            强制规则
            <span className={`rules-badge${filled ? ' on' : ' off'}`}>
              {filled ? `本页 ${filled} 条` : '本页为空'}
            </span>
          </div>
          <button type="button" className="rules-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="rules-body">
          <p className="rules-note">
            规则是<strong>强制</strong>的，没有开关。每条规则一句话；填了标题就是「标题 + 内容」两行。
            每次模型生成都会把条目注入系统提示，每次工具执行前都会校验它还读得出来。
            也可以在对话里直接说「加一条规则」，模型会用 <code>rules_add</code> 写进同一份文件。
          </p>

          <div className="rules-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'local'}
              className={`rules-tab${tab === 'local' ? ' active' : ''}`}
              onClick={() => setTab('local')}
            >
              当前目录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'global'}
              className={`rules-tab${tab === 'global' ? ' active' : ''}`}
              onClick={() => setTab('global')}
            >
              全局
            </button>
          </div>

          <div className="rules-path" title={(tab === 'local' ? status?.local : status?.global)?.path ?? ''}>
            {localDisabled
              ? '没有当前项目目录，目录规则不可编辑'
              : (tab === 'local' ? status?.local : status?.global)?.path || '（未创建，保存后自动生成）'}
          </div>

          {tab === 'local' && status?.local.error ? (
            <div className="rules-error">读不出来：{status.local.error}</div>
          ) : null}
          {tab === 'global' && status?.global.error ? (
            <div className="rules-error">读不出来：{status.global.error}</div>
          ) : null}

          <div className="rules-list">
            {drafts.length === 0 ? (
              <div className="rules-empty">
                还没有规则条目。点下面「＋ 单行」加一条一句话规则，或「＋ 标题+内容」加一条带标题的。
              </div>
            ) : null}
            {drafts.map((item, index) => (
              <div className="rules-item" key={index}>
                <span className="rules-item-no">{index + 1}</span>
                <div className="rules-item-fields">
                  <input
                    className="rules-item-title"
                    value={item.title}
                    spellCheck={false}
                    placeholder="标题（可选，留空就是单行规则）"
                    onChange={(event) => patch(index, { title: event.target.value })}
                    disabled={localDisabled}
                  />
                  <textarea
                    className="rules-item-text"
                    value={item.text}
                    spellCheck={false}
                    rows={1}
                    placeholder="规则内容，例如：改完必须跑 npm test"
                    onChange={(event) => patch(index, { text: event.target.value })}
                    disabled={localDisabled}
                  />
                </div>
                <button
                  type="button"
                  className="rules-item-del"
                  aria-label={`删除第 ${index + 1} 条`}
                  onClick={() => removeRow(index)}
                  disabled={saving}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div className="rules-foot">
            <button type="button" className="rules-btn" onClick={() => addRow(false)} disabled={localDisabled || saving}>
              ＋ 单行
            </button>
            <button type="button" className="rules-btn" onClick={() => addRow(true)} disabled={localDisabled || saving}>
              ＋ 标题+内容
            </button>
            <span className="rules-spacer" />
            <span className={`rules-count${overLimit ? ' over' : ''}`}>
              {bytes} / {limit} 字节
            </span>
            <button
              type="button"
              className="rules-btn primary"
              onClick={() => void handleSave()}
              disabled={!canSave}
            >
              {saving ? '保存中…' : dirty ? '保存' : '已保存'}
            </button>
          </div>

          <div className="rules-meta">
            <span className="rules-coverage">{coverageText(status)}</span>
            {message ? <span className="rules-msg">{message}</span> : null}
            {error ? <span className="rules-msg bad">{error}</span> : null}
            {loading && !status ? <span className="rules-msg">读取中…</span> : null}
            {status && !status.pluginInstalled ? (
              <span className="rules-warn">
                规则插件未安装（{status.pluginDir}），现在只保存文件、不会强制注入
              </span>
            ) : null}
            {status?.readErrors ? (
              <span className="rules-warn">有 {status.readErrors} 个规则文件读不出来，写类工具会被拦</span>
            ) : null}
          </div>
        </div>
      </aside>
    </>
  )
}
