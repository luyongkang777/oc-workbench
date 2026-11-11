// 保存通道的回归：多编码编解码 + dev 中间件的 PUT（编码切换 / 冲突 / 二进制 / 路径穿越）。
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  countLines,
  decodeUtf8Strict,
  encodeText,
  localFsPlugin,
  normalizeEncoding,
} from '../scripts/dev-local-fs.mjs'

test('encodeText：UTF-8 的 BOM / CRLF 原样保留', () => {
  assert.deepEqual(encodeText('a\nb\n', 'utf8', false, false), Buffer.from('a\nb\n', 'utf8'))
  assert.deepEqual(encodeText('a\nb\n', 'utf8', true, false), Buffer.from('\ufeffa\nb\n', 'utf8'))
  assert.deepEqual(encodeText('a\nb\n', 'utf8', false, true), Buffer.from('a\r\nb\r\n', 'utf8'))
  // 前端偶尔带裸 \r（粘贴 / 旧草稿）：先归一，再按文件风格写回
  assert.deepEqual(
    encodeText('a\r\nb\rc', 'utf8', true, true),
    Buffer.from('\ufeffa\r\nb\r\nc', 'utf8'),
  )
})

test('encodeText：UTF-16 一定带 BOM，字节序正确', () => {
  assert.deepEqual(
    encodeText('a\n', 'utf16le', false, false),
    Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x0a, 0x00]),
  )
  assert.deepEqual(
    encodeText('a\n', 'utf16be', false, false),
    Buffer.from([0xfe, 0xff, 0x00, 0x61, 0x00, 0x0a]),
  )
  // 中文 + CRLF：换行在字符串层还原，再整体按 UTF-16LE 落字节
  const bytes = encodeText('中\r\n', 'utf16le', false, true)
  assert.deepEqual(bytes, Buffer.from('\ufeff中\r\n', 'utf16le'))
})

test('encodeText：GBK 中文往返一致，且不是 UTF-8 字节', () => {
  const text = '中文\n第二行\n'
  const bytes = encodeText(text, 'gbk', false, false)
  assert.notDeepEqual(bytes, Buffer.from(text, 'utf8'))
  assert.equal(new TextDecoder('gb18030').decode(bytes), text)
  // ASCII 部分与 UTF-8 相同
  assert.deepEqual(encodeText('abc', 'gbk', false, false), Buffer.from('abc', 'utf8'))
})

test('countLines 与行索引口径一致', () => {
  assert.equal(countLines(''), 0)
  assert.equal(countLines('a'), 1)
  assert.equal(countLines('a\n'), 1)
  assert.equal(countLines('a\nb'), 2)
  assert.equal(countLines('a\nb\n'), 2)
  assert.equal(countLines('中文\n第二行\n'), 2)
})

test('decodeUtf8Strict 拒绝非法字节，不改写内容', () => {
  assert.equal(decodeUtf8Strict(Buffer.from('中文 ✓', 'utf8')), '中文 ✓')
  const bad = Buffer.from([0x61, 0xff, 0x62])
  assert.throws(
    () => decodeUtf8Strict(bad),
    (err) => err.status === 400 && /UTF-8/.test(err.message),
  )
})

test('normalizeEncoding 认常见写法，未知返回 null', () => {
  assert.equal(normalizeEncoding('UTF-8'), 'utf8')
  assert.equal(normalizeEncoding('utf16le'), 'utf16le')
  assert.equal(normalizeEncoding('UTF-16BE'), 'utf16be')
  assert.equal(normalizeEncoding('gb2312'), 'gbk')
  assert.equal(normalizeEncoding('gb18030'), 'gbk')
  assert.equal(normalizeEncoding('big5'), null)
})

/** 把 dev 中间件挂到一个裸 http server 上，直接打真实请求。 */
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
  const dir = await mkdtemp(path.join(tmpdir(), 'ocwb-write-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('PUT /local/fs/write 落盘，并按 mtime 拒绝过期覆盖', async () => {
  const app = await startLocalFs()
  try {
    await withDir(async (dir) => {
      const file = path.join(dir, 'a.txt')
      await writeFile(file, 'one\ntwo\n')
      const before = await stat(file)
      const query = `root=${encodeURIComponent(dir)}&path=a.txt`

      const saved = await fetch(
        `${app.base}/local/fs/write?${query}&expectedMtimeMs=${Math.trunc(before.mtimeMs)}`,
        { method: 'PUT', body: 'one\ntwo\nthree\n' },
      )
      assert.equal(saved.status, 200)
      const body = await saved.json()
      assert.equal(body.lineCount, 3)
      assert.equal(body.encoding, 'utf8')
      assert.equal(await readFile(file, 'utf8'), 'one\ntwo\nthree\n')

      // 把 mtime 拨到将来，模拟「别处改过」：旧 mtime 必须 409
      const future = new Date(Date.now() + 5000)
      await utimes(file, future, future)
      const stale = await fetch(
        `${app.base}/local/fs/write?${query}&expectedMtimeMs=${Math.trunc(before.mtimeMs)}`,
        { method: 'PUT', body: 'stale\n' },
      )
      assert.equal(stale.status, 409)
      assert.equal(await readFile(file, 'utf8'), 'one\ntwo\nthree\n')
    })
  } finally {
    await app.close()
  }
})

