import test from 'node:test'
import assert from 'node:assert/strict'

const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const REF_A = { attachmentId: 'sha256:' + HEX_A, mediaType: 'image/png', bytes: 111, width: 4, height: 4, name: 'one.png' }
const REF_B = { attachmentId: 'sha256:' + HEX_B, mediaType: 'image/jpeg', bytes: 222, width: 8, height: 8 }

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

function mockCtx(ctl, attachments, sessions) {
  const routes = {}
  const conn = { fetch: { register: (route) => { routes[route.path] = route; return () => {} } } }
  const handlers = {}
  const ctx = {
    get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : n === 'attachments' ? attachments : n === 'sessions' ? sessions : null),
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

  assert.equal(t.images.length, 1, '用户图进 images（分家后不再含助手图）')
  assert.equal(t.aimages.length, 1, '助手图进 aimages')
  assert.deepEqual(Object.keys(t.images[0]).sort(), ['bytes', 'id', 'mime', 'name'])
  assert.deepEqual(t.images[0], { id: 'sha256:' + HEX_A, name: 'one.png', mime: 'image/png', bytes: 111 })
  assert.deepEqual(Object.keys(t.aimages[0]).sort(), ['bytes', 'id', 'mime', 'name'])
  assert.deepEqual(t.aimages[0], { id: 'sha256:' + HEX_B, name: '', mime: 'image/jpeg', bytes: 222 })
  assert.ok(JSON.stringify(t.images).indexOf('objects') < 0, '形状里没有磁盘路径')
  assert.ok(JSON.stringify(t.aimages).indexOf('objects') < 0, 'aimages 同样没有磁盘路径')
})

test('contentText 行为没回退：正文仍然只有 text 块', async () => {
  const j = await detailOf({ sessionId: 's-1' })
  const t = j.result.turns[0]
  assert.equal(t.prompt, '看这张图')
  assert.equal(t.response, '收到')
  assert.ok(t.prompt.indexOf('sha256') < 0, '正文里不会混进 id')
})

test('live 图同形状（生成中的助手图 ⇒ live.aimages，走 session/event 总线真路径）', async () => {
  const ctl = mockCtl()
  const { ctx, routes, handlers } = mockCtx(ctl, null)
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  assert.ok(typeof handlers['session/event'] === 'function', '事件总线挂上了')
  const sess = { id: 's-1' }

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

  assert.ok(Array.isArray(j.result.live.images), 'live.images 存在（键一定在）')
  assert.deepEqual(j.result.live.images, [], '用户没发图 ⇒ live.images 空')
  assert.deepEqual(j.result.live.aimages, [{ id: 'sha256:' + HEX_A, name: 'one.png', mime: 'image/png', bytes: 111 }])
  assert.deepEqual(Object.keys(j.result.live.aimages[0]).sort(), ['bytes', 'id', 'mime', 'name'],
    'live.aimages 与 turn.aimages 同一个冻结形状')
})

test('没有 attachments 服务也不崩：元数据照给，字节留给路由层 404', async () => {
  const j = await detailOf({ sessionId: 's-1' }, null)
  assert.equal(j.ok, true)

  assert.equal(j.result.turns[0].images.length, 1, '用户图元数据照常下发（形状不回退）')
  assert.equal(j.result.turns[0].aimages.length, 1, '助手图照常下发（走 aimages）')
  assert.deepEqual(Object.keys(j.result.turns[0].images[0]).sort(), ['bytes', 'id', 'mime', 'name'])
})

function mockCtlEvents(events, outline) {
  return {
    projections: async () => ({ asOfSeq: 99, values: { title: 't', turnOutline: outline } }),
    page: async () => ({ records: events.map((e) => ({ type: 'event', event: e })) }),
    list: async () => ({ items: [] }),
    modelCatalog: async () => ({})
  }
}

async function detailOfEvents(events, outline) {
  const ctl = mockCtlEvents(events, outline)
  const { ctx, routes } = mockCtx(ctl, null)
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  const r = await routes['/api/dsh-console/cmd'].fetch(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: 's-ptc' } })
  }))
  return r.json()
}

const PTC_SHELL = '<path>D:\\dsh-console\\_s132.jpeg</path> <type>image</type> <content> image/jpeg image, 1320x2848 px, 247000 bytes'

test('🩸 ptc-mode 回灌消息的图一律不登记（内部截图不再泄露）', async () => {
  const j = await detailOfEvents([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: {
      turn: 1,
      source: { kind: 'ptc-mode' },
      content: [{ type: 'text', text: PTC_SHELL }, { type: 'image', attachment: REF_A }]
    } },
    { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { content: [
      { type: 'text', text: '三条都改完并装机验证了' }
    ] } } },
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 1 } }
  ], [{ turn: 1, seq: 2, prompt: '', response: '三条都改完并装机验证了' }])
  assert.equal(j.ok, true)
  const t = j.result.turns[0]
  assert.ok(t, '这一轮还在（助手正文照常显示）')
  assert.equal(t.images.length, 0, 'ptc-mode 的图没有被登记')
  assert.equal(t.prompt, '', 'ptc-mode 的附件描述壳没被当成用户提问')
  assert.ok(JSON.stringify(j.result).indexOf(HEX_A) < 0, '整个响应里都没有那张图的 id')
})

