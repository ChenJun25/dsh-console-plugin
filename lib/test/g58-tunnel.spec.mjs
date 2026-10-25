import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tomlText, writeToml, readTunnelConfig, pickProxyName, TUNNEL_AUTO_PATH } from '../tunnel.mjs'
import { createCloudLink, DEFAULT_CLOUD_BASE, DEFAULT_STORE_FILE } from '../cloud-link.mjs'
import { startLanServer } from '../lan-server.mjs'

const SHORT = 'A1B2C3D4E5F6G7H'

const OTHER = 'Z9Y8X7W6V5U4T3S'
const TOKEN = 'TOK-G58'

let tmpSeq = 0

const TMP_DIRS = []

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-g58-' + (tmpSeq++) + '-'))
  TMP_DIRS.push(d)
  return d
}
after(() => {
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (_) {} }
})
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(obj, null, 2))
}
function readJson(p) { return JSON.parse(String(fs.readFileSync(p, 'utf8')).replace(/^\uFEFF/, '')) }

const cloudTunnel = (over = {}) => Object.assign({
  name: 'dsh-' + SHORT,
  type: 'http',
  customDomains: ['gaoshou25.cn'],
  locations: ['/dsh-console/' + SHORT],
  publicUrl: 'https://gaoshou25.cn/dsh-console/' + SHORT,
  serverAddr: '118.178.129.217',
  serverPort: 7000,
  authToken: 'XWGlpO4EJhVJxKc9IUjX1bA'
}, over)

const autoFile = (over = {}) => Object.assign({ enabled: true }, cloudTunnel(over))

const manualFile = (over = {}) => Object.assign({
  enabled: true, serverAddr: '1.1.1.1', serverPort: 7000, authToken: 'TK-MANUAL',
  localPort: 8899, remotePort: 8899, proxyName: 'dsh-console'
}, over)

function fakeFetch(routes = {}) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url: String(url), init: init || {} })
    const h = routes[String(url).replace(DEFAULT_CLOUD_BASE, '')]
    if (h === undefined) return { status: 200, json: async () => ({ ok: true }) }
    return typeof h === 'function' ? h(url, init) : h
  }
  fn.calls = calls
  return fn
}
const ok200 = (body) => ({ status: 200, json: async () => body })

let portSeq = 0
const nextPort = () => 19701 + (portSeq++ * 2)

const cloudStub = (shortId = SHORT) => ({
  snapshot: () => ({
    ok: true, nodeId: 'node-1', shortId, vipExpireMs: Date.now() + 86400000,
    online: true, lastSeenMs: Date.now(), bound: null, offline: false
  })
})

async function serve(over = {}) {
  const o = Object.assign({
    port: nextPort(),
    allowShift: true,
    log: () => {},
    getToken: () => TOKEN,
    getInfo: () => ({ name: '我的电脑', nodeId: 'dsh-console', host: 'host-1', dshOk: true, version: '0.5.11' }),
    listSessions: async () => [],
    runCommand: async () => ({ ok: true }),
    cloud: cloudStub()
  }, over)
  const srv = startLanServer(o)
  const started = await srv.start()
  assert.ok(started, 'lan server 必须起得来（端口占用且不许顺延时它会 resolve(null)）')
  return { srv, origin: 'http://127.0.0.1:' + started.port }
}

const fromPublic = { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } }

async function rf(url, init) {
  try { return await fetch(url, init) } catch (e) { return await fetch(url, init) }
}

test('tomlText(http) 含 customDomains/locations、不含 remotePort（type="http"）', () => {
  const t = tomlText({
    type: 'http', serverAddr: '118.178.129.217', serverPort: 7000, authToken: 'TK',
    localPort: 8899, proxyName: 'dsh-' + SHORT,
    customDomains: ['gaoshou25.cn'], locations: ['/dsh-console/' + SHORT]
  })
  assert.ok(t.includes('type = "http"'), 'type 必须是 http：\n' + t)
  assert.ok(t.includes('name = "dsh-' + SHORT + '"'), '代理名要按短号唯一（根治 already exists 互踢）')
  assert.ok(t.includes('localIP = "127.0.0.1"'), 'http 代理仍连本机回环')
  assert.ok(t.includes('localPort = 8899'))
  assert.ok(t.includes('customDomains = ["gaoshou25.cn"]'), 'http 必须写 customDomains：\n' + t)
  assert.ok(t.includes('locations = ["/dsh-console/' + SHORT + '"]'), 'locations 必须带本机短号前缀：\n' + t)
  assert.equal(t.includes('remotePort'), false, 'http 绝不许写 remotePort:\n' + t)
  assert.equal(t.includes('type = "tcp"'), false, 'http 不许退化成 tcp')
})

