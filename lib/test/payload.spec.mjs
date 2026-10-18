/**
 * task-35 单测：#48「方案 A」payload 瘦身（第 100 节）。
 *
 * 用**按真机量级标定**的合成 records（32 轮 / 每轮 ~100 条 message / ~110 张工具卡）
 * 走真实 apply() → detail 通路，断言任务书那 5 条 + 冻结行为不回退。
 *
 * ⚠️ 关于 maxMessages：任务书写「600 ⇒ 32 轮」，**实测不成立** —— 宿主 paginate
 *    （asar@16195456：MESSAGE_TYPES = Set(['user/message','assistant/message'])）
 *    数的是 message **条数**；本机最大会话（41 轮 / 4332 条 message）平均每轮
 *    105.7 条 message，覆盖最后 32 轮需 3202 条 ⇒ 默认取 3200。
 *    这个单测的 page 替身实现了同一套 paginate 语义。
 *
 * 标定依据（真机 session-7f37d36e 的 32 轮窗口实测）：
 *   think 90KB / thinks[] 45KB / steps[] 86KB / tools[] 157KB / response 87KB，
 *   steps 3573 条、tools 3493 张 ⇒ 每轮约 110 步、约 110 张卡（卡本身很小，
 *   体积大头是每轮 think 与 response）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const MSG_TYPES = new Set(['user/message', 'assistant/message'])

/** 照宿主 paginate 语义从尾部取窗口（含 throughSeq 限制）。 */
function paginate(events, maxMessages) {
  const evs = events
  let count = 0
  let cut = 0
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i]
    if (!MSG_TYPES.has(e.type)) continue
    count++
    if (count >= maxMessages) { cut = i; break }
  }
  return evs.slice(cut)
}

/** 造一轮：~perTurnMessages 条 message + steps 张工具卡；bigThink 轮额外塞一段超长思考。 */
function makeTurn(turn, perTurnMessages, steps, bigThink) {
  const evs = []
  let seq = 1
  const push = (type, data) => evs.push({ type, seq: seq++, time: 1790000000000 + seq, data })
  push('turn/start', { turn })
  /* 最后几轮给一段**超长**提问：它同时是 trace 里的 kind:'user' 条目 —— 用来验
     TRACE_TEXT_MAX 的截断标记（trace 正文上限 240，短文本触发不了）。
     只加在最后几轮，免得把「32 轮」样本整体撑肥、偏离真机量级。 */
  const longPrompt = turn > 28
  push('user/message', { turn, content: [{ type: 'text', text: '第 ' + turn + ' 轮提问：' + '汉'.repeat(longPrompt ? 400 : 40) }] })
  const patch = (n) => String(n)
  for (let s = 1; s <= steps; s++) {
    // 每步一小段思考（真机每轮 think 合计约 900 汉字）
    const think = (bigThink && s === 1) ? '超长思考：' + '汉'.repeat(3000) : '思考 ' + s + '：' + '汉'.repeat(6)
    push('assistant/message', { turn, step: s, stream: [
      { type: 'reasoning-chunks', texts: [think] },
      { type: 'text-chunks', texts: ['正文 ' + s] }
    ], message: { content: [
      { type: 'reasoning', text: think },
      { type: 'text', text: '正文 ' + s }
    ] } })
    const args = s === steps
      ? JSON.stringify({ file_path: 'C:/p/f' + patch(s) + '.ets', note: '汉'.repeat(400) })
      : JSON.stringify({ file_path: 'C:/p/f' + patch(s) + '.ets' })
    push('tool/call', { turn, step: s, name: 'read', arguments: args })
    // 第一张卡给一段超长结果（触发 tool 详情 + trace 正文的截断标记）
    // ⚠️ 长结果必须放在**最后一张卡**上：foldHistoryToTurns 只让最后 TOOL_KEEP_FULL
    //    张走 TOOL_DETAIL_MAX 全文，更老的卡会被压到 OLD_DETAIL_MAX/OLD_TOOL_MIN
    //    （第 113 节起是预览而非删键），放第一张就验不到 TOOL_DETAIL_MAX 的效果。
    const res = s === steps ? '结果：' + '汉'.repeat(400) : 'ok'
    push('tool/result', { turn, step: s, name: 'read', message: { content: [{ type: 'text', text: res }] } })
  }
  // 补足到 perTurnMessages 条**总数**（真机每轮约 105.7 条 message）
  let have = 1 + steps
  while (have < perTurnMessages) {
    push('assistant/message', { turn, step: steps, stream: [{ type: 'text-chunks', texts: ['填充 ' + have] }], message: { content: [{ type: 'text', text: '填充 ' + have }] } })
    have++
  }
  push('turn/end', { turn })
  return evs
}

