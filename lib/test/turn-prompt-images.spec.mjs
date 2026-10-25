import test from 'node:test'
import assert from 'node:assert/strict'

const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const REF_A = { attachmentId: 'sha256:' + HEX_A, mediaType: 'image/png', bytes: 111, width: 4, height: 4, name: 'one.png' }
const REF_B = { attachmentId: 'sha256:' + HEX_B, mediaType: 'image/jpeg', bytes: 222, width: 8, height: 8, name: 'two.jpg' }

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
    method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: 's-pi' } })
  }))
  return (await r.json()).result || {}
}

const FROZEN_A = { id: 'sha256:' + HEX_A, name: 'one.png', mime: 'image/png', bytes: 111 }

function twoPrompts() {
  return [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { turn: 1, content: [
      { type: 'text', text: '看这张图' },
      { type: 'image', attachment: REF_A }
    ] } },
    { type: 'user/message', seq: 3, time: 3, data: { turn: 1, content: [
      { type: 'text', text: '这条是纯文字' }
    ] } },
    { type: 'assistant/message', seq: 4, time: 4, data: { turn: 1, step: 1, message: { content: [
      { type: 'text', text: '收到' }
    ] } } },
    { type: 'turn/end', seq: 5, time: 5, data: { turn: 1 } }
  ]
}
const OUTLINE_ONE = [{ turn: 1, seq: 2, prompt: '看这张图', response: '收到' }]

test('① 同一轮两条提问：pimgs 与 prompts 同序同长，纯文字那条不带图', async () => {
  const d = await detailOf(twoPrompts(), OUTLINE_ONE)
  assert.equal(d.full, true, '走的应是全文（page）通道')
  const t = d.turns[0]
  assert.ok(t, '折出了这一轮')
  assert.equal(t.prompts.length, 2, '两条提问 = 两个 prompts')
  assert.equal(t.pimgs.length, 2, 'pimgs 与 prompts 同长')
  assert.equal(t.pimgs[0].length, 1, '第一条提问的图')
  assert.deepEqual(t.pimgs[0][0], FROZEN_A, 'pimgs 与 images 同一冻结形状')
  assert.equal(t.pimgs[1].length, 0, '第二条纯文字提问 ⇒ 空数组（不再顶上一张图）')
  assert.equal(t.images.length, 1, '轮级 images 保留、内容不变')
})

test('② prompts.length === pimgs.length 恒成立（含没图 / 单条 / 双图轮）', async () => {
  const cases = [
    { name: '无图两条', want: 2, events: [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 2, data: { turn: 1, content: [{ type: 'text', text: 'a' }] } },
      { type: 'user/message', seq: 3, time: 3, data: { turn: 1, content: [{ type: 'text', text: 'b' }] } },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 1 } }
    ] },
    { name: '单条无图', want: 1, events: [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 2, data: { turn: 1, content: [{ type: 'text', text: 'a' }] } },
      { type: 'turn/end', seq: 3, time: 3, data: { turn: 1 } }
    ] },
    { name: '两条各带一张图（顺序不能串）', want: 2, events: [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 2, data: { turn: 1, content: [
        { type: 'text', text: 'a' }, { type: 'image', attachment: REF_A }] } },
      { type: 'user/message', seq: 3, time: 3, data: { turn: 1, content: [
        { type: 'text', text: 'b' }, { type: 'image', attachment: REF_B }] } },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 1 } }
    ] }
  ]
  for (const c of cases) {
    const d = await detailOf(c.events, [{ turn: 1, seq: 1, prompt: 'x', response: 'y' }])
    const t = d.turns[0]
    assert.ok(t, c.name + '：这一轮在')
    assert.ok(Array.isArray(t.pimgs), c.name + '：pimgs 是数组')
    assert.equal(t.pimgs.length, t.prompts.length, c.name + '：长度不变式被破坏')
    assert.equal(t.prompts.length, c.want, c.name + '：提问条数')
    if (c.name.indexOf('各带一张') >= 0) {
      assert.equal(t.pimgs[0].length, 1, '第一条提问第一张图')
      assert.equal(t.pimgs[1].length, 1, '第二条提问第二张图')
      assert.equal(t.pimgs[1][0].id, 'sha256:' + HEX_B, '第二条不能顶成第一条的图（下标串位）')
    } else {
      for (const arr of t.pimgs) assert.deepEqual(arr, [], c.name + '：没图就是空数组')
    }
  }
})

test('③ 图片只在 user/message 上：助手图不进 pimgs', async () => {
  const d = await detailOf([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { turn: 1, content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: REF_A }] } },
    { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { content: [
      { type: 'text', text: '回你一张' }, { type: 'image', attachment: REF_B }] } } },
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 1 } }
  ], OUTLINE_ONE)
  const t = d.turns[0]
  assert.equal(t.pimgs.length, 1, '只有一条用户提问')
  assert.equal(t.pimgs[0].length, 1, '只算用户那张')
  assert.equal(t.pimgs[0][0].id, 'sha256:' + HEX_A, '不许混进助手图')
  assert.equal(t.aimages.length, 1, '助手图照旧走 aimages')
  assert.equal(t.aimages[0].id, 'sha256:' + HEX_B)
})

test('④ 概要投影通道给 pimgs: [] 占位（键一定在，长度不变式仍成立）', async () => {
  const d = await detailOf([], [{ turn: 1, seq: 2, prompt: '看这张图', response: '收到' }])
  const t = d.turns[0]
  assert.ok(t, '投影轮照常下发')
  assert.ok(Array.isArray(t.pimgs), 'pimgs 是数组（键一定在）')
  assert.ok('pimgs' in t, 'pimgs 键必须存在 —— 客户端按下标取也不会 undefined')
  assert.equal(t.pimgs.length, 0, '投影通道给空占位（数组空，键在）')

  assert.equal(t.prompt, '看这张图', '轮级 prompt 照旧单条')
})

test('⑤ 只有图的提问轮（text 为空）也记进 pimgs', async () => {
  const d = await detailOf([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { turn: 1, content: [{ type: 'image', attachment: REF_A }] } },
    { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '看到了' }] } } },
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 1 } }
  ], OUTLINE_ONE)
  const t = d.turns[0]
  assert.ok(t, '只有图的提问不能整轮被丢掉')
  assert.equal(t.prompts.length, 1)
  assert.equal(t.pimgs.length, 1, '长度仍与 prompts 对齐')
  assert.equal(t.pimgs[0].length, 1)
  assert.equal(t.pimgs[0][0].id, 'sha256:' + HEX_A)
  assert.equal(t.images.length, 1, '轮级 images 照旧')
})

test('⑥ 轮级 images 内容不变（老客户端/助手卡/live 的回归网）', async () => {
  const d = await detailOf(twoPrompts(), OUTLINE_ONE)
  const t = d.turns[0]
  assert.equal(t.images.length, 1)
  assert.deepEqual(t.images[0], FROZEN_A, 'images 冻结形状与顺序不变')
  assert.ok(JSON.stringify(t.images).indexOf('objects') < 0, '形状里没有磁盘路径')
})
