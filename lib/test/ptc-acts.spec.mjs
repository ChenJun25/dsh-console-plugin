import test from 'node:test'
import assert from 'node:assert/strict'

const T = 1700000000000
function ev(type, data, time) {
  return { type: type, seq: 0, time: time || T, data: data || {} }
}

const CTRL = {
  projections: async () => ({ asOfSeq: 9, values: { title: 't', turnOutline: [] } }),
  page: async () => ({ records: [] }),
  list: async () => ({ items: [] }),
  modelCatalog: async () => ({})
}

function mockCtx(sessions) {
  const routes = {}
  const handlers = {}
  const conn = { fetch: { register: (route) => { routes[route.path] = route; return () => {} } } }
  const ctx = {
    get: (n) => (n === 'connection' ? conn
      : n === 'sessionController' ? CTRL
        : n === 'attachments' ? null
          : n === 'sessions' ? (sessions || null) : null),
    on: (evt, fn) => { handlers[evt] = fn; return () => {} },
    effect: () => () => {}
  }
  return { ctx, routes, handlers }
}

async function boot(sessions) {
  const { ctx, routes, handlers } = mockCtx(sessions)
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  assert.ok(routes['/api/dsh-console/cmd'], 'cmd 路由没注册上')
  return { routes, handlers }
}

async function detailOf(routes, sessionId, extra) {

  const payload = Object.assign({ sessionId: sessionId }, extra || {})
  const r = await routes['/api/dsh-console/cmd'].fetch(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ op: 'detail', payload: payload })
  }))
  return r.json()
}

function start(sub, name, args) {
  return ev('tool/ptc-dispatch-start', {
    turn: 1, step: 1, rootCallId: 'r1', parentCallId: 'p1',
    subCallId: sub, name: name, arguments: args || {}
  })
}

function done(sub, name, isError) {
  const d = {
    turn: 1, step: 1, rootCallId: 'r1', parentCallId: 'p1',
    subCallId: sub, name: name, arguments: {},
    content: [{ type: 'tool-result', text: 'ok' }]
  }
  if (isError) d.isError = true
  return ev('tool/ptc-dispatch', d)
}

test('① 事件总线：dispatch-start 依次进 acts，同名结果按 subCallId 变 done', async () => {
  const sid = 's-acts'
  const { routes, handlers } = await boot(null)
  const send = (e) => handlers['session/event']({ id: sid }, e)
  send(ev('turn/start', { turn: 1 }))

  send(ev('tool/call', { turn: 1, step: 1, name: 'run_code', arguments: JSON.stringify({ code: 'console.log(1)' }) }))
  send(start('c1', 'read', { file_path: '/d/a/张.mjs' }))
  send(start('c2', 'grep', { pattern: 'TODO' }))

  let j = await detailOf(routes, sid)
  assert.equal(j.ok, true)
  assert.ok(j.result.live, '有 live 块')
  const acts = j.result.live.acts
  assert.ok(Array.isArray(acts), 'live.acts 是数组')
  assert.deepEqual(acts.map((a) => a.name), ['read', 'grep'], '按发生顺序：read → grep')
  assert.deepEqual(acts.map((a) => a.state), ['run', 'run'], '还没收到结果 ⇒ 都是 run')
  assert.deepEqual(Object.keys(acts[0]).sort(), ['at', 'detail', 'name', 'state'],
    '出口形状冻结成 4 个键（内部 subCallId 不下发）')
  assert.ok(acts[0].detail.indexOf('张.mjs') >= 0, 'detail 用 briefOf 摘要（file_path 那条）')
  assert.ok(acts[0].detail.length <= 73, 'detail ≤ BRIEF_MAX(72) + 省略号')
  assert.equal(typeof acts[0].at, 'number', 'at 是毫秒戳')

  assert.deepEqual(j.result.live.tools.map((t) => t.name), ['run_code'], 'tool/call 语义不变')

  send(done('c1', 'read'))
  j = await detailOf(routes, sid)
  assert.deepEqual(j.result.live.acts.map((a) => a.state), ['done', 'run'],
    '收到 c1 的 dispatch ⇒ read=done，grep 不受影响')
})