test('tomlText 缺省/ tcp 仍是老格式（老手写配置零回归）', () => {
  const base = { serverAddr: '1.1.1.1', serverPort: 7000, authToken: 'TK', localPort: 8899, remotePort: 8899, proxyName: 'dsh-console' }
  for (const c of [base, Object.assign({}, base, { type: 'tcp' }), Object.assign({}, base, { type: 'TCP' })]) {
    const t = tomlText(c)
    assert.ok(t.includes('type = "tcp"'), '缺省必须还是 tcp：\n' + t)
    assert.ok(t.includes('remotePort = 8899'), 'tcp 必须有 remotePort：\n' + t)
    assert.equal(t.includes('customDomains'), false, 'tcp 不许凭空长出 customDomains')
    assert.equal(t.includes('locations'), false, 'tcp 不许凭空长出 locations')
  }
})

test('writeToml 真写文件：无 BOM + 内容就是 tomlText 的字节', () => {
  const dir = tmpDir()
  const out = path.join(dir, 'dsh-console-frpc.toml')
  const c = {
    type: 'http', serverAddr: '118.178.129.217', serverPort: 7000, authToken: 'TK',
    localPort: 8899, proxyName: 'dsh-' + SHORT,
    customDomains: ['gaoshou25.cn'], locations: ['/dsh-console/' + SHORT]
  }
  writeToml(c, out)
  const buf = fs.readFileSync(out)
  assert.equal(buf[0], 0x23, '首字节必须是 #（0x23）；第一字节是 0xEF 说明写了 BOM，frpc 会当 JSON 崩')
  assert.notDeepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF], '文件头不许是 UTF-8 BOM')
  assert.ok(buf.toString('utf8').includes('locations = ["/dsh-console/' + SHORT + '"]'))
  assert.equal(buf.toString('utf8'), tomlText(c), '写盘内容必须逐字等于 tomlText()')

})

test('只有云端自动文件 ⇒ 合并后 enabled=true（新用户装上即有隧道，不再静默关闭）', () => {
  const dir = tmpDir()
  const auto = path.join(dir, 'dsh-console-tunnel.auto.json')
  writeJson(auto, autoFile())
  const r = readTunnelConfig(path.join(dir, 'dsh-console-tunnel.json'), auto)
  assert.equal(r.exists, true, '自动文件在场 ⇒ 不许走「没有配置文件就关闭」那条老路')
  assert.equal(r.manual, null)
  assert.equal(r.merged.enabled, true)
  assert.equal(r.merged.type, 'http')
  assert.deepEqual(r.merged.locations, ['/dsh-console/' + SHORT])
  assert.deepEqual(r.merged.customDomains, ['gaoshou25.cn'])
  assert.equal(r.merged.authToken, 'XWGlpO4EJhVJxKc9IUjX1bA', '连接参数随 tunnel 一起下发（新用户零手工）')
})

test('手写打底 + 自动优先：云端值覆盖同名键，手写独有键保留（绝不写回手写文件）', () => {
  const dir = tmpDir()
  const man = path.join(dir, 'dsh-console-tunnel.json')
  const auto = path.join(dir, 'dsh-console-tunnel.auto.json')
  writeJson(man, manualFile())
  writeJson(auto, autoFile())
  const r = readTunnelConfig(man, auto)
  assert.equal(r.merged.serverAddr, '118.178.129.217', '自动文件优先：云端 serverAddr 盖过手写的 1.1.1.1')
  assert.equal(r.merged.proxyName, 'dsh-console', '自动文件没给的键保留手写值')
  assert.deepEqual(r.merged.locations, ['/dsh-console/' + SHORT])
  assert.equal(fs.readFileSync(man, 'utf8'), JSON.stringify(manualFile(), null, 2),
    '合并只是内存里的事，手写文件一个字节都不许动')
  assert.equal(TUNNEL_AUTO_PATH.endsWith('.auto.json'), true, '自动文件与手写文件必须是两个路径')
})

