import test from 'node:test'
import assert from 'node:assert/strict'

const T0 = 1791731571562

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

function mockCtl(events, outline) {
  return {
    projections: async () => ({ asOfSeq: 99, values: { title: 't', turnOutline: outline || [] } }),
    page: async () => ({ records: events.map((e) => ({ type: 'event', event: e })) }),
    list: async () => ({ items: [] })
  }
}

async function detailOf(events, outline) {
  const { ctx, routes } = mockCtx(mockCtl(events, outline))
  const mod = await import('../index.js?t=' + Math.random())
  mod.apply(ctx, { port: 0 })
  const r = await routes['/api/dsh-console/cmd'].fetch(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: 's-mt' } })
  }))
  return (await r.json()).result || {}
}

function turnEvents(reason, endMs) {
  return [
    { type: 'turn/start', seq: 1, time: T0, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: T0 + 4000, data: { turn: 1, content: [{ type: 'text', text: '跑一下' }] } },
    { type: 'assistant/message', seq: 3, time: T0 + 60000, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '好了' }] } } },
    { type: 'turn/end', seq: 4, time: endMs, data: Object.assign({ turn: 1 }, reason ? { reason } : {}) }
  ]
}

test('① reason.kind = "max-tokens" ⇒ turns[0].maxTokens === true', async () => {
  const d = await detailOf(turnEvents({ kind: 'max-tokens' }, T0 + 90000), [{ turn: 1, seq: 2, prompt: '跑一下', response: '好了' }])
  assert.equal(d.full, true, '走的应是全文（page）通道')
  const t = d.turns[0]
  assert.ok(t, '折出了这一轮')
  assert.equal(t.maxTokens, true, '撞了输出上限但插件续了轮 ⇒ maxTokens 必须为 true')
  assert.equal(t.endedMs, T0 + 90000, 'endedMs = turn/end 的毫秒戳')
})

test('② reason.kind = "error" ⇒ 不置 true，failure 照旧', async () => {
  const d = await detailOf(turnEvents({ kind: 'error', error: { code: 'x', message: '炸了' } }, T0 + 91000), [{ turn: 1, seq: 2, prompt: '跑一下', response: '好了' }])
  const t = d.turns[0]
  assert.ok(t, '失败轮仍然在（有正文）')
  assert.notEqual(t.maxTokens, true, 'error 不是 max-tokens，不许置 true')
  assert.equal(t.maxTokens, false, '未被命中时保持懒建时的 false')
  assert.ok(t.failure && typeof t.failure === 'object', 'failure 照旧存在（本轮真失败）')
  assert.notEqual(t.failure.ok, true, 'fatal 失败不许被标成 ok')
  assert.equal(t.endedMs, T0 + 91000, '失败轮也有结束时间')
})

test('③ 其它 kind（completed / blocked / interrupted）不置 true，endedMs 恒为数字', async () => {
  for (const kind of ['completed', 'blocked', 'interrupted']) {
    const d = await detailOf(turnEvents({ kind }, T0 + 100000), [{ turn: 1, seq: 2, prompt: '跑一下', response: '好了' }])
    const t = d.turns[0]
    assert.equal(t.maxTokens, false, kind + ' 不该置 true')
    assert.equal(typeof t.endedMs, 'number', kind + ' 的 endedMs 必须是数字')
    assert.equal(t.endedMs, T0 + 100000, kind + ' 的 endedMs = turn/end 的毫秒戳')
  }
})

test('④ 宿主没给 reason（undefined）时两个字段仍是稳定形状', async () => {
  const d = await detailOf(turnEvents(null, T0 + 101000), [{ turn: 1, seq: 2, prompt: '跑一下', response: '好了' }])
  const t = d.turns[0]
  assert.equal(t.maxTokens, false, '没 reason ⇒ false（不是 undefined）')
  assert.equal(typeof t.endedMs, 'number', 'endedMs 必须是数字')
  assert.equal(t.endedMs, T0 + 101000)
})

test('⑤ 没走到 turn/end 的轮：endedMs 保持 0，maxTokens 保持 false', async () => {
  const events = [
    { type: 'turn/start', seq: 1, time: T0, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: T0 + 4000, data: { turn: 1, content: [{ type: 'text', text: '跑一下' }] } }
  ]
  const d = await detailOf(events, [{ turn: 1, seq: 2, prompt: '跑一下', response: '' }])
  const t = d.turns[0]
  assert.ok(t, '这一轮在')
  assert.equal(t.endedMs, 0, '没 turn/end ⇒ 0（App 不会当成 1970 年算用时）')
  assert.equal(t.maxTokens, false)
})

test('⑥ 概要投影通道给稳定占位：endedMs 0 / maxTokens false（键一定在）', async () => {
  const d = await detailOf([], [{ turn: 1, seq: 2, prompt: '跑一下', response: '好了' }])
  const t = d.turns[0]
  assert.ok(t, '投影轮照常下发')
  assert.equal(t.endedMs, 0, 'turnOutline 没有结束时间 ⇒ 0 占位')
  assert.equal(t.maxTokens, false, 'turnOutline 没有 reason ⇒ false 占位')
  assert.ok('endedMs' in t && 'maxTokens' in t, '两个键必须都存在（稳定形状）')
})
