// 「裸文件名打不开」的回归测试：node --experimental-strip-types --test scripts/findLocate.test.mjs
//
// 真实故障：聊天里点工具详情 `Status.h`，实际文件在 src\Status.h，
// 前端按工作区根去开 → 404 文件不存在。修法是先按名字在工作区里定位。
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { localFsPlugin } from './dev-local-fs.mjs'

/** 把 dev 的 /local 中间件挂到裸 HTTP 服务上，按真实请求语义验证（含 URL 编码）。 */
async function withServer(fn) {
  let middleware = null
  localFsPlugin().configureServer({
    middlewares: {
      use(handler) {
        middleware = handler
      },
    },
  })
  const server = http.createServer((req, res) =>
    middleware(req, res, () => {
      res.statusCode = 404
      res.end('no route')
    }),
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(async (endpoint, query) => {
      const res = await fetch(`http://127.0.0.1:${port}/local/fs/${endpoint}?${query}`)
      return { status: res.status, body: await res.json().catch(() => null) }
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function makeTree() {
  const root = await mkdtemp(path.join(tmpdir(), 'ocwb-find-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await mkdir(path.join(root, 'include'), { recursive: true })
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(path.join(root, 'src', 'Status.h'), '// real header\n')
  await writeFile(path.join(root, 'include', 'Status.h'), '// include header\n')
  await writeFile(path.join(root, 'node_modules', 'pkg', 'Status.h'), '// vendored\n')
  return root
}

const query = (root, rel) =>
  `root=${encodeURIComponent(root)}&path=${encodeURIComponent(rel)}`

test('裸文件名直接 stat 会 404（故障复现）', async () => {
  const root = await makeTree()
  try {
    await withServer(async (call) => {
      const res = await call('stat', query(root, 'Status.h'))
      assert.equal(res.status, 404)
      assert.match(res.body.error, /文件不存在/)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('find 能按名字找回真实路径：浅层优先、跳过 node_modules', async () => {
  const root = await makeTree()
  try {
    await withServer(async (call) => {
      const res = await call('find', `root=${encodeURIComponent(root)}&name=Status.h`)
      assert.equal(res.status, 200)
      assert.deepEqual(
        res.body.matches.map((item) => item.path),
        ['include\\Status.h', 'src\\Status.h'],
      )
      // 大小写不敏感（聊天里常写小写）
      const lower = await call('find', `root=${encodeURIComponent(root)}&name=status.h`)
      assert.equal(lower.body.matches.length, 2)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('按 find 结果能真正读到文件；找不到时返回空数组', async () => {
  const root = await makeTree()
  try {
    await withServer(async (call) => {
      const found = await call('find', `root=${encodeURIComponent(root)}&name=Status.h`)
      const rel = found.body.matches[1].path
      const stat = await call('stat', query(root, rel))
      assert.equal(stat.status, 200)
      assert.ok(stat.body.size > 0)

      const text = await call('text', query(root, rel))
      assert.equal(text.status, 200)
      assert.match(text.body.text, /real header/)

      const missing = await call('find', `root=${encodeURIComponent(root)}&name=Nope.h`)
      assert.equal(missing.status, 200)
      assert.deepEqual(missing.body.matches, [])
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