test('两处都没有 ⇒ exists=false（老行为：静默关闭）', () => {
  const dir = tmpDir()
  const r = readTunnelConfig(path.join(dir, 'nope.json'), path.join(dir, 'nope.auto.json'))
  assert.equal(r.exists, false)
  assert.equal(r.merged, null)
})

test('手写文件坏成非 JSON + 自动文件好 ⇒ 自动文件救场（manualBroken 仍如实上报）', () => {
  const dir = tmpDir()
  const man = path.join(dir, 'dsh-console-tunnel.json')
  const auto = path.join(dir, 'dsh-console-tunnel.auto.json')
  fs.writeFileSync(man, '{ 这不是 JSON')
  writeJson(auto, autoFile())
  const r = readTunnelConfig(man, auto)
  assert.equal(r.manualBroken, true)
  assert.equal(r.autoBroken, false)
  assert.equal(r.merged.enabled, true, '手写坏了不该连累云端下发的整条隧道')
  assert.deepEqual(r.merged.locations, ['/dsh-console/' + SHORT])
})

test('两份都坏 ⇒ merged=null（调用方据此打 error phase，不静默）', () => {
  const dir = tmpDir()
  const man = path.join(dir, 'dsh-console-tunnel.json')
  const auto = path.join(dir, 'dsh-console-tunnel.auto.json')
  fs.writeFileSync(man, '[1,2,3]')
  fs.writeFileSync(auto, 'null')
  const r = readTunnelConfig(man, auto)
  assert.equal(r.merged, null)
  assert.equal(r.manualBroken, true, '合法 JSON 但不是对象 ⇒ 也算坏（不许当配置用）')
  assert.equal(r.autoBroken, true)
})

test('云端文件里只有 name（没有 proxyName）⇒ 仍生成按短号唯一的代理名', () => {
  const dir = tmpDir()
  const auto = path.join(dir, 'dsh-console-tunnel.auto.json')
  writeJson(auto, autoFile())
  const r = readTunnelConfig(path.join(dir, 'nope.json'), auto)
  assert.equal(r.merged.proxyName, undefined, '云端只下发 name（cloud.py 的字段名）')
  assert.equal(r.merged.name, 'dsh-' + SHORT)

  const t = tomlText(Object.assign({}, r.merged, {
    localPort: 8899,
    proxyName: pickProxyName(r.merged)
  }))
  assert.ok(t.includes('name = "dsh-' + SHORT + '"'), '代理名必须落到短号上：\n' + t)
})

test('register 带回 tunnel ⇒ 自动文件落盘（enabled 由插件写死 true），返回值不加新键', async () => {
  const dir = tmpDir()
  const store = path.join(dir, 'dsh-console-cloud.json')
  const auto = path.join(dir, 'dsh-console-tunnel.auto.json')
  const ff = fakeFetch({ '/register': ok200({ ok: true, shortId: SHORT, vipExpireMs: Date.now() + 86400000, tunnel: cloudTunnel() }) })
  const c = createCloudLink({ autoStart: false, storePath: store, autoPath: auto, fetch: ff })
  const r = await c.register()
  assert.equal(r.ok, true)
  assert.equal(r.shortId, SHORT)
  assert.deepEqual(Object.keys(r).sort(), ['allow', 'ok', 'shortId', 'vipDays', 'vipExpireMs'],
    'register() 的返回形状是既有契约（cloud-link.spec.mjs 有严格断言），一个字都不许加')
  assert.equal(fs.existsSync(auto), true, '云端下发 tunnel ⇒ 必须落盘自动文件（装上即自动有隧道）')
  const j = readJson(auto)
  assert.equal(j.enabled, true, '插件写死 true：云端值没有开关权限（enabled 归用户手写文件）')
  assert.equal(j.type, 'http')
  assert.equal(j.name, 'dsh-' + SHORT)
  assert.deepEqual(j.locations, ['/dsh-console/' + SHORT])
  assert.deepEqual(j.customDomains, ['gaoshou25.cn'])
  assert.equal(j.serverAddr, '118.178.129.217')
  assert.equal(j.authToken, 'XWGlpO4EJhVJxKc9IUjX1bA')
  assert.notEqual(auto, store, '自动文件与 store 是两个文件')
})