function makeEvents(turns, perTurnMessages, steps, bigThinkEvery) {
  const out = []
  for (let i = 1; i <= turns; i++) out.push(...makeTurn(i, perTurnMessages, steps, bigThinkEvery > 0 && i % bigThinkEvery === 0))
  return out
}

/** 假 ctx + 截胡 cmd 路由；page 替身按页大小真的分页。 */
async function detailWith(events, env, maxMessagesOverride) {
  const saved = {}
  for (const k of Object.keys(env || {})) { saved[k] = process.env[k]; process.env[k] = String(env[k]) }
  try {
    const asOfSeq = events.reduce((m, e) => Math.max(m, e.seq), 0)
    const pageSize = Number(maxMessagesOverride) || Number((env || {}).DSH_MP_MAX_MESSAGES) || 3200
    let cmdFetch = null
    const conn = { fetch: { register: (r) => { if (r.path === '/api/dsh-console/cmd') cmdFetch = r.fetch; return () => {} } } }
    const ctl = {
      projections: async () => ({ asOfSeq, values: { title: 't', turnOutline: [] } }),
      // 真按 maxMessages 分页（宿主行为），再叠加插件请求里传的上限
      page: async (req) => {
        const n = Number((req && req.maxMessages) || pageSize)
        return { records: paginate(events, n).map((e) => ({ type: 'event', event: e })) }
      },
      list: async () => ({ items: [] }),
    }
    const ctx = { get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : null), on: () => () => {}, effect: () => () => {} }
    const mod = await import('../index.js?t=' + Math.random())
    mod.apply(ctx, { port: 0 })
    const r = await cmdFetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: 's' } }) }))
    const txt = await r.text()
    return { bytes: Buffer.byteLength(txt), detail: (JSON.parse(txt).result) || {} }
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }
}

const loneSurrogates = (s) => {
  let n = 0
  for (const ch of Array.from(String(s || ''))) {
    const c = ch.codePointAt(0)
    if (c >= 0xd800 && c <= 0xdfff) n++
  }
  return n
}
const HAS_MARK = (s) => String(s || '').includes('已截断')

// 32 轮 × 100 条 message = 3200 条（真机 32 轮窗口实测 3202 条，同一量级）
const EVENTS = makeEvents(32, 100, 90, 8)

test('① 32 轮会话的 payload ≤ 900KB', async () => {
  /* 🔴 第 113 节（task-5 · 用户需求9）：老卡不再 delete detail/result/brief 键
     （旧做法 ⇒ 手机端点开历史步骤全空，用户「过程流里只有最下面一个能展开」），
     改成按体积预算渐进裁剪 ⇒ payload 地板必然抬高，本上限随之 600KB → 900KB。
     本机实测同一份标定素材（脚本 lib/test/_tmp_measure.mjs 同源）：
       旧「删键」逻辑 ≈ 511KB（2848 张老卡正文被删 235KB）
       新「保键」逻辑 = 746KB（保留每条卡正文；2880 张卡的 JSON 脚手架地板 183KB）
     ⇒ 900KB = 746KB + 20% 余量。**真正的红线没变**：第 112 节的 2.06MB /
     手机端 5s 超时，746KB 离红线还有 2.7 倍。体积之外「点开必须有内容」
     由 ①b 单独钉住（那里才是需求9 的护栏）。 */
  const r = await detailWith(EVENTS)
  assert.ok(r.bytes <= 900 * 1024, '实测 ' + r.bytes + 'B (' + (r.bytes / 1024).toFixed(0) + 'KB) 超了 900KB；轮数=' + r.detail.turns.length)
})

test('①b 需求9：历史工具卡点开必须有内容（detail/result 不许全空）', async () => {
  /* 第 113 节（task-5）：旧「删键」逻辑下本素材 2816/2880 张老卡展开全空 —— 这就是
     用户抱怨的现象。口径：只看**已结束**的卡（state !== 'run'）；live 那几张工具还
     没跑完，result 本来就允许是空字符串（卡构造点写的就是 result: ''）。 */
  const r = await detailWith(EVENTS)
  const blanks = []
  for (const t of r.detail.turns) {
    for (const c of (t.tools || [])) {
      if (c.state === 'run') continue
      if (!String(c.detail || '') && !String(c.result || '')) blanks.push(String(c.name || '?'))
    }
  }
  assert.equal(blanks.length, 0, '有 ' + blanks.length + ' 张历史卡展开是空的（需求9 回归）：' + blanks.slice(0, 5).join(','))
})

