import test from 'node:test'
import assert from 'node:assert/strict'

const T = 1700000000000

function ev(type, data, time) {
  return { type, seq: 0, time: time || T, data: data || {} }
}

function twoStepLog() {
  return [
    ev('turn/start', { turn: 1 }),
    ev('step/start', { step: 7 }),
    ev('assistant/message', { step: 7, message: { content: [{ type: 'text', text: '第 7 步' }] } }),
    ev('tool/call', { step: 7, name: 'read_A', arguments: { path: 'A' } }),
    ev('tool/result', { step: 7, message: { content: [{ type: 'tool-result', text: 'A ok' }] } }),
    ev('step/end', { step: 7 }),
    ev('step/start', { step: 8 }),
    ev('assistant/message', { step: 8, message: { content: [{ type: 'text', text: '第 8 步' }] } }),
    ev('tool/call', { step: 8, name: 'read_B', arguments: { path: 'B' } })
  ]
}

function mockCtl(opt = {}) {
  return {
    projections: async () => ({ asOfSeq: 9, values: opt.values || {} }),
    page: async () => ({ records: [] }),
    list: async () => ({ items: [] }),
    modelCatalog: async () => ({})
  }
}

function mockCtx(ctl, sessions) {
  const routes = {}
  const conn = { fetch: { register: (route) => { routes[route.path] = route; return () => {} } } }
  const handlers = {}
  const ctx = {
    get: (n) => (n === 'connection' ? conn
      : n === 'sessionController' ? ctl
      : n === 'sessions' ? sessions
      : null),
    on: (evt, fn) => { handlers[evt] = fn; return () => {} },
    effect: () => () => {}
  }
  return { ctx, routes, handlers }
}

async function boot(ctl, sessions) {
  const { ctx, routes } = mockCtx(ctl, sessions)
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  assert.ok(routes['/api/dsh-console/cmd'], 'cmd 路由没注册上')
  return { routes }
}

async function cmd(routes, op, payload) {
  const r = await routes['/api/dsh-console/cmd'].fetch(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ op, payload })
  }))
  return r.json()
}

test('#112 liveFromLog：跨 step 的整轮工具都下发（不再只剩最后 1 条）', async () => {
  const sessions = { get: (sid) => (sid === 's-live' ? { log: twoStepLog() } : null) }
  const { routes } = await boot(mockCtl({ values: { turnOutline: [] } }), sessions)
  const j = await cmd(routes, 'detail', { sessionId: 's-live' })
  assert.equal(j.ok, true, 'detail 不应失败：' + JSON.stringify(j.error || ''))
  const live = j.result.live
  assert.ok(live, 'base.live 必须下发')
  const names = live.tools.map((t) => t.name)
  assert.ok(names.indexOf('read_A') >= 0, '窗口起点后的第 1 个 step 的工具 A 必须在（names=' + JSON.stringify(names) + '）')
  assert.ok(names.indexOf('read_B') >= 0, '当前 step 的工具 B 也必须在（names=' + JSON.stringify(names) + '）')
  assert.ok(live.tools.length >= 2, '整轮累计应 ≥2 条，实际 ' + live.tools.length + ' 条')

  const os = live.steps.filter((s) => s.k === 'o').map((s) => [s.i, s.s])
  assert.deepEqual(os, [[0, 7], [1, 8]], 'steps 工具项应为整轮下标 + 各自 step 号')
})