test('云端没下发 tunnel（窄响应 / 老云端）⇒ 不新建也不清空已有自动文件', async () => {
  const dir = tmpDir()
  const auto = path.join(dir, 'dsh-console-tunnel.auto.json')

  writeJson(auto, autoFile())
  const before = fs.readFileSync(auto, 'utf8')
  const ff = fakeFetch({ '/register': ok200({ ok: true, shortId: SHORT, vipExpireMs: 1 }) })
  const c = createCloudLink({ autoStart: false, storePath: path.join(dir, 'cloud.json'), autoPath: auto, fetch: ff })
  await c.register()
  assert.equal(ff.calls.length, 1, '必须真打了云端（不然这条用例什么都没验到）')
  assert.equal(fs.readFileSync(auto, 'utf8'), before, '没有 tunnel 字段 ⇒ 自动文件保持原样')
})

test('端到端：register 落盘的短号，就是 lan-server 会认的那个前缀', async () => {
  const dir = tmpDir()
  const ff = fakeFetch({ '/register': ok200({ ok: true, shortId: SHORT, vipExpireMs: Date.now() + 86400000, tunnel: cloudTunnel() }) })
  const c = createCloudLink({ autoStart: false, storePath: path.join(dir, 'cloud.json'), autoPath: path.join(dir, 'auto.json'), fetch: ff })
  await c.register()
  const s = await serve({ cloud: c })
  try {
    const r = await rf(s.origin + '/dsh-console/' + SHORT + '/info?token=' + TOKEN, fromPublic)
    assert.equal(r.status, 200, '云端下发的短号必须能被本机路由认掉（两个模块同一份 shortId）')
  } finally { await s.srv.stop() }
})

test('公网 /dsh-console/<本机短号>/info ⇒ 200（前缀被正确剥离）', async () => {
  const s = await serve()
  try {
    const r = await rf(s.origin + '/dsh-console/' + SHORT + '/info?token=' + TOKEN, fromPublic)
    assert.equal(r.status, 200, '剥完必须落到 /info；剥不干净会剩 /<shortId>/info ⇒ 401/404')
    const j = await r.json()
    assert.equal(j.ok, true)
    assert.equal(j.cloud.shortId, SHORT)
  } finally { await s.srv.stop() }
})

test('公网 /dsh-console/<别人短号>/info ⇒ 404，且抢在访问码校验之前', async () => {
  const s = await serve()
  try {
    const r = await rf(s.origin + '/dsh-console/' + OTHER + '/info?token=' + TOKEN, fromPublic)
    assert.equal(r.status, 404, '别人的短号绝不许被剥成本机路径（否则别人的号能读本机会话）')
    const j = await r.json()
    assert.equal(j.ok, false)
    assert.ok(String(j.error).includes(OTHER), '文案要指出这个短号不是这台机器的')

    const r2 = await rf(s.origin + '/dsh-console/' + OTHER + '/info', fromPublic)
    assert.equal(r2.status, 404)
  } finally { await s.srv.stop() }
})

test('空前缀老路径 /dsh-console/info ⇒ 200（老客户端零回归）', async () => {
  const s = await serve()
  try {
    assert.equal((await rf(s.origin + '/dsh-console/info?token=' + TOKEN, fromPublic)).status, 200)
    assert.equal((await rf(s.origin + '/dsh-console/sessions?token=' + TOKEN, fromPublic)).status, 200)

    const post = { method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, fromPublic.headers),
      body: JSON.stringify({ op: 'noop' }) }
    assert.equal((await rf(s.origin + '/dsh-console/cmd?token=' + TOKEN, post)).status, 200)
  } finally { await s.srv.stop() }
})

test('更老前缀 /dafeiyu/info ⇒ 200（改名前的老包仍能用）', async () => {
  const s = await serve()
  try {
    assert.equal((await rf(s.origin + '/dafeiyu/info?token=' + TOKEN, fromPublic)).status, 200)
    assert.equal((await rf(s.origin + '/dafeiyu/' + SHORT + '/info?token=' + TOKEN, fromPublic)).status, 200)
    assert.equal((await rf(s.origin + '/dafeiyu/' + OTHER + '/info?token=' + TOKEN, fromPublic)).status, 404)
  } finally { await s.srv.stop() }
})

