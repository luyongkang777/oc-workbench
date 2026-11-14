// HTML 预览资源内联的纯函数测试：
// node --experimental-strip-types --test scripts/htmlPreview.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectResources,
  describeSkipped,
  dirOf,
  htmlPreviewNote,
  inlineLocalResources,
  mimeOf,
  resolveRelative,
  toDataUrl,
} from '../src/components/htmlPreview.ts'

test('dirOf: 取目录、顶层文件为空', () => {
  assert.equal(dirOf('a/b/c.html'), 'a/b')
  assert.equal(dirOf('index.html'), '')
  assert.equal(dirOf('a\\b\\c.html'), 'a/b')
})

test('resolveRelative: 同级 / 子目录 / 父目录', () => {
  assert.equal(resolveRelative('docs/a.html', 'style.css'), 'docs/style.css')
  assert.equal(resolveRelative('docs/a.html', './style.css'), 'docs/style.css')
  assert.equal(resolveRelative('docs/a.html', 'css/app.css'), 'docs/css/app.css')
  assert.equal(resolveRelative('docs/a.html', '../style.css'), 'style.css')
  assert.equal(resolveRelative('a/b/c.html', '../../x.png'), 'x.png')
  assert.equal(resolveRelative('index.html', 'app.js'), 'app.js')
})

test('resolveRelative: 外部地址与锚点不处理', () => {
  assert.equal(resolveRelative('a.html', 'https://x.com/a.css'), null)
  assert.equal(resolveRelative('a.html', '//cdn/x.css'), null)
  assert.equal(resolveRelative('a.html', 'data:text/css,body{}'), null)
  assert.equal(resolveRelative('a.html', '#top'), null)
  assert.equal(resolveRelative('a.html', 'mailto:a@b.c'), null)
  assert.equal(resolveRelative('a.html', ''), null)
})

test('resolveRelative: 跳出工作区返回 null', () => {
  assert.equal(resolveRelative('index.html', '../secret.txt'), null)
  assert.equal(resolveRelative('a.html', '../../x'), null)
})

test('resolveRelative: 去掉查询串和锚点', () => {
  assert.equal(resolveRelative('a.html', 'style.css?v=2'), 'a.css'.replace('a.css', 'style.css'))
  assert.equal(resolveRelative('a.html', 'img/logo.png#frag'), 'img/logo.png')
})

test('collectResources: 挑出 css / script / img，并跳过外链', () => {
  const html = [
    '<link rel="stylesheet" href="style.css">',
    "<link rel='stylesheet' href='/abs.css'>",
    '<link rel="icon" href="favicon.ico">',
    '<script src="app.js"></script>',
    '<script>console.log(1)</script>',
    '<script src="https://cdn/x.js"></script>',
    '<img src="pics/a.png">',
    '<img src="data:image/png;base64,AAA">',
  ].join('\n')
  const refs = collectResources(html, 'docs/page.html')
  const kinds = refs.map((item) => `${item.kind}:${item.ref}->${item.rel ?? 'null'}`)
  assert.deepEqual(kinds, [
    'css:style.css->docs/style.css',
    'css:/abs.css->abs.css',
    'script:app.js->docs/app.js',
    'script:https://cdn/x.js->null',
    'image:pics/a.png->docs/pics/a.png',
    'image:data:image/png;base64,AAA->null',
  ])
})

test('collectResources: 同一资源重复引用只留一条', () => {
  const html = '<img src="a.png"><img src="a.png">'
  const refs = collectResources(html, 'p.html')
  assert.equal(refs.length, 1)
})

test('inlineLocalResources: 把相对资源换成 data URL', async () => {
  const html = [
    '<link rel="stylesheet" href="style.css">',
    '<script src="app.js"></script>',
    '<img src="logo.png">',
  ].join('\n')
  const loaded = []
  const result = await inlineLocalResources(html, 'docs/page.html', async (rel) => {
    loaded.push(rel)
    return new TextEncoder().encode('x-' + rel)
  })
  assert.equal(result.inlined, 3)
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(loaded, ['docs/style.css', 'docs/app.js', 'docs/logo.png'])
  assert.ok(!result.html.includes('href="style.css"'))
  // MIME 必须按扩展名给对，否则样式表会被浏览器忽略
  assert.ok(result.html.includes('data:text/css;base64,'))
  assert.ok(result.html.includes('data:text/javascript;base64,'))
  assert.ok(result.html.includes('data:image/png;base64,'))
})

