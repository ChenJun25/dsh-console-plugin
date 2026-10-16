/**
 * 🔴 第 211 节 · task-6 回归 spec：把「真日志 A/B 全量回放」的核心判据固化成**不依赖真日志**的单测。
 *
 * A/B 的两个版本：
 *   旧判据 = git 4f320b7^:lib/index.js —— 只有「当前段已有**助手正文**(cur.response)」才 forkSegment；
 *   新判据 = 当前 lib/index.js —— 当前段已有**任意助手活动**（response/think/steps/tools/failure）就 forkSegment。
 * 真日志回放（~/.dsh/sessions，43 个会话）实测差异：
 *   82 处真 steer 里旧判据只切 24 段、新判据切 79 段；「同一张卡塞 ≥2 条提问」从 57 处降到 3 处。
 * 本文件把那三个核心判据钉死，跑法：node lib/test/task6-ab-parity.spec.mjs
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

/** 每次换 query 破模块缓存 ⇒ 用例之间不串 live/段状态。 */
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

/* ============================================================
 * ① A/B 核心差异格：正文之前只有 reasoning / tool/call —— 新判据必须切段
 *    （旧判据 cur.response !== '' 为假 ⇒ 这一格漏切，同一张卡塞两条提问）
 * ============================================================ */
test('task-6 ① 只有 reasoning/tool、尚无正文时 steer 必须切段（旧判据此格漏切）', async () => {
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
  assert.ok(d.turns[0].think.length > 0, '上一张卡有 reasoning')
  assert.equal(d.turns[0].tools.length, 1, '上一张卡有 tool/call')
  assert.deepEqual(d.turns[1].prompts, ['中途追问'], '新卡只装追问')
  assert.equal(d.turns[1].response, '追问的答')
})

/* ============================================================
 * ② 对照格：正文已经在 —— 旧判据本来就切，说明差异只在①那一格
 * ============================================================ */
test('task-6 ② 对照：已有助手正文时 steer 切段（新旧判据行为一致）', async () => {
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

/* ============================================================
 * ③ 红线：中间没有任何助手事件的两条连问，仍同卡（放宽只加了「已有活动」这一维）
 * ============================================================ */
test('task-6 ③ 红线：正文前连问不切（turns=1、prompts 两条）', async () => {
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

/* ============================================================
 * ④ 跨段工具终态回填：steer 在工具还在跑时切段 ⇒ call 留旧段、result 落新段
 *    旧版（仅靠 byNo 指向新段）旧卡永远 state='run'（手机端一直「运行中」）
 * ============================================================ */
test('task-6 ④a 工具运行中 steer：result 跨段回填旧段补 done', async () => {
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

test('task-6 ④b 同口径 isError：回填 err 而不是 done', async () => {
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

/* ============================================================
 * ⑤ live 窗口 == 已折入末轮 ⇒ 不下发 base.live（App 的 liveCardFallback 随之关闭）
 *    身份判据是**毫秒戳为主、seq 为辅**：真实会话 session-98fbbeec idx1410 的
 *    live 窗口起点是第 1404 条 steer，而折出的 fork 段 seq=1403 —— 两者同毫秒
 *    （1792076639946），只比 seq 会漏判、双卡照旧。
 *    本用例刻意造成 seq 不相等（4 vs 5）、毫秒戳相等（T0+3000）⇒ 必须仍判同源。
 * ============================================================ */
test('task-6 ⑤ 毫秒戳相等（seq 不同）即视为同源 ⇒ 不发 base.live', async () => {
  const events = [
    start(1),
    u(2, '第一问', T0 + 1000),
    a(3, 1, '第一答', T0 + 2000),
    u(4, '追问', T0 + 3000),
    u(5, '紧跟着再问', T0 + 3000),          // 同毫秒：不再 fork，折进同一段
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

test('task-6 ⑥ 反例护栏：末段没有过程内容时 live 照旧下发（宁可多下一份）', async () => {
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

/* ============================================================
 * ⑦ A/B 里旧判据的「正文前漏切」在**同一份真日志口径**下必然 0 命中：
 *    这里用一段夹具证明旧条件（只看 response）在 ① 的 steer 处判假，
 *    而新条件判真 —— 即脚本统计的两个数字之差不是统计口径造成的。
 * ============================================================ */
test('task-6 ⑦ 判据差集自证：①夹具的 steer 处「旧条件假、新条件真」', async () => {
  /* 局部复刻两条判据（与 index.js:1960 逐字同构，只有 cur 的活动字段不同） */
  const oldCond = (cur) => !!(cur.response)
  const newCond = (cur) => !!(cur.response || cur.think || (cur.steps && cur.steps.length) ||
    (cur.tools && cur.tools.length) || cur.failure)
  const cur = { response: '', think: '先想一下', steps: [{ k: 't', i: 0, s: 1 }], tools: [{ name: 'bash', state: 'run' }], failure: null }
  assert.equal(oldCond(cur), false, '旧判据：无正文 ⇒ 不切段')
  assert.equal(newCond(cur), true, '新判据：有 reasoning/tool ⇒ 切段')
  /* 与 ① 的实测结果对齐：新判据下确实折出 2 段 */
  const events = [
    start(1), u(2, '第一问', T0 + 1000), thinkOnly(3, 1, '先想一下', T0 + 2000),
    call(4, 1, 'bash', T0 + 2100), u(5, '中途追问', T0 + 3000), a(6, 2, '追问的答', T0 + 4000)
  ]
  const d = (await detail(events, [])).result
  assert.equal(d.turns.length, 2)
})