test('② 轮数 ≥ 30（默认 MAX_MESSAGES=3200 覆盖得住）', async () => {
  const r = await detailWith(EVENTS)
  assert.ok(r.detail.turns.length >= 30, '只有 ' + r.detail.turns.length + ' 轮')
})

test('③ 截断标记出现（不许静默丢）：think / thinks / 工具详情 / trace 正文 / trace 省略标记', async () => {
  const r = await detailWith(EVENTS)
  /* 🔴 第 245 节：四个思考预算默认值已抬到「等于不截断」（用户 m02484「全放开」），
     本素材单条思考最长 3000 字，默认口径下不再产生截断标记。这里显式把思考预算
     压到 100 来继续钉「截断时必须有标记」这条护栏（同下面 TOOL_DETAIL_MAX=20 的手法）。 */
  const rth = await detailWith(EVENTS, {
    DSH_MP_THINK_MAX: 100,
    DSH_MP_THINK_STEP_MAX: 100,
    DSH_MP_THINK_STEPS_TOTAL: 1000,
    DSH_MP_THINK_TAIL_STEP_MAX: 100
  })
  const ts = rth.detail.turns
  /* 第 247 节：thinks[] 非空时 t.think 被删（去冗余），护栏统一看步骤流。 */
  assert.ok(ts.some((t) => t.think !== undefined || (t.thinks || []).length > 0), '思考字段整体丢失')
  assert.ok(ts.some((t) => (t.thinks || []).some(HAS_MARK)), 'thinks[] 没有截断标记')
  /* 🔴 第 112 节：默认上限放宽到 600 后，本素材的工具结果（403 字）不再触发截断，
     这里显式把上限压到 20 来继续钉「截断时必须有标记」这条护栏（不许静默丢内容）。 */
  const rt = await detailWith(EVENTS, { DSH_MP_TOOL_DETAIL_MAX: 20 })
  const tst = rt.detail.turns
  assert.ok(tst.some((t) => (t.tools || []).some((x) => HAS_MARK(x.result) || HAS_MARK(x.detail))), '工具详情没有截断标记')
  assert.ok((r.detail.trace || []).some((x) => HAS_MARK(x.text)), 'trace 正文没有截断标记')
  assert.ok((r.detail.trace || []).some((x) => x.kind === 'note' && /省略/.test(x.text)),
    'trace 没有被省略条数的 note 标记')
})

test('④ 汉字不被切成半个（无孤立代理码元）；emoji 按码点切', async () => {
  const r = await detailWith(EVENTS)
  let bad = 0
  for (const t of r.detail.turns) {
    bad += loneSurrogates(t.think) + loneSurrogates(t.response) + loneSurrogates(t.prompt)
    ;(t.thinks || []).forEach((x) => { bad += loneSurrogates(x) })
    ;(t.tools || []).forEach((x) => { bad += loneSurrogates(x.detail) + loneSurrogates(x.result) })
  }
  ;(r.detail.trace || []).forEach((x) => { bad += loneSurrogates(x.text) })
  assert.equal(bad, 0, '出现 ' + bad + ' 个孤立代理码元（半个字）')
})

test('④b emoji / 代理对素材：正好切在代理对上也不产生半个字符', async () => {
  const evs = []
  let seq = 1
  const push = (type, data) => evs.push({ type, seq: seq++, time: 1790000000000 + seq, data })
  push('turn/start', { turn: 1 })
  push('user/message', { turn: 1, content: [{ type: 'text', text: 'q' }] })
  push('assistant/message', { turn: 1, step: 1, stream: [{ type: 'reasoning-chunks', texts: ['🧠'.repeat(3000)] }],
    message: { content: [{ type: 'reasoning', text: '🧠'.repeat(3000) }, { type: 'text', text: 'ok' }] } })
  push('turn/end', { turn: 1 })
  const r = await detailWith(evs, { DSH_MP_THINK_MAX: 100 })
  const t = r.detail.turns[0]
  /* 第 247 节：本素材只有 reasoning、无正文 ⇒ thinks[] 非空 ⇒ t.think 被删，改看步骤流。 */
  const th0 = String((t.thinks || [])[0] || '')
  assert.equal(loneSurrogates(th0), 0, 'emoji 被切半了')
  assert.ok(th0.startsWith('🧠'.repeat(100)), '应按码点切出 100 个 emoji')
  assert.match(th0, /已截断 2900 字/)
})

