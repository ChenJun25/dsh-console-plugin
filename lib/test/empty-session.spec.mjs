
import test from 'node:test'
import assert from 'node:assert/strict'

const CMD = '/api/dsh-console/cmd'
const SESSIONS = '/api/dsh-console/sessions'

const REMINDER = '<system-reminder>\nYou are teammate "plugin-inject".\n</system-reminder>'

async function boot(items, opt = {}) {
  let cmdFetch = null
  let sessionsFetch = null
  const conn = {
    fetch: {
      register: (route) => {
        if (route.path === CMD) cmdFetch = route.fetch
        if (route.path === SESSIONS) sessionsFetch = route.fetch
        return () => {}
      }
    }
  }
  const ctl = { list: async () => ({ items }), modelCatalog: async () => ({}) }
  const ctx = {
    get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : n === 'workspaceRegistry' ? (opt.reg || null) : null),
    on: () => () => {},
    effect: () => () => {}
  }
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  assert.ok(cmdFetch, 'cmd 路由没注册上')
  assert.ok(sessionsFetch, '/sessions 路由没注册上')
  const post = async (op, payload) => {
    const r = await cmdFetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ op, payload }) }))
    return { status: r.status, j: await r.json() }
  }
  const getSessions = async () => {
    const r = await sessionsFetch(new Request('http://x', { method: 'GET' }))
    return { status: r.status, j: await r.json() }
  }
  return { post, getSessions }
}

const EMPTY = { sessionId: 's-empty', updatedAt: 1760000000000 }

test('空会话不下发：cmd sessions 里没有它', async () => {
  const { post } = await boot([EMPTY, { sessionId: 's-real', title: '真会话' }])
  const { j } = await post('sessions', {})
  assert.equal(j.ok, true)
  assert.deepEqual(j.result.map((x) => x.id), ['s-real'], '只剩真会话')
})

test('空会话不下发：GET /sessions 同样过滤，count 一致', async () => {
  const { getSessions } = await boot([EMPTY, { sessionId: 's-real', title: '真会话' }])
  const { status, j } = await getSessions()
  assert.equal(status, 200)
  assert.equal(j.ok, true)
  assert.equal(j.count, 1, 'count 是过滤后的条数')
  assert.deepEqual(j.sessions.map((x) => x.id), ['s-real'])
})

test('按 id 直查照样查得到：空会话能 pin（readSessions 不过滤）', async () => {
  const pinned = []
  const reg = {
    get pinnedSessionIds() { return pinned.slice() },
    async pinSession(id) { if (!pinned.includes(id)) pinned.unshift(id) },
    async unpinSession(id) { const i = pinned.indexOf(id); if (i >= 0) pinned.splice(i, 1) }
  }
  const { post } = await boot([EMPTY], { reg })
  const { j } = await post('pin', { sessionId: 's-empty', pinned: true })
  assert.equal(j.ok, true, '置顶空会话不该报找不到')
  assert.deepEqual(j.result, { ok: true, pinned: ['s-empty'] })
})

test('正面证据 · 原始 title 非空（注入壳也一样）：绝不算空', async () => {
  const { post } = await boot([
    { sessionId: 's-shell', projections: { values: { title: REMINDER } } },
    { sessionId: 's-plain', title: '普通标题' }
  ])
  const { j } = await post('sessions', {})
  assert.deepEqual(j.result.map((x) => x.id), ['s-shell', 's-plain'], '注入壳在原始数据里有标题 = 有过内容')
  assert.equal(j.result[0].title, '', '但下发的 title 仍然是剥壳后的空串（剥壳行为不变）')
})

test('正面证据 · modelSelection 有 provider+model：绝不算空', async () => {
  const { post } = await boot([
    { sessionId: 's-model', projections: { values: { modelSelection: { lastUsed: { provider: 'p', model: 'm' } } } } },
    { sessionId: 's-model-next', projections: { values: { modelSelection: { next: { provider: 'p2', model: 'm2' } } } } }
  ])
  const { j } = await post('sessions', {})
  assert.deepEqual(j.result.map((x) => x.id), ['s-model', 's-model-next'])
})

