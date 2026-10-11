/**
 * 第 117 节 · task-16（⑯）· /cmd 的 wsRename op（工作区改名）单测。
 *
 * 手法照 lib/test/pins.spec.mjs：从 apply() 里截胡 /api/dsh-console/cmd 路由，
 * 假 ctx 提供可注入的 workspaceRegistry / workspaceController 替身。
 *
 * 覆盖任务卡要求的五条：
 *   ① 正常改名   ② 空名拒绝   ③ 找不到工作区   ④ 重名   ⑤ controller 不可用
 * 另加两条边界：只给 workspaceId（无 path）能改名；宿主错误码 → 中文文案的映射。
 *
 * ⚠️ 本单测只跑插件侧逻辑，**不连真机、不碰宿主**；插件改动要用户重启宿主才生效。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** 宿主 WorkspaceEntity 的替身（照 asar 语义：title 可独立于 path 改）。 */
function mockEntity(id, p, title) {
  const state = { id, path: p, title }
  return {
    get id() { return state.id },
    get path() { return state.path },
    get title() { return state.title },
    async setTitle(t) { state.title = t },
    _state: state,
  }
}

/** 裸实体（**没有** setTitle）—— 用来验「兜底走 workspaceController」那条路。 */
function bareEntity(id, p, title) {
  return { id, path: p, title }
}

/** 宿主 WorkspaceRegistry 的替身（list() 同步返回实体数组，与 asar 一致）。 */
function mockReg(entities) {
  const list = entities.slice()
  return {
    list: () => list,
    _list: list,
  }
}

async function makeCmd(opts) {
  const o = opts || {}
  const reg = o.reg === undefined ? mockReg([mockEntity('d2cbef6f-aaaa', 'C:\\ws\\alpha', 'alpha')]) : o.reg
  const wc = o.wc === undefined ? null : o.wc
  let cmdFetch = null
  const conn = { fetch: { register: (route) => { if (route.path === '/api/dsh-console/cmd') cmdFetch = route.fetch; return () => {} } } }
  const ctl = {
    list: async () => ({ items: [] }),
    modelCatalog: async () => ({}),
  }
  const ctx = {
    get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : n === 'workspaceRegistry' ? reg : n === 'workspaceController' ? wc : null),
    on: () => () => {}, effect: () => () => {},
  }
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  assert.ok(cmdFetch, 'cmd 路由没注册上')
  const post = async (op, payload) => {
    const r = await cmdFetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ op, payload }) }))
    return { status: r.status, j: await r.json() }
  }
  return { post, reg, wc }
}

/* ① 正常改名 ------------------------------------------------------------- */
test('wsRename 正常改名 → { ok:true, renamed:true, title }（形状冻结）', async () => {
  const { post, reg } = await makeCmd()
  const r = await post('wsRename', { path: 'C:\\ws\\alpha', title: '我的工作台' })
  assert.equal(r.j.ok, true)
  assert.deepEqual(r.j.result, { ok: true, renamed: true, title: '我的工作台' })
  assert.equal(reg._list[0].title, '我的工作台', '真的写进宿主实体（durable）')
  assert.equal(reg._list[0].path, 'C:\\ws\\alpha', 'path 不变 —— 只改显示名，不改文件夹')
})

test('wsRename 只给 workspaceId（无 path）也能改名', async () => {
  const { post, reg } = await makeCmd()
  const r = await post('wsRename', { workspaceId: 'd2cbef6f-aaaa', title: '换个名字' })
  assert.equal(r.j.ok, true)
  assert.equal(reg._list[0].title, '换个名字')
})

test('wsRename 前后带空格的名字会被 trim 后再写（与宿主 .trim() 同口径）', async () => {
  const { post, reg } = await makeCmd()
  const r = await post('wsRename', { path: 'C:\\ws\\alpha', title: '  我的工作台  ' })
  assert.equal(r.j.ok, true)
  assert.deepEqual(r.j.result, { ok: true, renamed: true, title: '我的工作台' })
  assert.equal(reg._list[0].title, '我的工作台')
})

/* ② 空名拒绝 ------------------------------------------------------------- */
test('wsRename 空名字 → 中文错误，且不写盘', async () => {
  const { post, reg } = await makeCmd()
  for (const bad of ['', '   ']) {
    const r = await post('wsRename', { path: 'C:\\ws\\alpha', title: bad })
    assert.equal(r.j.ok, false)
    assert.match(r.j.error, /新名字不能为空/)
  }
  assert.equal(reg._list[0].title, 'alpha', '一个字都没改')
})

test('wsRename 既没 path 也没 workspaceId → 中文错误', async () => {
  const { post } = await makeCmd()
  const r = await post('wsRename', { title: '随便' })
  assert.equal(r.j.ok, false)
  assert.match(r.j.error, /缺少工作区路径/)
})

/* ③ 找不到工作区 --------------------------------------------------------- */
test('wsRename 路径配不上任何工作区 → 中文错误「找不到这个工作区」，不编造成功', async () => {
  const { post, reg } = await makeCmd()
  const r = await post('wsRename', { path: 'C:\\ws\\nope', title: '新名字' })
  assert.equal(r.j.ok, false, '绝不回 ok 假成功')
  assert.match(r.j.error, /找不到这个工作区/)
  assert.equal(reg._list[0].title, 'alpha', '不是我的那条，一个字没动')
})

