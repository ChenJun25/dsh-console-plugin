import test from 'node:test'
import assert from 'node:assert/strict'

const PARENT = 'session-parent-0001'
const FORK = 'session-fork-0002'
const CHILD = 'child-0003'
const MAIN = 'session-main-0004'
const COLD = 'session-cold-0005'

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

const ELLIPSIS_TAIL = '…'

const OUTLINE_TEXT = '这是一段很长很长的正文'.repeat(20).slice(0, 119) + ELLIPSIS_TAIL

function baseEvents (o) {
  const long = (o && o.long) || '分叉会话的完整正文，一个字都没被截。'
  return [
    { type: 'turn/start', seq: 1, time: 1790000000001, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 1790000000002, data: { turn: 1, content: [{ type: 'text', text: '分叉后的第 1 轮提问' }] } },
    { type: 'assistant/message', seq: 3, time: 1790000000003, data: { turn: 1, step: 1, stream: [], message: { content: [{ type: 'text', text: long }] } } },
    { type: 'turn/end', seq: 4, time: 1790000000004, data: { turn: 1 } }
  ]
}

function eventsWithDelivery (files) {
  const evs = baseEvents()
  evs.splice(3, 0,
    { type: 'deliverables/presented', seq: 4, time: 1790000000004, data: { turn: 1, files: files } },
    { type: 'turn/end', seq: 5, time: 1790000000005, data: { turn: 1 } })
  evs.splice(3, 0, { type: 'workspace/changes', seq: 0, time: 0, data: { turn: 1 } })
  return evs.filter((e) => e.type !== 'workspace/changes')
}

async function detailOf (o) {
  const events = o.events
  const maxSeq = events.reduce((m, e) => Math.max(m, e.seq), 0)
  const seen = { addresses: [], throughSeqs: [] }
  let cmdFetch = null
  const conn = { fetch: { register: (r) => { if (r.path === '/api/dsh-console/cmd') cmdFetch = r.fetch; return () => {} } } }

  const ctl = {
    projections: async () => ({
      asOfSeq: maxSeq,
      values: {
        title: 't',

        turnOutline: [{ turn: 1, seq: 1, prompt: '概要提问', response: OUTLINE_TEXT }]
      }
    }),
    page: async (req) => {
      seen.addresses.push(req && req.address)
      seen.throughSeqs.push(req && req.throughSeq)
      const header = o.origin === 'subagent'
        ? { cwd: 'C:/w', origin: 'subagent', parentSession: o.parentSessionId || PARENT }
        : (o.origin ? { cwd: 'C:/w', origin: o.origin } : { cwd: 'C:/w' })
      hostValidate(req.address, header)
      const end = req.throughSeq + 1
      return { records: events.slice(0, end).map((e) => ({ type: 'event', event: e })), hasMore: end < maxSeq }
    },
    list: async () => {
      const row = { id: o.sid, title: 't', cwd: 'C:/w', updatedAt: 1, running: false }
      if (o.parentSessionId) row.parentSessionId = o.parentSessionId
      if (o.origin !== undefined) row.origin = o.origin
      const items = [row]

      items.push({ id: o.parentSessionId || PARENT, title: 'p', cwd: 'C:/w', updatedAt: 2, running: false })
      return { items }
    }
  }

  const store = {
    get: (id) => (o.ownLog && id === o.sid) ? { id, log: o.ownLog } : null,
    forEach: (fn) => { for (const d of (o.decoys || [])) fn(d) },
    list: () => (o.decoys || [])
  }

  const ctx = {
    get: (n) => (n === 'connection' ? conn
      : n === 'sessionController' ? ctl
        : n === 'sessions' ? store
          : null),
    on: () => () => {}, effect: () => () => {}
  }
  const mod = await import('../index.js?t=' + Math.random())
  mod.apply(ctx, { port: 0 })
  const r = await cmdFetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: o.sid } }) }))
  const j = await r.json()
  return { detail: (j && j.result) || {}, seen }
}

test('① 分叉会话（parentSessionId 非空 + origin 空）必须走 kind:session 地址，拿到全文而不是省略号', async () => {
  const long = '分叉会话的完整正文'.repeat(40)
  const { detail, seen } = await detailOf({
    sid: FORK, parentSessionId: PARENT, origin: undefined, events: baseEvents({ long })
  })
  assert.deepEqual(seen.addresses[0], { kind: 'session', sessionId: FORK },
    'fork 不是子智能体：地址必须是 kind:session，否则宿主会以 subagent/unauthorized 拒绝')
  assert.equal(detail.full, true, 'fork 会话必须走全文通道')
  assert.equal(detail.turns.length, 1)
  assert.equal(detail.turns[0].response, long, '正文必须是全文，不能是 120 字概要')
  assert.equal(detail.turns[0].response.endsWith(ELLIPSIS_TAIL), false, '不能以省略号结尾')
})

