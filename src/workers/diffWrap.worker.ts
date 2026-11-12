/// <reference lib="webworker" />
/**
 * diff 换行行数的计算线程。
 *
 * 单个文件的 patch 可能有几万行（实测 6 万行），逐字模拟折行是纯 CPU 活：
 * 6 万行 ≈ 100ms 以上，压在主线程上就是一次明显的卡顿。
 * 这里把整段计算挪出主线程，只回传一个 Uint16Array（Transferable，零拷贝）。
 */
import { wrapRows } from '../components/wrapLayout'

type Request = {
  id: number
  patch: string
  availPx: number
  metrics: { charWidth: number; wideWidth: number }
}

type Response = { id: number; rows: Uint16Array }

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, patch, availPx, metrics } = event.data
  // 必须和主线程用同一种切分（\r?\n），否则行号会和渲染对不上
  const lines = patch.split(/\r?\n/)
  const rows = new Uint16Array(lines.length)
  for (let i = 0; i < lines.length; i += 1) {
    rows[i] = wrapRows(lines[i], availPx, metrics)
  }
  const message: Response = { id, rows }
  ;(self as unknown as Worker).postMessage(message, [rows.buffer])
}
