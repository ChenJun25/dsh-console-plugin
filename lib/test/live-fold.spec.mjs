import test from 'node:test'
import assert from 'node:assert/strict'

/* 🔴 第 303 节 · 回归：live 已被末轮折叠时必须删掉（否则 App 底部兜底卡把同一段正文再画一遍）。
   旧实现只认「live 起点 === 末轮起点」（时间戳/seq 严格相等），实测两条数据源天然差 1ms ⇒ 恒 false。
   现实现改为内容归属：末轮 response（或 think）里已经装着 live 的正文 ⇒ 判折叠。 */

const T0 = 1792445116400
const LONG = '收到。我按先 3 再 1 的顺序来：先把三态 A/B 量清楚，再动手改。这会占用你手机屏幕约 2 分钟，期间别切走。'

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

const am = (seq, time, text) => ({ type: 'assistant/message', seq, time,
  data: { turn: 1, step: 1, stream: [{ type: 'text-chunks', texts: [text] }],
    message: { content: [{ type: 'text', text }] } } })
const amThink = (seq, time, text) => ({ type: 'assistant/message', seq, time,
  data: { turn: 1, step: 1, stream: [{ type: 'reasoning-chunks', texts: [text] }],
    message: { content: [{ type: 'reasoning', text }] } } })

async function detail(pageEvents, logEvents) {
  const ctl = {
    projections: async () => ({ asOfSeq: 99, values: { title: 't', turnOutline: [] } }),
    page: async () => ({ records: pageEvents.map((e) => ({ type: 'event', event: e })) }),
    list: async () => ({ items: [] })
  }
  const sessions = { get: (sid) => (sid === 's-fold' ? { log: logEvents } : null) }
  const { ctx, routes } = mockCtx(ctl, sessions)
  const { apply } = await import('../index.js?t=' + Math.random())
  apply(ctx, { port: 0 })
  const r = await routes['/api/dsh-console/cmd'].fetch(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: 's-fold' } })
  }))
  return r.json()
}

/* page 通道：一整轮（含 turn/end）⇒ 会折进 turns */
function foldedTurn(text, t0) {
  return [
    { type: 'turn/start', seq: 1, time: t0, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: t0 + 10,
      data: { turn: 1, source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '3到1' }] } },
    am(3, t0 + 20, text),
    { type: 'turn/end', seq: 4, time: t0 + 30, data: { turn: 1 } }
  ]
}

/* 内存 log：turn/start 起点比折出来的轮起点晚 1ms，且**没有 turn/end** ⇒ live 仍在跑 */
function liveLog(text, t0) {
  return [
    { type: 'turn/start', seq: 10, time: t0 + 1, data: { turn: 1 } },
    am(11, t0 + 1, text)
  ]
}

test('① 末轮已含 live 正文 + 起点差 1ms ⇒ 不下发 live（旧逻辑这里是漏删）', async () => {
  const t0 = T0
  const d = (await detail(foldedTurn('先看了下三态。' + LONG, t0), liveLog(LONG, t0))).result
  assert.equal(d.full, true, '走了全量折叠通道')
  assert.equal(d.turns.length, 1)
  assert.ok(String(d.turns[0].response).indexOf(LONG) >= 0, '末轮正文里确实装着 live 那段')
  assert.equal(d.live, undefined, '同一段内容不能既在 turns 又下发 live')
})

test('② live 属于还没折进 turns 的新一轮 ⇒ live 照旧下发（不能吞内容）', async () => {
  const t0 = T0
  const d = (await detail(foldedTurn('上一轮的正文', t0), liveLog('这一轮刚开始写的一段全新内容，末轮里没有', t0))).result
  assert.ok(d.live, 'live 必须下发')
  assert.ok(String(d.live.text).indexOf('全新内容') >= 0)
})

test('③ 只有思考、且末轮 think 已含 ⇒ 不下发 live', async () => {
  const t0 = T0
  const TH = '我需要先量一下三态功耗，再决定改哪里。'
  const page = [
    { type: 'turn/start', seq: 1, time: t0, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: t0 + 10,
      data: { turn: 1, source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: 'q' }] } },
    amThink(3, t0 + 20, TH),
    { type: 'turn/end', seq: 4, time: t0 + 30, data: { turn: 1 } }
  ]
  const log = [
    { type: 'turn/start', seq: 10, time: t0 + 1, data: { turn: 1 } },
    amThink(11, t0 + 1, TH)
  ]
  const d = (await detail(page, log)).result
  assert.equal(d.live, undefined, '思考段已归末轮 ⇒ 不再下发 live')
})
