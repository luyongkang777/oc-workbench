/**
 * 自绘标题栏 ↔ 桌面外壳的窗口命令通道。
 *
 * 页面 → 外壳：`window.ipc.postMessage('oc:win-minimize' | 'oc:win-toggle-maximize' | …)`
 * 外壳 → 页面：窗口最大化状态变化时调 `window.__ocWinState(true/false)`
 *
 * dev（Vite 浏览器）里没有 `window.ipc`：所有命令退化成空操作，
 * 界面照常渲染，不会因为点按钮报错。
 */

type IpcBridge = { postMessage(message: string): void }

type WinStateHook = { __ocWinState?: (maximized: boolean) => void }

/** 外壳只认这四个命令；多一个都不发，免得页面能任意操作窗口。 */
export const WINDOW_COMMANDS = {
  minimize: 'oc:win-minimize',
  toggleMaximize: 'oc:win-toggle-maximize',
  close: 'oc:win-close',
  drag: 'oc:win-drag',
} as const

export type WindowCommand = keyof typeof WINDOW_COMMANDS

const MAXIMIZED_EVENT = 'oc:window-maximized'

function bridge(): IpcBridge | undefined {
  const ipc = (window as unknown as { ipc?: IpcBridge }).ipc
  return ipc?.postMessage ? ipc : undefined
}

/** 桌面外壳在不在（dev 浏览器里为 false，顶栏按钮点了也不会有反应）。 */
export function hasWindowControls(): boolean {
  return bridge() !== undefined
}

/** 发一条窗口命令：最小化 / 最大化切换 / 关闭 / 开始拖动。 */
export function sendWindowCommand(command: WindowCommand): void {
  bridge()?.postMessage(WINDOW_COMMANDS[command])
}

let installed = false

/**
 * 挂 `__ocWinState`：保留外壳/其它插件可能已经装好的实现，不直接覆盖。
 * StrictMode 会把组件 effect 跑两遍，这里用模块级标记保证只装一次。
 */
function installStateHook(): void {
  if (installed) return
  installed = true
  const target = window as unknown as WinStateHook
  const previous = target.__ocWinState
  target.__ocWinState = (maximized: boolean) => {
    previous?.(maximized)
    window.dispatchEvent(
      new CustomEvent<boolean>(MAXIMIZED_EVENT, { detail: maximized === true }),
    )
  }
}

/** 订阅窗口最大化状态；返回取消订阅函数。 */
export function onWindowMaximized(listener: (maximized: boolean) => void): () => void {
  installStateHook()
  const handler = (event: Event) => {
    listener((event as CustomEvent<boolean>).detail === true)
  }
  window.addEventListener(MAXIMIZED_EVENT, handler)
  return () => window.removeEventListener(MAXIMIZED_EVENT, handler)
}

/**
 * 顶栏里这些元素自己处理点击，按下时不能当标题栏拖动。
 * 注意 `[data-win-controls]` 要写进来：窗口按钮就在顶栏里。
 */
const INTERACTIVE_SELECTOR = [
  'button',
  'a',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="tab"]',
  '[contenteditable="true"]',
  '[data-win-controls]',
].join(',')

type ClosestLike = { closest(selector: string): unknown }

/**
 * 在顶栏空白处按下才允许拖动窗口。
 *
 * 用鸭子类型（closest 方法）而不是 `instanceof Element`：单测里没有 DOM，
 * 这样可以喂假对象验证「按钮上不拖、空白处拖」。
 */
export function isWindowDragTarget(target: unknown): boolean {
  if (!target || typeof (target as ClosestLike).closest !== 'function') return false
  return (target as ClosestLike).closest(INTERACTIVE_SELECTOR) === null
}
