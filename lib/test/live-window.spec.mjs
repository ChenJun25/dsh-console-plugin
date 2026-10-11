/**
 * 第 112 节 · 过程流窗口回归（task：手机端实时步骤只回传最后 1 条工具）。
 *
 * 病灶：lib/index.js liveFromLog() 的回扫窗口原来认三种边界，其中
 *   if (tt === 'assistant/message') { start = i + 1; busy = true; break }
 * 命中「当前 step 刚落的 assistant/message」，窗口恰好落在它之后
 * ⇒ 整轮 41~106 次工具调用只剩最后 0~1 条下发。
 *
 * 宿主事件是 step 粒度、且每个 step **先落 assistant/message 再落该 step 的 tool/call**
 * （实测 session-4e99a84d 下标 55-64）。所以本用例逐字复刻这个顺序：
 *   turn/start → step/start(7) → assistant/message(7) → tool/call(A) → tool/result
 *              → step/end → step/start(8) → assistant/message(8) → tool/call(B)
 * 断言 detail 的 base.live.tools **同时**含 A 与 B，且 steps[].i 是整轮下标（0/1）、
 * steps[].s 是宿主 step 号（7/8）—— 与 history turns[].steps 的下标语义一致。
 *
 * 跑法：node --test lib/test/live-window.spec.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const T = 1700000000000

function ev(type, data, time) {
  return { type, seq: 0, time: time || T, data: data || {} }
}

/** 实测形状的宿主事件日志（step 粒度：先 assistant/message、再该 step 的 tool/call）。 */
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

/** 三件套 + sessions store 桩：ctx.get('sessions').get(sid) → { log } */
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
  // steps[].i = **整轮** tools 下标（与 history turns[].steps 同语义）；s = 宿主 step 号
  const os = live.steps.filter((s) => s.k === 'o').map((s) => [s.i, s.s])
  assert.deepEqual(os, [[0, 7], [1, 8]], 'steps 工具项应为整轮下标 + 各自 step 号')
})
