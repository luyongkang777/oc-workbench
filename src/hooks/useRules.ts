import { useCallback, useEffect, useRef, useState } from 'react'
import { getRulesStatus, saveRule, type RuleDraft, type RuleScope, type RulesStatus } from '../api/rules'

/**
 * 规则面板状态。
 *
 * 规则是强制的，所以这里只有「读条目」和「整份保存」，没有 enabled 开关。
 * 保存后回读一次，界面显示的是磁盘真值（写失败不能静默）。
 */
export type RulesController = {
  status: RulesStatus | null
  loading: boolean
  saving: boolean
  error: string | null
  reload: (directory?: string) => Promise<void>
  save: (scope: RuleScope, items: RuleDraft[]) => Promise<boolean>
}

export function useRules(directory: string, connected: boolean): RulesController {
  const [status, setStatus] = useState<RulesStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  const dirRef = useRef(directory)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    dirRef.current = directory
  }, [directory])

  const reload = useCallback(async (nextDir?: string) => {
    const dir = nextDir ?? dirRef.current
    try {
      const fresh = await getRulesStatus(dir)
      if (!alive.current) return
      setStatus(fresh)
      setError(fresh.readErrors > 0 ? '有规则文件读不出来，写操作会被拦下' : null)
    } catch (err) {
      if (!alive.current) return
      setError(err instanceof Error ? err.message : '读取规则失败')
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  // 连上之后读一次；换项目（目录变）也重读
  useEffect(() => {
    void reload(directory)
  }, [reload, directory, connected])

  const save = useCallback(
    async (scope: RuleScope, items: RuleDraft[]): Promise<boolean> => {
      if (saving) return false
      setSaving(true)
      setError(null)
      try {
        const fresh = await saveRule(scope, dirRef.current, items)
        if (!alive.current) return true
        setStatus(fresh)
        setError(fresh.readErrors > 0 ? '保存后文件仍读不出来，检查权限' : null)
        return true
      } catch (err) {
        if (alive.current) setError(err instanceof Error ? err.message : '保存失败')
        return false
      } finally {
        if (alive.current) setSaving(false)
      }
    },
    [saving],
  )

  return { status, loading, saving, error, reload, save }
}
