/**
 * 批次F · task-33 单测：子智能体会话的 detail **全文通道**（durable parent address）。
 *
 * 病灶（Lead 取证 + asar 实锤）：lib/index.js 的 detail 全文分支写死
 *   `ctl.page({ address: { kind: 'session', sessionId } })`
 * 而宿主 validateAddress（asar@16264180）对 header.origin === 'subagent' 的第一件事就是
 *   throw new RemoteError('session/agent-busy',
 *     'subagent Sessions require their durable parent address')
 * ⇒ 子会话**永远**掉进 catch，退回 turnOutline 概要投影（每轮 120 字、images 恒空），
 *   task-8 的助手侧图片与 task-21 的 failure 卡片在子会话上因此都不可达。
 *
 * 正确契约（asar@16438673 SessionAddress 声明，逐字）：
 *   { kind: 'session'; sessionId } |
 *   { kind: 'subagent'; parentSessionId; childSessionId; mode: 'one-shot'|'continuable'|'unknown' }
 * parent 从 ctl.list() 的行上取：子会话行有 parentSessionId + origin:'subagent'（实测）。
 *
 * 这个 spec 里的 page 替身**照抄宿主 validateAddress 的判定**，所以「传错 address 一定被抓」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const REF_A = { attachmentId: 'sha256:' + HEX_A, mediaType: 'image/png', bytes: 111, width: 4, height: 4, name: 'one.png' }
const REF_B = { attachmentId: 'sha256:' + HEX_B, mediaType: 'image/jpeg', bytes: 222, width: 8, height: 8 }

const PARENT = 'session-parent-0001'
const CHILD = 'child-0002'
const MAIN = 'session-main-0003'

/** 宿主 validateAddress 的关键分支（asar@16264180）：session 地址碰上 subagent 会话即拒。 */
function hostValidate (address, header) {
  if (address.kind === 'session') {
    if (header.origin === 'subagent') {
      throw Object.assign(new Error('subagent Sessions require their durable parent address'),
        { code: 'session/agent-busy' })
    }
    return
  }
  if (header.origin !== 'subagent' || header.parentSession !== address.parentSessionId) {
    throw Object.assign(new Error('subagent does not belong to the supplied parent'),
      { code: 'subagent/unauthorized' })
  }
}

/** 造一小组真形状事件（含一对助手侧图片，验 task-8 在子会话上也能到）。 */
function makeEvents () {
  let seq = 0
  const push = (type, data) => ({ type, seq: ++seq, time: 1790000000000 + seq, data })
  return [
    push('turn/start', { turn: 1 }),
    push('user/message', { turn: 1, content: [{ type: 'text', text: '子智能体第 1 轮提问' }] }),
    push('assistant/message', { turn: 1, step: 1, stream: [], message: { content: [
      { type: 'reasoning', text: '子智能体的思考' },
      { type: 'text', text: '子智能体的正文' },
      /* 宿主事件里图片块的真实形状是 {type:'image', attachment:{attachmentId,…}}
         （照 lib/test/detail-images.spec.mjs 的 REF_A/REF_B），不是 base64 data。 */
      { type: 'image', attachment: REF_A },
      { type: 'image', attachment: REF_B }
    ] } }),
    push('tool/call', { turn: 1, step: 1, name: 'read', arguments: '{"file_path":"C:/x.ets"}' }),
    push('tool/result', { turn: 1, step: 1, name: 'read', message: { content: [{ type: 'text', text: 'ok' }] } }),
    push('turn/end', { turn: 1 })
  ]
}

/**
 * 走真 apply() → detail 通路。
 * @param {{ sid:string, origin?:'subagent'|undefined, parentSessionId?:string, events:any[],
 *           listThrows?:boolean, rejectSubagent?:boolean, zeroSeq?:boolean }} o
 */