test('wsRename 路径大小写 / 尾部斜杠差异仍能配上（与客户端归一化同口径）', async () => {
  const { post, reg } = await makeCmd()
  const r = await post('wsRename', { path: 'c:\\WS\\ALPHA\\', title: '归一化也能配' })
  assert.equal(r.j.ok, true)
  assert.equal(reg._list[0].title, '归一化也能配')
})

/* ④ 重名 ---------------------------------------------------------------- */
test('wsRename 与另一个工作区重名 → 中文错误「已存在同名工作区」，不写盘', async () => {
  const reg = mockReg([
    mockEntity('id-1', 'C:\\ws\\alpha', 'alpha'),
    mockEntity('id-2', 'C:\\ws\\beta', 'beta'),
  ])
  const { post } = await makeCmd({ reg })
  const r = await post('wsRename', { path: 'C:\\ws\\alpha', title: 'beta' })
  assert.equal(r.j.ok, false)
  assert.match(r.j.error, /已存在同名工作区/)
  assert.equal(reg._list[0].title, 'alpha', '冲突时不写')
})

test('wsRename 改成自己原本的名字 → 视为成功（幂等，不算重名）', async () => {
  const { post } = await makeCmd()
  const r = await post('wsRename', { path: 'C:\\ws\\alpha', title: 'alpha' })
  assert.equal(r.j.ok, true)
  assert.deepEqual(r.j.result, { ok: true, renamed: true, title: 'alpha' })
})

/* ⑤ controller 不可用 ---------------------------------------------------- */
test('wsRename registry 与 workspaceController 都取不到 → 明确不支持，绝不编造成功', async () => {
  const { post } = await makeCmd({ reg: null, wc: null })
  const r = await post('wsRename', { path: 'C:\\ws\\alpha', title: '新名字' })
  assert.equal(r.j.ok, false, '绝不回 ok')
  assert.match(r.j.error, /本机插件不支持工作区改名，或需要重启 DSH/)
})

test('wsRename registry 有 list 但无 setTitle、controller 也没有 rename → 同样明确不支持', async () => {
  const reg = { list: () => [bareEntity('id-1', 'C:\\ws\\alpha', 'alpha')] }    // 实体缺 setTitle
  const { post } = await makeCmd({ reg, wc: {} })                                  // wc 缺 rename
  const r = await post('wsRename', { path: 'C:\\ws\\alpha', title: '新名字' })
  assert.equal(r.j.ok, false)
  assert.match(r.j.error, /本机插件不支持工作区改名，或需要重启 DSH/)
})

/* 兜底路：多路依次试 + 宿主错误码映射 ------------------------------------ */
test('wsRename 实体没有 setTitle → 自动兜底走 workspaceController.rename', async () => {
  const seen = []
  const wc = { rename: async (req) => { seen.push(req); return { workspace: { workspaceId: req.workspaceId, title: req.title } } } }
  const reg = { list: () => [bareEntity('id-1', 'C:\\ws\\alpha', 'alpha')] }
  const { post } = await makeCmd({ reg, wc })
  const r = await post('wsRename', { path: 'C:\\ws\\alpha', title: '走 RPC' })
  assert.equal(r.j.ok, true)
  assert.deepEqual(seen, [{ workspaceId: 'id-1', title: '走 RPC' }], '契约 = {workspaceId,title}')
})

test('wsRename 宿主错误码 → 中文文案（bad-request / name-conflict / not-found 三条）', async () => {
  const cases = [
    [{ code: 'gateway/bad-request', message: 'blank title' }, /新名字不能为空/],
    [{ code: 'workspace/name-conflict', message: "already in use" }, /已存在同名工作区/],
    [{ code: 'workspace/not-found', message: 'workspace not found' }, /找不到这个工作区/],
  ]
  for (const [errObj, re] of cases) {
    const wc = { rename: async () => { const e = new Error(errObj.message); e.code = errObj.code; throw e } }
    const reg = { list: () => [bareEntity('id-1', 'C:\\ws\\alpha', 'alpha')] }
    const { post } = await makeCmd({ reg, wc })
    const r = await post('wsRename', { path: 'C:\\ws\\alpha', title: '新名字' })
    assert.equal(r.j.ok, false, '宿主报错不能变 ok')
    assert.match(r.j.error, re)
  }
})

test('wsRename 未知错误也照实带出原因（不吞、不假成功）', async () => {
  const wc = { rename: async () => { throw new Error('宿主机房着火了') } }
  // 实体用**没有 setTitle 的裸对象**，逼它走 workspaceController 那条兜底路
  const reg2 = { list: () => [bareEntity('id-1', 'C:\\ws\\alpha', 'alpha')] }
  const made = await makeCmd({ reg: reg2, wc })
  const r = await made.post('wsRename', { path: 'C:\\ws\\alpha', title: '新名字' })
  assert.equal(r.j.ok, false)
  assert.match(r.j.error, /工作区改名失败：宿主机房着火了/)
})
