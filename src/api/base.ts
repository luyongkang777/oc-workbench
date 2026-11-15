/**
 * 运行时路径前缀。
 *
 * 为什么不在构建期写死：同一个 exe 要给不同实例用不同前缀（`/u/<id>/`），
 * 而二进制只有一份。所以从前页面地址推导：
 *   页面 `/u/abc/` → base `/u/abc`
 *   页面 `/`       → base 为空
 *
 * 只改写「以 / 开头的内部路径」（`/api`、`/local`）；外链、相对路径、`//cdn` 原样返回。
 */

const INTERNAL_PREFIXES = ['/api', '/local']

/**
 * 远程凭据在 localStorage 里的键。**必须带前缀**：localStorage 按 origin 分区，
 * 同一个入口下的多个实例会互相覆盖同一个键，导致「登了 A 结果 B 也变了」。
 */
export function remoteTokenKey(pathname: string = window.location.pathname): string {
  return `oc-workbench:remote-token:${computeBase(pathname)}`
}

/** 从 pathname 算前缀（纯函数，方便单测）。 */
export function computeBase(pathname: string): string {
  const withoutIndex = pathname.replace(/\/index\.html?$/i, '/')
  return withoutIndex.replace(/\/+$/, '')
}

/** 把内部绝对路径加上前缀。`pathname` 默认取当前页面，可注入便于测试。 */
export function withBase(url: string, pathname: string = window.location.pathname): string {
  if (!url.startsWith('/') || url.startsWith('//')) return url
  const base = computeBase(pathname)
  if (!base) return url
  const internal = INTERNAL_PREFIXES.some(
    (prefix) => url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`),
  )
  return internal ? `${base}${url}` : url
}