test('保存保留 CRLF，二进制与目录路径被拒', async () => {
  const app = await startLocalFs()
  try {
    await withDir(async (dir) => {
      const crlf = path.join(dir, 'win.txt')
      await writeFile(crlf, 'a\r\nb\r\n')
      const saved = await fetch(
        `${app.base}/local/fs/write?root=${encodeURIComponent(dir)}&path=win.txt`,
        { method: 'PUT', body: 'a\nb\nc\n' },
      )
      assert.equal(saved.status, 200)
      assert.equal(await readFile(crlf, 'utf8'), 'a\r\nb\r\nc\r\n')

      const bin = path.join(dir, 'blob.bin')
      await writeFile(bin, Buffer.from([0x00, 0x01, 0xff]))
      const refused = await fetch(
        `${app.base}/local/fs/write?root=${encodeURIComponent(dir)}&path=blob.bin`,
        { method: 'PUT', body: 'text' },
      )
      assert.equal(refused.status, 415)

      const traversal = await fetch(
        `${app.base}/local/fs/write?root=${encodeURIComponent(dir)}&path=../evil.txt`,
        { method: 'PUT', body: 'x' },
      )
      assert.equal(traversal.status, 400)
    })
  } finally {
    await app.close()
  }
})

test('GBK 文件：stat 认成 gbk、text 解得对、保存仍是 GBK', async () => {
  const app = await startLocalFs()
  try {
    await withDir(async (dir) => {
      const file = path.join(dir, 'gbk.txt')
      await writeFile(file, encodeText('中文\n第二行\n', 'gbk', false, false))
      const query = `root=${encodeURIComponent(dir)}&path=gbk.txt`

      const info = await fetch(`${app.base}/local/fs/stat?${query}`).then((res) => res.json())
      assert.equal(info.encoding, 'gbk')
      assert.equal(info.lineCount, 2)

      const text = await fetch(`${app.base}/local/fs/text?${query}`).then((res) => res.json())
      assert.equal(text.text, '中文\n第二行\n')

      // 不带 encoding：沿用原编码
      const saved = await fetch(`${app.base}/local/fs/write?${query}`, {
        method: 'PUT',
        body: '中文\n第二行\n第三行\n',
      })
      assert.equal(saved.status, 200)
      assert.equal((await saved.json()).encoding, 'gbk')
      const bytes = await readFile(file)
      assert.equal(new TextDecoder('gb18030').decode(bytes), '中文\n第二行\n第三行\n')
    })
  } finally {
    await app.close()
  }
})

test('指定 encoding=gbk / utf16le 可以把 UTF-8 文件改编码保存', async () => {
  const app = await startLocalFs()
  try {
    await withDir(async (dir) => {
      const file = path.join(dir, 'conv.txt')
      await writeFile(file, '中文\n', 'utf8')
      const query = `root=${encodeURIComponent(dir)}&path=conv.txt`

      const toGbk = await fetch(`${app.base}/local/fs/write?${query}&encoding=gbk`, {
        method: 'PUT',
        body: '中文\n',
      })
      assert.equal(toGbk.status, 200)
      assert.equal((await toGbk.json()).encoding, 'gbk')
      assert.equal(new TextDecoder('gb18030').decode(await readFile(file)), '中文\n')

      const toUtf16 = await fetch(`${app.base}/local/fs/write?${query}&encoding=utf16le`, {
        method: 'PUT',
        body: '中文\n',
      })
      assert.equal((await toUtf16.json()).encoding, 'utf16le')
      const bytes = await readFile(file)
      assert.deepEqual(bytes.subarray(0, 2), Buffer.from([0xff, 0xfe]))
      assert.equal(bytes.subarray(2).toString('utf16le'), '中文\n')

      const bad = await fetch(`${app.base}/local/fs/write?${query}&encoding=big5`, {
        method: 'PUT',
        body: 'x',
      })
      assert.equal(bad.status, 400)
    })
  } finally {
    await app.close()
  }
})

test('GET 打 write 接口回 405', async () => {
  const app = await startLocalFs()
  try {
    await withDir(async (dir) => {
      await writeFile(path.join(dir, 'a.txt'), 'x\n')
      const res = await fetch(
        `${app.base}/local/fs/write?root=${encodeURIComponent(dir)}&path=a.txt`,
      )
      assert.equal(res.status, 405)
    })
  } finally {
    await app.close()
  }
})

test('GET 编码覆盖：encoding=gbk 可以把 UTF-8 文件按 GBK 重新解释', async () => {
  const app = await startLocalFs()
  try {
    await withDir(async (dir) => {
      const file = path.join(dir, 'utf8.txt')
      await writeFile(file, '中文\n', 'utf8')
      const query = `root=${encodeURIComponent(dir)}&path=utf8.txt`

      const stat = await fetch(`${app.base}/local/fs/stat?${query}&encoding=gbk`).then((res) =>
        res.json(),
      )
      assert.equal(stat.encoding, 'gbk')

      const text = await fetch(`${app.base}/local/fs/text?${query}&encoding=gbk`).then((res) =>
        res.json(),
      )
      assert.notEqual(text.text, '中文\n')

      // 不带 encoding：回到自动探测，还是原文
      const auto = await fetch(`${app.base}/local/fs/text?${query}`).then((res) => res.json())
      assert.equal(auto.text, '中文\n')

      // 分页读取同样按覆盖编码解
      const window = await fetch(
        `${app.base}/local/fs/read?${query}&start=0&lines=10&encoding=gbk`,
      ).then((res) => res.json())
      assert.notEqual(window.text, '中文')

      // 不认识的编码直接 400
      const bad = await fetch(`${app.base}/local/fs/stat?${query}&encoding=big5`)
      assert.equal(bad.status, 400)
    })
  } finally {
    await app.close()
  }
})
