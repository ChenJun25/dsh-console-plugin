import test from 'node:test'
import assert from 'node:assert/strict'
import { startLanServer } from '../lan-server.mjs'

let portSeq = 0
const nextPort = () => 18901 + (portSeq++ * 2)

async function serve(over = {}) {
  const o = Object.assign({
    port: nextPort(),
    allowShift: true,
    log: () => {},
    getToken: () => 'TOK',
    getInfo: () => ({
      name: '我的电脑', nodeId: 'dsh-console', host: 'host-1', dshOk: true,
      dshError: '', version: '9.9.9',
      agentPreset: 'ptc', agentPresetAvailable: true,
    }),
    listSessions: async () => [],
    runCommand: async () => ({ ok: true }),
  }, over)
  const srv = startLanServer(o)
  const started = await srv.start()
  assert.ok(started, 'lan server 必须起得来（端口占用且不允许顺延时会 resolve(null)）')
  return {
    base: 'http://127.0.0.1:' + started.port,
    close: () => srv.stop(),
  }
}

const infoOf = async (base) => {
  const r = await fetch(base + '/dsh-console/info', { headers: { 'x-dsh-console-token': 'TOK' } })
  assert.equal(r.status, 200)
  return r.json()
}

test('①-a /info 真的带上 agentPreset / agentPresetAvailable', async () => {
  const s = await serve()
  const j = await infoOf(s.base)
  assert.equal(j.ok, true)
  assert.equal(j.agentPreset, 'ptc', 'agentPreset 被 safeInfo 白名单丢了')
  assert.equal(j.agentPresetAvailable, true, 'agentPresetAvailable 被 safeInfo 白名单丢了')

  for (const k of ['name', 'nodeId', 'host', 'dshOk', 'dshError', 'version', 'ports']) {
    assert.ok(Object.prototype.hasOwnProperty.call(j, k), '老字段丢了: ' + k)
  }
  s.close()
})

test('①-b getInfo 不带这两个字段时，键仍然在（空串 / false，不是 undefined）', async () => {
  const s = await serve({ getInfo: () => ({ name: '机器', dshOk: true }) })
  const j = await infoOf(s.base)
  assert.ok(Object.prototype.hasOwnProperty.call(j, 'agentPreset'), '键必须存在，否则客户端读到 undefined 显示“未知”')
  assert.equal(j.agentPreset, '')
  assert.equal(j.agentPresetAvailable, false)
  s.close()
})

test('①-c getInfo 抛错时兜底包也带这两个字段', async () => {
  const s = await serve({ getInfo: () => { throw new Error('宿主炸了') } })
  const j = await infoOf(s.base)
  assert.equal(j.dshOk, false)
  assert.equal(j.agentPreset, '')
  assert.equal(j.agentPresetAvailable, false)
  s.close()
})

test('①-d 白名单仍然是白名单：getInfo 里多出来的字段不许漏出去', async () => {
  const s = await serve({
    getInfo: () => ({ name: 'n', dshOk: true, agentPreset: 'ptc', token: 'SECRET', secret: 'S2', cwd: 'C:/私密' }),
  })
  const j = await infoOf(s.base)
  assert.equal(j.token, undefined, '访问码泄漏到 /info 了')
  assert.equal(j.secret, undefined, '内部字段泄漏到 /info 了')
  assert.equal(j.cwd, undefined, '内部字段泄漏到 /info 了')
  s.close()
})

/* ---------------- ② selectPreset ---------------- */

