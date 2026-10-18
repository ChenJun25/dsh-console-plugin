import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startLanServer } from '../lan-server.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, ms = 3000) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(20)
  }
}

function withEnv(kv) {
  const old = {}
  for (const [k, v] of Object.entries(kv)) {
    old[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return () => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const freshIndex = () => import('../index.js?t=' + Math.random())

let regSeq = 0

async function fakeRegistry({ version = '9.9.9', delayMs = 0, status = 200, body } = {}) {
  const hits = []
  const srv = http.createServer((req, res) => {
    hits.push(req.url)
    const reply = () => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body !== undefined ? body : JSON.stringify({ name: 'dsh-console-plugin', version }))
    }
    if (delayMs) setTimeout(reply, delayMs)
    else reply()
  })
  await new Promise((r) => srv.listen(21601 + (regSeq++ * 2), '127.0.0.1', r))
  return {
    url: 'http://127.0.0.1:' + srv.address().port + '/dsh-console-plugin/latest',
    hits,
    close: () => new Promise((r) => srv.close(r)),
  }
}

test('① 刷新成功后缓存到 version；TTL 内不再重复打 registry', async () => {
  const reg = await fakeRegistry({ version: '0.9.9' })
  const restore = withEnv({ DSH_CONSOLE_NPM_LATEST_URL: reg.url, DSH_CONSOLE_NPM_TTL_MS: '60000' })
  try {
    const mod = await freshIndex()
    assert.equal(mod.latestVersionNow(), '', '新实例初始缓存必须是空串')
    mod.refreshLatestVersion()
    assert.equal(await waitFor(() => mod.latestVersionNow()), '0.9.9', '成功响应后要缓存 version')
    assert.equal(reg.hits.length, 1, '一次刷新只该打一次 registry')
    mod.refreshLatestVersion()
    mod.refreshLatestVersion()
    await sleep(150)
    assert.equal(reg.hits.length, 1, 'TTL 内不许再打 registry（防猛打）')
  } finally {
    restore()
    await reg.close()
  }
})

test('② registry 挂了：静默、保留旧值、不抛错', async () => {
  const reg = await fakeRegistry({ version: '0.9.9' })
  const restore = withEnv({ DSH_CONSOLE_NPM_LATEST_URL: reg.url, DSH_CONSOLE_NPM_TTL_MS: '60000' })
  try {
    const mod = await freshIndex()
    mod.refreshLatestVersion()
    assert.equal(await waitFor(() => mod.latestVersionNow()), '0.9.9')
    await reg.close()
    process.env.DSH_CONSOLE_NPM_TTL_MS = '1'
    assert.doesNotThrow(() => mod.refreshLatestVersion(), '网络失败绝不许往上抛')
    await sleep(250)
    assert.equal(mod.latestVersionNow(), '0.9.9', '拿不到新号时必须保留旧值，不许清空')
  } finally {
    restore()
  }
})

test('②-b registry 返 500 / 非 JSON：值留空串，不抛错', async () => {
  const r500 = await fakeRegistry({ status: 500, body: 'boom' })
  const rBad = await fakeRegistry({ status: 200, body: 'not-json' })
  const restore = withEnv({ DSH_CONSOLE_NPM_LATEST_URL: r500.url, DSH_CONSOLE_NPM_TTL_MS: '60000' })
  try {
    const mod = await freshIndex()
    mod.refreshLatestVersion()
    await sleep(250)
    assert.equal(mod.latestVersionNow(), '', '500 时缓存保持空串')
    process.env.DSH_CONSOLE_NPM_LATEST_URL = rBad.url
    process.env.DSH_CONSOLE_NPM_TTL_MS = '1'
    assert.doesNotThrow(() => mod.refreshLatestVersion())
    await sleep(250)
    assert.equal(mod.latestVersionNow(), '', 'JSON 解析失败也要静默')
  } finally {
    restore()
    await r500.close()
    await rBad.close()
  }
})

test('③ 单测环境没给 URL ⇒ 跳过网络（不许真打 registry）', async () => {
  const restore = withEnv({ DSH_CONSOLE_NPM_LATEST_URL: undefined })
  try {
    const mod = await freshIndex()
    assert.doesNotThrow(() => mod.refreshLatestVersion())
    await sleep(200)
    assert.equal(mod.latestVersionNow(), '', '没 URL 就该直接跳过，缓存保持空串')
  } finally {
    restore()
  }
})

let portSeq = 0

async function serve(over = {}) {
  const o = Object.assign({
    port: 21551 + (portSeq++ * 2),
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
  assert.ok(started, 'lan server 必须起得来')
  return { base: 'http://127.0.0.1:' + started.port, close: () => srv.stop() }
}

const infoOf = async (base) => {
  const r = await fetch(base + '/dsh-console/info', { headers: { 'x-dsh-console-token': 'TOK' } })
  assert.equal(r.status, 200)
  return r.json()
}

const OLD_KEYS = ['name', 'nodeId', 'host', 'dshOk', 'dshError', 'version', 'ports']
const FALLBACK_KEYS = ['name', 'nodeId', 'host', 'dshOk', 'ports']
const oldKeysAllThere = (j, keys = OLD_KEYS) => {
  for (const k of keys) {
    assert.ok(Object.prototype.hasOwnProperty.call(j, k), '老字段丢了: ' + k)
  }
}

test('④ getInfo 带 latestVersion ⇒ /info 原样下发（那类白名单漏字段的复现点）', async () => {
  const s = await serve({ getInfo: () => ({ name: '机器', dshOk: true, latestVersion: '0.9.9' }) })
  try {
    const j = await infoOf(s.base)
    assert.equal(j.ok, true)
    assert.equal(j.latestVersion, '0.9.9', 'latestVersion 被 safeInfo 白名单丢了')
    oldKeysAllThere(j)
  } finally {
    s.close()
  }
})

test('⑤ getInfo 不给 / getInfo 抛错 ⇒ 键仍在且是空串（不是 undefined）', async () => {
  const s1 = await serve({ getInfo: () => ({ name: '机器', dshOk: true }) })
  try {
    const a = await infoOf(s1.base)
    assert.ok(Object.prototype.hasOwnProperty.call(a, 'latestVersion'),
      '键必须存在，否则客户端读到 undefined 显示“未知”')
    assert.equal(a.latestVersion, '', '没拿到号时给空串')
    oldKeysAllThere(a)
  } finally {
    s1.close()
  }
  const s2 = await serve({ getInfo: () => { throw new Error('boom') } })
  try {
    const b = await infoOf(s2.base)
    assert.equal(b.ok, true, 'getInfo 抛错时 /info 仍要 200')
    assert.equal(b.latestVersion, '', '兜底分支同样给空串')
    oldKeysAllThere(b, FALLBACK_KEYS)
  } finally {
    s2.close()
  }
})

let liveSeq = 0

async function live() {
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
      if (n === 'settings') return { update: async () => {}, namespace: () => null }
      if (n === 'agentPresets') return null
      return null
    },
    on: () => () => {},
    effect: (fn) => { cleanup = fn; return () => {} },
  }
  const mod = await import('../index.js?t=' + Math.random())

  await mod.apply(ctx, { port: 21701 + (liveSeq++ * 2), allowShiftPort: true })
  const stateRoute = routes['/api/dsh-console/state']
  assert.ok(stateRoute, '/api/dsh-console/state 必须注册上')
  const panel = await (await stateRoute.fetch(
    new Request('http://127.0.0.1/api/dsh-console/state?light=1')
  )).json()
  assert.ok(panel.port > 0, 'panelData 必须给出真实监听端口')
  const hdr = { 'x-dsh-console-token': panel.token }
  const base = 'http://127.0.0.1:' + panel.port
  return {
    mod,
    info: async () => (await fetch(base + '/dsh-console/info', { headers: hdr })).json(),
    close: () => { if (cleanup) cleanup()() },
  }
}

test('⑥ 首个 /info 不许等 registry（空串立刻回），随后自己补上号且 TTL 内只打一次', async () => {
  const reg = await fakeRegistry({ version: '0.9.9', delayMs: 400 })
  const restore = withEnv({ DSH_CONSOLE_NPM_LATEST_URL: reg.url, DSH_CONSOLE_NPM_TTL_MS: '60000' })
  const L = await live()
  try {
    const t0 = Date.now()
    const a = await L.info()
    const dt = Date.now() - t0
    assert.equal(a.latestVersion, '', '首个 /info 缓存还空着，只能是空串')
    assert.ok(dt < 300, '请求路径被 registry 拖住了（fire-and-forget 破了）: ' + dt + 'ms')
    oldKeysAllThere(a)

    await sleep(600)
    const b = await L.info()
    assert.equal(b.latestVersion, '0.9.9', '后台拿到号之后 /info 必须补上新值')
    assert.equal(reg.hits.length, 1, 'TTL 内只该打一次 registry')
    await L.info()
    await L.info()
    await sleep(150)
    assert.equal(reg.hits.length, 1, '连续打 /info 不许把 registry 打爆')
  } finally {
    restore()
    L.close()
    await reg.close()
  }
})