test('② 分叉会话 origin 显式为 not-subagent 的其他值时同样不当子会话（判据是 origin!=="subagent"）', async () => {
  const { detail, seen } = await detailOf({
    sid: FORK, parentSessionId: PARENT, origin: 'fork', events: baseEvents()
  })
  assert.deepEqual(seen.addresses[0], { kind: 'session', sessionId: FORK })
  assert.equal(detail.full, true)
})

test('③ 真子智能体（origin=subagent）仍然用 durable parent 地址（回归防线：不能被这次修复打回去）', async () => {
  const { detail, seen } = await detailOf({
    sid: CHILD, origin: 'subagent', parentSessionId: PARENT, events: baseEvents({ long: '子智能体正文' })
  })
  assert.deepEqual(seen.addresses[0], {
    kind: 'subagent', parentSessionId: PARENT, childSessionId: CHILD, mode: 'unknown'
  })
  assert.equal(detail.full, true)
  assert.equal(detail.turns[0].response, '子智能体正文')
})

test('④ 主会话不受影响：仍是 kind:session 地址 + 全文', async () => {
  const { detail, seen } = await detailOf({ sid: MAIN, events: baseEvents({ long: '主会话正文' }) })
  assert.deepEqual(seen.addresses[0], { kind: 'session', sessionId: MAIN })
  assert.equal(detail.full, true)
  assert.equal(detail.turns[0].response, '主会话正文')
})

function decoySession (id, files) {
  return {
    id,
    log: [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'deliverables/presented', seq: 2, time: 2, data: { turn: 1, files: files } },
      { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, stream: [], message: { content: [{ type: 'text', text: '别人的对话' }] } } },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 1 } }
    ]
  }
}

test('⑤ 冷会话（本会话没有活 log）不许借别人的交付文件卡 —— 手机端"每个会话末页同一批文件"的根因', async () => {
  const stolen = [
    { path: 'C:/别人的/a.md', description: 'A' },
    { path: 'C:/别人的/b.png', description: 'B' },
    { path: 'C:/别人的/c.zip', description: 'C' }
  ]
  const { detail } = await detailOf({
    sid: COLD,
    events: baseEvents({ long: '冷会话正文' }),
    ownLog: null,

    decoys: [decoySession('session-someone-else', stolen), decoySession('session-someone-else-2', stolen)]
  })
  assert.equal(detail.ok, true, 'detail 必须 ok:true（手机端不能红屏）')
  assert.equal(detail.full, true, '全文通道不受影响')
  const files = detail.turns.flatMap((t) => (Array.isArray(t.files) ? t.files : []))
  assert.deepEqual(files, [], '拿不到本会话日志就该一个文件都不挂，绝不能从别人的日志里捞')
})

test('⑥ 本会话自己的交付文件仍要正确归到对应轮（修复不能把正常能力一起干掉）', async () => {
  const own = eventsWithDelivery([{ path: 'C:/我的/report.md', description: '我的交付' }])
  const { detail } = await detailOf({
    sid: MAIN,
    events: own,
    ownLog: own
  })
  const files = detail.turns.flatMap((t) => (Array.isArray(t.files) ? t.files : []))
  assert.equal(files.length, 1, '同一批交付文件只该挂一次（log 与 page 事件流按 type|seq 去重）')
  assert.equal(files[0].path, 'C:/我的/report.md')
  assert.equal(detail.turns[0].files.length, 1, '应归到第 1 轮，而不是被甩到最后一轮')
})

test('⑦ page 事件流里有、活 log 里还没有的交付文件也要补上（合并不是只看 log）', async () => {
  const events = eventsWithDelivery([{ path: 'C:/新/report.md', description: '新交付' }])
  const { detail } = await detailOf({
    sid: MAIN,
    events: events,

    ownLog: events.slice(0, 3)
  })
  const files = detail.turns.flatMap((t) => (Array.isArray(t.files) ? t.files : []))
  assert.equal(files.length, 1)
  assert.equal(files[0].path, 'C:/新/report.md')
})
