import { useEffect, useRef, useState } from 'react'
import { matchPurgeKeyword, matchPurgeModel, type PurgeModelEntry } from '../api/purge'
import type { PurgeController } from '../hooks/usePurge'
import { formatDateTime } from './turns'

type ModelKey = { id: string; providerID: string; variant?: string }

type Props = {
  controller: PurgeController
  currentModel: ModelKey | null
}

function basename(file: string | undefined): string {
  if (!file) return ''
  const parts = file.split(/[\\/]/)
  return parts[parts.length - 1] || file
}

function formatBytes(bytes: number | undefined): string {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  return `${(value / 1024).toFixed(1)} KB`
}

/**
 * 顶栏的破甲开关。
 *
 * 单击开关本体直接切（这是主操作），右侧小三角才展开详情。详情里最关键的一行是
 * 「当前模型会不会注入」：插件用 perModel 精确匹配，没匹配上是完全静默的，
 * 只看到开关是「开」但选择器里换了个模型就一点注入都没有。
 */
export default function PurgeToggle({ controller, currentModel }: Props) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)
  const { status, loading, busy, error } = controller

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const enabled = status?.enabled ?? false
  const matched: PurgeModelEntry | null = matchPurgeModel(
    status?.perModel,
    currentModel?.providerID,
    currentModel?.id,
  )
  const keywordHit = matchPurgeKeyword(status?.keywords, currentModel?.id)

  /** 一眼能看出「开了但不生效」的几种情况都归到 warn。 */
  let coverage = '尚未读取配置'
  let tone: 'on' | 'off' | 'warn' = 'off'
  if (loading && !status) {
    coverage = '读取配置…'
  } else if (status && !status.ok) {
    coverage = status.error ?? '配置读取失败'
    tone = 'warn'
  } else if (status) {
    if (!enabled) {
      coverage = '已关闭：模型请求里不加任何内容'
      tone = 'off'
    } else if (matched) {
      coverage = `当前模型注入 ${basename(matched.file)}（精确匹配）`
      tone = matched.exists ? 'on' : 'warn'
    } else if (keywordHit) {
      coverage = `当前模型注入 ${basename(keywordHit.file)}（关键词 ${keywordHit.keyword}）`
      tone = keywordHit.exists === false ? 'warn' : 'on'
    } else if (!currentModel) {
      coverage = '还没选择模型'
      tone = 'warn'
    } else if (status.injectDefault) {
      coverage = `当前模型没命中关键词，走默认正文 ${basename(status.promptFile)}`
      tone = 'warn'
    } else {
      coverage = '当前模型既不在名单、也没命中关键词，不会注入'
      tone = 'warn'
    }
  }

  const chipTitle = [
    `破甲注入：${enabled ? '开' : '关'}`,
    coverage,
    '点击切换，右侧 ▾ 看详情',
  ].join('\n')

  const lastAt = Number(status?.state?.lastAt) || 0
  const injects = Number(status?.state?.injects) || 0
  const requests = Number(status?.state?.requests) || 0

  return (
    <div className="purge" ref={box}>
      <button
        type="button"
        className={`purge-chip ${tone}`}
        title={chipTitle}
        onClick={() => void controller.toggle()}
        disabled={!status || busy}
      >
        <span className="purge-dot" aria-hidden="true" />
        <span className="purge-label">破甲</span>
        <span className="purge-state">{busy ? '…' : enabled ? '开' : '关'}</span>
      </button>
      <button
        type="button"
        className={`purge-caret${open ? ' open' : ''}`}
        title="破甲详情"
        onClick={() => {
          setOpen((value) => !value)
          void controller.reload()
        }}
        aria-label="破甲详情"
      >
        ▾
      </button>

      {open ? (
        <div className="purge-menu">
          <div className="purge-menu-head">
            <div>
              <div className="purge-menu-title">破甲注入</div>
              <div className="purge-menu-sub">插件：purge</div>
            </div>
            <button
              type="button"
              className={`purge-switch${enabled ? ' on' : ''}`}
              role="switch"
              aria-checked={enabled}
              aria-label="破甲注入开关"
              disabled={!status || busy}
              onClick={() => void controller.toggle()}
            >
              <span className="purge-switch-knob" />
            </button>
          </div>

          <div className={`purge-coverage ${tone}`}>{coverage}</div>

          {error ? <div className="purge-error">{error}</div> : null}
          {status?.configError ? <div className="purge-error">配置：{status.configError}</div> : null}

          {status?.ok ? (
            <>
              <div className="purge-facts">
                <div className="purge-fact">
                  <span>默认正文</span>
                  <span title={status.promptPath}>
                    {basename(status.promptFile)} · {formatBytes(status.promptBytes)}
                    {status.promptExists ? '' : '（缺失）'}
                  </span>
                </div>
                <div className="purge-fact">
                  <span>注入范围</span>
                  <span>{status.injectDefault ? '名单外模型走默认正文' : '仅名单内模型'}</span>
                </div>
                <div className="purge-fact">
                  <span>运行统计</span>
                  <span>
                    注入 {injects} 次 / 请求 {requests} 次
                  </span>
                </div>
                <div className="purge-fact">
                  <span>最近注入</span>
                  <span>{lastAt ? formatDateTime(lastAt) : '从未'}</span>
                </div>
              </div>

              <div className="purge-models-title">
                关键词 <span>{status.keywords ? status.keywords.length : '默认 5'}</span>
              </div>
              <div className="purge-models">
                {status.keywords === null ? (
                  <div className="purge-model-empty">配置未写 keywordMap，插件按内置 5 项生效</div>
                ) : status.keywords.length === 0 ? (
                  <div className="purge-model-empty">关键词匹配已关闭</div>
                ) : (
                  status.keywords.map((entry) => (
                    <div
                      key={entry.keyword}
                      className={`purge-model${
                        keywordHit?.keyword === entry.keyword ? ' active' : ''
                      }${entry.exists === false ? ' missing' : ''}`}
                      title={entry.path ?? entry.file}
                    >
                      <span className="purge-model-key">{entry.keyword}</span>
                      <span className="purge-model-file">
                        {basename(entry.file)}
                        {entry.exists === false ? ' · 缺失' : ''}
                      </span>
                    </div>
                  ))
                )}
              </div>

              <div className="purge-models-title">
                模型名单 <span>{status.perModel.length}</span>
              </div>
              <div className="purge-models">
                {status.perModel.length === 0 ? (
                  <div className="purge-model-empty">没有配置 perModel</div>
                ) : (
                  status.perModel.map((entry) => {
                    const active = matched?.key === entry.key
                    return (
                      <div
                        key={entry.key}
                        className={`purge-model${active ? ' active' : ''}${
                          entry.exists ? '' : ' missing'
                        }`}
                        title={`${entry.key}\n${entry.path}`}
                      >
                        <span className="purge-model-key">{entry.key}</span>
                        <span className="purge-model-file">
                          {basename(entry.file)}
                          {entry.exists ? '' : ' · 缺失'}
                        </span>
                      </div>
                    )
                  })
                )}
              </div>

              <div className="purge-menu-foot" title={status.configPath}>
                开关写入 config.json，插件按 5 秒缓存读取，切换后最长 5 秒生效。
              </div>
            </>
          ) : (
            <div className="purge-menu-foot">
              {status?.error ?? '读不到破甲配置，确认插件目录存在。'}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
