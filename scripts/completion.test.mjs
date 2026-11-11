// 代码补全纯逻辑测试：node --experimental-strip-types --test scripts/completion.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyCompletion,
  buildCandidates,
  caretLineCol,
  collectSymbols,
  isCodeLang,
  languageOf,
  pathCandidates,
  popupPlacement,
  rankCandidates,
  readContext,
  shouldAutoTrigger,
} from '../src/components/completion.ts'

test('语言识别：常见扩展名', () => {
  assert.equal(languageOf('a/b/c.ts'), 'ts')
  assert.equal(languageOf('C:\\x\\y.TSX'), 'ts')
  assert.equal(languageOf('main.py'), 'python')
  assert.equal(languageOf('lib.rs'), 'rust')
  assert.equal(languageOf('README.md'), 'markdown')
  assert.equal(languageOf('Makefile'), 'text')
  assert.equal(isCodeLang('markdown'), false)
  assert.equal(isCodeLang('text'), false)
  assert.equal(isCodeLang('ts'), true)
})

test('上下文：标识符中间取前缀', () => {
  const text = 'const value = greet(x)'
  const pos = text.indexOf('val') + 3
  const ctx = readContext(text, pos)
  assert.equal(ctx.mode, 'word')
  assert.equal(ctx.prefix, 'val')
  assert.equal(ctx.start, text.indexOf('val'))
})

test('上下文：点之后是成员补全，前缀可以为空', () => {
  const text = 'obj.'
  const ctx = readContext(text, text.length)
  assert.equal(ctx.mode, 'member')
  assert.equal(ctx.prefix, '')
})

test('上下文：字符串里识别为路径补全', () => {
  const text = 'import x from "./gre'
  const ctx = readContext(text, text.length)
  assert.equal(ctx.mode, 'path')
  assert.equal(ctx.prefix, './gre')
  assert.equal(ctx.quote, '"')
})

test('上下文：字符串已闭合就不是路径', () => {
  const text = 'const a = "hello" + bo'
  const ctx = readContext(text, text.length)
  assert.equal(ctx.mode, 'word')
  assert.equal(ctx.prefix, 'bo')
})

test('上下文：行注释之后不补路径', () => {
  const text = 'const a = 1 // "not a string'
  const ctx = readContext(text, text.length)
  assert.equal(ctx.mode, 'word')
})

test('触发规则', () => {
  assert.equal(shouldAutoTrigger('g', readContext('gre', 3)), true)
  assert.equal(shouldAutoTrigger(' ', readContext('hello roll', 10)), true)
  assert.equal(shouldAutoTrigger('1', readContext('12', 2)), false)
  assert.equal(shouldAutoTrigger('.', readContext('obj.', 4)), true)
  assert.equal(shouldAutoTrigger('r', readContext('import x from "./gre', 20)), true)
  assert.equal(shouldAutoTrigger('h', readContext('const a = "hello', 15)), false)
  assert.equal(shouldAutoTrigger('g', readContext('', 0).mode === 'word' ? readContext('', 0) : readContext('', 0)), false)
})

test('抽符号：TS 函数 / 类 / 接口 / 变量 / import', () => {
  const src = `
import { helper, other as alias } from './lib'
import React from 'react'

export function greet(name) { return name }
export class Store {}
export interface Options { a: 1 }
const timeout = 10
let count: number = 0
`
  const names = collectSymbols(src, 'ts').map((s) => s.name)
  assert.ok(names.includes('greet'))
  assert.ok(names.includes('Store'))
  assert.ok(names.includes('Options'))
  assert.ok(names.includes('timeout'))
  assert.ok(names.includes('count'))
  assert.ok(names.includes('helper'))
  assert.ok(names.includes('alias'))
  assert.ok(names.includes('React'))
  // 去重
  assert.equal(new Set(names).size, names.length)
})

test('抽符号：Python', () => {
  const src = `
import os
from typing import List, Optional as Opt

def run(job):
    pass

class Worker:
    pass

RETRY = 3
`
  const names = collectSymbols(src, 'python').map((s) => s.name)
  assert.ok(names.includes('run'))
  assert.ok(names.includes('Worker'))
  assert.ok(names.includes('RETRY'))
  assert.ok(names.includes('List'))
  assert.ok(names.includes('Opt'))
})

test('抽符号：Rust / Go', () => {
  const rust = collectSymbols('fn main() {}\nstruct Foo;\nconst MAX: u8 = 1;', 'rust').map((s) => s.name)
  assert.ok(rust.includes('main'))
  assert.ok(rust.includes('Foo'))
  assert.ok(rust.includes('MAX'))

  const go = collectSymbols('func Start() {}\ntype Server struct{}\nvar count int', 'go').map((s) => s.name)
  assert.ok(go.includes('Start'))
  assert.ok(go.includes('Server'))
  assert.ok(go.includes('count'))
})

test('排序：前缀匹配优先于包含匹配', () => {
  const pool = [
    { label: 'loadConfig', kind: 'local' },
    { label: 'config', kind: 'local' },
    { label: 'setConfig', kind: 'keyword' },
  ]
  const out = rankCandidates(pool, 'conf', 10)
  assert.equal(out[0].label, 'config')
  assert.ok(out.some((c) => c.label === 'loadConfig'))
})

