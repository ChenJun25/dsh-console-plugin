import test from 'node:test'
import assert from 'node:assert/strict'

const ACP6 = '<acp tokens="86" type="text">m01440</acp>'
const ACP7 = '<acp tokens="836" type="text">m01619</acp>'

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

test('① 概要投影分支：prompt/response 里的 <acp> 被剥净', async () => {
  const d = await detailOf({ turnOutline: [
    { turn: 6, seq: 4195, prompt: '问题六', response: ACP6 + ' Root cause is emerging. 正文六' },
    { turn: 7, seq: 4387, prompt: ACP6 + '问题七', response: ACP7 + ' 两项任务都已收工，正文七' },
  ] })
  assert.equal(d.turns.length, 2, '两轮都在（不能被空 prompt 过滤掉）')
  assert.equal(d.turns[0].response, ' Root cause is emerging. 正文六', 'turn6 response 没剥净')
  assert.equal(d.turns[1].response, ' 两项任务都已收工，正文七', 'turn7 response 没剥净')
  assert.equal(d.turns[1].prompt, '问题七', 'prompt 没剥净')
  assert.ok(!JSON.stringify(d.turns).includes('<acp'), '结果里还残留 <acp')
})

test('② 全文分支终态清洗：手工塞进 fold 结果的 <acp> 也被剥净', async () => {

  const events = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { turn: 1, content: [{ type: 'text', text: ACP6 + '提问' }] } },
    { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { content: [
      { type: 'reasoning', text: ACP7 + '思考' },
      { type: 'text', text: ACP6 + '回复' }
    ] } } },
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 1 } },
  ]
  const d = await detailOf({ events, turnOutline: [] })
  assert.equal(d.full, true, '应该走全文分支')
  const t = d.turns[0]
  assert.equal(t.prompt, '提问')
  assert.equal(t.response, '回复')

  assert.equal((t.thinks || [])[0], '思考')
  assert.equal(t.think, undefined, 'thinks[] 非空时 t.think 应被删掉')
  assert.ok(t.prompts.every((x) => !x.includes('<acp')), 'prompts[] 还有残留')
  assert.ok((t.thinks || []).every((x) => !x.includes('<acp')), 'thinks[] 还有残留')
})

test('③ 无 <acp> 时逐字不变（幂等、不误伤普通尖括号文本）', async () => {
  const plain = [
    { turn: 1, seq: 1, prompt: '正常提问', response: '正常回复' },
  ]
  const d = await detailOf({ turnOutline: plain })
  assert.equal(d.turns[0].prompt, '正常提问')
  assert.equal(d.turns[0].response, '正常回复')

  const tricky = '<div>a<b 1<2</div> 以及 <acpx>keep</acpx> 和 1 < 2'
  const d2 = await detailOf({ turnOutline: [{ turn: 1, seq: 1, prompt: tricky, response: tricky }] })
  assert.equal(d2.turns[0].prompt, tricky, '普通尖括号文本被误伤')
  assert.equal(d2.turns[0].response, tricky, '普通尖括号文本被误伤')
})

test('④ 未配对的 <acp> 不吞正文（跨块切开时不误吞）', async () => {

  const straddle = '前半 <acp tokens="7" type="text">m00181 后半正文（没有闭合标签）'
  const d = await detailOf({ turnOutline: [{ turn: 1, seq: 1, prompt: 'q', response: straddle }] })
  assert.equal(d.turns[0].response, straddle, '未配对的 <acp> 被吞了正文')

  const paired = '前 <acp tokens="7" type="text">m00181</acp> 后'
  const d2 = await detailOf({ turnOutline: [{ turn: 1, seq: 1, prompt: 'q', response: paired }] })
  assert.equal(d2.turns[0].response, '前  后')
})

test('⑤ 冻结行为不回退：turn/seq/time/images 等结构字段不受清洗影响', async () => {
  const d = await detailOf({ turnOutline: [
    { turn: 9, seq: 777, prompt: ACP6 + 'q', response: ACP7 + 'r' },
  ] })
  const t = d.turns[0]
  assert.equal(t.turn, 9)
  assert.equal(t.seq, 777)
  assert.deepEqual(t.images, [], '概要分支仍有 images 占位')
  assert.equal(d.asOfSeq, 100)
})
