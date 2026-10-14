/**
 * task-A 单测：PTC 子调用（tool/ptc-dispatch-start / tool/ptc-dispatch）折进历史轮（第 187 节）。
 *
 * 背景：用户 m01797/m01830 —— 手机端会话历史里的折叠栏打开只有「思考 + 代码」，
 * 但 DSH 电脑端的 run_code 内部每一步（read / grep / pwsh / subagent…）都该列出来：
 * 「别只显示思考和代码了，本来折叠栏打开就是要看步骤的啊。」
 *
 * 数据源（实锤）：
 *  - { type:'tool/ptc-dispatch-start', data:{ rootCallId, parentCallId, subCallId, name, arguments } }
 *  - { type:'tool/ptc-dispatch',       data:{ …, subCallId, name, arguments, isError, content } }
 *  两类事件**都没有 turn / step**（靠 lastTurn / lastStep 游标归位），夹在父
 *  tool/call 与 tool/result 之间。
 *
 * 本节只做**历史轮数据通路**（readDetail → detail.turns[].tools / steps）：
 * 子调用卡与父卡进同一个 cur.tools 数组 ⇒ 同样的裁剪与预算；老宿主没有这两类事件时逐字不变。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const T = 1700000000000

/** 造一个假 ctx（照抄 acp-turns.spec.mjs / todo-projection.spec.mjs 的范式）。 */
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

/** 事件工厂：seq 由调度方给，time 默认同一基准。 */
function ev(type, seq, data) { return { type, seq, time: T + seq, data: data || {} } }

/** 一轮的开头（turn/start + 提问 + 一次带思考的助手回复）。 */
function turnHead(turn, seq0, text, think) {
  const out = [
    ev('turn/start', seq0, { turn }),
    ev('user/message', seq0 + 1, { turn, content: [{ type: 'text', text: '帮我查一下' }] }),
  ]
  const blocks = []
  if (think) blocks.push({ type: 'reasoning', text: think })
  blocks.push({ type: 'text', text })
  out.push(ev('assistant/message', seq0 + 2, { turn, step: 1, message: { content: blocks } }))
  return out
}

/** 折叠栏里的步骤序列（k:'o' 是工具卡下标，k:'t' 是思考）。 */
function toolSteps(t) {
  return (t.steps || []).filter((s) => s.k === 'o').map((s) => ({ i: s.i, s: s.s }))
}

test('① 一个 run_code 父调用带 2 个子调用 ⇒ tools 列出 run_code/read/grep，顺序与事件一致、state 全是 done', async () => {
  const events = turnHead(1, 1, '跑完了', '先看代码')
    .concat([
      ev('tool/call', 4, { turn: 1, step: 1, name: 'run_code', arguments: { code: 'a' } }),
      ev('tool/ptc-dispatch-start', 5, { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'a', name: 'read', arguments: { file_path: 'lib/index.js' } }),
      ev('tool/ptc-dispatch', 6, { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'a', name: 'read', content: [{ type: 'text', text: '读到了' }] }),
      ev('tool/ptc-dispatch-start', 7, { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'b', name: 'grep', arguments: { pattern: 'ptc' } }),
      ev('tool/ptc-dispatch', 8, { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'b', name: 'grep', content: [{ type: 'text', text: '3 处命中' }] }),
      ev('tool/result', 9, { turn: 1, step: 1, name: 'run_code', message: { content: [{ type: 'text', text: '父调用结果' }] } }),
      ev('turn/end', 10, { turn: 1 }),
    ])
  const d = await detailOf({ events, turnOutline: [] })
  assert.equal(d.full, true, '本该走全文分支')
  assert.equal(d.turns.length, 1, '子调用不该造出新轮')
  const t = d.turns[0]
  assert.deepEqual(t.tools.map((c) => c.name), ['run_code', 'read', 'grep'], '折叠栏没列出真实步骤/顺序不对')
  assert.deepEqual(t.tools.map((c) => c.state), ['done', 'done', 'done'], 'state 不对（父卡被末尾子卡顶住会漏 done）')
  // 步骤流：三张卡各一步，都在 step 1（PTC 事件没带 step，靠游标归位）
  assert.deepEqual(toolSteps(t), [{ i: 0, s: 1 }, { i: 1, s: 1 }, { i: 2, s: 1 }], 'steps 顺序/步骤号不对')
  assert.equal(t.tools[0].result, '父调用结果', 'tool/result 应回填父卡（不是末尾的子卡）')
  assert.equal(t.tools[1].result, '读到了', '子调用结果没回填')
  assert.equal(t.tools[2].result, '3 处命中', '子调用结果没回填')
})