test('排序：同名去重保留更高分来源', () => {
  const out = rankCandidates(
    [
      { label: 'greet', kind: 'keyword' },
      { label: 'greet', kind: 'local', detail: '本文件' },
    ],
    'gr',
    10,
  )
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'local')
})

test('排序：等于前缀的候选排最后，避免 Tab 补成自己', () => {
  const out = rankCandidates(
    [
      { label: 'abc', kind: 'local' },
      { label: 'abcd', kind: 'local' },
    ],
    'abc',
    10,
  )
  assert.equal(out[0].label, 'abcd')
})

test('空前缀：自动触发不给候选，手动触发给关键字', () => {
  const ctx = readContext('x', 0)
  const auto = buildCandidates({ lang: 'ts', ctx, local: [] })
  assert.equal(auto.length, 0)
  const manual = buildCandidates({ lang: 'ts', ctx, local: [], manual: true })
  assert.ok(manual.length > 10)
  assert.ok(manual.some((c) => c.label === 'function'))
})

test('接受候选：替换前缀并定位光标', () => {
  const text = 'const a = gre'
  const ctx = readContext(text, text.length)
  const result = applyCompletion(text, ctx, { label: 'greet', kind: 'local' })
  assert.equal(result.text, 'const a = greet')
  assert.equal(result.caret, result.text.length)

  // 光标在中间：后缀不能被吃掉
  const mid = 'gr)'
  const midCtx = readContext(mid, 2)
  const out = applyCompletion(mid, midCtx, { label: 'greet', kind: 'local' })
  assert.equal(out.text, 'greet)')
  assert.equal(out.caret, 5)
})

test('路径补全：目录带斜杠、前缀过滤、保留 ./ 前缀', () => {
  const entries = [
    { name: 'greet.js', isDir: false },
    { name: 'components', isDir: true },
    { name: 'index.js', isDir: false },
  ]
  const out = pathCandidates(entries, './gr')
  assert.equal(out.length, 1)
  assert.equal(out[0].label, 'greet.js')
  assert.equal(out[0].insert, './greet.js')

  const dirs = pathCandidates(entries, './c')
  assert.equal(dirs[0].label, 'components/')
  assert.equal(dirs[0].insert, './components/')
})

test('路径补全：没有前缀时列出当前目录全部', () => {
  const out = pathCandidates([{ name: 'a.ts', isDir: false }], './')
  assert.equal(out.length, 1)
  assert.equal(out[0].insert, './a.ts')
})

test('行列计算：多行文本与行尾', () => {
  const text = 'aa\nbbbb\ncc'
  assert.deepEqual(caretLineCol(text, 0), { line: 0, col: 0 })
  assert.deepEqual(caretLineCol(text, 3), { line: 1, col: 0 })
  assert.deepEqual(caretLineCol(text, text.length), { line: 2, col: 2 })
})

test('成员补全带上本文件符号', () => {
  const text = 'function loadConfig() {}\ncfg.'
  const ctx = readContext(text, text.length)
  const local = collectSymbols(text, 'ts')
  const items = buildCandidates({ lang: 'ts', ctx, local })
  assert.ok(items.some((c) => c.label === 'loadConfig'))
})

test('浮层定位：跟随光标列，行号列与内边距都算进去', () => {
  const place = popupPlacement({
    line: 1,
    col: 3,
    charWidth: 7.5,
    scrollTop: 0,
    scrollLeft: 0,
    paneWidth: 800,
    paneHeight: 600,
    rows: 5,
  })
  assert.equal(place.left, 68 + 12 + 22.5)
  assert.equal(place.top, 19 + 19)
})

test('浮层定位：靠右时夹在编辑区内', () => {
  const place = popupPlacement({
    line: 0, col: 200, charWidth: 7.5, scrollTop: 0, scrollLeft: 0,
    paneWidth: 800, paneHeight: 600, rows: 5,
  })
  assert.equal(place.left, 800 - 330 - 4)
})

test('浮层定位：下方放不下就翻到光标上方', () => {
  const place = popupPlacement({
    line: 30, col: 0, charWidth: 7.5, scrollTop: 0, scrollLeft: 0,
    paneWidth: 800, paneHeight: 600, rows: 5,
  })
  assert.ok(place.top < 30 * 19, String(place.top))
  assert.ok(place.top >= 0)
})

test('浮层定位：顶部放不下时不会出现负坐标', () => {
  const place = popupPlacement({
    line: 0, col: 0, charWidth: 7.5, scrollTop: 0, scrollLeft: 0,
    paneWidth: 800, paneHeight: 30, rows: 9,
  })
  assert.equal(place.top, 0)
})

test('浮层定位：编辑区很窄时宽度跟着收', () => {
  const place = popupPlacement({
    line: 0, col: 0, charWidth: 7.5, scrollTop: 0, scrollLeft: 0,
    paneWidth: 200, paneHeight: 600, rows: 3,
  })
  assert.equal(place.width, 192)
})
