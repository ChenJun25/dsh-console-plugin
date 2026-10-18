/**
 * 🔴 第 211 节 · task-2（G55 §2-D）回归 spec：**生成中双卡 + 新消息跑到回复之上**。
 *
 * 用户原话（真实会话 session-98fbbeec，idx1404 / idx2000）：
 *   「修下为什么生成中卡片又变成2条了…」「我发出去的新消息在你回复之上了，
 *    但是这条信息是回复你这条消息的」。
 *
 * 病根两条，都在插件侧的**事件 → 视觉轮**折叠口径上（App 侧只是照单渲染）：
 *  ① 一轮里用户 steer 进来的追问没有独立成卡 ⇒ 同一张卡里塞了多条提问，
 *     App 的 turnBlock 先 ForEach 画**全部提问**、之后才画助手正文
 *     ⇒ 用户看到「我发出去的新消息在你回复之上」。
 *     旧判据只认 cur.response（已有**助手正文**），而真实一轮先跑几十条
 *     reasoning + tool/call 才出正文 ⇒ 62/63 处 steer 漏切（实测）。
 *  ② 末轮已经折进 turns（同一份 Session.log）之后，base.live 仍然照发
 *     ⇒ App 的 showLiveCard() 被 response 守卫挡掉、liveCardFallback() 为真
 *     ⇒ 主路径「已完成本轮」卡 + 页面底部兜底 live 卡同屏 = 上下两张卡。
 *
 * 跑法：node lib/test/task2-live-double-card.spec.mjs
 */
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

/** 每次都换 query 破坏模块缓存 ⇒ 各用例之间不串 live/段状态。 */
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

/* ============================================================
 * ① 放宽切段：正文之前只有 reasoning / tool 时，steer 也要另起一张卡
 * ============================================================ */
test('task-2 ① 助手已有活动（只有思考+工具、还没正文）时 steer 切段', async () => {
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
  /* 第 247 节：thinks[] 非空时 t.think 被删（去冗余），改断言步骤流。 */
  assert.ok((d.turns[0].thinks || []).some((x) => String(x).length > 0), '上一张卡有思考')
  assert.equal(d.turns[0].tools.length, 1, '上一张卡有工具卡')
  assert.deepEqual(d.turns[1].prompts, ['中途追问'], '新卡只装追问')
  assert.equal(d.turns[1].response, '追问的答')
})

/* ============================================================
 * ② 红线：正文之前连着两条提问，仍同卡（不许切）
 * ============================================================ */
test('task-2 ② 红线：没有任何助手事件时的连问仍同卡', async () => {
  const events = [
    start(1),
    u(2, 'a', T0 + 1000),
    u(3, 'b', T0 + 1500),
    a(4, 1, 'y', T0 + 2000)
  ]
  const d = (await detail(events, [])).result
  assert.equal(d.turns.length, 1, '正文前连问不切（turn-prompt-images.spec ① 的红线）')
  assert.deepEqual(d.turns[0].prompts, ['a', 'b'])
  assert.equal(d.turns[0].response, 'y')
})

/* ============================================================
 * ③ 工具还在跑时 steer：call 留在上一段，result 要跨段回填它的终态
 *    （否则上一段的父卡永远停在 state='run'，手机端一直显示「运行中」）
 * ============================================================ */
test('task-2 ③ 工具运行中 steer：result 跨段回填上一段的 run 父卡', async () => {
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

/* ============================================================
 * ④ live 窗口 == 已折入末轮 ⇒ 不下发 base.live（消掉兜底重复卡）
 *    夹具：末段由 steer 那条 user/message 起头，liveFromLog 回扫也停在同一条
 *    ⇒ 段身份一致（毫秒戳 + seq 都相等）、末段有思考/工具、live 正文被末轮
 *    response 覆盖 ⇒ 三条判据全真。
 * ============================================================ */
test('task-2 ④ live 窗口与末轮是同一段时：不发 base.live（关掉 App 兜底卡）', async () => {
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

/* ============================================================
 * ⑤ 反例（护栏）：末轮没有过程内容时**照常下发** live —— 宁可多下一份，不许丢信息
 * ============================================================ */
test('task-2 ⑤ 反例：末轮没有思考/工具时 live 照旧下发', async () => {
  const events = [
    start(1),
    u(2, '第一问', T0 + 1000),
    a(3, 1, '第一答', T0 + 2000),
    u(4, '中途追问', T0 + 3000),
    a(5, 2, '追问的答', T0 + 4000)
  ]
  const d = (await detail(events, [], { get: () => ({ log: events }) })).result
  assert.equal(d.turns.length, 2)
  assert.ok(d.live, '末轮没有过程内容 ⇒ 屏蔽条件②不成立 ⇒ live 照发')
  assert.equal(d.live.text, '追问的答')
  assert.equal(d.live.startedMs, T0 + 3000, 'live 窗口起点 = 那条 steer 消息')
  assert.equal(d.running, true)
})
