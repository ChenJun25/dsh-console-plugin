import assert from 'node:assert/strict'
import { createDispatcher } from '../lib/mp-dispatch.mjs'

let n = 0
const ok = (t) => { n++; console.log('  ok - ' + t) }
const section = (t) => console.log('\n' + t)
const noop = () => {}

function fakeCtl(over = {}) {
  return {
    async list() { return { items: [] } },
    async create(req) { return { sessionId: 'new-1', ...req } },
    async history(req) { return { events: [], maxSeq: 7 } },
    async prompt(req) { return { ok: true, requestId: req.requestId } },
    async cancel() { return { cancelled: true } },
    async attachment() { return { attachmentId: 'a1' } },
    async modelCatalog() { return { items: [{ id: 'm1' }] } },
    async selectModel() { return { ok: true } },
    async commands() { return { items: [{ name: 'clear' }] } },
    ...over,
  }
}

const ctxWith = (ctl, extra = {}) => ({
  get: (name) => (name === 'sessionController' ? ctl : (extra[name] || null)),
})

const noLog = noop

section('信封与白名单')

{
  const d = createDispatcher(ctxWith(fakeCtl()), noLog, null, { pins: new Set() })
  const r = await d('session.models', {}, 'rpc-1')
  assert.equal(r.type, 'server-response')
  assert.equal(r.rpcId, 'rpc-1')
  assert.equal(r.result.ok, true)
  assert.deepEqual(r.result.value, { items: [{ id: 'm1' }] })
  ok('a known method returns a success envelope with rpcId echoed back')
}

{
  const d = createDispatcher(ctxWith(fakeCtl()), noLog, null, { pins: new Set() })
  const r = await d('evil.method', {}, 'rpc-2')
  assert.equal(r.result.ok, false)
  assert.equal(r.result.error.code, 'forbidden')
  ok('a method off the allowlist comes back forbidden, not an exception')
}

{

  const d = createDispatcher(ctxWith({}), noLog, null, { pins: new Set() })
  for (const m of ['session.list', 'session.history', 'session.prompt', 'session.cancel', 'command.list']) {
    const r = await d(m, { sessionId: 's1' }, 'r')
    assert.equal(r.result.ok, false, m)
    assert.ok(['unavailable', 'error'].includes(r.result.error.code), m + ' -> ' + r.result.error.code)
  }
  ok('every method degrades safely when the host lacks it')
}

section('会话投影字段')

{
  const raw = {
    items: [{
      sessionId: 's1',
      title: '标题',
      cwd: 'C:/work',
      updatedAt: 1700,
      running: true,
      projections: { values: { title: '投影标题' } },
      modelSelection: { lastUsed: 'gpt-x' },
    }],
  }
  const d = createDispatcher(ctxWith(fakeCtl({ list: async () => raw })), noLog, null, { pins: new Set() })
  const r = await d('session.list', {}, 'r')
  const s = r.result.value.items[0]

  assert.equal(s.sessionId, 's1')
  assert.equal(s.title, '标题')
  assert.equal(s.updatedAt, 1700)
  assert.equal(s.running, true)
  assert.equal(s.pinned, false)
  assert.equal(s.model, 'gpt-x')
  ok('a session is projected onto the field names the client reads')

  const r2 = await d('session.list', {}, 'r')
  assert.equal(r2.result.value.items.length, 1)
  assert.equal(r2.result.value.hasMore, false)
  ok('one session fits in one page')
}

section('游标分页')

{
  const items = Array.from({ length: 25 }, (_, i) => ({
    sessionId: 's' + i, title: 't' + i, updatedAt: 3000 - i, cwd: 'w',
  }))
  const d = createDispatcher(ctxWith(fakeCtl({ list: async () => ({ items }) })), noLog, null, { pins: new Set() })

  const p1 = (await d('session.list', {}, 'r')).result.value
  assert.equal(p1.items.length, 20, 'page one is the host page size')
  assert.equal(p1.hasMore, true)
  assert.equal(p1.nextCursor, `${items[19].updatedAt}:s19`)
  ok('page one is capped and carries a cursor')

  const p2 = (await d('session.list', { cursor: p1.nextCursor }, 'r')).result.value
  assert.equal(p2.items.length, 5, 'the remainder arrives on page two')
  assert.equal(p2.hasMore, false)
  assert.equal(p2.items[0].sessionId, 's20', 'page two continues where page one stopped')
  ok('the cursor resumes exactly after the last item of page one')

  const seen = new Set([...p1.items, ...p2.items].map((s) => s.sessionId))
  assert.equal(seen.size, 25, 'no session appears on both pages')
  ok('paging never repeats or drops a session')

  const stale = (await d('session.list', { cursor: '0:gone' }, 'r')).result.value
  assert.equal(stale.items.length, 20)
  ok('an unrecognised cursor falls back to page one rather than nothing')
}

