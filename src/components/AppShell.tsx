import type { CSSProperties } from 'react'
import { useAppContext } from '../appContext'
import { nextThemePref } from './theme'
import AccountPanel from './AccountPanel'
import ChatTabs from './ChatTabs'
import CodeView from './CodeView'
import FileTabs from './FileTabs'
import FileTree from './FileTree'
import DeviceStrip from './DeviceStrip'
import GitPanel from './GitPanel'
import { IconDefs } from './Icon'
import MobileNav from './MobileNav'
import ReviewPanel from './ReviewPanel'
import SubagentPanel from './SubagentPanel'
import Terminal from './Terminal'
import TopBar from './TopBar'
import WelcomePane from './WelcomePane'
import { isRemoteHost } from '../api/auth'

/**
 * 主界面的全部布局与 JSX。
 *
 * 从 App.tsx 搬出来的：状态由 App 组装进 Context，这里只负责「把状态画出来」。
 * 变量名与 Context 字段一一对应，所以下面的 JSX 和搬家前完全一样。
 */
export default function AppShell() {
  const c = useAppContext()
  const {
    auth,
    connected,
    reconnecting,
    retryError,
    retryConnect,
    statusOk,
    statusText,
    showRetry,
    themePref,
    theme,
    setThemePref,
    mobile,
    pane,
    setPane,
    sideW,
    chatW,
    scaleHint,
    beginResize,
    mainRef,
    projects,
    root,
    applyRoot,
    forgetProject,
    pickFolder,
    fileTabs,
    activeFile,
    file,
    fileRoot,
    openFile,
    selectTab,
    closeTab,
    closeAllTabs,
    isTabDirty,
    hasDirtyTabs,
    handleTabDirty,
    handleEditorSaved,
    handleOpenFailed,
    handlePathRemoved,
    handlePathRenamed,
    useExternalRoot,
    view,
    setView,
    gitOpen,
    setGitOpen,
    accountOpen,
    setAccountOpen,
    subagentMode,
    setSubagentMode,
    activeSessionID,
    setActiveSessionID,
    tabRequest,
    openInTab,
    lights,
    notice,
    treeSeq,
    bumpTree,
    handleTopbarMouseDown,
    remoteBack,
  } = c

  return (
    <div className="app" data-mobile={mobile ? '1' : undefined}>
      <IconDefs />
      {/* 同账号下在线的电脑：直接顶在最上面，方便来回切（只有一台时自己会隐藏） */}
      <DeviceStrip />
      <TopBar
        onMouseDown={handleTopbarMouseDown}
        projects={projects}
        activeRoot={root}
        runningDirs={lights.dirs}
        connected={connected}
        onSwitchProject={applyRoot}
        onRemoveProject={forgetProject}
        onAddProject={pickFolder}
        themePref={themePref}
        theme={theme}
        onCycleTheme={() => setThemePref((cur) => nextThemePref(cur))}
        accountOpen={accountOpen}
        onToggleAccount={() => setAccountOpen((v) => !v)}
        gitOpen={gitOpen}
        onToggleGit={() => setGitOpen((v) => !v)}
        view={view}
        onToggleDiff={() => {
          setView((v) => (v === 'diff' ? 'code' : 'diff'))
          // 手机上审查面板在编辑栏里：不切过去就等于点了没反应
          if (mobile) setPane('editor')
        }}
        statusOk={statusOk}
        statusText={statusText}
        retryError={retryError}
        showRetry={showRetry}
        reconnecting={reconnecting}
        onRetry={() => void retryConnect()}
      />

      {notice ? <div className="app-notice">{notice.text}</div> : null}

      {root ? (
        <div
          className="main"
          ref={mainRef}
          data-pane={pane}
          style={{ '--side-w': `${sideW}px`, '--chat-w': `${chatW}px` } as CSSProperties}
        >
          <aside className="sidebar">
            <div className="pane-title">
              资源管理器
              <span className="pane-actions">
                <button type="button" className="pane-action" onClick={bumpTree} title="刷新文件树">
                  刷新
                </button>
              </span>
            </div>
            {auth.status === 'ready' ? (
              // 拿到令牌就挂载：文件树走本地直读，不依赖 opencode 连上；
              // 后端断开时只有聊天/审查不可用，文件照样能看。
              <FileTree
                root={root}
                onOpenFile={openFile}
                refreshSeq={treeSeq}
                // 手机上行高放大到 40px，手指点得中（虚拟列表常量必须同步）
                rowHeight={mobile ? 40 : 27}
                // 正在看工作区外的文件时不高亮任何树节点（path 是相对文件自己的 root 的）
                activePath={fileRoot ? null : file}
                isDirty={hasDirtyTabs}
                onPathRemoved={handlePathRemoved}
                onPathRenamed={handlePathRenamed}
              />
            ) : (
              <div className={`pane-notice${retryError ? ' error' : ''}`} role="status">
                {auth.status === 'pending'
                  ? '正在连接本地服务…'
                  : (retryError ?? '等待后端连接…')}
              </div>
            )}
          </aside>

          <div
            className="col-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧栏宽度"
            title="拖动调整宽度，双击复位"
            onPointerDown={beginResize('side')}
          />

          <section className="editor-pane">
            {view === 'diff' ? (
              <ReviewPanel root={root} connected={connected} />
            ) : (
              <>
                <FileTabs
                  tabs={fileTabs}
                  activeKey={activeFile}
                  dirtyOf={isTabDirty}
                  onSelect={selectTab}
                  onClose={closeTab}
                  onCloseAll={closeAllTabs}
                />
                <div className="editor-stack">
                  {fileTabs.length === 0 ? (
                    <div className="editor-empty">
                      <div className="editor-empty-icon">⌘</div>
                      <div>{mobile ? '从底部「文件」里选一个查看' : '选择左侧文件查看'}</div>
                    </div>
                  ) : null}
                  {fileTabs.map((tab) => (
                    <div
                      key={tab.key}
                      className="editor-slot"
                      // 非激活标签只藏起来、不卸载：滚动位置、编辑草稿、预览状态全部保留。
                      style={tab.key === activeFile ? undefined : { display: 'none' }}
                    >
                      <CodeView
                        // 外部文件用它自己的目录当 root，读写/搜索都落在同一个工作目录下
                        root={tab.root ?? root}
                        path={tab.path}
                        openSeq={tab.seq}
                        openLine={tab.line}
                        onOpenFile={openFile}
                        onDirtyChange={(dirty) => handleTabDirty(tab.key, dirty)}
                        onSaved={handleEditorSaved}
                        autoEditSeq={tab.editSeq}
                        externalRoot={tab.root}
                        onUseExternalRoot={useExternalRoot}
                        onOpenFailed={handleOpenFailed}
                        onClose={() => closeTab(tab.key)}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>

          <div
            className="col-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整聊天面板宽度"
            title="拖动调整宽度，双击复位"
            onPointerDown={beginResize('chat')}
          />

          <aside
            className="chat-pane"
            data-chat-tier={mobile ? 3 : chatW <= 410 ? 3 : chatW <= 460 ? 2 : chatW <= 520 ? 1 : 0}
          >
            <ChatTabs
              key={root}
              root={root}
              connected={connected}
              onOpenFile={openFile}
              lights={lights.status}
              request={tabRequest}
              onActiveSession={setActiveSessionID}
            />
          </aside>

          <SubagentPanel
            sessionID={activeSessionID ?? undefined}
            connected={connected}
            mode={subagentMode}
            onToggle={(next) => setSubagentMode(next)}
            onOpen={openInTab}
          />
        </div>
      ) : (
        <WelcomePane
          projects={projects}
          connected={connected}
          reason={retryError ?? (auth.status === 'failed' ? auth.error : null)}
          onPick={pickFolder}
          onOpen={(path) => applyRoot(path)}
          onRemove={forgetProject}
        />
      )}

      {root ? <Terminal key={root} root={root} connected={connected} /> : null}

      {root ? (
        <GitPanel root={root} open={gitOpen} onClose={() => setGitOpen(false)} onOpenFile={openFile} />
      ) : null}

      {mobile && root ? <MobileNav pane={pane} setPane={setPane} /> : null}

      <AccountPanel
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        onOpenDevice={(url) => {
          setAccountOpen(false)
          // 顶层导航（不是 iframe）：这样远程页面的 origin 就是网关，账号 cookie 同站生效。
          // back 只传能回去的东西：远程页面里的 127.0.0.1 是手机自己，回网关门户才对。
          const back = encodeURIComponent(
            isRemoteHost() ? '/' : window.location.pathname + window.location.hash,
          )
          window.location.href = `${url}${url.includes('?') ? '&' : '?'}back=${back}`
        }}
      />

      {remoteBack ? (
        <button type="button" className="remote-back" onClick={() => (window.location.href = remoteBack)}>
          ← 返回本机
        </button>
      ) : null}

      {/* 缩放比例：只在 Ctrl+滚轮时短暂出现，平时不占位也不吃鼠标 */}
      <div className={`zoom-hint${scaleHint ? ' show' : ''}`} aria-live="polite">
        {scaleHint ?? ''}
      </div>
    </div>
  )
}