async function detailOf (o) {
  const events = o.events
  const maxSeq = events.reduce((m, e) => Math.max(m, e.seq), 0)
  const seen = { addresses: [], throughSeqs: [] }
  let cmdFetch = null
  const conn = { fetch: { register: (r) => { if (r.path === '/api/dsh-console/cmd') cmdFetch = r.fetch; return () => {} } } }
  const ctl = {
    // asOfSeq：子会话场景默认给 0 —— 复现「projections 还没算出来」的真实时序
    projections: async () => ({
      asOfSeq: o.zeroSeq ? 0 : maxSeq,
      values: { title: 't', turnOutline: [{ turn: 1, seq: maxSeq, prompt: '概要提问', response: '概要正文' }] }
    }),
    page: async (req) => {
      seen.addresses.push(req && req.address)
      seen.throughSeqs.push(req && req.throughSeq)
      const header = o.origin === 'subagent'
        ? { cwd: 'C:/w', origin: 'subagent', parentSession: o.parentSessionId || PARENT }
        : { cwd: 'C:/w' }
      if (o.rejectSubagent && req.address && req.address.kind === 'subagent') {
        throw Object.assign(new Error('subagent descriptor is unavailable'), { code: 'subagent/catalog-diagnostic' })
      }
      hostValidate(req.address, header)
      if (req.throughSeq === -1) return { records: [], hasMore: false }
      /* 宿主 page 的两条闸，逐字（asar@16255800）：
           `if (throughSeq > sourceCursor) throw …past cursor…`
         末尾再按 `end = min(throughSeq+1, …)` 切出**到 throughSeq 为止**的稠密前缀。
         所以 throughSeq 偏小时拿到的是**截短**的页，而不是报错 —— 这正是
         「projections 还没算出来 ⇒ 折出 0 轮 ⇒ 退回概要」的真实成因。 */
      if (req.throughSeq > maxSeq) {
        throw Object.assign(new Error('session page through seq is past cursor'), { code: 'gateway/bad-request' })
      }
      const end = req.throughSeq + 1
      return { records: events.slice(0, end).map((e) => ({ type: 'event', event: e })), hasMore: end < maxSeq }
    },
    list: async () => {
      if (o.listThrows) throw new Error('会话列表不可用')
      const row = { id: o.sid, title: 't', cwd: 'C:/w', updatedAt: 1, running: false }
      if (o.origin === 'subagent') { row.parentSessionId = o.parentSessionId || PARENT; row.origin = 'subagent' }
      return { items: [row, { id: PARENT, title: 'p', cwd: 'C:/w', updatedAt: 2, running: false }] }
    }
  }
  const ctx = { get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : null), on: () => () => {}, effect: () => () => {} }
  const mod = await import('../index.js?t=' + Math.random())
  mod.apply(ctx, { port: 0 })
  const r = await cmdFetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: o.sid } }) }))
  return { detail: (await r.json()).result || {}, seen }
}

test('① 子智能体会话：用 kind:subagent 的 durable parent address 拿到全文（task-33 主修点）', async () => {
  const { detail, seen } = await detailOf({ sid: CHILD, origin: 'subagent', events: makeEvents() })
  assert.equal(seen.addresses.length, 1, 'page 只该被调一次')
  assert.deepEqual(seen.addresses[0], {
    kind: 'subagent', parentSessionId: PARENT, childSessionId: CHILD, mode: 'unknown'
  }, 'address 形状必须与宿主 SessionAddress 声明逐字一致')
  assert.equal(detail.full, true, '子会话必须走全文通道（原来恒为概要）')
  assert.equal(detail.turns.length, 1)
  assert.equal(detail.turns[0].prompt, '子智能体第 1 轮提问')
  assert.equal(detail.turns[0].response, '子智能体的正文', '正文不该是 120 字概要')
  assert.equal(detail.turns[0].think, '子智能体的思考')
  assert.equal((detail.trace || []).length > 0, true, 'trace 也该有')
})

