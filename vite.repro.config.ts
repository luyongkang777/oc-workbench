// 复现专用：继承主配置，只把 release/（打包产物、WebView2 缓存）排除出 watcher，
// 那里有被占用的文件会让 fs.watch 抛 EBUSY 把 dev server 直接带崩。
import { defineConfig } from 'vite'
import base from './vite.config'

export default defineConfig(async (env) => {
  const config = await (typeof base === 'function' ? base(env) : base)
  const ignored = new Set(config.server?.watch?.ignored ?? [])
  ignored.add('**/release/**')
  ignored.add('**/.tmp/**')
  return {
    ...config,
    server: {
      ...config.server,
      watch: { ...config.server?.watch, ignored: [...ignored] },
    },
  }
})