test('② 子调用报错 ⇒ 该卡 state=err，同轮其它卡不受影响；同 subCallId 精确配对不串卡', async () => {
  const events = turnHead(1, 1, '跑完了', '先看代码')
    .concat([
      ev('tool/call', 4, { turn: 1, step: 1, name: 'run_code', arguments: { code: 'a' } }),
      ev('tool/ptc-dispatch-start', 5, { subCallId: 'a1', name: 'read', arguments: { file_path: 'one' } }),
      ev('tool/ptc-dispatch-start', 6, { subCallId: 'a2', name: 'read', arguments: { file_path: 'two' } }),
      // 后发的先收尾：靠 subCallId 配，绝不能把 a2 的结果盖到 a1 上
      ev('tool/ptc-dispatch', 7, { subCallId: 'a2', name: 'read', isError: true, content: [{ type: 'text', text: '第二个失败了' }] }),
      ev('tool/ptc-dispatch', 8, { subCallId: 'a1', name: 'read', content: [{ type: 'text', text: '第一个成功了' }] }),
      ev('tool/result', 9, { turn: 1, step: 1, name: 'run_code', message: { content: [{ type: 'text', text: '父结果' }] } }),
      ev('turn/end', 10, { turn: 1 }),
    ])
  const d = await detailOf({ events, turnOutline: [] })
  const t = d.turns[0]
  assert.deepEqual(t.tools.map((c) => c.name), ['run_code', 'read', 'read'])
  assert.deepEqual(t.tools.map((c) => c.state), ['done', 'done', 'err'], '报错的那张卡 state 应为 err')
  assert.equal(t.tools[1].result, '第一个成功了', 'a1 的结果被串到别的卡了')
  assert.equal(t.tools[2].result, '第二个失败了', 'a2 的结果没落回自己那张卡')
})

test('③ 只有 dispatch（缺 start）⇒ 补一张卡，宁多勿漏；老会话（无 ptc 事件）逐字不变', async () => {
  const withOnly = turnHead(1, 1, '跑完了')
    .concat([
      ev('tool/call', 4, { turn: 1, step: 1, name: 'run_code', arguments: { code: 'a' } }),
      ev('tool/ptc-dispatch', 5, { subCallId: 'z', name: 'pwsh', content: [{ type: 'text', text: 'ok' }] }),
      ev('tool/result', 6, { turn: 1, step: 1, name: 'run_code', message: { content: [{ type: 'text', text: '父结果' }] } }),
      ev('turn/end', 7, { turn: 1 }),
    ])
  const d1 = await detailOf({ events: withOnly, turnOutline: [] })
  assert.deepEqual(d1.turns[0].tools.map((c) => c.name), ['run_code', 'pwsh'], '孤儿 dispatch 应补一张卡')
  assert.deepEqual(d1.turns[0].tools.map((c) => c.state), ['done', 'done'])

  // 回归：老宿主/老会话——一条 ptc 事件都没有时，工具卡形状与语义不许多出任何东西
  const legacy = turnHead(1, 1, '跑完了')
    .concat([
      ev('tool/call', 4, { turn: 1, step: 1, name: 'run_code', arguments: { code: 'a' } }),
      ev('tool/result', 5, { turn: 1, step: 1, name: 'run_code', message: { content: [{ type: 'text', text: '父结果' }] } }),
      ev('turn/end', 6, { turn: 1 }),
    ])
  const d2 = await detailOf({ events: legacy, turnOutline: [] })
  const t = d2.turns[0]
  assert.equal(t.tools.length, 1, '无 ptc 事件时不该多出卡片')
  assert.deepEqual(Object.keys(t.tools[0]), ['name', 'state', 'detail', 'result', 'brief'], '工具卡形状变了（不许加内部字段）')
  for (const keys of toolsKeysAcross(d1).concat(toolsKeysAcross(d2))) {
    assert.deepEqual(keys, ['name', 'state', 'detail', 'result', 'brief'], '带 ptc 的卡也必须只有这五个键')
  }
  assert.deepEqual(t.steps, [{ k: 'o', i: 0, s: 1 }], '无 ptc 时 steps 逐字不变')
})