test('正面证据 · running / parentSessionId / origin：绝不算空', async () => {
  const { post } = await boot([
    { sessionId: 's-run', running: true },
    { sessionId: 's-sub', parentSessionId: 'session-parent' },
    { sessionId: 's-origin', origin: 'subagent' }
  ])
  const { j } = await post('sessions', {})
  assert.deepEqual(j.result.map((x) => x.id), ['s-run', 's-sub', 's-origin'])
})

test('正面证据 · agentTeam 真带成员/任务才算；空壳 agentTeam 不算', async () => {
  const teamEmpty = { id: 'session-x', members: [], tasks: [], messages: [], delivered: [], nextTaskNumber: 1 }
  const teamReal = { id: 'session-y', members: [{ id: 'lead', name: 'lead', role: 'lead', phase: 'active' }], tasks: [] }
  const { post } = await boot([
    { sessionId: 's-team-empty', projections: { values: { agentTeam: teamEmpty } } },
    { sessionId: 's-team-real', projections: { values: { agentTeam: teamReal } } }
  ])
  const { j } = await post('sessions', {})
  assert.deepEqual(j.result.map((x) => x.id), ['s-team-real'], '每会话都有的空 agentTeam 壳不能当证据')
})

test('正面证据 · 首条用户消息 titleInput.first 非空：绝不算空', async () => {
  const { post } = await boot([
    { sessionId: 's-first', projections: { values: { titleInput: { first: '帮我看看这个' } } } }
  ])
  const { j } = await post('sessions', {})
  assert.deepEqual(j.result.map((x) => x.id), ['s-first'])
})

test('正面证据 · 首条用户消息两种形状（字符串 / {seq,text}）都认', async () => {
  const { post } = await boot([
    { sessionId: 's-first-str', projections: { values: { titleInput: { first: '字符串老形状' } } } },
    { sessionId: 's-first-obj', projections: { values: { titleInput: { first: { seq: 8, text: '现版本的 {seq,text}' } } } } },
    { sessionId: 's-first-empty', projections: { values: { titleInput: { first: { seq: 0, text: '' } } } } }
  ])
  const { j } = await post('sessions', {})
  assert.deepEqual(j.result.map((x) => x.id), ['s-first-str', 's-first-obj'], 'text 为空的 {seq,text} 不算证据')
})

test('宿主 blank 字段/投影是第二道闸：blank:false 绝不吃，blank:true 才可能吃', async () => {
  const { post } = await boot([
    { sessionId: 's-bf', blank: false },
    { sessionId: 's-bt', blank: true },
    { sessionId: 's-pf', projections: { values: { sessionListMetadata: { blank: false, lastPromptAt: 1 } } } },
    { sessionId: 's-pt', projections: { values: { sessionListMetadata: { blank: true, lastPromptAt: null } } } }
  ])
  const { j } = await post('sessions', {})
  assert.deepEqual(j.result.map((x) => x.id), ['s-bf', 's-pf'], '宿主明说不空的都留，两只空壳都被吃')
})

test('判据字段 __blank 绝不外泄（不可枚举，JSON 里没有这个键）', async () => {
  const { post } = await boot([EMPTY, { sessionId: 's-real', title: 't' }])
  const { j } = await post('sessions', {})
  const wire = JSON.stringify(j)
  assert.ok(wire.indexOf('__blank') < 0, '载荷里出现 __blank = 内部判据泄漏')
  assert.ok(wire.indexOf('sessionListMetadata') < 0, '宿主投影字段也不该顺手带出去')
})

test('宿主抛错时列表仍然 500 归一（不过滤路径不吞错）', async () => {
  let cmdFetch = null
  const conn = { fetch: { register: (route) => { if (route.path === CMD) cmdFetch = route.fetch; return () => {} } } }
  const ctl = { list: async () => { throw new Error('宿主炸了') }, modelCatalog: async () => ({}) }
  const ctx = {
    get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : null),
    on: () => () => {}, effect: () => () => {}
  }
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  const r = await cmdFetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ op: 'sessions', payload: {} }) }))
  const j = await r.json()
  assert.equal(j.ok, false)
  assert.match(String(j.error), /宿主炸了/)
})