test('⑤ 环境变量覆盖：MAX_MESSAGES / THINK_MAX / TOOL_DETAIL_MAX / TRACE_MAX', async () => {
  // MAX_MESSAGES 调小 → 窗口变小 → 轮数变少
  const small = await detailWith(EVENTS, { DSH_MP_MAX_MESSAGES: 300 })
  const big = await detailWith(EVENTS)
  assert.ok(small.detail.turns.length < big.detail.turns.length,
    'DSH_MP_MAX_MESSAGES 没生效: ' + small.detail.turns.length + ' vs ' + big.detail.turns.length)

  // THINK_MAX
  const th = await detailWith(EVENTS, { DSH_MP_THINK_MAX: 50 })
  /* 第 247 节：改看 thinks[]（t.think 在 thinks[] 非空时被删）。 */
  assert.ok(th.detail.turns.some((t) => (t.thinks || []).some((x) => HAS_MARK(x) && /已截断 \d+ 字/.test(x))), 'DSH_MP_THINK_MAX 没生效')

  // TOOL_DETAIL_MAX：结果正文必须跟着变小
  const def = await detailWith(EVENTS)
  const td = await detailWith(EVENTS, { DSH_MP_TOOL_DETAIL_MAX: 30 })
  const maxLen = (d) => Math.max(0, ...d.turns.flatMap((t) => (t.tools || []).map((x) => Array.from(String(x.result || '')).length)))
  assert.ok(maxLen(td.detail) < maxLen(def.detail), 'DSH_MP_TOOL_DETAIL_MAX 没生效: ' + maxLen(td.detail) + ' vs ' + maxLen(def.detail))
  assert.ok(maxLen(td.detail) <= 30 + 30, 'TOOL_DETAIL_MAX=30 时结果仍过长: ' + maxLen(td.detail))
})

test('⑥ 第245节：默认口径下思考**不截断**（thinks[] 无标记、条数与原文一致）', async () => {
  /* 用户 m02484「全放开」：默认四个预算都远超真实思考量，因此本素材
     （每轮 3000 字超长思考 + 若干短思考）默认口径下一条「已截断」都不许有。
     这条与 ③ 一起构成双向护栏：③ 保证「真压小上限时必须有标记」，
     ⑥ 保证「默认不再无故砍内容」。 */
  const r = await detailWith(EVENTS)
  const marked = []
  for (const t of r.detail.turns) {
    if (HAS_MARK(t.think)) marked.push('think@' + t.turn)
    ;(t.thinks || []).forEach((x, i) => { if (HAS_MARK(x)) marked.push('thinks@' + t.turn + '#' + i) })
  }
  assert.equal(marked.length, 0, '默认口径下仍有 ' + marked.length + ' 处思考被截断：' + marked.slice(0, 5).join(','))
  // 超长思考必须全文落地（3000 个汉字一个不少）
  const big = r.detail.turns.flatMap((t) => (t.thinks || [])).find((x) => String(x).includes('超长思考：'))
  assert.ok(big, '找不到超长思考样本')
  assert.equal(Array.from(big).length, '超长思考：'.length + 3000, '超长思考没有全文落地')
})

test('冻结行为不回退：无 <acp> 时正文逐字不变，prompt/response/轮号照旧', async () => {
  const evs = []
  let seq = 1
  const push = (type, data) => evs.push({ type, seq: seq++, time: 1790000000000 + seq, data })
  push('turn/start', { turn: 1 })
  push('user/message', { turn: 1, content: [{ type: 'text', text: '你好，世界' }] })
  push('assistant/message', { turn: 1, step: 1, stream: [{ type: 'text-chunks', texts: ['回复内容'] }], message: { content: [{ type: 'text', text: '回复内容' }] } })
  push('turn/end', { turn: 1 })
  const r = await detailWith(evs)
  const t = r.detail.turns[0]
  assert.equal(t.turn, 1)
  assert.equal(t.prompt, '你好，世界')
  assert.equal(t.response, '回复内容')
  assert.deepEqual(t.prompts, ['你好，世界'])
})

test('冻结行为不回退：<acp> 标记仍被剥净（contentText 白名单 + stripAcp）', async () => {
  const evs = []
  let seq = 1
  const push = (type, data) => evs.push({ type, seq: seq++, time: 1790000000000 + seq, data })
  push('turn/start', { turn: 1 })
  push('user/message', { turn: 1, content: [{ type: 'text', text: '<acp tokens="7" type="text">m1</acp>问题' }] })
  push('assistant/message', { turn: 1, step: 1, stream: [], message: { content: [{ type: 'text', text: '<acp tokens="9" type="text">m2</acp>答案' }] } })
  push('turn/end', { turn: 1 })
  const r = await detailWith(evs)
  assert.equal(r.detail.turns[0].prompt, '问题')
  assert.equal(r.detail.turns[0].response, '答案')
})