test('①b 同名子调用按 subCallId 精确配对（第二次 read 不能动第一次）', async () => {
  const sid = 's-acts2'
  const { routes, handlers } = await boot(null)
  const send = (e) => handlers['session/event']({ id: sid }, e)
  send(ev('turn/start', { turn: 1 }))
  send(ev('tool/call', { turn: 1, step: 1, name: 'run_code', arguments: '{"code":"x"}' }))
  send(start('a1', 'read', { file_path: '/d/one.mjs' }))
  send(start('a2', 'read', { file_path: '/d/two.mjs' }))
  send(done('a1', 'read'))
  let j = await detailOf(routes, sid)
  assert.deepEqual(j.result.live.acts.map((a) => a.state), ['done', 'run'], '只结束 a1')

  send(done('a1', 'read'))
  j = await detailOf(routes, sid)
  assert.deepEqual(j.result.live.acts.map((a) => a.state), ['done', 'run'], '重发同 id 不误伤 a2')
  send(done('a2', 'read', true))
  j = await detailOf(routes, sid)
  assert.deepEqual(j.result.live.acts.map((a) => a.state), ['done', 'err'], 'isError ⇒ err')
})

test('③ Session.log 回放（liveFromLog）也收，收尾缺失的 run 兜成 done', async () => {
  const events = [
    ev('turn/start', { turn: 1 }),
    ev('tool/call', { turn: 1, step: 1, name: 'run_code', arguments: '{"code":"x"}' }),
    start('c1', 'read', { file_path: '/d/a.mjs' }),
    start('c2', 'bash', { command: 'ls -la' }),
    done('c1', 'read'),
    start('c3', 'grep', { pattern: 'x' })
  ]
  const { routes } = await boot({ get: () => ({ log: events }) })
  const j = await detailOf(routes, 's-log')
  assert.ok(j.result.live, '有 live 块（来自 Session.log 窗口）')
  const acts = j.result.live.acts
  assert.deepEqual(acts.map((a) => a.name), ['read', 'bash', 'grep'], '三个子调用都在')
  assert.deepEqual(acts.map((a) => a.state), ['done', 'done', 'done'],
    '窗口结束还挂 run 的由 settleActs 兜成 done（不能让手机永久显示运行中）')
  assert.ok(acts[1].detail.indexOf('ls -la') >= 0, 'bash 的 command 进了 detail')
})

test('④a 公网档上限 ACTS_KEEP=60：超出从头部整条丢', async () => {
  const sid = 's-acts-cap'
  const { routes, handlers } = await boot(null)
  const send = (e) => handlers['session/event']({ id: sid }, e)
  send(ev('turn/start', { turn: 1 }))
  for (let i = 0; i < 70; i++) send(start('c' + i, 'n' + i, { file_path: '/d/f' + i + '.mjs' }))
  const j = await detailOf(routes, sid, { __wan: true })
  const acts = j.result.live.acts
  assert.equal(acts.length, 60, '只留 60 条')
  assert.equal(acts[0].name, 'n10', '从头部丢 ⇒ 留下的是第 11 条起')
  assert.equal(acts[59].name, 'n69', '最后一条是最新的')
})

test('④b 局域网档（默认，不截断）：70 条全留', async () => {
  const sid = 's-acts-cap-lan'
  const { routes, handlers } = await boot(null)
  const send = (e) => handlers['session/event']({ id: sid }, e)
  send(ev('turn/start', { turn: 1 }))
  for (let i = 0; i < 70; i++) send(start('c' + i, 'n' + i, { file_path: '/d/f' + i + '.mjs' }))

  const j = await detailOf(routes, sid)
  const acts = j.result.live.acts
  assert.equal(acts.length, 70, '局域网档 70 条全留')
  assert.equal(acts[0].name, 'n0', '从第一条起都在')
  assert.equal(acts[69].name, 'n69', '最后一条也在')
})

test('⑤ 没有 dispatch 事件（老宿主）⇒ acts 是空数组，不是 undefined', async () => {
  const sid = 's-acts-old'
  const { routes, handlers } = await boot(null)
  const send = (e) => handlers['session/event']({ id: sid }, e)
  send(ev('turn/start', { turn: 1 }))
  send(ev('tool/call', { turn: 1, step: 1, name: 'run_code', arguments: '{"code":"x"}' }))

  send({ type: 'assistant/message', seq: 0, time: T, data: {
    turn: 1, step: 1, stream: [{ type: 'text-chunks', texts: ['在跑'] }],
    message: { content: [{ type: 'text', text: '在跑' }] }
  } })
  const j = await detailOf(routes, sid)
  assert.deepEqual(j.result.live.acts, [], '老宿主没有该字段 ⇒ 下发空数组（App 侧兜底）')
  assert.ok(JSON.stringify(j.result.live).indexOf('undefined') < 0, '响应里不出现 undefined')
})
