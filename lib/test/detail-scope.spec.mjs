import test from 'node:test'
import assert from 'node:assert/strict'

const MSG_TYPES = new Set(['user/message', 'assistant/message'])
const TAIL_MARK = '尾部暗号-ZYXWV'
const UNIQ_MARK = '唯一暗号-ABCDE'

function paginate(events, maxMessages) {
  const evs = events
  let count = 0
  let cut = 0
  for (let i = evs.length - 1; i >= 0; i--) {
    if (!MSG_TYPES.has(evs[i].type)) continue
    count++
    if (count >= maxMessages) { cut = i; break }
  }
  return evs.slice(cut)
}

const STEPS = 6
const LONG = 3000

function makeTurn(turn) {
  const evs = []
  let seq = 1
  const push = (type, data) => evs.push({ type, seq: seq++, time: 1790000000000 + seq, data })
  push('turn/start', { turn })
  push('user/message', { turn, content: [{ type: 'text', text: '第 ' + turn + ' 轮提问' + (turn === 1 ? UNIQ_MARK : '') }] })
  for (let s = 1; s <= STEPS; s++) {
    const think = '思考 ' + s + '：' + '汉'.repeat(50)
    push('assistant/message', { turn, step: s, stream: [
      { type: 'reasoning-chunks', texts: [think] },
      { type: 'text-chunks', texts: ['正文 ' + s] }
    ], message: { content: [
      { type: 'reasoning', text: think },
      { type: 'text', text: '正文 ' + s }
    ] } })
    const args = JSON.stringify({ file_path: 'C:/p/f' + s + '.ets', note: '汉'.repeat(300) })
    push('tool/call', { turn, step: s, name: 'read', arguments: args })
    const res = '结果 ' + s + '：' + '汉'.repeat(LONG) + (turn === 1 && s === 1 ? TAIL_MARK : '')
    push('tool/result', { turn, step: s, message: { content: [{ type: 'text', text: res }] } })
  }
  push('turn/end', { turn })
  return evs
}

function makeEvents(turns) {
  const out = []
  for (let i = 1; i <= turns; i++) out.push(...makeTurn(i))
  return out
}

const EVENTS = makeEvents(32)

let seqNo = 0
async function detailWith(payload, env) {
  const saved = {}
  for (const k of Object.keys(env || {})) { saved[k] = process.env[k]; process.env[k] = String(env[k]) }
  try {
    const asOfSeq = EVENTS.reduce((m, e) => Math.max(m, e.seq), 0)
    let cmdFetch = null
    const conn = { fetch: { register: (r) => { if (r.path === '/api/dsh-console/cmd') cmdFetch = r.fetch; return () => {} } } }
    const ctl = {
      projections: async () => ({ asOfSeq, values: { title: 't', turnOutline: [] } }),
      page: async (req) => ({ records: paginate(EVENTS, Number((req && req.maxMessages) || 3200)).map((e) => ({ type: 'event', event: e })) }),
      list: async () => ({ items: [] })
    }
    const ctx = { get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : null), on: () => () => {}, effect: () => () => {} }
    const mod = await import('../index.js?t=' + (++seqNo) + '-' + Math.random())
    mod.apply(ctx, { port: 0 })
    assert.ok(cmdFetch, 'cmd 路由没注册上')
    const r = await cmdFetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ op: 'detail', payload }) }))
    const txt = await r.text()
    return { bytes: Buffer.byteLength(txt), text: txt, detail: (JSON.parse(txt).result) || {} }
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }
}

let CACHE = null
async function both() {
  if (CACHE) return CACHE
  const lan = await detailWith({ sessionId: 's' })
  const wan = await detailWith({ sessionId: 's', __wan: true })
  CACHE = { lan, wan }
  return CACHE
}

test('① 同一份大会话：LAN 全量明显大于 WAN，且按单行打印 LAN_BYTES/WAN_BYTES', async () => {
  const { lan, wan } = await both()

  console.log('LAN_BYTES=' + lan.bytes + ' WAN_BYTES=' + wan.bytes)
  assert.ok(lan.bytes > wan.bytes, 'LAN(' + lan.bytes + ') 应大于 WAN(' + wan.bytes + ')')
  assert.ok(lan.bytes > wan.bytes * 2,
    'LAN 全量应明显大于 WAN 截断档：LAN=' + lan.bytes + ' WAN=' + wan.bytes + ' 比值=' + (lan.bytes / wan.bytes).toFixed(2))
  assert.equal(wan.detail.truncated, false, 'WAN 档自身不标 truncated')
  assert.equal(lan.detail.truncated, false, 'LAN 未超 64MB 体积闸 ⇒ 不标 truncated')
})

test('② LAN 能找回 WAN 砍掉的原文（长结果末尾的暗号）', async () => {
  const { lan, wan } = await both()
  assert.ok(lan.text.indexOf(TAIL_MARK) >= 0, 'LAN 全量里必须能找到被截掉的长尾原文')
  assert.ok(wan.text.indexOf(TAIL_MARK) < 0, 'WAN 截断后不该出现这段原文（否则说明公网口径没截）')
  assert.ok(wan.text.indexOf('已截断') >= 0, 'WAN 必须有「已截断」标记（不许静默丢）')
})

