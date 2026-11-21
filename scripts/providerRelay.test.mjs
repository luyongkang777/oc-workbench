// dev 侧 relay 地址还原的回归。
// node --experimental-strip-types --test scripts/providerRelay.test.mjs
//
// 背景：磁盘上的 OpenCode Go / Command Code 会被改写成
// http://127.0.0.1:<port>/local/relay/<secret>/go|cc。
// 还原失败会让额度识别认不出服务商（整行额度消失）、图标退化成首字母。
import assert from 'node:assert/strict'
import test from 'node:test'

import { upstreamOf } from './dev-local-provider-util.mjs'

const GO = 'https://opencode.ai/inference/go/openai/v1'
const CC = 'https://api.commandcode.ai/provider/v1'

test('go / cc 转发地址还原成上游', () => {
  assert.equal(upstreamOf('http://127.0.0.1:17800/local/relay/abc123/go'), GO)
  assert.equal(upstreamOf('http://127.0.0.1:17800/local/relay/abc123/cc'), CC)
  // 远程入口带 /u/<id> 前缀
  assert.equal(upstreamOf('http://localhost:5273/u/645a6a9ede23f047/local/relay/abc123/go'), GO)
  // 尾斜杠
  assert.equal(upstreamOf('http://127.0.0.1:17800/local/relay/abc123/cc/'), CC)
})

test('不是本机 relay 的一律原样返回', () => {
  assert.equal(upstreamOf('https://opencode.ai/inference/go/openai/v1'), GO)
  assert.equal(upstreamOf('https://api.commandcode.ai/provider/v1'), CC)
  assert.equal(upstreamOf('http://127.0.0.1:17800/local/relay/nope'), 'http://127.0.0.1:17800/local/relay/nope')
  // 外部域名冒充 relay 路径不能改写
  assert.equal(upstreamOf('https://evil.example/local/relay/abc/go'), 'https://evil.example/local/relay/abc/go')
  assert.equal(upstreamOf(''), '')
})