test('🩸 对照：kind=user 且带 rpcId 的图（用户真发的）照旧登记', async () => {
  const j = await detailOfEvents([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: {
      turn: 1,
      source: { kind: 'user', rpcId: '2a01c229-889e-4861-bc1c-180f54e6db0d' },
      content: [{ type: 'text', text: '看这张图' }, { type: 'image', attachment: REF_A }]
    } },
    { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { content: [
      { type: 'text', text: '收到' }
    ] } } },
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 1 } }
  ], [{ turn: 1, seq: 2, prompt: '看这张图', response: '收到' }])
  assert.equal(j.ok, true)
  const t = j.result.turns[0]
  assert.equal(t.prompt, '看这张图', '真用户提问照旧')
  assert.equal(t.images.length, 1, '真用户发的图照旧登记')
  assert.equal(t.images[0].id, 'sha256:' + HEX_A)
})

const T0 = 1791731571562

test('🩸 live（事件总线）下发 startedMs = turn/start 的毫秒戳', async () => {
  const ctl = mockCtl()
  const { ctx, routes, handlers } = mockCtx(ctl, null, null)
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  handlers['session/event']({ id: 's-ms' }, { type: 'turn/start', seq: 1, time: T0, data: { turn: 1 } })
  handlers['session/event']({ id: 's-ms' }, { type: 'assistant/message', seq: 2, time: T0 + 3000, data: {
    turn: 1, step: 1,
    stream: [{ type: 'text-chunks', texts: ['在的'] }],
    message: { content: [{ type: 'text', text: '在的' }] }
  } })
  const r = await routes['/api/dsh-console/cmd'].fetch(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: 's-ms' } })
  }))
  const j = await r.json()
  assert.ok(j.result.live, '有 live 块')
  assert.equal(j.result.live.startedMs, T0, 'live.startedMs = 本轮起点毫秒戳（不是进页面那一刻）')
})

test('🩸 liveFromLog（权威日志兜底）也带 startedMs', async () => {
  const events = [
    { type: 'turn/start', seq: 1, time: T0, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: T0 + 5000, data: { turn: 1, content: [{ type: 'text', text: '你好' }] } },
    { type: 'assistant/message', seq: 3, time: T0 + 65000, data: {
      turn: 1, step: 1,
      stream: [{ type: 'text-chunks', texts: ['在的'] }],
      message: { content: [{ type: 'text', text: '在的' }] }
    } }
  ]
  const ctl = mockCtlEvents(events, [{ turn: 1, seq: 2, prompt: '你好', response: '在的' }])
  const sessions = { get: () => ({ log: events }) }
  const { ctx, routes } = mockCtx(ctl, null, sessions)
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  const r = await routes['/api/dsh-console/cmd'].fetch(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: 's-log' } })
  }))
  const j = await r.json()
  assert.ok(j.result.live, '有 live 块（来自 Session.log 窗口）')
  assert.equal(j.result.running, true, '这一轮还在跑')
  assert.equal(j.result.live.startedMs, T0 + 5000, '窗口首条带时间的事件 = 用户提问那条')
})

test('🩸 历史轮 turn.startedMs = 该轮首事件的毫秒戳', async () => {
  const j = await detailOfEvents([
    { type: 'turn/start', seq: 1, time: T0, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: T0 + 4000, data: { turn: 1, source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '跑一下' }] } },
    { type: 'assistant/message', seq: 3, time: T0 + 240000, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '好了' }] } } },
    { type: 'turn/end', seq: 4, time: T0 + 240100, data: { turn: 1 } }
  ], [{ turn: 1, seq: 2, prompt: '跑一下', response: '好了' }])
  const t = j.result.turns[0]
  assert.ok(t, '折出了这一轮')
  assert.equal(t.startedMs, T0 + 4000, '历史轮也带毫秒起点（电脑 4 分钟 / 手机照算 4 分钟）')
})

test('🩸 概况投影（turnOutline）通道 startedMs 缺省为 0，不报错', async () => {
  const j = await detailOfEvents([], [{ turn: 1, seq: 2, prompt: '跑一下', response: '好了' }])
  const t = j.result.turns[0]
  assert.ok(t, '投影轮照常下发')
  assert.equal(t.startedMs, 0, '宿主没给毫秒戳时是 0（App 侧退旧兜底，不会算错）')
})
