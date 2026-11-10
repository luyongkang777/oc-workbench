/** 复制文本：优先 Clipboard API，失败退回 execCommand（WebView2 里两条路都能用）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 权限被拒时走下面的兜底
  }
  const area = document.createElement('textarea')
  area.value = text
  area.readOnly = true
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  const prev = document.activeElement as HTMLElement | null
  try {
    area.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    // 无论成败都要摘掉隐藏 textarea，否则它会留在 body 上并持有焦点
    area.remove()
    try {
      prev?.focus()
    } catch {
      // 原焦点元素可能已经被卸载
    }
  }
}