test('③ LAN 的历史工具卡不做 OLD_TOOL_BUDGET 瘦身（全量 detail/result、六张卡齐）', async () => {
  const { lan } = await both()
  assert.ok(lan.detail.turns.length >= 30, 'LAN 轮数应 ≥ 30，实际 ' + lan.detail.turns.length)
  const firstTurn = lan.detail.turns.find((t) => t.turn === 1)
  assert.ok(firstTurn, '找不到第 1 轮')
  assert.equal((firstTurn.tools || []).length, STEPS, 'LAN 第 1 轮工具卡数应完整为 ' + STEPS)
  const t1 = firstTurn.tools[0]
  assert.ok(String(t1.result).length >= LONG, 'LAN 旧轮工具结果应为全文（≥' + LONG + ' 字），实际 ' + String(t1.result).length)
  assert.ok(String(t1.result).indexOf(TAIL_MARK) >= 0, 'LAN 旧轮结果应含长尾原文')
  assert.ok(String(t1.result).indexOf('已截断') < 0, 'LAN 结果不该有截断标记')
  assert.ok(String(t1.detail).indexOf('已截断') < 0, 'LAN 参数不该有截断标记')
})

test('④ trace 默认下发空数组；DSH_CONSOLE_DETAIL_TRACE=1 时恢复旧行为（LAN 条数多于 WAN）', async () => {

  const { lan, wan } = await both()
  assert.equal((lan.detail.trace || []).length, 0, 'LAN 默认口径 trace 应下发空数组')
  assert.equal((wan.detail.trace || []).length, 0, 'WAN 默认口径 trace 应下发空数组')

  const on = { DSH_CONSOLE_DETAIL_TRACE: 1 }
  const lanOn = await detailWith({ sessionId: 's' }, on)
  const wanOn = await detailWith({ sessionId: 's', __wan: true }, on)
  const lt = (lanOn.detail.trace || []).length
  const wt = (wanOn.detail.trace || []).length
  assert.ok(lt > 0, 'DSH_CONSOLE_DETAIL_TRACE=1 时 LAN trace 不该为空')
  assert.ok(lt > wt, 'DSH_CONSOLE_DETAIL_TRACE=1 时 LAN 条数应多于 WAN：LAN=' + lt + ' WAN=' + wt)
})

test('⑤ 不带 meta 与 __wan:false 都等效 LAN（默认就是局域网全量）', async () => {
  const { lan } = await both()
  const explicitLan = await detailWith({ sessionId: 's', __wan: false })
  assert.equal(explicitLan.bytes, lan.bytes, '__wan:false 应与不带 meta 完全一致')
  const firstTurn = explicitLan.detail.turns.find((t) => t.turn === 1)
  assert.ok(String(firstTurn.tools[0].result).indexOf(TAIL_MARK) >= 0, '__wan:false 应保留全文')
})

test('⑥ 体积闸：DSH_CONSOLE_DETAIL_MAX_BYTES 卡住 LAN 时整体退回 WAN 口径 + 明写原因', async () => {
  const gate = 200 * 1024
  const r = await detailWith({ sessionId: 's' }, { DSH_CONSOLE_DETAIL_MAX_BYTES: gate })
  assert.equal(r.detail.truncated, true, '超体积闸必须标 truncated:true')
  assert.ok(typeof r.detail.truncatedReason === 'string' && r.detail.truncatedReason.length > 0, '必须带 truncatedReason')
  assert.ok(r.detail.truncatedReason.indexOf('DSH_CONSOLE_DETAIL_MAX_BYTES') >= 0, '原因里点明是哪个环境变量：' + r.detail.truncatedReason)
  assert.ok(r.detail.truncatedReason.indexOf(String(gate)) >= 0, '原因里带上限数字：' + r.detail.truncatedReason)
  assert.ok(Number(r.detail.lanBytes) > gate, 'lanBytes 应记录真实全量字节数：' + r.detail.lanBytes)
  assert.equal(Number(r.detail.detailMaxBytes), gate, 'detailMaxBytes = 生效上限')

  assert.ok(r.bytes < Number(r.detail.lanBytes), '退回后体积应小于全量：' + r.bytes + ' vs ' + r.detail.lanBytes)
  assert.ok(Number(r.detail.lanBytes) > r.bytes * 2, '全量应明显大于退回结果：' + r.detail.lanBytes + ' vs ' + r.bytes)
})

test('⑦ WAN 档也认 payload.__wan:true 的「只收紧」语义（不会被放宽）', async () => {
  const wan = await detailWith({ sessionId: 's', __wan: true })

  const firstTurn = wan.detail.turns.find((t) => t.turn === 1)
  const r0 = String((firstTurn.tools || [])[0] && firstTurn.tools[0].result || '')
  assert.ok(r0.length < LONG, 'WAN 旧轮结果应被瘦身，实际长度 ' + r0.length)
})
