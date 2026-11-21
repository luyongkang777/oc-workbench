/**
 * `/skills` 的技能列表视图。
 *
 * 点一行展开 SKILL.md 全文（接口本来就带 content），可以：
 *   - 插入到对话：往输入框写一句「用 skill 工具加载技能 X」，比手动敲路径快
 *   - 复制路径：贴给别人 / 自己打开
 * 列表按目录缓存 60 秒，底部「重新读取」强制刷新。
 */
import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { fetchSkills } from '../api/skills'
import { copyText } from './clipboard'
import { filterSkills, type SkillInfo } from './skillList'
import { insertPrompt } from './manageActions'

type Props = {
  root?: string
  /** 把一段文字放进输入框（由 Chat 提供） */
  onInsert?: (text: string) => void
}

export default function ManageSkillView({ root, onInsert }: Props) {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [nonce, setNonce] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const copyTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    // nonce > 0 是用户点了「重新读取」：绕过 60 秒缓存
    fetchSkills(root, { force: nonce > 0 })
      .then((list) => {
        if (!alive) return
        setSkills(list)
      })
      .catch((err) => {
        if (!alive) return
        setSkills([])
        setError((err as Error).message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [root, nonce])

  const shown = filterSkills(skills, query)

  async function copyPath(skill: SkillInfo) {
    if (!skill.path) return
    const ok = await copyText(skill.path)
    if (!ok) return
    setCopied(skill.id)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(
      () => setCopied((current) => (current === skill.id ? null : current)),
      1500,
    )
  }

  return (
    <>
      <div className="manage-search">
        <Icon name="search" size={14} />
        <input
          className="manage-search-input"
          value={query}
          placeholder="按名字、描述或路径筛选"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="manage-count">
          {loading ? '加载中…' : `${shown.length}/${skills.length}`}
        </span>
      </div>

      {error ? <p className="manage-error">{error}</p> : null}

      <div className="manage-list">
        {loading ? (
          <p className="manage-note">正在读取技能清单…</p>
        ) : shown.length === 0 ? (
          <p className="manage-note">
            {skills.length === 0 ? '当前目录没有可用技能' : '没有匹配的技能'}
          </p>
        ) : (
          shown.map((skill) => {
            const open = expanded === skill.id
            return (
              <div key={skill.id} className="manage-skill">
                <button
                  type="button"
                  className={`manage-row manage-row-btn${open ? ' open' : ''}`}
                  aria-expanded={open}
                  title={skill.path || skill.name}
                  onClick={() => setExpanded(open ? null : skill.id)}
                >
                  <span className="manage-row-main">
                    <span className="manage-row-name">
                      {skill.name}
                      {/* 技能目录名几乎总等于技能名，重复显示只是噪声；不同的才标出来 */}
                      {skill.source && skill.source !== skill.name ? (
                        <span className="manage-row-src">{skill.source}</span>
                      ) : null}
                    </span>
                    {skill.description ? (
                      <span className="manage-row-desc">{skill.description}</span>
                    ) : null}
                  </span>
                  <span className="manage-row-chev">{open ? '收起' : '查看'}</span>
                </button>

                {open ? (
                  <div className="manage-doc-wrap">
                    <div className="manage-doc-actions">
                      <button
                        type="button"
                        className="manage-mini strong"
                        disabled={!onInsert}
                        onClick={() => onInsert?.(insertPrompt(skill))}
                      >
                        插入到对话
                      </button>
                      <button
                        type="button"
                        className="manage-mini"
                        disabled={!skill.path}
                        onClick={() => void copyPath(skill)}
                      >
                        {copied === skill.id ? '已复制' : '复制路径'}
                      </button>
                      <span className="manage-doc-path">{skill.path || '（没有路径）'}</span>
                    </div>
                    <pre className="manage-doc">{skill.content || '（这个技能没有正文）'}</pre>
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>

      <div className="manage-foot">
        <span>{loading ? '读取中…' : `共 ${skills.length} 个技能`}</span>
        <button
          type="button"
          className="manage-btn ghost"
          onClick={() => setNonce((value) => value + 1)}
          disabled={loading}
        >
          重新读取
        </button>
      </div>
    </>
  )
}
