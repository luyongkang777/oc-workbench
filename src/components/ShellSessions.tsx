import { useEffect, useState } from 'react'
import { useShellKill, useShellList, useShellOutput } from './shellList'
import { ShellDetail, ShellEmpty, ShellRows } from './shellViews'

/** 后台命令面板：列表 + 选中项输出 + 终止。 */

type Props = {
  root: string
  connected: boolean
  /** 面板当前是否可见（隐藏时不再轮询输出） */
  visible: boolean
  onCount?: (n: number) => void
}

export default function ShellSessions({ root, connected, visible, onCount }: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  const { items, error, markKilled, refresh } = useShellList(root, connected, onCount)
  const { killing, killError, kill } = useShellKill(root, markKilled, refresh)
  const active = items.find((item) => item.id === selected)
  const isRunning = active?.status === 'running'
  const { output, truncated, error: outError, reset } = useShellOutput(
    selected,
    root,
    isRunning && visible,
    active?.status === 'killed',
  )

  // 被缓存裁掉 / 被别处删除的条目要顺手清掉选中，否则详情区会静默消失还留着高亮
  useEffect(() => {
    if (selected && !items.some((item) => item.id === selected)) {
      setSelected(null)
      reset()
    }
  }, [items, selected])

  if (items.length === 0) return <ShellEmpty connected={connected} error={error} />

  return (
    <div className="shell-panel">
      <ShellRows
        items={items}
        selected={selected}
        onPick={(id) => {
          setSelected(id)
          reset()
        }}
      />
      {error ? <div className="shell-error">{error}</div> : null}
      {killError ? <div className="shell-error">{killError}</div> : null}
      {active ? (
        <ShellDetail
          item={active}
          output={output}
          truncated={truncated}
          error={outError}
          killing={killing === active.id}
          onKill={() => void kill(active.id)}
        />
      ) : null}
    </div>
  )
}
