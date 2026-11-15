import { Icon } from './Icon'

export type MobilePane = 'files' | 'editor' | 'chat'

/**
 * 手机底部导航：单列布局下切换三栏。
 *
 * 只在 `mobile` 为真时渲染（由 App 控制），这里只管三个 tab。
 */
export default function MobileNav({
  pane,
  setPane,
}: {
  pane: MobilePane
  setPane: (pane: MobilePane) => void
}) {
  return (
    <nav className="mobile-nav" role="tablist" aria-label="切换视图">
      <button
        type="button"
        role="tab"
        aria-selected={pane === 'files'}
        className={`mobile-nav-btn${pane === 'files' ? ' active' : ''}`}
        onClick={() => setPane('files')}
      >
        <Icon name="files" size={18} />
        <span>文件</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={pane === 'editor'}
        className={`mobile-nav-btn${pane === 'editor' ? ' active' : ''}`}
        onClick={() => setPane('editor')}
      >
        <Icon name="code" size={18} />
        <span>编辑</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={pane === 'chat'}
        className={`mobile-nav-btn${pane === 'chat' ? ' active' : ''}`}
        onClick={() => setPane('chat')}
      >
        <Icon name="chat" size={18} />
        <span>聊天</span>
      </button>
    </nav>
  )
}
