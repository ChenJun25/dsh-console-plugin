import test from 'node:test'
import assert from 'node:assert/strict'
import { stripAcp } from '../mp-contract.mjs'

const MSG = '429: {"message":"workbuddy upstream soft_rate (http 429): 您的使用量已超出频率限制，将在 2026-10-08 21:25:09 UTC+8 重置，您也可以切换其他模型继续使用。","type":"soft_rate","code":"soft_rate"}'

const BAR = '｜'
const ACP_RESIDUAL =
  '<acp tokens="20" string="true">m04778</acp>' + '\n' +
  '<acp tokens="5" string="true">m04776' + BAR + BAR + 'DSML' + BAR + BAR + ' parameter>' + '\n' +
  '</' + BAR + BAR + 'DSML' + BAR + BAR + ' invoke>' + '\n' +
  '</' + BAR + BAR + 'DSML' + BAR + BAR + ' calls>'

function retryEvent(seq, retry) {
  return {
    type: 'llm/retry', seq, time: 1791399244148 + retry,
    data: {
      retryId: '2619b74f-37d2-4ee5-94e6-a2c58ed313f6', turn: 3, step: 167,
      provider: 'workbuddy', mode: 'normal',
      policyKey: '["normal",5,["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],500,10000,0.1]',
      retry, maxRetries: 5, delayMs: 505.3201068142593,
      failure: { message: MSG, code: 'RATE_LIMIT' }
    }
  }
}

const ATTEMPT_ERR = {
  type: 'assistant/attempt', seq: 2244, time: 1791399244148,
  data: {
    turn: 3, step: 167,
    stream: [
      { type: 'chunk', time: 1791399244148, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } },
      { type: 'chunk', time: 1791399244148, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: MSG, code: 'RATE_LIMIT' } } } }
    ]
  }
}

const TURN_END_ERR = {
  type: 'turn/end', seq: 2261, time: 1791399262806,
  data: { turn: 3, reason: { kind: 'error', error: { message: MSG, code: 'RATE_LIMIT' } } }
}

async function detailOf(opts) {
  const o = opts || {}
  const asOfSeq = o.asOfSeq === undefined ? 100 : o.asOfSeq
  let cmdFetch = null
  const conn = { fetch: { register: (r) => { if (r.path === '/api/dsh-console/cmd') cmdFetch = r.fetch; return () => {} } } }
  const ctl = {
    projections: async () => ({ asOfSeq, values: { title: 't', turnOutline: o.turnOutline || [] } }),
    list: async () => ({ items: [] })
  }
  if (o.events) ctl.page = async () => ({ records: o.events.map((e) => ({ type: 'event', event: e })) })
  const ctx = { get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : null), on: () => () => {}, effect: () => () => {} }
  const mod = await import('../index.js?t=' + Math.random())
  mod.apply(ctx, { port: 0 })
  const r = await cmdFetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: 's' } }) }))
  return (await r.json()).result || {}
}

function turnEvents(failureEvents) {
  const evs = [
    { type: 'turn/start', seq: 1, time: 1791399000000, data: { turn: 3 } },
    { type: 'user/message', seq: 2, time: 1791399000001, data: { turn: 3, content: [{ type: 'text', text: '继续' }] } }
  ]
  return evs.concat(failureEvents || [])
}

test('failure 1a 整轮失败：llm/retry x5 + assistant/attempt error + turn/end error ⇒ fatal 全字段', async () => {
  const retries = [1, 2, 3, 4, 5].map((n, i) => retryEvent(2245 + i * 3, n))
  const evs = turnEvents(retries.concat([ATTEMPT_ERR, TURN_END_ERR]))
  const d = await detailOf({ events: evs, turnOutline: [] })
  assert.equal(d.full, true, '应该走全文分支')
  const t = d.turns.find((x) => x.turn === 3)
  assert.ok(t, 'turn 3 应该存在')
  const f = t.failure
  assert.ok(f, 'turn 3 应该带 failure 字段')
  assert.equal(f.ok, false, 'ok 应为 false')
  assert.equal(f.fatal, true, 'fatal 应为 true（turn/end reason=error）')
  assert.equal(f.retrying, false, '终局 retrying 应为 false')
  assert.equal(f.recovered, false, '没恢复')
  assert.equal(f.retry, 5, '重试次数应取最大值 5')
  assert.equal(f.maxRetries, 5, '重试上限 5')
  assert.equal(f.code, 'RATE_LIMIT', '错误码')
  assert.equal(f.type, 'soft_rate', '外层没有 type，应从 message 内嵌 JSON 提取')
  assert.ok(f.message.includes('soft_rate'), '人类可读消息应透传')
  assert.ok(f.message.length <= 300, '消息被 clip 到 FAILURE_MSG_MAX=300')
  assert.match(f.time, /^[0-9]{2}:[0-9]{2}$/, 'time 应为 HH:MM')
})

