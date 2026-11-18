import { useEffect, useState } from 'react'
import { locateFile, type LocateHit } from './locateFile.ts'
import { localFsIo } from './locateIo.ts'
import { normKey, projectNameOf } from './projectList.ts'

/**
 * 打开失败时给出的「在别处找到」列表。
 *
 * 背景：查看区只能按当前工作区根拼路径，`404 文件不存在：.tmp/patch-verify-4.mjs`
 * 这种提示以前是死路 —— 只有一个「重试」，重试还是同一个路径，还是 404。
 * 现在失败后自动去「当前工作区 → 上级目录 → 其它已记录项目」里找一遍，
 * 找到就列出来，点一下直接打开（外部文件会自动带上它自己的根目录）。
 *
 * 找不到时也明确说一句找过哪些地方，别让用户怀疑按钮坏了。
 */
export default function LocateHint({
  root,
  path,
  projects,
  onOpen,
}: {
  root: string
  path: string
  /** 其它已记录的项目根（当前工作区之外的作用域） */
  projects?: readonly string[]
  onOpen: (absPath: string) => void
}) {
  const [hits, setHits] = useState<LocateHit[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setHits([])
    setFailed(false)
    setLoading(true)
    const others = (projects ?? []).filter((item) => normKey(item) !== normKey(root))
    locateFile(path, { root, projects: others, signal: controller.signal }, localFsIo)
      .then((found) => {
        if (!controller.signal.aborted) setHits(found)
      })
      .catch(() => {
        // 定位本身失败（网络/超时）不能盖掉原本的 404 说明，只标一句「没找到」
        if (!controller.signal.aborted) setFailed(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [root, path, projects])

  if (loading) return <div className="locate-note">正在其它目录里找这个文件…</div>

  if (hits.length === 0) {
    return (
      <div className="locate-note">
        {failed
          ? '在其它位置搜索时出错，没能确认它还在不在。'
          : '当前工作区、上级目录和其它项目里都没有找到这个文件（可能已删除或改名）。'}
      </div>
    )
  }

  return (
    <div className="locate-list">
      <div className="locate-title">
        在其它位置找到 {hits.length} 个{hits.length > 1 ? '同名文件' : '文件'}，点一下打开：
      </div>
      {hits.map((hit) => (
        <button
          type="button"
          className="locate-item"
          key={`${hit.root}\u0000${hit.path}`}
          // title 给全路径，列表里只显示「项目名 + 相对路径」免得一行放不下
          title={hit.abs}
          onClick={() => onOpen(hit.abs)}
        >
          <span className="locate-where">{projectNameOf(hit.root)}</span>
          <span className="locate-path">{hit.path}</span>
        </button>
      ))}
    </div>
  )
}
