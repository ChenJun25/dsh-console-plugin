/**
 * task-22 单测（端到端半边）：apply() + 假 ctx 把 readDetail 的 images 拉出来看形状。
 *
 * 用 test-selectmodel.mjs 同款的「从 apply() 里截胡 cmd 路由」手法，
 * mock sessionController.page 回一段带 image 块的 history 事件流。
 * 跑法：node lib/test/detail-images.spec.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const REF_A = { attachmentId: 'sha256:' + HEX_A, mediaType: 'image/png', bytes: 111, width: 4, height: 4, name: 'one.png' }
const REF_B = { attachmentId: 'sha256:' + HEX_B, mediaType: 'image/jpeg', bytes: 222, width: 8, height: 8 }

/** 宿主 page() 的回包：1 轮（用户带图提问 → 助手回文 + 回图）。 */
function mockCtl() {
  const events = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { turn: 1, content: [
      { type: 'text', text: '看这张图' },
      { type: 'image', attachment: REF_A }
    ] } },
    { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { content: [
      { type: 'text', text: '收到' },
      { type: 'image', attachment: REF_B }
    ] } } },
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 1 } }
  ]
  return {
    projections: async () => ({ asOfSeq: 4, values: { title: 't', turnOutline: [
      { turn: 1, seq: 2, prompt: '看这张图', response: '收到' }
    ] } }),
    page: async () => ({ records: events.map((e) => ({ type: 'event', event: e })) }),
    list: async () => ({ items: [] }),
    modelCatalog: async () => ({})
  }
}

function mockCtx(ctl, attachments) {
  const routes = {}
  const conn = { fetch: { register: (route) => { routes[route.path] = route; return () => {} } } }
  const handlers = {}
  const ctx = {
    get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : n === 'attachments' ? attachments : null),
    on: (evt, fn) => { handlers[evt] = fn; return () => {} },
    effect: () => () => {}
  }
  return { ctx, routes, handlers }
}

async function detailOf(payload, attachments) {
  const ctl = mockCtl()
  const { ctx, routes } = mockCtx(ctl, attachments)
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  assert.ok(routes['/api/dsh-console/cmd'], 'cmd 路由没注册上')
  const r = await routes['/api/dsh-console/cmd'].fetch(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ op: 'detail', payload })
  }))
  return r.json()
}

test('turn.images 形状是冻结的 {id,name,mime,bytes}（顺序 = 块出现顺序）', async () => {
  const j = await detailOf({ sessionId: 's-1' })
  assert.equal(j.ok, true)
  assert.equal(j.result.full, true, '走的是全文（page）通道')
  const t = j.result.turns[0]
  assert.ok(Array.isArray(t.images), 'turn.images 存在')
  assert.equal(t.images.length, 2, '两张图都登记了')
  assert.deepEqual(Object.keys(t.images[0]).sort(), ['bytes', 'id', 'mime', 'name'])
  assert.deepEqual(t.images[0], { id: 'sha256:' + HEX_A, name: 'one.png', mime: 'image/png', bytes: 111 })
  assert.deepEqual(t.images[1], { id: 'sha256:' + HEX_B, name: '', mime: 'image/jpeg', bytes: 222 })
  assert.ok(JSON.stringify(t.images).indexOf('objects') < 0, '形状里没有磁盘路径')
})

test('contentText 行为没回退：正文仍然只有 text 块', async () => {
  const j = await detailOf({ sessionId: 's-1' })
  const t = j.result.turns[0]
  assert.equal(t.prompt, '看这张图')
  assert.equal(t.response, '收到')
  assert.ok(t.prompt.indexOf('sha256') < 0, '正文里不会混进 id')
})

test('live.images 同形状（生成中的图，走 session/event 总线真路径）', async () => {
  const ctl = mockCtl()
  const { ctx, routes, handlers } = mockCtx(ctl, null)
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  assert.ok(typeof handlers['session/event'] === 'function', '事件总线挂上了')
  const sess = { id: 's-1' }
  // 一轮开始 → 宿主落一条带图 + 正文的 assistant/message（生成中）
  handlers['session/event'](sess, { type: 'turn/start', seq: 1, time: 1, data: {} })
  handlers['session/event'](sess, { type: 'assistant/message', seq: 2, time: 2, data: {
    turn: 1, step: 1,
    stream: [{ type: 'text-chunks', texts: ['看这张'] }],
    message: { content: [{ type: 'text', text: '看这张' }, { type: 'image', attachment: REF_A }] }
  } })
  const r = await routes['/api/dsh-console/cmd'].fetch(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: 's-1' } })
  }))
  const j = await r.json()
  assert.ok(j.result.live, '有 live 块')
  assert.ok(Array.isArray(j.result.live.images), 'live.images 存在')
  assert.deepEqual(j.result.live.images, [{ id: 'sha256:' + HEX_A, name: 'one.png', mime: 'image/png', bytes: 111 }])
  assert.deepEqual(Object.keys(j.result.live.images[0]).sort(), ['bytes', 'id', 'mime', 'name'],
    'live.images 与 turn.images 同一个冻结形状')
})

test('没有 attachments 服务也不崩：元数据照给，字节留给路由层 404', async () => {
  const j = await detailOf({ sessionId: 's-1' }, null)
  assert.equal(j.ok, true)
  // 元数据只依赖事件里的 ref，不依赖 ctx.get('attachments')；
  // 真正需要宿主的只有读字节那一步（attachmentOf → readImageOf → null → 404）。
  assert.equal(j.result.turns[0].images.length, 2, '元数据照常下发（形状不回退）')
  assert.deepEqual(Object.keys(j.result.turns[0].images[0]).sort(), ['bytes', 'id', 'mime', 'name'])
})
