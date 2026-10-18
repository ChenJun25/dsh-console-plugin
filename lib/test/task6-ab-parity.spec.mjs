import test from 'node:test'
import assert from 'node:assert/strict'

const T0 = 1791731571562

function mockCtx(ctl, sessions) {
  const routes = {}
  const conn = { fetch: { register: (route) => { routes[route.path] = route; return () => {} } } }
  const ctx = {
    get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : n === 'sessions' ? sessions : null),
    on: () => () => {},
    effect: () => () => {}
  }
  return { ctx, routes }
}

function mockCtl(events, outline) {
  return {
    projections: async () => ({ asOfSeq: 99, values: { title: 't', turnOutline: outline || [] } }),
    page: async () => ({ records: events.map((e) => ({ type: 'event', event: e })) }),
    list: async () => ({ items: [] })
  }
}

async function detail(events, outline, sessions) {
  const { ctx, routes } = mockCtx(mockCtl(events, outline), sessions || null)
  const { apply } = await import('../index.js?t=' + Math.random())
  apply(ctx, { port: 0 })
  const r = await routes['/api/dsh-console/cmd'].fetch(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: 's-task6' } })
  }))
  return r.json()
}

const start = (seq, time) => ({ type: 'turn/start', seq, time: time || T0, data: { turn: 1 } })
const u = (seq, text, time) => ({ type: 'user/message', seq, time,
  data: { turn: 1, source: { kind: 'user', rpcId: 'r-' + seq }, content: [{ type: 'text', text }] } })
const a = (seq, step, text, time) => ({ type: 'assistant/message', seq, time,
  data: { turn: 1, step, stream: [{ type: 'text-chunks', texts: [text] }],
    message: { content: [{ type: 'text', text }] } } })
const thinkOnly = (seq, step, text, time) => ({ type: 'assistant/message', seq, time,
  data: { turn: 1, step, message: { content: [{ type: 'reasoning', text }] } } })
const call = (seq, step, name, time) => ({ type: 'tool/call', seq, time,
  data: { turn: 1, step, name, arguments: JSON.stringify({ command: 'ls' }) } })
const res = (seq, step, text, time, isErr) => ({ type: 'tool/result', seq, time,
  data: { turn: 1, step, name: 'bash', isError: !!isErr, message: { content: [{ type: 'text', text }] } } })

test('① 只有 reasoning/tool、尚无正文时 steer 必须切段（旧判据此格漏切）', async () => {
  const events = [
    start(1),
    u(2, '第一问', T0 + 1000),
    thinkOnly(3, 1, '先想一下', T0 + 2000),
    call(4, 1, 'bash', T0 + 2100),
    u(5, '中途追问', T0 + 3000),
    a(6, 2, '追问的答', T0 + 4000)
  ]
  const d = (await detail(events, [])).result
  assert.equal(d.full, true, '走了全量折叠通道')
  assert.equal(d.turns.length, 2, 'steer 后另起一张卡（旧判据会停在 1）')
  assert.deepEqual(d.turns[0].prompts, ['第一问'], '上一张卡只有第一问 —— A/B 里「一张卡塞多条提问」的直接来源')
  assert.equal(d.turns[0].response, '', '此刻还没有助手正文 ⇒ 正是旧判据判假的那一格')

  assert.ok((d.turns[0].thinks || []).some((x) => String(x).length > 0), '上一张卡有 reasoning')
  assert.equal(d.turns[0].tools.length, 1, '上一张卡有 tool/call')
  assert.deepEqual(d.turns[1].prompts, ['中途追问'], '新卡只装追问')
  assert.equal(d.turns[1].response, '追问的答')
})

test('② 对照：已有助手正文时 steer 切段（新旧判据行为一致）', async () => {
  const events = [
    start(1),
    u(2, '第一问', T0 + 1000),
    a(3, 1, '第一答', T0 + 2000),
    u(4, '中途追问', T0 + 3000),
    a(5, 2, '追问的答', T0 + 4000)
  ]
  const d = (await detail(events, [])).result
  assert.equal(d.turns.length, 2)
  assert.deepEqual(d.turns[0].prompts, ['第一问'])
  assert.deepEqual(d.turns[1].prompts, ['中途追问'])
})

test('③ 红线：正文前连问不切（turns=1、prompts 两条）', async () => {
  const events = [
    start(1),
    u(2, 'a', T0 + 1000),
    u(3, 'b', T0 + 1500),
    a(4, 1, 'y', T0 + 2000)
  ]
  const d = (await detail(events, [])).result
  assert.equal(d.turns.length, 1)
  assert.deepEqual(d.turns[0].prompts, ['a', 'b'])
})

