// 文件树结构操作的回归：新建文件夹 / 新建文件 / 重命名 / 删除（dev 中间件真实请求）。
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { localFsPlugin } from '../scripts/dev-local-fs.mjs'

async function startLocalFs() {
  let middleware = null
  localFsPlugin().configureServer({
    middlewares: {
      use(fn) {
        middleware = fn
      },
    },
  })
  assert.ok(middleware, '中间件没有注册')
  const server = http.createServer((req, res) => {
    middleware(req, res, () => {
      res.statusCode = 404
      res.end('not found')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function withDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocwb-ops-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function op(base, dir, action, rel, extra = '') {
  const query = `root=${encodeURIComponent(dir)}&path=${encodeURIComponent(rel)}${extra}`
  return fetch(`${base}/local/fs/${action}?${query}`, { method: 'POST' })
}

test('新建文件夹 → 新建文件 → 重命名 → 递归删除', async () => {
  const app = await startLocalFs()
  try {
    await withDir(async (dir) => {
      assert.equal((await op(app.base, dir, 'mkdir', 'src')).status, 200)
      assert.equal((await stat(path.join(dir, 'src'))).isDirectory(), true)

      // 重名 409
      assert.equal((await op(app.base, dir, 'mkdir', 'src')).status, 409)

      // 代码文件
      assert.equal((await op(app.base, dir, 'create', 'src/main.cpp')).status, 200)
      assert.equal((await stat(path.join(dir, 'src', 'main.cpp'))).isFile(), true)
      assert.equal((await op(app.base, dir, 'create', 'src/main.cpp')).status, 409)

      // 重命名
      const renamed = await op(
        app.base,
        dir,
        'rename',
        'src/main.cpp',
        '&to=' + encodeURIComponent('src/app.cpp'),
      )
      assert.equal(renamed.status, 200)
      const files = await readdir(path.join(dir, 'src'))
      assert.deepEqual(files, ['app.cpp'])

      // 目标已被占用
      assert.equal(
        (
          await op(app.base, dir, 'create', 'src/other.cpp')
        ).status,
        200,
      )
      const taken = await op(
        app.base,
        dir,
        'rename',
        'src/app.cpp',
        '&to=' + encodeURIComponent('src/other.cpp'),
      )
      assert.equal(taken.status, 409)

      // 删目录（递归）
      assert.equal((await op(app.base, dir, 'delete', 'src')).status, 200)
      await assert.rejects(() => stat(path.join(dir, 'src')))
    })
  } finally {
    await app.close()
  }
})

test('名字与路径防护：保留名 / 非法字符 / 越界 / 删根 / 需要 POST', async () => {
  const app = await startLocalFs()
  try {
    await withDir(async (dir) => {
      assert.equal((await op(app.base, dir, 'create', 'a:b.cpp')).status, 400)
      assert.equal((await op(app.base, dir, 'create', 'CON.txt')).status, 400)
      assert.equal((await op(app.base, dir, 'create', 'bad.')).status, 400)
      assert.equal((await op(app.base, dir, 'mkdir', '../evil')).status, 400)
      assert.equal((await op(app.base, dir, 'create', 'nope/a.cpp')).status, 404)
      assert.equal((await op(app.base, dir, 'delete', '')).status, 400)
      // 已有文件也要能删
      await writeFile(path.join(dir, 'gone.txt'), 'x')
      assert.equal((await op(app.base, dir, 'delete', 'gone.txt')).status, 200)

      // GET 打结构接口必须 405
      const query = `root=${encodeURIComponent(dir)}&path=docs`
      const res = await fetch(`${app.base}/local/fs/mkdir?${query}`)
      assert.equal(res.status, 405)
    })
  } finally {
    await app.close()
  }
})