async function cmdOf(o) {
  const opt = o || {}
  let cmdFetch = null
  const conn = {
    fetch: { register: (r) => { if (r.path === '/api/dsh-console/cmd') cmdFetch = r.fetch; return () => {} } },
  }
  const ctl = {
    projections: async () => ({ asOfSeq: 0, values: { title: '', turnOutline: [] } }),
    list: async () => { if (opt.sessionsThrows) throw new Error('会话列表不可用'); return { items: opt.sessionsItems || [] } },
  }
  const ctx = {
    get: (n) => {
      if (n === 'connection') return conn
      if (n === 'sessionController') return ctl
      if (n === 'agents') return { get: () => (opt.agent === undefined ? null : opt.agent) }
      if (n === 'settings') return opt.settings === undefined ? { update: async () => {} } : opt.settings
      if (n === 'agentPresets') return opt.svc === undefined ? null : opt.svc
      return null
    },
    on: () => () => {},
    effect: () => () => {},
  }
  const mod = await import('../index.js?t=' + Math.random())
  mod.apply(ctx, { port: 0 })
  return async (op, payload) => {
    const r = await cmdFetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ op, payload }) }))
    return { status: r.status, body: await r.json() }
  }
}

function settingsSpy() {
  const updates = []
  return {
    updates,
    update: async (ns, val) => { updates.push({ ns, val }) },
  }
}

test('②-a 空 sessionId + 有 presetId ⇒ 200，写全局默认（不再是 500）', async () => {
  const spy = settingsSpy()
  const cmd = await cmdOf({ settings: spy, sessionsItems: [], svc: { list: async () => [] } })
  const { status, body } = await cmd('selectPreset', { presetId: 'minimal' })
  assert.equal(status, 200, '空 sid 不该再是 HTTP 500')
  assert.equal(body.ok, true)
  assert.equal(body.result.ok, true)
  assert.equal(body.result.selected, 'minimal')
  assert.equal(body.result.scope, 'global', '要能区分落点是全局默认还是某条会话')
  assert.equal(spy.updates.length, 1, 'settings.update 必须被调一次')
  assert.equal(spy.updates[0].ns, 'agent-preset-registry')
  assert.equal(spy.updates[0].val.selectedDefault, 'minimal')
})

test('②-b sessionId 不存在 ⇒ 200，仍走全局默认（实测曾经 500）', async () => {
  const spy = settingsSpy()
  const cmd = await cmdOf({ settings: spy, sessionsItems: [], svc: { list: async () => [] } })
  const { status, body } = await cmd('selectPreset', { sessionId: '__nonexistent_t25__', presetId: 'standard' })
  assert.equal(status, 200, '不存在的 sid 不该把「换默认预设」打成 500')
  assert.equal(body.result.selected, 'standard')
  assert.equal(body.result.scope, 'global')
  assert.equal(spy.updates[0].val.selectedDefault, 'standard')
})

test('②-c 会话列表不可用（sessionExists 返回 null）也不拦路', async () => {
  const spy = settingsSpy()
  const cmd = await cmdOf({ settings: spy, sessionsThrows: true, svc: { list: async () => [] } })
  const { status, body } = await cmd('selectPreset', { sessionId: 'session-x', presetId: 'cordis' })
  assert.equal(status, 200)
  assert.equal(body.result.selected, 'cordis')
  assert.equal(spy.updates.length, 1)
})

test('②-d 缺 presetId 仍然是硬错误（这条校验不能一起放掉）', async () => {
  const spy = settingsSpy()
  const cmd = await cmdOf({ settings: spy, svc: { list: async () => [] } })
  const { status, body } = await cmd('selectPreset', { sessionId: 'session-x' })
  assert.equal(status, 500)
  assert.match(body.error, /缺少 presetId/)
  assert.equal(spy.updates.length, 0, '参数不全时绝不能动全局默认')
})

test('②-e 会话已开轮（agent-preset/locked）语义不变', async () => {
  const spy = settingsSpy()
  const locked = new Error('This session has already started')
  locked.code = 'agent-preset/locked'
  const agent = { id: 'a1' }
  const cmd = await cmdOf({
    settings: spy, agent,
    svc: { select: async () => { throw locked } },
  })
  const { status, body } = await cmd('selectPreset', { sessionId: 'session-x', presetId: 'ptc' })
  assert.equal(status, 500)
  assert.match(body.error, /agent-preset\/locked/)
  assert.equal(spy.updates.length, 0, '会话级失败不许偷偷落到全局默认')
})

