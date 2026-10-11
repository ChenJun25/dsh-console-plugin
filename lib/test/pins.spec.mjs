/**
 * task-28 A 段单测：/cmd 的 pins / pin 两个 op（第 100 节）。
 *
 * 用 test-selectmodel.mjs 同款手法从 apply() 里截胡 cmd 路由，假 ctx 提供
 * 一个可注入的 workspaceRegistry 替身（宿主 pin API 有 / 没有 两条路都验）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const S1 = 'session-pin-aaa-1111'
const S2 = 'session-pin-bbb-2222'

/** 宿主 WorkspaceRegistry 的替身（照 asar@66468936 的语义：最新在前、幂等、未置顶不报错）。 */
function mockReg(pinned) {
  const state = { pinned: pinned.slice() }
  return {
    get pinnedSessionIds() { return state.pinned.slice() },
    async pinSession(id) {
      if (state.pinned.includes(id)) return
      state.pinned = [id].concat(state.pinned)
    },
    async unpinSession(id) {
      state.pinned = state.pinned.filter((x) => x !== id)
    },
    _state: state,
  }
}

async function makeCmd(opts) {
  const o = opts || {}
  const reg = o.reg === undefined ? mockReg([]) : o.reg
  let cmdFetch = null
  const conn = { fetch: { register: (route) => { if (route.path === '/api/dsh-console/cmd') cmdFetch = route.fetch; return () => {} } } }
  const ctl = {
    list: async () => ({ items: (o.sessions || [{ sessionId: S1 }, { sessionId: S2 }]).map((s) => (typeof s === 'string' ? { sessionId: s } : s)) }),
    modelCatalog: async () => ({}),
  }
  const ctx = {
    get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : n === 'workspaceRegistry' ? reg : null),
    on: () => () => {}, effect: () => () => {},
  }
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  assert.ok(cmdFetch, 'cmd 路由没注册上')
  const post = async (op, payload) => {
    const r = await cmdFetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ op, payload }) }))
    return { status: r.status, j: await r.json() }
  }
  return { post, reg }
}

test('pins 初始为空', async () => {
  const { post } = await makeCmd()
  const { j } = await post('pins', {})
  assert.equal(j.ok, true)
  assert.deepEqual(j.result, { ok: true, pinned: [] })
})

test('pin 置顶 → 返回完整集合，最新在前（形状冻结）', async () => {
  const { post, reg } = await makeCmd()
  const a = await post('pin', { sessionId: S1, pinned: true })
  assert.equal(a.j.ok, true)
  assert.deepEqual(a.j.result, { ok: true, pinned: [S1] })
  const b = await post('pin', { sessionId: S2, pinned: true })
  assert.deepEqual(b.j.result, { ok: true, pinned: [S2, S1] }, '后置顶的排最前')
  assert.deepEqual(reg._state.pinned, [S2, S1], '真的写进宿主 registry（durable）')
})

test('pin:false 取消置顶；未置顶的取消不报错（幂等）', async () => {
  const { post } = await makeCmd({ reg: mockReg([S1, S2]) })
  const a = await post('pin', { sessionId: S1, pinned: false })
  assert.deepEqual(a.j.result, { ok: true, pinned: [S2] })
  const b = await post('pin', { sessionId: S1, pinned: false })
  assert.equal(b.j.ok, true, '重复取消不报错')
  assert.deepEqual(b.j.result, { ok: true, pinned: [S2] })
})

test('重复置顶同一条不重排（宿主 pinSession 幂等语义）', async () => {
  const { post } = await makeCmd({ reg: mockReg([S2, S1]) })
  const a = await post('pin', { sessionId: S1, pinned: true })
  assert.deepEqual(a.j.result, { ok: true, pinned: [S2, S1] }, '已置顶的原样返回，不挪到最前')
})

test('pinned 缺省 = 置顶（客户端只传 sessionId 也能用）', async () => {
  const { post } = await makeCmd()
  const a = await post('pin', { sessionId: S1 })
  assert.deepEqual(a.j.result, { ok: true, pinned: [S1] })
})

test('缺 sessionId → 中文错误；不存在的会话 → 中文错误且不写', async () => {
  const { post, reg } = await makeCmd()
  const a = await post('pin', {})
  assert.equal(a.j.ok, false)
  assert.match(a.j.error, /缺少 sessionId/)
  const b = await post('pin', { sessionId: 'session-nope-9999', pinned: true })
  assert.equal(b.j.ok, false)
  assert.match(b.j.error, /找不到这个会话/)
  assert.deepEqual(reg._state.pinned, [], '没写进去')
})

test('宿主没有 pin API → 落文件兜底（~/.dsh/dsh-console-pins.json）', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const pinFile = path.join(os.homedir(), '.dsh', 'dsh-console-pins.json')
  const before = fs.existsSync(pinFile) ? fs.readFileSync(pinFile, 'utf8') : null
  try {
    const { post } = await makeCmd({ reg: {} })     // 空对象 = 没有 pinnedSessionIds / pinSession
    const a = await post('pin', { sessionId: S1, pinned: true })
    assert.equal(a.j.ok, true)
    assert.deepEqual(a.j.result, { ok: true, pinned: [S1] })
    assert.ok(fs.existsSync(pinFile), '兜底文件已写出')
    const raw = JSON.parse(fs.readFileSync(pinFile, 'utf8'))
    assert.deepEqual(raw.pinned, [S1], '格式 = {pinned:[...]}')
    const b = await post('pins', {})
    assert.deepEqual(b.j.result, { ok: true, pinned: [S1] }, '读的也是同一个来源')
    const c = await post('pin', { sessionId: S1, pinned: false })
    assert.deepEqual(c.j.result, { ok: true, pinned: [] })
  } finally {
    if (before === null) { try { fs.unlinkSync(pinFile) } catch (e) {} }
    else fs.writeFileSync(pinFile, before)
  }
})

test('宿主 pinSession 抛错 → 中文错误往上抛（不静默吞掉）', async () => {
  const reg = mockReg([])
  reg.pinSession = async () => { throw new Error('session/not-found: session "x" not found') }
  const { post } = await makeCmd({ reg })
  const a = await post('pin', { sessionId: S1, pinned: true })
  assert.equal(a.j.ok, false, '不能回 ok 让客户端误显示成功')
  assert.match(a.j.error, /置顶失败/)
  assert.match(a.j.error, /not-found/)
})
