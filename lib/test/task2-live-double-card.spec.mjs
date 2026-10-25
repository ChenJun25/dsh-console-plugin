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
    method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: 's-task2' } })
  }))
  return r.json()
}

const start = (seq) => ({ type: 'turn/start', seq, time: T0, data: { turn: 1 } })
const u = (seq, text, time) => ({ type: 'user/message', seq, time,
  data: { turn: 1, source: { kind: 'user', rpcId: 'r-' + seq }, content: [{ type: 'text', text }] } })
const a = (seq, step, text, time, stream) => ({ type: 'assistant/message', seq, time,
  data: { turn: 1, step, stream: stream || [{ type: 'text-chunks', texts: [text] }],
    message: { content: [{ type: 'text', text }] } } })
const thinkOnly = (seq, step, text, time) => ({ type: 'assistant/message', seq, time,
  data: { turn: 1, step, message: { content: [{ type: 'reasoning', text }] } } })
const call = (seq, step, name, time) => ({ type: 'tool/call', seq, time,
  data: { turn: 1, step, name, arguments: JSON.stringify({ command: 'ls' }) } })
const res = (seq, step, text, time) => ({ type: 'tool/result', seq, time,
  data: { turn: 1, step, name: 'bash', message: { content: [{ type: 'text', text }] } } })

test('① 助手已有活动（只有思考+工具、还没正文）时 steer 切段', async () => {
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
  assert.equal(d.turns.length, 2, 'steer 之后另起一张卡')
  assert.deepEqual(d.turns[0].prompts, ['第一问'], '上一张卡只有第一问')
  assert.equal(d.turns[0].response, '', '上一张卡还没有正文（正是旧判据漏切的那一段）')

  assert.ok((d.turns[0].thinks || []).some((x) => String(x).length > 0), '上一张卡有思考')
  assert.equal(d.turns[0].tools.length, 1, '上一张卡有工具卡')
  assert.deepEqual(d.turns[1].prompts, ['中途追问'], '新卡只装追问')
  assert.equal(d.turns[1].response, '追问的答')
})

test('② 红线：没有任何助手事件时的连问仍同卡', async () => {
  const events = [
    start(1),
    u(2, 'a', T0 + 1000),
    u(3, 'b', T0 + 1500),
    a(4, 1, 'y', T0 + 2000)
  ]
  const d = (await detail(events, [])).result
  assert.equal(d.turns.length, 1, '正文前连问不切（turn-prompt-images.spec ① 的）')
  assert.deepEqual(d.turns[0].prompts, ['a', 'b'])
  assert.equal(d.turns[0].response, 'y')
})

test('③ 工具运行中 steer：result 跨段回填上一段的 run 父卡', async () => {
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
  assert.equal(d.turns[0].tools.length, 1, 'call 留在上一段')
  assert.equal(d.turns[0].tools[0].state, 'done', '跨段回填终态（不能停在 run）')
  assert.ok(d.turns[0].tools[0].result.indexOf('ok-结果') >= 0, '跨段回填结果正文')
  assert.equal(d.turns[1].tools.length, 0, '新段不凭空多一张工具卡')
})

test('④ live 窗口与末轮是同一段时：不发 base.live（关掉 App 兜底卡）', async () => {
  const events = [
    start(1),
    u(2, '第一问', T0 + 1000),
    a(3, 1, '第一答', T0 + 2000),
    u(4, '中途追问', T0 + 3000),
    a(5, 2, '追问的答', T0 + 4000),
    call(6, 2, 'bash', T0 + 4500),
    res(7, 2, 'ok', T0 + 5000)
  ]
  const d = (await detail(events, [], { get: () => ({ log: events }) })).result
  assert.equal(d.full, true)
  assert.equal(d.turns.length, 2)
  assert.equal(d.turns[1].response, '追问的答', '末轮已有正文（App 的 showLiveCard 被 response 守卫挡掉）')
  assert.ok(d.turns[1].tools.length > 0 || d.turns[1].steps.length > 0, '末轮已折进过程内容')
  assert.equal(Object.prototype.hasOwnProperty.call(d, 'live'), false,
    'live 与末轮同源 ⇒ 不下发 base.live（App 的 liveCardFallback 随之关闭，同一屏只剩一张卡）')
  assert.equal(d.running, true, 'running 不动：轮询该继续还继续')
})

test('⑤ 反例：live 是还没折进 turns 的新内容 ⇒ live 照旧下发', async () => {

  const pageEvents = [
    start(1),
    u(2, '第一问', T0 + 1000),
    a(3, 1, '第一答', T0 + 2000)
  ]
  const logEvents = pageEvents.concat([
    u(4, '中途追问', T0 + 3000),
    a(5, 2, '追问的答', T0 + 4000)
  ])
  const d = (await detail(pageEvents, [], { get: () => ({ log: logEvents }) })).result
  assert.equal(d.turns.length, 1)
  assert.equal(d.turns[0].response, '第一答')
  assert.ok(d.live, 'live 的内容还不在 turns 里 ⇒ 必须照发（否则新内容被吞）')
  assert.equal(d.live.text, '追问的答')
  assert.equal(d.live.startedMs, T0 + 3000, 'live 窗口起点 = 那条 steer 消息')
  assert.equal(d.running, true)
})
