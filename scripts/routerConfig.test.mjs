/**
 * 多模型路由配置生成/解析测试。
 *
 *   npm test
 *   node --experimental-strip-types --test scripts/routerConfig.test.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ROUTER_AGENT_NAMES,
  buildRouterAgents,
  modelRef,
  modelsFromAgents,
  parseModelRef,
  parseRouterAgent,
  routerStatus,
  sameModel,
  validateRouterModels,
} from '../src/components/routerConfig.ts'

const MODELS = {
  main: { providerID: 'anthropic', id: 'claude-sonnet-5-5', variant: 'high' },
  worker: { providerID: 'deepseek-official', id: 'deepseek-flash' },
  reviewer: { providerID: 'openai', id: 'gpt-5.2' },
}

// ---------------------------------------------------------------- 模型引用

test('modelRef: 带档位拼成 provider/id#variant', () => {
  assert.equal(modelRef(MODELS.main), 'anthropic/claude-sonnet-5-5#high')
})

test('modelRef: 没有档位不写 #', () => {
  assert.equal(modelRef(MODELS.worker), 'deepseek-official/deepseek-flash')
})

test('modelRef: 空模型返回空串', () => {
  assert.equal(modelRef(undefined), '')
  assert.equal(modelRef({ providerID: '', id: 'x' }), '')
})

test('parseModelRef: model id 里的斜杠要保留', () => {
  assert.deepEqual(parseModelRef('openrouter/anthropic/claude-3#low'), {
    providerID: 'openrouter',
    id: 'anthropic/claude-3',
    variant: 'low',
  })
})

test('parseModelRef: 没有档位和非法输入', () => {
  assert.deepEqual(parseModelRef('deepseek-official/deepseek-flash'), {
    providerID: 'deepseek-official',
    id: 'deepseek-flash',
  })
  assert.equal(parseModelRef(''), undefined)
  assert.equal(parseModelRef('no-slash'), undefined)
  assert.equal(parseModelRef('/leading'), undefined)
})

test('sameModel: 不看档位', () => {
  assert.equal(
    sameModel({ providerID: 'a', id: 'b', variant: 'high' }, { providerID: 'a', id: 'b' }),
    true,
  )
  assert.equal(sameModel({ providerID: 'a', id: 'b' }, { providerID: 'a', id: 'c' }), false)
  assert.equal(sameModel(undefined, { providerID: 'a', id: 'b' }), false)
})

// ---------------------------------------------------------------- 校验

test('validateRouterModels: 全填且执行体≠审核体时通过', () => {
  assert.deepEqual(validateRouterModels(MODELS), [])
})

test('validateRouterModels: 缺模型报中文错误', () => {
  const errors = validateRouterModels({ ...MODELS, worker: { providerID: '', id: '' } })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /执行体/)
})

test('validateRouterModels: 执行体和审核体同模型被拦', () => {
  const errors = validateRouterModels({
    ...MODELS,
    reviewer: { ...MODELS.worker },
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /自己审自己/)
})

test('validateRouterModels: 同模型不同档位仍算同一个', () => {
  const errors = validateRouterModels({
    ...MODELS,
    reviewer: { ...MODELS.worker, variant: 'max' },
  })
  assert.equal(errors.length, 1)
})

// ---------------------------------------------------------------- 生成

test('buildRouterAgents: 固定三个角色和文件名', () => {
  const files = buildRouterAgents(MODELS)
  assert.deepEqual(
    files.map((file) => file.name),
    [ROUTER_AGENT_NAMES.main, ROUTER_AGENT_NAMES.worker, ROUTER_AGENT_NAMES.reviewer],
  )
  assert.deepEqual(
    files.map((file) => file.role),
    ['main', 'worker', 'reviewer'],
  )
})

test('buildRouterAgents: 主脑是 primary，另外两个是 subagent', () => {
  const files = buildRouterAgents(MODELS)
  const main = files.find((file) => file.role === 'main')
  const worker = files.find((file) => file.role === 'worker')
  const reviewer = files.find((file) => file.role === 'reviewer')
  assert.match(main.content, /^mode: primary$/m)
  assert.match(worker.content, /^mode: subagent$/m)
  assert.match(reviewer.content, /^mode: subagent$/m)
})

test('buildRouterAgents: 三个文件都写进了各自模型', () => {
  const files = buildRouterAgents(MODELS)
  assert.match(files[0].content, /^model: anthropic\/claude-sonnet-5-5#high$/m)
  assert.match(files[1].content, /^model: deepseek-official\/deepseek-flash$/m)
  assert.match(files[2].content, /^model: openai\/gpt-5\.2$/m)
})

test('buildRouterAgents: 主脑明确禁掉 edit/shell，只能派两个子 agent', () => {
  const main = buildRouterAgents(MODELS)[0].content
  assert.match(main, /action: "\*"[\s\S]*effect: deny/)
  assert.match(main, new RegExp(`resource: ${ROUTER_AGENT_NAMES.worker}[\\s\\S]*effect: allow`))
  assert.match(main, new RegExp(`resource: ${ROUTER_AGENT_NAMES.reviewer}[\\s\\S]*effect: allow`))
  assert.doesNotMatch(main, /action: edit[\s\S]*effect: allow/)
})

test('buildRouterAgents: 执行体不能派子代理，审核体不能改文件', () => {
  const files = buildRouterAgents(MODELS)
  assert.match(files[1].content, /action: subagent[\s\S]*effect: deny/)
  assert.match(files[2].content, /action: edit[\s\S]*effect: deny/)
})

test('buildRouterAgents: 执行体 system 里要求四段式摘要', () => {
  const worker = buildRouterAgents(MODELS)[1].content
  assert.match(worker, /做了什么/)
  assert.match(worker, /改了哪些文件/)
})

// ---------------------------------------------------------------- 幂等

test('buildRouterAgents → parseRouterAgent 能反解出模型', () => {
  const parsed = buildRouterAgents(MODELS).map((file) => parseRouterAgent(file.name, file.content))
  const models = modelsFromAgents(parsed)
  assert.deepEqual(models.main, MODELS.main)
  assert.deepEqual(models.worker, MODELS.worker)
  assert.deepEqual(models.reviewer, MODELS.reviewer)
})

test('第二次生成与第一次完全一致（幂等）', () => {
  const first = buildRouterAgents(MODELS)
  const models = modelsFromAgents(
    first.map((file) => parseRouterAgent(file.name, file.content)),
  )
  const second = buildRouterAgents({
    main: models.main,
    worker: models.worker,
    reviewer: models.reviewer,
  })
  assert.deepEqual(
    first.map((file) => file.content),
    second.map((file) => file.content),
  )
})

test('parseRouterAgent: 没 frontmatter 只返回名字', () => {
  assert.deepEqual(parseRouterAgent('x', 'hello'), { name: 'x' })
})

test('parseRouterAgent: 描述里的单引号能读回来', () => {
  const content = "---\ndescription: 'it''s fine'\nmode: subagent\n---\nbody"
  assert.equal(parseRouterAgent('x', content).description, "it's fine")
})

// ---------------------------------------------------------------- 状态

test('routerStatus: 三个齐全才算 ready', () => {
  const all = routerStatus(Object.values(ROUTER_AGENT_NAMES))
  assert.equal(all.ready, true)
  assert.deepEqual(all.missing, [])

  const partial = routerStatus([ROUTER_AGENT_NAMES.main, ROUTER_AGENT_NAMES.worker])
  assert.equal(partial.ready, false)
  assert.deepEqual(partial.missing, ['reviewer'])
})

test('routerStatus: 也接受解析后的对象', () => {
  const status = routerStatus([{ name: ROUTER_AGENT_NAMES.main }])
  assert.equal(status.present.main, true)
  assert.equal(status.present.worker, false)
})
