/**
 * 页面可见性的小工具。
 *
 * 工作台最小化、切到别的应用、被别的窗口盖住（不可见时浏览器会回 hidden）时，
 * 轮询没必要继续打接口：既费 CPU 又占外壳的请求线程。各轮询在 tick 开头调用
 * [`pageVisible`] 跳过一次，恢复可见后下一次 tick 立刻接着跑。
 *
 * dev / 单测里没有 document 时一律当可见，行为与之前完全一致。
 */
export function pageVisible(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
}

/**
 * 注册「恢复可见」回调：轮询用它立即补一次，不用干等一个完整周期。
 * 返回取消注册函数。
 */
export function onPageVisible(listener: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const handler = () => {
    if (pageVisible()) listener()
  }
  document.addEventListener('visibilitychange', handler)
  return () => document.removeEventListener('visibilitychange', handler)
}