test('②-f 有 Agent 且 select 成功 ⇒ 会话级落点，不带 scope 字段', async () => {
  const spy = settingsSpy()
  const agent = { id: 'a1' }
  const cmd = await cmdOf({
    settings: spy, agent,
    svc: { select: async () => 'minimal' },
  })
  const { status, body } = await cmd('selectPreset', { sessionId: 'session-x', presetId: 'minimal' })
  assert.equal(status, 200)
  assert.equal(body.result.ok, true)
  assert.equal(body.result.selected, 'minimal')
  assert.equal(body.result.scope, undefined, '会话级不该带 scope:global，客户端会读错落点')
  assert.equal(spy.updates.length, 0, '会话级成功不该再写全局设置')
})

const catalogOf = async (svc, settings) => {
  const cmd = await cmdOf({ svc, settings })
  const { status, body } = await cmd('presetCatalog', {})
  assert.equal(status, 200)
  return body.result
}

const ROWS = [{ id: 'standard' }, { id: 'ptc' }, { id: 'minimal' }]

test('③-a svc.defaultId（asar getter）⇒ current 拿到默认预设', async () => {
  const r = await catalogOf({ list: async () => ROWS, defaultId: 'ptc' })
  assert.equal(r.current, 'ptc', 'defaultId 没被读，current 会是空串')
  assert.equal(r.unavailable, false)
  const cur = r.presets.filter((p) => p.isDefault).map((p) => p.id)
  assert.deepEqual(cur, ['ptc'], 'isDefault 标记要跟着 current 走')
})

test('③-b svc.config.selectedDefault（有 .get() 的 volatile 字段）⇒ current', async () => {
  const svc = { list: async () => ROWS, config: { default: 'standard', selectedDefault: { get: () => 'minimal' } } }
  const r = await catalogOf(svc)
  assert.equal(r.current, 'minimal')
})

test('③-c selectedDefault 没设过 ⇒ 退到 config.default', async () => {
  const svc = { list: async () => ROWS, config: { default: 'standard', selectedDefault: { get: () => null } } }
  const r = await catalogOf(svc)
  assert.equal(r.current, 'standard', '与宿主 defaultId getter 的 ?? config.default 语义一致')
})

test('③-d 服务上没有默认 ⇒ 退到 settings 命名空间的 selectedDefault', async () => {
  const settings = {
    update: async () => {},
    namespace: (ns) => (ns === 'agent-preset-registry' ? { selectedDefault: 'cordis' } : null),
  }
  const r = await catalogOf({ list: async () => ROWS }, settings)
  assert.equal(r.current, 'cordis')
})

test('③-e 全都拿不到 ⇒ current 空串（客户端落「未知」，不许抛）', async () => {
  const r = await catalogOf({ list: async () => ROWS }, { update: async () => {}, namespace: () => null })
  assert.equal(r.current, '')
  assert.equal(r.unavailable, false)
  assert.equal(r.presets.length, 3)
})

test('③-f 属性是函数时不把函数体 String 进 current', async () => {
  const svc = { list: async () => ROWS, current: () => 'oops', config: { default: 'standard' } }
  const r = await catalogOf(svc)
  assert.equal(r.current, 'standard', '函数必须跳过，不能 String 成源码')
  assert.ok(!r.current.includes('=>'), 'current 里混进了函数源码')
})

let liveSeq = 0

