/**
 * 第 189 节 · task-B 单测：**同一 DSH 轮里的追问要独立成卡**（视觉轮切分）。
 *
 * 病灶（用户 m01563 / m01725 原话：「刚刚我发送这段问题在手机发出去后，显示在已完成
 * 回复的卡片上面」「新一轮的回复都单独显示在新的卡片上」）：DSH 的「一轮」=
 * 宿主 turn/start → turn/end，而用户可以在同一轮里继续追问（steer：agent/inbox/spliced
 * 插话），宿主把这些 user/message 全折进同一个 turn。插件照旧 push 进同一轮 ⇒
 *   · 手机端 turnBlock 先画提问再画回复 ⇒ 新提问看起来「在上一张已完成回复上面」；
 *   · 该轮 response 早已非空 ⇒ App 的 showLiveCard() 被 response 守卫挡掉，生成中卡
 *     消失（m01570），退化成平铺过程流的兜底分支（m01544）。
 *
 * 口径：**「当前段已经有助手正文」之后**再来的用户提问，另起一段；同段后续的
 * assistant / tool / turn/end 都落到新段（靠 byNo 上该 DSH 轮号改指新段实现）。
 * 切分只发生在「已有正文之后」⇒ 「一轮里连着两条提问、之后才有回复」仍同卡
 * （turn-prompt-images.spec ① 的红线）。
 *
 * 跑法：node lib/test/segment-turns.spec.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

function mockCtx(ctl) {
  const routes = {}
  const conn = { fetch: { register: (route) => { routes[route.path] = route; return () => {} } } }
  const ctx = {
    get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : null),
    on: () => () => {},
    effect: () => () => {}
  }
  return { ctx, routes }
}

function mockCtl(events) {
  return {
    projections: async () => ({ asOfSeq: 99, values: { title: 't', turnOutline: [] } }),
    page: async () => ({ records: events.map((e) => ({ type: 'event', event: e })) }),
    list: async () => ({ items: [] })
  }
}

async function detailOf(events) {
  const { ctx, routes } = mockCtx(mockCtl(events))
  const mod = await import('../index.js?t=' + Math.random())
  mod.apply(ctx, { port: 0 })
  const r = await routes['/api/dsh-console/cmd'].fetch(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: 's-seg' } })
  }))
  return (await r.json()).result || {}
}

const u = (seq, time, turn, text) => ({ type: 'user/message', seq, time, data: { turn, content: [{ type: 'text', text }] } })
const a = (seq, time, turn, step, text) => ({ type: 'assistant/message', seq, time, data: { turn, step, message: { content: [{ type: 'text', text }] } } })
const tool = (seq, time, turn, step, name) => ({ type: 'tool/call', seq, time, data: { turn, step, name, input: {} } })

test('① 同一 DSH 轮里「回复之后再追问」⇒ 切成两张卡，各带自己的提问与回复', async () => {
  const d = await detailOf([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    u(2, 2, 1, '第一问'),
    a(3, 3, 1, 1, '第一答'),
    u(4, 4, 1, '中途追问'),
    a(5, 5, 1, 2, '追问的答'),
    { type: 'turn/end', seq: 6, time: 6, data: { turn: 1 } }
  ])
  assert.equal(d.full, true, '走的应是全文（page）通道')
  assert.equal(d.turns.length, 2, '一个 DSH 轮被切成两个视觉轮')
  const [t1, t2] = d.turns
  assert.deepEqual(t1.turn, 1, '第一段保留真实轮号')
  assert.deepEqual(t1.prompts, ['第一问'], '第一段只有第一问')
  assert.equal(t1.response, '第一答', '第一段的回复只有第一答')
  assert.equal(t2.turn, 2, '第二段拿新号（不撞 key）')
  assert.deepEqual(t2.prompts, ['中途追问'], '追问落在第二段')
  assert.equal(t2.response, '追问的答', '追问的答复也在第二段 —— 不再挤在上一张卡上')
})

test('② 红线：一轮里连着两条提问、之后才有回复 ⇒ 仍同卡（不许切）', async () => {
  const d = await detailOf([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    u(2, 2, 1, 'a'),
    u(3, 3, 1, 'b'),
    a(4, 4, 1, 1, 'y'),
    { type: 'turn/end', seq: 5, time: 5, data: { turn: 1 } }
  ])
  assert.equal(d.turns.length, 1, '正文之前的连续提问不切段')
  assert.equal(d.turns[0].prompts.length, 2, '两条提问仍在同一轮')
  assert.equal(d.turns[0].turn, 1, '没切段 ⇒ 真实轮号与老行为逐字一致')
})

test('③ 切段后同轮的 tool / turn / 事件都归新段', async () => {
  const d = await detailOf([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    u(2, 2, 1, '第一问'),
    a(3, 3, 1, 1, '第一答'),
    u(4, 4, 1, '追问'),
    tool(5, 5, 1, 2, 'bash'),
    { type: 'turn/end', seq: 6, time: 6, data: { turn: 1 } }
  ])
  assert.equal(d.turns.length, 2)
  const [t1, t2] = d.turns
  assert.equal(t1.tools.length, 0, '第一段不该收下追问之后的工具')
  assert.equal(t2.tools.length, 1, '追问之后的工具归第二段')
  assert.equal(t2.tools[0].name, 'bash')
  assert.ok(t2.startedMs > 0, '第二段的起点是它自己首事件的时间')
  assert.ok(t1.startedMs > 0 && t1.startedMs < t2.startedMs, '第一段起点早于第二段')
})

test('④ 连续追问两次 ⇒ 三段，轮号稠密 1..N', async () => {
  const d = await detailOf([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    u(2, 2, 1, 'A'),
    a(3, 3, 1, 1, 'a'),
    u(4, 4, 1, 'B'),
    a(5, 5, 1, 2, 'b'),
    u(6, 6, 1, 'C'),
    a(7, 7, 1, 3, 'c'),
    { type: 'turn/end', seq: 8, time: 8, data: { turn: 1 } }
  ])
  assert.equal(d.turns.length, 3)
  assert.deepEqual(d.turns.map((t) => t.turn), [1, 2, 3], '轮号稠密无洞、无重号')
  assert.deepEqual(d.turns.map((t) => t.prompts[0]), ['A', 'B', 'C'])
  assert.deepEqual(d.turns.map((t) => t.response), ['a', 'b', 'c'], '每段的回复各归各段')
})

test('⑤ 没切段的老形态：多轮日志仍按真实轮号排序，逐字不变', async () => {
  const d = await detailOf([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    u(2, 2, 1, '一'), a(3, 3, 1, 1, '答一'),
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 1 } },
    { type: 'turn/start', seq: 5, time: 5, data: { turn: 2 } },
    u(6, 6, 2, '二'), a(7, 7, 2, 1, '答二'),
    { type: 'turn/end', seq: 8, time: 8, data: { turn: 2 } }
  ])
  assert.equal(d.turns.length, 2)
  assert.deepEqual(d.turns.map((t) => t.turn), [1, 2], '真实轮号原样保留')
  assert.equal(d.turns[1].prompts[0], '二')
})