test('局域网直连（无转发头）+ 本机短号 ⇒ 200；别人短号 ⇒ 404', async () => {
  const s = await serve()
  try {
    assert.equal((await rf(s.origin + '/dsh-console/' + SHORT + '/info?token=' + TOKEN)).status, 200)
    assert.equal((await rf(s.origin + '/dsh-console/' + OTHER + '/info?token=' + TOKEN)).status, 404)
  } finally { await s.srv.stop() }
})

test('本机还没短号（未绑定）⇒ 带 15 位段的路径一律 404，空段仍可用', async () => {
  const s = await serve({ cloud: cloudStub('') })
  try {
    assert.equal((await rf(s.origin + '/dsh-console/' + SHORT + '/info?token=' + TOKEN, fromPublic)).status, 404)
    assert.equal((await rf(s.origin + '/dsh-console/info?token=' + TOKEN, fromPublic)).status, 200)
  } finally { await s.srv.stop() }
})

test('段不是 15 位短号（老客户端 / 老前缀）⇒ 照旧剥到第一层，不受影响', async () => {
  const s = await serve()
  try {

    assert.equal((await rf(s.origin + '/dsh-console/info?token=' + TOKEN, fromPublic)).status, 200)
    const r = await rf(s.origin + '/dsh-console/ab12cd/info?token=' + TOKEN, fromPublic)
    assert.equal(r.status, 404, '非 15 位段 ⇒ 剥成 /ab12cd/info，落兜底 404（不是短号判定那条）')
  } finally { await s.srv.stop() }
})

test('#G58B http：手写 proxyName="dsh-console" 会压过云端 name ⇒ 必须取 name（多机互踢根治点）', () => {
  const dir = tmpDir()
  const manual = path.join(dir, 'manual.json')
  const auto = path.join(dir, 'dsh-console-tunnel.auto.json')
  writeJson(manual, manualFile())
  writeJson(auto, autoFile())
  const r = readTunnelConfig(manual, auto)
  assert.equal(r.merged.proxyName, 'dsh-console', '合并层保真：手写 proxyName 仍在（auto 没给这个键）')
  assert.equal(r.merged.name, 'dsh-' + SHORT)
  assert.equal(r.merged.type, 'http')
  const picked = pickProxyName(r.merged)
  const t = tomlText(Object.assign({}, r.merged, { localPort: 8899, proxyName: picked }))
  assert.equal(picked, 'dsh-' + SHORT, 'http 下代理名必须落到云端短号名，否则同一台 frps 多机 already exists')
  assert.ok(t.includes('name = "dsh-' + SHORT + '"'), 'toml 代理名不对：' + t)
  assert.ok(!t.includes('name = "dsh-console"'), '不许再落到全局同名 dsh-console：' + t)
})

test('#G58B tcp：手写 proxyName="dsh-console" 仍是第一优先（老手写配置零回归）', () => {
  const dir = tmpDir()
  const manual = path.join(dir, 'manual.json')
  writeJson(manual, manualFile())
  const r = readTunnelConfig(manual, path.join(dir, 'nope-auto.json'))
  assert.equal(r.merged.type, undefined, '老手写文件里没有 type')
  const picked = pickProxyName(r.merged)
  const t = tomlText(Object.assign({}, r.merged, { localPort: 8899, proxyName: picked }))
  assert.equal(picked, 'dsh-console')
  assert.ok(t.includes('name = "dsh-console"'), t)
  assert.ok(t.includes('type = "tcp"'), t)
  assert.ok(t.includes('remotePort = 8899'), t)
})

test('#G58B tcp：手写里再多个 name 也抢不走代理名', () => {
  const dir = tmpDir()
  const manual = path.join(dir, 'manual.json')
  writeJson(manual, manualFile({ proxyName: 'dsh-old', name: 'dsh-should-lose' }))
  const r = readTunnelConfig(manual, path.join(dir, 'nope-auto.json'))
  assert.equal(pickProxyName(r.merged), 'dsh-old', 'tcp 分支永不被 name 抢走')
})
