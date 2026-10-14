/**
 * task-C 单测：会话级任务清单（todo/write）→ detail.todos（第 186 节）。
 *
 * 背景：用户 m01310 要把电脑端 DSH 那张「任务」列表也搬到手机端会话页。
 * 数据源（实锤）＝会话日志事件 { type:'todo/write', data:{ todos:[{content,status}] } }，
 * **覆盖式全量**（每条写的就是当前完整清单）⇒ 取最后一条。
 *
 * 本节只做**数据通路**：形状 { content, status }、content 过 stripShellText、
 * status 三态归一、空 content 丢弃、拿不到事件流时键仍在且是 []。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * 造一个假 ctx（照抄 acp-turns.spec.mjs 的范式）：
 *  - projections 必给（readDetail 的入口）；turnOutline 默认空
 *  - page 可选：给了才走全文通道（todo/write 就藏在这份 events 里）
 */
async function detailOf(opts) {
  const o = opts || {}
  const asOfSeq = o.asOfSeq === undefined ? 100 : o.asOfSeq
  let cmdFetch = null
  const conn = { fetch: { register: (r) => { if (r.path === '/api/dsh-console/cmd') cmdFetch = r.fetch; return () => {} } } }
  const ctl = {
    projections: async () => ({ asOfSeq, values: { title: 't', turnOutline: o.turnOutline || [] } }),
    list: async () => ({ items: [] }),
  }
  if (o.events) {
    ctl.page = async () => ({ records: o.events.map((e) => ({ type: 'event', event: e })) })
  }
  const ctx = { get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : null), on: () => () => {}, effect: () => () => {} }
  const mod = await import('../index.js?t=' + Math.random())
  mod.apply(ctx, { port: 0 })
  const r = await cmdFetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: 's' } }) }))
  return (await r.json()).result || {}
}

/** 一份带正文的事件流骨架（todos 由调用方塞 todo/write 进去）。 */
function baseEvents() {
  return [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { turn: 1, content: [{ type: 'text', text: '帮我改一下' }] } },
  ]
}

test('① 两条 todo/write（第二条覆盖第一条，三态齐全）⇒ todos 逐字等于第二条', async () => {
  const first = [
    { content: '读代码', status: 'in_progress' },
    { content: '写补丁', status: 'pending' },
  ]
  const second = [
    { content: '读代码', status: 'completed' },
    { content: '写补丁', status: 'in_progress' },
    { content: '跑自测', status: 'pending' },
  ]
  const events = baseEvents().concat([
    { type: 'todo/write', seq: 3, time: 3, data: { todos: first } },
    { type: 'assistant/message', seq: 4, time: 4, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '先看代码' }] } } },
    { type: 'todo/write', seq: 5, time: 5, data: { todos: second } },
    { type: 'turn/end', seq: 6, time: 6, data: { turn: 1 } },
  ])
  const d = await detailOf({ events, turnOutline: [] })
  assert.deepEqual(d.todos, [
    { content: '读代码', status: 'completed' },
    { content: '写补丁', status: 'in_progress' },
    { content: '跑自测', status: 'pending' },
  ], 'todos 不是第二条清单（顺序/内容/状态都要逐字对）')
  assert.equal(d.todos.length, 3, '第一条的 2 项被覆盖掉了，不该冒出来')
})

test('② 一条 todo/write 都不灌 ⇒ todos 是 []（不是 undefined / null）', async () => {
  const events = baseEvents().concat([
    { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '没有任务清单的一轮' }] } } },
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 1 } },
  ])
  const d = await detailOf({ events, turnOutline: [] })
  assert.ok('todos' in d, 'todos 这个键必须一定在')
  assert.ok(Array.isArray(d.todos), 'todos 必须是数组')
  assert.deepEqual(d.todos, [], '没有 todo/write 时必须为空数组')
})

test('③ 拿不到事件流（老宿主 / 只有概要投影）⇒ 键仍在且为 []', async () => {
  const d = await detailOf({ turnOutline: [{ turn: 1, seq: 1, prompt: 'q', response: 'r' }] })
  assert.ok('todos' in d, '概要回退分支也必须带 todos 键')
  assert.deepEqual(d.todos, [], '概要回退分支 todos 必须是 []')
})

test('④ 清洗与归一：content 剥注入壳、未知状态归 pending、空项丢弃', async () => {
  const events = baseEvents().concat([
    { type: 'todo/write', seq: 3, time: 3, data: { todos: [
      { content: '正常项', status: 'completed' },
      { content: '带壳<system-reminder>这段注入要剥掉</system-reminder>项', status: 'in_progress' },
      { content: '状态不认识', status: 'doing' },
      { content: '', status: 'pending' },
      { content: '   ', status: 'pending' },
      { content: 42, status: 'pending' },
      null,
      '字符串不是对象',
      { content: '<system-reminder>x</system-reminder>', status: 'pending' },
    ] } },
    { type: 'assistant/message', seq: 4, time: 4, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '好' }] } } },
    { type: 'turn/end', seq: 5, time: 5, data: { turn: 1 } },
  ])
  const d = await detailOf({ events, turnOutline: [] })
  assert.deepEqual(d.todos, [
    { content: '正常项', status: 'completed' },
    { content: '带壳项', status: 'in_progress' },
    { content: '状态不认识', status: 'pending' },
    { content: '42', status: 'pending' },
  ], '清洗/归一/丢弃规则不对')
  const keys = Object.keys(d.todos[0])
  assert.deepEqual(keys, ['content', 'status'], '下发形状必须只有 content/status 两键')
  assert.ok(!JSON.stringify(d.todos).includes('<system-reminder'), '注入壳没剥净')
})

test('⑤ 结构字段不受影响：turns/live/stats 照旧，todos 是新增并列字段', async () => {
  const events = baseEvents().concat([
    { type: 'todo/write', seq: 3, time: 3, data: { todos: [{ content: 'A', status: 'pending' }] } },
    { type: 'assistant/message', seq: 4, time: 4, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '回复' }] } } },
    { type: 'turn/end', seq: 5, time: 5, data: { turn: 1 } },
  ])
  const d = await detailOf({ events, turnOutline: [] })
  assert.equal(d.full, true, '本该走全文分支')
  assert.equal(d.turns.length, 1)
  assert.equal(d.turns[0].prompt, '帮我改一下')
  assert.equal(d.turns[0].response, '回复')
  assert.equal(d.todos.length, 1)
  assert.ok(d.stats && typeof d.stats.turns === 'number', 'stats 结构被动了')
})