test('④ PTC 事件没有 turn 字段 ⇒ 靠 lastTurn 归位到正确轮（跨轮不串）', async () => {
  const events = turnHead(1, 1, '第一轮结束')
    .concat([
      ev('tool/call', 4, { turn: 1, step: 1, name: 'run_code', arguments: { code: 'a' } }),
      ev('tool/ptc-dispatch-start', 5, { subCallId: 'a', name: 'read', arguments: { file_path: 'one' } }),
      ev('tool/ptc-dispatch', 6, { subCallId: 'a', name: 'read', content: [{ type: 'text', text: 'r1' }] }),
      ev('tool/result', 7, { turn: 1, step: 1, name: 'run_code', message: { content: [{ type: 'text', text: 'p1' }] } }),
      ev('turn/end', 8, { turn: 1 }),
    ])
    .concat(turnHead(2, 9, '第二轮结束'))
    .concat([
      ev('tool/call', 12, { turn: 2, step: 1, name: 'run_code', arguments: { code: 'b' } }),
      ev('tool/ptc-dispatch-start', 13, { subCallId: 'b', name: 'ops_bash', arguments: { command: 'ls' } }),
      ev('tool/ptc-dispatch', 14, { subCallId: 'b', name: 'ops_bash', content: [{ type: 'text', text: 'r2' }] }),
      ev('tool/result', 15, { turn: 2, step: 1, name: 'run_code', message: { content: [{ type: 'text', text: 'p2' }] } }),
      ev('turn/end', 16, { turn: 2 }),
    ])
  const d = await detailOf({ events, turnOutline: [] })
  assert.equal(d.turns.length, 2, '不该多出轮')
  assert.deepEqual(d.turns[0].tools.map((c) => c.name), ['run_code', 'read'], '第 1 轮的子调用串到别处了')
  assert.deepEqual(d.turns[1].tools.map((c) => c.name), ['run_code', 'ops_bash'], '第 2 轮的子调用串到别处了')
  assert.equal(d.turns[1].tools[1].result, 'r2')
  assert.equal(d.turns[0].tools[1].result, 'r1')
})

test('⑤ 体积红线：一轮几十个子调用也吃既有裁剪（老卡 brief/detail 退到上限），总量有界', async () => {
  const N = 60
  const events = turnHead(1, 1, '跑完了', '先看代码')
  let seq = 4
  events.push(ev('tool/call', seq++, { turn: 1, step: 1, name: 'run_code', arguments: { code: 'a' } }))
  const long = 'x'.repeat(400)
  for (let i = 0; i < N; i++) {
    events.push(ev('tool/ptc-dispatch-start', seq++, { subCallId: 's' + i, name: 'read', arguments: { file_path: 'C:/proj/lib/' + i + '-' + long + '.js' } }))
    events.push(ev('tool/ptc-dispatch', seq++, { subCallId: 's' + i, name: 'read', content: [{ type: 'text', text: long }] }))
  }
  events.push(ev('tool/result', seq++, { turn: 1, step: 1, name: 'run_code', message: { content: [{ type: 'text', text: '父结果' }] } }))
  events.push(ev('turn/end', seq++, { turn: 1 }))
  const d = await detailOf({ events, turnOutline: [] })
  const t = d.turns[0]
  assert.equal(t.tools.length, N + 1, '子调用卡漏了')
  const cp = (s) => Array.from(String(s || '')).length
  // BRIEF_KEEP=4 / OLD_BRIEF_MAX=32：最老的子卡 brief 必须已被裁（32 码点 +「…」）
  assert.ok(cp(t.tools[0].brief) <= 33, '很老的卡 brief 没被裁：' + cp(t.tools[0].brief))
  // 最新的卡（fromTail=0）仍是全量 brief（≤ BRIEF_MAX=72），说明是「老卡退让」而不是全裁
  assert.ok(cp(t.tools[N].brief) > cp(t.tools[0].brief), '最新的卡不该被裁成老卡长度')
  // TOOL_KEEP_FULL=2 / OLD_DETAIL_MAX=120：更老的卡 detail 已退到 120(+标记)
  assert.ok(cp(t.tools[0].detail) <= 130, '很老的卡 detail 没被裁：' + cp(t.tools[0].detail))
  assert.ok(cp(t.tools[N].detail) > cp(t.tools[0].detail), '最新卡 detail 不该退到老卡上限')
  const bytes = Buffer.byteLength(JSON.stringify(t), 'utf8')
  console.log('  [体积实测] 单轮 ' + (N + 1) + ' 张工具卡 ⇒ turns[0] JSON = ' + bytes + ' 字节')
  assert.ok(bytes < 80 * 1024, '一轮几十张卡体积失控：' + bytes + ' 字节')
})

function toolsKeysAcross(d) {
  const out = []
  for (const t of d.turns || []) for (const c of (t.tools || [])) out.push(Object.keys(c))
  return out
}