async function liveOf(svcOrFn, settings) {
  const pick = () => (typeof svcOrFn === 'function' ? svcOrFn() : svcOrFn)
  const routes = {}
  const conn = { fetch: { register: (r) => { routes[r.path] = r; return () => {} } } }
  const ctl = {
    projections: async () => ({ asOfSeq: 0, values: { title: '', turnOutline: [] } }),
    list: async () => ({ items: [] }),
  }
  let cleanup = null
  const ctx = {
    get: (n) => {
      if (n === 'connection') return conn
      if (n === 'sessionController') return ctl
      if (n === 'agents') return { get: () => null }
      if (n === 'settings') return settings || { update: async () => {}, namespace: () => null }
      if (n === 'agentPresets') return pick()
      return null
    },
    on: () => () => {},
    effect: (fn) => { cleanup = fn; return () => {} },
  }
  const mod = await import('../index.js?t=' + Math.random())

  await mod.apply(ctx, { port: 19301 + (liveSeq++ * 2), allowShiftPort: true })
  const stateRoute = routes['/api/dsh-console/state']
  assert.ok(stateRoute, '/api/dsh-console/state 必须注册上')
  const panel = await (await stateRoute.fetch(
    new Request('http://127.0.0.1/api/dsh-console/state?light=1')
  )).json()
  assert.ok(panel.port > 0, 'panelData 必须给出真实监听端口')
  const hdr = { 'x-dsh-console-token': panel.token }
  const base = 'http://127.0.0.1:' + panel.port
  return {
    info: async () => {
      const r = await fetch(base + '/dsh-console/info', { headers: hdr })
      assert.equal(r.status, 200)
      return r.json()
    },
    cmd: async (op, payload) => {
      const r = await routes['/api/dsh-console/cmd'].fetch(
        new Request('http://x', { method: 'POST', body: JSON.stringify({ op, payload }) })
      )
      return { status: r.status, body: await r.json() }
    },
    close: () => { if (cleanup) cleanup()() },
  }
}

test('④-a selectPreset（空 sid，全局默认）后 /info 立刻变新值，且与 presetCatalog 同口径', async () => {
  let current = 'ptc'
  const updates = []

  const settings = {
    update: async (ns, val) => { updates.push({ ns, val }); current = val.selectedDefault },
    namespace: () => null,
  }
  const svc = { list: async () => ROWS, config: { default: 'standard', selectedDefault: { get: () => current } } }
  const live = await liveOf(svc, settings)
  try {
    const before = await live.info()
    assert.equal(before.agentPreset, 'ptc', '初始默认应该是 ptc')
    assert.equal(before.agentPresetAvailable, true)
    const cat0 = await live.cmd('presetCatalog', {})
    assert.equal(cat0.body.result.current, 'ptc')

    const { status, body } = await live.cmd('selectPreset', { presetId: 'minimal' })
    assert.equal(status, 200)
    assert.equal(body.result.selected, 'minimal')
    assert.equal(body.result.scope, 'global')
    assert.equal(updates.length, 1, '全局默认必须真的写进 settings')

    const after = await live.info()
    assert.equal(after.agentPreset, 'minimal',
      '主修点：getInfo 吃了 probePreset 的一次性 probed 缓存 ⇒ 这里会返旧值 ptc')
    assert.equal(after.agentPresetAvailable, true)
    const cat1 = await live.cmd('presetCatalog', {})
    assert.equal(cat1.body.result.current, after.agentPreset, '/info 与 presetCatalog 必须同口径')
  } finally {
    live.close()
  }
})

test('④-b 不经 selectPreset、外部改掉全局默认（如电脑端设置页）也立刻反映', async () => {
  let current = 'ptc'
  const svc = { list: async () => ROWS, config: { default: 'standard', selectedDefault: { get: () => current } } }
  const live = await liveOf(svc)
  try {
    assert.equal((await live.info()).agentPreset, 'ptc')
    current = 'cordis'
    assert.equal((await live.info()).agentPreset, 'cordis', '第二次 /info 还在吐缓存值')
  } finally {
    live.close()
  }
})

test('④-c 服务取不到 ⇒ /info 回落空串 + available:false（不拿旧值硬撑）', async () => {
  let svc = { list: async () => ROWS, defaultId: 'ptc' }
  const live = await liveOf(() => svc)
  try {
    const a = await live.info()
    assert.equal(a.agentPreset, 'ptc')
    assert.equal(a.agentPresetAvailable, true)
    svc = null
    const b = await live.info()
    assert.equal(b.agentPreset, '', '服务没了还吐旧值 = 假数据')
    assert.equal(b.agentPresetAvailable, false)
  } finally {
    live.close()
  }
})