test('inlineLocalResources: 读不到或太大就跳过，不影响其它资源', async () => {
  const html = '<link rel="stylesheet" href="ok.css"><img src="huge.png"><img src="gone.png">'
  const result = await inlineLocalResources(html, 'p.html', async (rel) => {
    if (rel === 'ok.css') return new TextEncoder().encode('body{}')
    if (rel === 'huge.png') return new Uint8Array(9 * 1024 * 1024)
    return null
  })
  assert.equal(result.inlined, 1)
  assert.deepEqual(result.skipped.sort(), ['gone.png', 'huge.png'])
  assert.ok(result.html.includes('data:text/css;base64,'))
  assert.ok(result.html.includes('src="huge.png"'))
})

test('inlineLocalResources: 同一个资源只读一次', async () => {
  const html = '<img src="a.png"><img src="./a.png">'
  let calls = 0
  await inlineLocalResources(html, 'p.html', async () => {
    calls += 1
    return new TextEncoder().encode('a')
  })
  assert.equal(calls, 1)
})

test('inlineLocalResources: 没有本地资源时原样返回', async () => {
  const html = '<p>纯静态内容</p>'
  const result = await inlineLocalResources(html, 'p.html', async () => {
    throw new Error('不该被调用')
  })
  assert.equal(result.html, html)
  assert.equal(result.inlined, 0)
})

test('mimeOf: 按扩展名给正确的 MIME（css/js 不能是 octet-stream）', () => {
  assert.equal(mimeOf('a/b.css'), 'text/css')
  assert.equal(mimeOf('b.js'), 'text/javascript')
  assert.equal(mimeOf('b.mjs'), 'text/javascript')
  assert.equal(mimeOf('c.PNG'), 'image/png')
  assert.equal(mimeOf('d.svg'), 'image/svg+xml')
  assert.equal(mimeOf('e.woff2'), 'font/woff2')
  assert.equal(mimeOf('noext'), 'application/octet-stream')
})

test('toDataUrl: 拼成 data URL 且带正确 MIME', () => {
  const url = toDataUrl('style.css', new TextEncoder().encode('body{}'))
  assert.ok(url.startsWith('data:text/css;base64,'))
  assert.equal(atob(url.split(',')[1]), 'body{}')
})

test('htmlPreviewNote: 纯静态页面没有说明', () => {
  const html = '<html><body><h1>标题</h1><p>正文</p></body></html>'
  assert.equal(htmlPreviewNote(html), null)
})

test('htmlPreviewNote: 脚本渲染的空壳要说明会空白', () => {
  const html = '<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>'
  const note = htmlPreviewNote(html)
  assert.ok(note)
  assert.ok(note.includes('脚本生成'))
})

test('htmlPreviewNote: 内联成功后不再说「不会加载」', () => {
  const html = '<html><body><h1>x</h1><link rel="stylesheet" href="a.css"></body></html>'
  const note = htmlPreviewNote(html, { inlined: 1, skipped: [] })
  assert.ok(note)
  assert.ok(note.includes('已内联'))
  assert.ok(!note.includes('不会加载（相对路径）'))
})

test('htmlPreviewNote: 有资源没内联成功要点名', () => {
  const html = '<html><body><h1>x</h1><img src="a.png"></body></html>'
  const note = htmlPreviewNote(html, { inlined: 0, skipped: ['a.png'] })
  assert.ok(note)
  assert.ok(note.includes('a.png'))
})

test('describeSkipped: 只列名字、最多三个', () => {
  assert.equal(describeSkipped([]), null)
  assert.equal(describeSkipped(['a/x.css']), 'x.css')
  assert.equal(describeSkipped(['a.css', 'b.css', 'c.css', 'd.css']), 'a.css、b.css、c.css 等 4 个')
})
