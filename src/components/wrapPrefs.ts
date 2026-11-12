/**
 * 「自动换行」偏好的读写。
 *
 * 查看器和审查面板共用同一个开关：按项目根各记一份，新项目沿用最近一次的选择。
 * 抽成独立模块是因为两处都要读写同一条记录，逻辑放一边才不会各写一套。
 */

const WRAP_KEY = 'oc-workbench:wrap'

export function readWrapPref(root: string): boolean {
  try {
    const own = window.localStorage.getItem(`${WRAP_KEY}:${root}`)
    if (own === '0') return false
    if (own === '1') return true
    return window.localStorage.getItem(WRAP_KEY) !== '0'
  } catch {
    return true
  }
}

export function writeWrapPref(root: string, value: boolean): void {
  try {
    window.localStorage.setItem(`${WRAP_KEY}:${root}`, value ? '1' : '0')
    // 全局值当作「新项目的默认」，和用户在别的项目里的最近选择保持一致
    window.localStorage.setItem(WRAP_KEY, value ? '1' : '0')
  } catch {
    // 存不下只影响下次启动的恢复
  }
}