section('session.prompt')

{
  let seen = null
  const d = createDispatcher(ctxWith(fakeCtl({ prompt: async (req) => { seen = req; return { ok: true } } })), noLog, null, { pins: new Set() })

  await d('session.prompt', { sessionId: 's1', text: '你好' }, 'rpc-9')
  assert.equal(seen.sessionId, 's1')
  assert.equal(seen.mode, 'queue')
  assert.equal(seen.requestId, 'rpc-9', 'the rpcId is reused as requestId, like the host does')
  assert.deepEqual(seen.content, [{ type: 'text', text: '你好' }])
  ok('a prompt maps onto sessionController.prompt with the host requestId rule')

  const empty = await d('session.prompt', { sessionId: 's1', content: [] }, 'r')
  assert.equal(empty.result.ok, false)
  assert.equal(empty.result.error.code, 'bad-request')
  ok('an empty message is rejected before it reaches the host')

  const noSess = await d('session.prompt', { text: 'hi' }, 'r')
  assert.equal(noSess.result.error.code, 'bad-request')
  ok('a missing sessionId is rejected')
}

{
  let seen = null
  const d = createDispatcher(ctxWith(fakeCtl({ prompt: async (req) => { seen = req; return { ok: true } } })), noLog, null, { pins: new Set() })

  await d('session.prompt', {
    sessionId: 's1',
    content: [
      { type: 'text', text: '看这张' },
      { type: 'image', mediaType: 'image/png', data: 'aGk=', name: 'shot.png' },
    ],
  }, 'rpc-x')
  assert.equal(seen.content.length, 2)
  assert.equal(seen.content[0].type, 'text')
  assert.equal(seen.content[0].text, '看这张')
  assert.equal(seen.content[1].type, 'image')
  assert.equal(seen.content[1].mediaType, 'image/png')
  assert.equal(seen.content[1].name, 'shot.png', 'the name rides along')
  assert.equal(seen.clientTimeZone, Intl.DateTimeFormat().resolvedOptions().timeZone)
  ok('content blocks pass through with mediaType and clientTimeZone intact')

  await d('session.prompt', { sessionId: 's1', content: [{ type: 'image', data: 'aGk=' }] }, 'r')
  assert.equal(seen.content.length, 1, 'an image with no text is still a message')
  assert.equal(seen.content[0].mediaType, 'image/jpeg', 'mediaType defaults rather than staying undefined')
  ok('an image-only message is accepted and gets a default mediaType')

  const blank = await d('session.prompt', { sessionId: 's1', content: [{ type: 'text', text: '' }] }, 'r')
  assert.equal(blank.result.ok, false)
  assert.equal(blank.result.error.code, 'bad-request')
  ok('a message whose only block is empty is refused, not sent blank')

  const junk = await d('session.prompt', { sessionId: 's1', content: [{ type: 'video' }, null, 'x'] }, 'r')
  assert.equal(junk.result.error.code, 'bad-request', 'unknown block types are dropped too')
  ok('unknown block types are dropped rather than forwarded blindly')
}

section('session.history')

{

  const shapes = [
    { events: [{ seq: 1 }] },
    { value: { events: [{ seq: 2 }] } },
    [{ seq: 3 }],
  ]
  for (const shape of shapes) {
    const d = createDispatcher(ctxWith(fakeCtl({ history: async () => shape })), noLog, null, { pins: new Set() })
    const r = await d('session.history', { sessionId: 's1' }, 'r')
    assert.equal(r.result.value.events.length, 1, JSON.stringify(Object.keys(shape)))
    assert.equal(r.result.value.events[0].seq > 0, true)
  }
  ok('all three history shapes are unwrapped, so an old host still renders')
}