test('② 子会话的图片能到（task-8 的助手侧图片在子会话上不再不可达）', async () => {
  const { detail } = await detailOf({ sid: CHILD, origin: 'subagent', events: makeEvents() })
  /* 第 167 节 T1 分流：makeEvents 的两张图都塞在同一条 assistant/message 里 ⇒
     两张都是**助手图**，全进 aimages；这一轮没有用户图 ⇒ images 恒空。 */
  assert.equal(detail.turns[0].images.length, 0, '这一轮没有用户图')
  assert.equal(detail.turns[0].aimages.length, 2,
    '概要投影给的是 images/aimages:[] 占位；全文分支才登记得到图片')
  assert.deepEqual(Object.keys(detail.turns[0].aimages[0]).sort(), ['bytes', 'id', 'mime', 'name'])
  assert.equal(detail.turns[0].aimages[0].id, 'sha256:' + HEX_A)
  assert.equal(detail.turns[0].aimages[1].id, 'sha256:' + HEX_B)
})

test('③ 主会话不受影响：仍然是 kind:session 地址（回归防线）', async () => {
  const { detail, seen } = await detailOf({ sid: MAIN, events: makeEvents() })
  assert.deepEqual(seen.addresses[0], { kind: 'session', sessionId: MAIN })
  assert.equal(detail.full, true)
  assert.equal(detail.turns[0].response, '子智能体的正文')
})

test('④ 列表不可用时拿不到 parent ⇒ 退回 kind:session，交给宿主照原样拒绝（不编假 parent）', async () => {
  const { detail, seen } = await detailOf({ sid: CHILD, origin: 'subagent', listThrows: true, events: makeEvents() })
  assert.deepEqual(seen.addresses[0], { kind: 'session', sessionId: CHILD })
  assert.equal(detail.full, undefined, '拿不到 parent 就该退回概要，而不是伪造')
  assert.equal(detail.turns.length, 1, '概要仍要有一轮（不能整页崩）')
  assert.equal(detail.turns[0].response, '概要正文')
})

test('⑤ 子会话地址仍被宿主拒（描述符缺失）⇒ 照样退回概要，不崩不假装 full', async () => {
  const { detail } = await detailOf({ sid: CHILD, origin: 'subagent', rejectSubagent: true, events: makeEvents() })
  assert.equal(detail.full, undefined)
  assert.equal(detail.ok, true, 'detail 必须仍然是 ok:true（手机端不能红屏）')
  assert.equal(detail.turns[0].response, '概要正文')
})

test('⑥ projections 未就绪（asOfSeq=0）⇒ 页被截短、折出 0 轮、退回概要，且只请求一次', async () => {
  /* 这是「子会话一开始也拿不到全文」的**真实成因之一**，不是本任务要修的 bug：
     throughSeq=0 ⇒ 页只到第 1 条事件 ⇒ foldHistoryToTurns 折出 0 轮 ⇒ 落概要。
     断言插件**不**自作聪明重试 throughSeq:-1 —— 那必得空页，落点一模一样
     （所以本轮没加那条分支，免得留一条没人能覆盖的死代码）。 */
  const { detail, seen } = await detailOf({ sid: CHILD, origin: 'subagent', zeroSeq: true, events: makeEvents() })
  assert.deepEqual(seen.throughSeqs, [0], '只发一次请求，不重试')
  assert.equal(detail.full, undefined, '截短的页折不出轮，退回概要')
  assert.equal(detail.ok, true, 'detail 仍然是 ok:true')
  assert.equal(detail.turns[0].response, '概要正文')
})

test('⑦ throughSeq 正常时不触发重试（主会话路径零变化）', async () => {
  const { seen } = await detailOf({ sid: MAIN, events: makeEvents() })
  assert.equal(seen.throughSeqs.length, 1)
  assert.ok(seen.throughSeqs[0] > 0)  // = asOfSeq，不是 -1
})
