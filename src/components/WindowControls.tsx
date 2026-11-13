import { useEffect, useState } from 'react'

import { onWindowMaximized, sendWindowCommand } from '../api/window'

/**
 * 自绘窗口按钮（最小化 / 最大化 / 关闭）。
 *
 * 窗口已经去掉系统边框（`with_decorations(false)`），这里就是唯一的关闭入口，
 * 所以放在顶栏最右、紧贴「已连接」后面，高度撑满顶栏（Windows 习惯的点击区）。
 *
 * 最大化状态由外壳在 resize 时推过来，不能只看自己上一次点了什么：
 * 用户可能用 Win+↑、双击标题栏或系统菜单改变窗口状态。
 */
export default function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => onWindowMaximized(setMaximized), [])

  return (
    <div className="win-controls" data-win-controls>
      <button
        type="button"
        className="win-control"
        onClick={() => sendWindowCommand('minimize')}
        title="最小化"
        aria-label="最小化"
      >
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <path d="M2 5.5h6" />
        </svg>
      </button>

      <button
        type="button"
        className="win-control"
        onClick={() => sendWindowCommand('toggleMaximize')}
        title={maximized ? '向下还原' : '最大化'}
        aria-label={maximized ? '向下还原' : '最大化'}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
            <rect x="1.6" y="3.1" width="5.1" height="5.1" />
            <path d="M3.5 3.1V1.8h4.7v4.7H6.7" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
            <rect x="1.9" y="1.9" width="6.2" height="6.2" />
          </svg>
        )}
      </button>

      <button
        type="button"
        className="win-control win-close"
        onClick={() => sendWindowCommand('close')}
        title="关闭"
        aria-label="关闭"
      >
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <path d="M2.2 2.2l5.6 5.6M7.8 2.2l-5.6 5.6" />
        </svg>
      </button>
    </div>
  )
}