test('failure 1b 重试后成功：ok=true / recovered=true / fatal=false', async () => {
  const evs = turnEvents([retryEvent(2245, 1), { type: 'turn/end', seq: 2300, time: 1791399300000, data: { turn: 3 } }])
  const d = await detailOf({ events: evs, turnOutline: [] })
  const f = d.turns.find((x) => x.turn === 3).failure
  assert.ok(f, '过程中失败过 ⇒ 仍应保留 failure')
  assert.equal(f.ok, true, '最终成功 ⇒ ok=true')
  assert.equal(f.fatal, false, '不是致命失败')
  assert.equal(f.retrying, false, '不再重试')
  assert.equal(f.recovered, true, '重试后恢复 ⇒ recovered=true')
  assert.equal(f.retry, 1, 'retry 次数保留')
})

test('failure 1c 概要分支不编造 failure —— 失败只在事件流里', async () => {
  const d = await detailOf({ turnOutline: [{ turn: 3, seq: 1, prompt: '继续', response: '普通回复' }] })
  assert.equal(d.full, undefined, '走概要分支')
  assert.equal(d.turns[0].failure, undefined, '概要投影没有 failure，不能凭空造')
})

test('failure 1d 只有 failure、没有正文的轮被删掉（不画空蓝气泡）', async () => {
  const d = await detailOf({ events: [retryEvent(2245, 1)], turnOutline: [] })
  assert.equal(d.turns.length, 0, '空轮应被清理')
})

test('acp 2a 真实残片：未配对尾巴 + 伪 DSML ⇒ 自 <acp 起整段丢弃', () => {
  const out = stripAcp(ACP_RESIDUAL)
  assert.ok(!out.includes('<acp'), '残渣里的 <acp 必须消失')
  assert.ok(!out.includes('DSML'), '伪 DSML 标签必须消失')
  assert.ok(!out.includes('m04776'), '残留引用 id 必须消失')
  assert.equal(out.trim(), '', '残片上没有正文 ⇒ 清洗后只剩空白')
})

test('acp 2b 残片前面有正文 ⇒ 正文逐字保留，只丢残渣', () => {
  const head = 'Now patch AddNode.ets the same way.'
  const out = stripAcp(head + ACP_RESIDUAL)
  assert.ok(out.startsWith(head), '正文必须完整保留')
  assert.ok(!out.includes('<acp'), '残渣必须消失')
  assert.ok(!out.includes('DSML'), '伪 DSML 必须消失')
  assert.equal(out.slice(head.length).trim(), '', '正文之后只允许剩空白')
})

test('acp 2c 幂等：清洗结果再洗一遍完全不变', () => {
  const once = stripAcp(ACP_RESIDUAL)
  assert.equal(stripAcp(once), once, 'stripAcp 必须幂等')
  const withBody = '正文' + ACP_RESIDUAL
  const o1 = stripAcp(withBody)
  assert.equal(stripAcp(o1), o1, '带正文时也要幂等')
})

test('acp 3a straddle：未配对的 <acp> 后跟中文正文 ⇒ 一并保留', () => {
  const straddle = '前半 <acp tokens="7" type="text">m00181 后半正文（没有闭合标签）'
  assert.equal(stripAcp(straddle), straddle, '不能因为没闭合就吞掉正文')
})

test('acp 3b 只有开标签、后面什么都没有 ⇒ 判为残渣丢弃', () => {
  assert.equal(stripAcp('正文<acp tokens="5" string="true">'), '正文')
})

test('acp 3c 配对完整的仍剥掉，前后正文都留', () => {
  const paired = '前 <acp tokens="7" type="text">m00181</acp> 后'
  assert.equal(stripAcp(paired), '前  后')
})

test('acp 4 普通尖括号 / 像 ACP 但不是的文本逐字不变', () => {
  const tricky = '<div>a<b 1<2</div> 以及 <acpx>keep</acpx> 和 1 < 2'
  assert.equal(stripAcp(tricky), tricky, '普通尖括号被误伤')
  assert.equal(stripAcp('没有标记的普通正文'), '没有标记的普通正文')
  assert.equal(stripAcp(''), '', '空串原样返回')
})