{
  let seen = null
  const d = createDispatcher(ctxWith(fakeCtl({ history: async (req) => { seen = req; return { events: [] } } })), noLog, null, { pins: new Set() })
  await d('session.history', { sessionId: 's1', maxMessages: 20 }, 'r')
  assert.equal(seen.limit, 20, 'maxMessages becomes the request limit')
  ok('maxMessages is honoured, not ignored')
}

section('mobile.respond')

{
  const calls = []
  const tracker = {
    snapshot: () => ({ approvals: [{ approvalId: 'a1' }], questions: [] }),
    resolveApproval: (b) => { calls.push(b); return { resolved: true } },
    resolveQuestion: (b) => { calls.push(b); return { resolved: true } },
  }
  const d = createDispatcher(ctxWith(fakeCtl()), noLog, tracker, { pins: new Set() })

  const snap = await d('mobile.pending', { sessionId: 's1' }, 'r')
  assert.equal(snap.result.value.approvals[0].approvalId, 'a1')
  ok('the pending snapshot reaches the client')

  const r = await d('mobile.respond', { sessionId: 's1', type: 'approval', approvalId: 'a1', outcome: 'allow' }, 'r')
  assert.equal(r.result.ok, true)
  assert.equal(calls[0].approvalId, 'a1')
  assert.equal(calls[0].outcome, 'allow')
  ok('an approval reply is forwarded flat, which is what the host parses')

  await d('mobile.respond', { sessionId: 's1', type: 'question', rpcId: 'q1', answers: [{ id: 'a', selected: ['x'] }] }, 'r')
  assert.equal(calls[1].type, 'question')
  assert.equal(calls[1].answers[0].selected[0], 'x')
  ok('a question reply is forwarded flat too')

  const bad = await d('mobile.respond', { sessionId: 's1', type: 'nonsense' }, 'r')
  assert.equal(bad.result.error.code, 'bad-request')
  assert.equal(bad.result.error.message, 'unknown respond type')
  ok('an unknown respond type is refused with the host wording')

  const noId = await d('mobile.respond', { sessionId: 's1', type: 'approval' }, 'r')
  assert.equal(noId.result.error.code, 'bad-request')
  ok('an approval reply without approvalId is refused')
}

section('session.pin')

{
  const pins = new Set()
  const d = createDispatcher(ctxWith(fakeCtl()), noLog, null, { pins })

  await d('session.pin', { sessionId: 's1', pinned: true }, 'r')
  assert.equal(pins.has('s1'), true)
  const list = await d('session.pins', {}, 'r')
  assert.deepEqual(list.result.value.sessionIds, ['s1'])
  ok('pinning round-trips through the pins list')

  await d('session.pin', { sessionId: 's1', pinned: false }, 'r')
  assert.equal(pins.has('s1'), false)
  ok('unpinning works')

  const bad = await d('session.pin', { pinned: true }, 'r')
  assert.equal(bad.result.error.code, 'bad-request')
  ok('pinning without a sessionId is refused')
}

section('宿主抛错时的行为')

{
  const boom = createDispatcher(ctxWith(fakeCtl({
    list: async () => { throw new Error('宿主炸了') },
  })), noLog, null, { pins: new Set() })
  const r = await boom('session.list', {}, 'r')
  assert.equal(r.result.ok, false)
  assert.equal(r.result.error.message, '宿主炸了')
  assert.equal(r.result.error.stack, undefined, 'a stack must not leak to the client')
  ok('a host exception becomes an error envelope, with no stack leaked')
}

{

  const d = createDispatcher(ctxWith(fakeCtl()), noLog, null, { pins: new Set() })
  const k = await d('push.key', {}, 'r')
  assert.equal(k.result.ok, true)
  assert.equal(k.result.value.unsupported, 'harmony-no-web-push')
  ok('push.key reports the reason instead of pretending it works')

  const rs = await d('workspace.create', { path: 'x' }, 'r')
  assert.equal(rs.result.error.code, 'unavailable')
  ok('workspace.create is refused with a clear reason, not a crash')
}

console.log(`\n${n} 项分发器断言通过`)
