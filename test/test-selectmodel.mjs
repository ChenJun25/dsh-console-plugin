/**
 * test-selectmodel.mjs —— 0.4.0 换模型 op 的逻辑测试（进程外直调）
 *
 * 不起 LAN 服务、不碰真 DSH：mock sessionController 按宿主实测形状回包，
 * 验证 runCommand 里 selectModel / modelCatalog / sessions.model 三个新路径。
 * 跑法：node test/test-selectmodel.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const { apply: applyFn } = await import('../lib/index.js')

/** 按宿主实测形状 mock sessionController（sc-index.js:720 / modelCatalog 实测回包） */
function mockCtl() {
  return {
    list: async () => ({
      items: [{
        sessionId: 's-1',
        updatedAt: 1,
        running: false,
        projections: { values: { title: 't', modelSelection: {
          lastUsed: { provider: 'workbuddy', model: 'glm-5.3-flash', reasoningEffort: 'high' },
          next: { provider: 'deepseek-official', model: 'deepseek-flash' }
        } } }
      }]
    }),
    selectModel: async (req) => {
      if (!req.provider || !req.model) throw new Error('Select an available model before sending a message.')
      return { selected: { provider: req.provider, model: req.model, ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}) } }
    },
    modelCatalog: async () => ({
      default: { provider: 'workbuddy', model: 'glm-5.3-flash', reasoningEffort: 'high' },
      routableProviders: ['deepseek-official', 'deepseek-account', 'workbuddy'],
      groups: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [{
          id: 'deepseek-flash',
          name: 'DeepSeek-V41-Flash',
          reasoning: {
            efforts: [{ id: 'off', name: 'Off', description: 'x' }, { id: 'low', name: 'Low', description: 'y' }],
            defaultEffort: 'high'
          }
        }]
      }]
    })
  }
}

/** 从 apply() 里抠出 runCommand：注册路由时截胡 cmd 路由的 fetch 处理器 */
function extractRunCommand() {
  const ctl = mockCtl()
  let captured = null
  const conn = { fetch: { register: (route) => {
    if (route.path === '/api/dsh-console/cmd') captured = route.fetch
    return () => {}
  } } }
  applyFn({ get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : null), effect: () => () => {} }, { port: 0 })
  assert.ok(captured, 'cmd 路由没注册上')
  return captured
}

const post = (cmd, payload) => cmd(new Request('http://x', {
  method: 'POST',
  body: JSON.stringify({ op: payload.op, payload })
})).then((r) => r.json())

test('selectModel 扁平形状直达宿主（含 effort）', async () => {
  const cmd = extractRunCommand()
  const j = await post(cmd, { op: 'selectModel', sessionId: 's-1', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' })
  assert.equal(j.ok, true)
  assert.deepEqual(j.result.selected, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' })
})

test('selectModel 不带 effort 也通', async () => {
  const cmd = extractRunCommand()
  const j = await post(cmd, { op: 'selectModel', sessionId: 's-1', provider: 'workbuddy', model: 'glm-5.3-flash' })
  assert.equal(j.ok, true)
  assert.deepEqual(j.result.selected, { provider: 'workbuddy', model: 'glm-5.3-flash', reasoningEffort: '' })
})

test('selectModel 缺参会报错而不是裸崩', async () => {
  const cmd = extractRunCommand()
  const j = await post(cmd, { op: 'selectModel', sessionId: 's-1' })
  assert.equal(j.ok, false)
  assert.match(j.error, /provider 或 model/)
})

test('modelCatalog 出标准形状（groups/models/efforts）', async () => {
  const cmd = extractRunCommand()
  const j = await post(cmd, { op: 'modelCatalog' })
  assert.equal(j.ok, true)
  assert.equal(j.result.default.model, 'glm-5.3-flash')
  assert.equal(j.result.groups[0].models[0].id, 'deepseek-flash')
  assert.equal(j.result.groups[0].models[0].efforts.length, 2)
  assert.equal(j.result.groups[0].models[0].defaultEffort, 'high')
})

test('sessions 列表带出当前模型（next 优先于 lastUsed）', async () => {
  const cmd = extractRunCommand()
  const j = await post(cmd, { op: 'sessions' })
  assert.equal(j.ok !== false, true)
  const s = Array.isArray(j) ? j[0] : (j.result ? j.result[0] : j.sessions[0])
  const list = Array.isArray(j) ? j : (j.result || j.sessions)
  const one = s && s.model ? s : list[0]
  assert.deepEqual(one.model, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: '' })
})