test('④a 工具运行中 steer：result 跨段回填旧段补 done', async () => {
  const events = [
    start(1),
    u(2, '第一问', T0 + 1000),
    a(3, 1, '第一答', T0 + 2000),
    call(4, 1, 'bash', T0 + 2100),
    u(5, '追问', T0 + 3000),
    res(6, 1, 'ok-结果', T0 + 4000)
  ]
  const d = (await detail(events, [])).result
  assert.equal(d.turns.length, 2)
  assert.equal(d.turns[0].tools.length, 1, 'call 留在旧段')
  assert.equal(d.turns[0].tools[0].state, 'done', '跨段回填终态（不能停在 run）')
  assert.ok(d.turns[0].tools[0].result.indexOf('ok-结果') >= 0, '跨段回填结果正文')
  assert.equal(d.turns[1].tools.length, 0, '新段不凭空多一张工具卡')
})

test('④b 同口径 isError：回填 err 而不是 done', async () => {
  const events = [
    start(1),
    u(2, '第一问', T0 + 1000),
    a(3, 1, '第一答', T0 + 2000),
    call(4, 1, 'bash', T0 + 2100),
    u(5, '追问', T0 + 3000),
    res(6, 1, '炸了', T0 + 4000, true)
  ]
  const d = (await detail(events, [])).result
  assert.equal(d.turns[0].tools[0].state, 'err')
  assert.ok(d.turns[0].tools[0].result.indexOf('炸了') >= 0)
})

test('⑤ 毫秒戳相等（seq 不同）即视为同源 ⇒ 不发 base.live', async () => {
  const events = [
    start(1),
    u(2, '第一问', T0 + 1000),
    a(3, 1, '第一答', T0 + 2000),
    u(4, '追问', T0 + 3000),
    u(5, '紧跟着再问', T0 + 3000),
    call(6, 2, 'bash', T0 + 3500),
    res(7, 2, 'ok', T0 + 4000)
  ]
  const d = (await detail(events, [], { get: () => ({ log: events }) })).result
  assert.equal(d.full, true)
  assert.equal(d.turns.length, 2, '第二条同毫秒追问没有再切段')
  assert.equal(d.turns[1].seq, 4, '折出的末段段身份 seq=4')
  assert.ok(d.turns[1].tools.length > 0, '末段已折进过程内容（屏蔽条件②）')
  assert.equal(d.turns[1].response, '', '末段此时还没有正文')
  assert.equal(Object.prototype.hasOwnProperty.call(d, 'live'), false,
    'live 窗口起点 seq=5 / 末段 seq=4，但毫秒戳都是 T0+3000 ⇒ 判同源 ⇒ 不发 base.live')
  assert.equal(d.running, true, 'running 不受影响（轮询照旧）')
})

test('⑥ 反例护栏：末段没有过程内容时 live 照旧下发（宁可多下一份）', async () => {
  const events = [
    start(1),
    u(2, '第一问', T0 + 1000),
    a(3, 1, '第一答', T0 + 2000),
    u(4, '中途追问', T0 + 3000),
    a(5, 2, '追问的答', T0 + 4000)
  ]
  const d = (await detail(events, [], { get: () => ({ log: events }) })).result
  assert.equal(d.turns.length, 2)
  assert.ok(d.live, '末段无 tools/steps ⇒ 屏蔽条件②不成立 ⇒ live 照发')
  assert.equal(d.live.text, '追问的答')
  assert.equal(d.live.startedMs, T0 + 3000, 'live 窗口起点 = 那条 steer')
})

test('⑦ 判据差集自证：①夹具的 steer 处「旧条件假、新条件真」', async () => {

  const oldCond = (cur) => !!(cur.response)
  const newCond = (cur) => !!(cur.response || cur.think || (cur.steps && cur.steps.length) ||
    (cur.tools && cur.tools.length) || cur.failure)
  const cur = { response: '', think: '先想一下', steps: [{ k: 't', i: 0, s: 1 }], tools: [{ name: 'bash', state: 'run' }], failure: null }
  assert.equal(oldCond(cur), false, '旧判据：无正文 ⇒ 不切段')
  assert.equal(newCond(cur), true, '新判据：有 reasoning/tool ⇒ 切段')

  const events = [
    start(1), u(2, '第一问', T0 + 1000), thinkOnly(3, 1, '先想一下', T0 + 2000),
    call(4, 1, 'bash', T0 + 2100), u(5, '中途追问', T0 + 3000), a(6, 2, '追问的答', T0 + 4000)
  ]
  const d = (await detail(events, [])).result
  assert.equal(d.turns.length, 2)
})
