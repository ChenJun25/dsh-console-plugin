/**
 * task-1 单测（插件半 · 第131节 · 云链路）：cloud-link.mjs + lan-server 的三条云路由。
 *
 * 验的是合同，不是实现：
 *   ① cloud-link 对云的四个 POST（register/bind/redeem/status）—— 超时、断网、HTTP 500、
 *      非 JSON 全都要**永不抛**，并归一成 { ok:false, error }；
 *   ② snapshot() 永不抛（面板/App 靠它，云端挂了也不能让插件崩）；
 *   ③ nodeId + 缓存的 shortId/vipExpireMs/绑定 要落盘（重启后离线也能显示上次的公网短 ID）；
 *   ④ 心跳：默认 60s、首拍延迟 3s、timer.unref()、上一发没回来时跳过这一拍；
 *   ⑤ lan-server：GET /cloud/status、POST /cloud/bind、POST /cloud/redeem、/info.cloud ——
 *      没配 cloud 给 503 / null，云端炸了也**绝不 500**；nodeId 不进任何响应。
 *
 * 跑法：node --test --test-force-exit lib/test/cloud-link.spec.mjs
 * ⚠️ 全程不碰真云端：cloud-link 一律传 autoStart:false + 注入假 fetch。
 * ⚠️ 端口段 19501 起，与 preset-info(18901) / device-roster(19101) / sec-gate(19301) 错开。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createCloudLink,
  newRawNodeId,
  isValidNodeId,
  DEFAULT_CLOUD_BASE,
  HEARTBEAT_MS,
  FIRST_TICK_MS,
  DEFAULT_STORE_FILE
} from '../cloud-link.mjs'
import { startLanServer } from '../lan-server.mjs'

/* ---------------- 夹具 ---------------- */

let tmpSeq = 0
/** 每个用例一个独立 storePath（临时目录），互不干扰。 */
function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cloud-' + (tmpSeq++) + '-'))
  return path.join(dir, 'dsh-console-cloud.json')
}

let portSeq = 0
const nextPort = () => 19501 + (portSeq++ * 2)

/**
 * 假 fetch：按云端**相对路径**取预设响应，并把每次调用记下来。
 * 预设值可是对象（直接当 Response 用）或函数（url, init）=&gt; Response。
 */
function fakeFetch(routes = {}) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url: String(url), init: init || {} })
    const key = String(url).replace(DEFAULT_CLOUD_BASE, '')
    const h = routes[key]
    if (h === undefined) return { status: 200, json: async () => ({ ok: true }) }
    return typeof h === 'function' ? h(url, init) : h
  }
  fn.calls = calls
  return fn
}

/** 云端某个接口的 200 响应。 */
const ok200 = (body) => ({ status: 200, json: async () => body })
/** 永不回来的响应：专门验超时（配合 timeoutMs 很小的实例）。 */
function hang(url, init) {
  return new Promise((_res, rej) => {
    const sig = init && init.signal
    const boom = () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e) }
    if (sig) {
      if (sig.aborted) boom()
      else sig.addEventListener('abort', boom)
    }
  })
}

/** 起一个真 lan-server（照 device-roster.spec.mjs 的 serve 模式）。 */
async function serve(over = {}) {
  const o = Object.assign({
    port: nextPort(),
    allowShift: true,
    log: () => {},
    getToken: () => 'TOK',
    getInfo: () => ({ name: '我的电脑', nodeId: 'dsh-console', host: 'host-1', dshOk: true,
      dshError: '', version: '9.9.9', agentPreset: 'ptc', agentPresetAvailable: true }),
    listSessions: async () => [],
    runCommand: async () => ({ ok: true })
  }, over)
  const srv = startLanServer(o)
  const started = await srv.start()
  assert.ok(started, 'lan server 必须起得来')
  return { srv, base: 'http://127.0.0.1:' + started.port + '/dsh-console', close: () => srv.stop() }
}

const TOK = { 'x-dsh-console-token': 'TOK' }
/** 带访问码请求 lan-server，返回 { status, body }。 */
async function req(url, init = {}) {
  const r = await fetch(url, Object.assign({}, init, {
    headers: Object.assign({}, TOK, init.headers || {})
  }))
  let body = null
  try { body = await r.json() } catch (e) { body = null }
  return { status: r.status, body }
}

/** 假云链路：形状与真 cloud-link 的冻结面一致，方便逐条造异常。 */
function fakeCloud(over = {}) {
  const calls = []
  const base = {
    calls,
    snapshot: () => ({
      ok: true,
      nodeId: 'node-secret-xyz',
      shortId: 'A1B2C3D4E5F6G7H',
      vipExpireMs: 1790000000000,
      online: true,
      offline: false,
      lastSeenMs: 1780000000000,
      bound: { uid: 'u1', name: '小主', avatar: 'https://a/b.png', ms: 123 }
    }),
    bind: async (u) => { calls.push(['bind', u]); return { ok: true, shortId: 'A1B2C3D4E5F6G7H', vipExpireMs: 1790000000000 } },
    redeem: async (code) => { calls.push(['redeem', code]); return { ok: false, error: '体验码已被使用' } },
    tick: async () => ({ ok: true })
  }
  return Object.assign(base, over)
}

/* ================= ① cloud-link：常量与 nodeId ================= */

test('常量：云基址 / 心跳 60s / 首拍 3s / storePath 落 ~/.dsh', () => {
  assert.ok(/^https:\/\/[^\/]+\/api\/cloud$/.test(DEFAULT_CLOUD_BASE), '默认云基址形状必须是 https://<host>/api/cloud')
  assert.equal(HEARTBEAT_MS, 60000)
  assert.equal(FIRST_TICK_MS, 3000)
  assert.ok(DEFAULT_STORE_FILE.endsWith(path.join('.dsh', 'dsh-console-cloud.json')), DEFAULT_STORE_FILE)
})

test('nodeId 工具：32 位十六进制；校验只认 8~64 位字母数字', () => {
  const id = newRawNodeId()
  assert.match(id, /^[0-9a-f]{32}$/)
  assert.ok(isValidNodeId(id))
  assert.equal(isValidNodeId('short'), false)
  assert.equal(isValidNodeId('a'.repeat(65)), false)
  assert.equal(isValidNodeId('has space!!'), false)
  assert.equal(isValidNodeId(null), false)
})

test('nodeId 生成后落盘，第二个实例读回同一个（重启不换身份）', () => {
  const file = tmpStore()
  const a = createCloudLink({ autoStart: false, storePath: file, fetch: fakeFetch() })
  const id1 = a.snapshot().nodeId
  assert.ok(isValidNodeId(id1))
  assert.ok(fs.existsSync(file), 'storePath 必须被写出来')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(raw.nodeId, id1)
  const b = createCloudLink({ autoStart: false, storePath: file, fetch: fakeFetch() })
  assert.equal(b.snapshot().nodeId, id1)
  assert.equal(a.snapshot().shortId, '')
  assert.equal(a.snapshot().offline, true)
})

test('落盘文件坏了（半截 JSON / 不是对象）也照起不误，重新生成 nodeId', () => {
  const file = tmpStore()
  fs.writeFileSync(file, '{ 这不是 JSON')
  const a = createCloudLink({ autoStart: false, storePath: file, fetch: fakeFetch() })
  assert.ok(isValidNodeId(a.snapshot().nodeId))
  fs.writeFileSync(file, '[1,2,3]')
  const b = createCloudLink({ autoStart: false, storePath: file, fetch: fakeFetch() })
  assert.ok(isValidNodeId(b.snapshot().nodeId))
})

test('config.cloud.nodeId 与 DSH_CLOUD_API 都被认（env 覆盖默认基址）', () => {
  const file = tmpStore()
  const id = 'cfg-node-1234'
  const a = createCloudLink({ autoStart: false, storePath: file, config: { nodeId: id }, fetch: fakeFetch() })
  assert.equal(a.snapshot().nodeId, id)
  const old = process.env.DSH_CLOUD_API
  process.env.DSH_CLOUD_API = 'https://example.test/api/x/'
  try {
    const b = createCloudLink({ autoStart: false, storePath: tmpStore(), fetch: fakeFetch() })
    assert.equal(b.base, 'https://example.test/api/x')
  } finally {
    if (old === undefined) delete process.env.DSH_CLOUD_API
    else process.env.DSH_CLOUD_API = old
  }
})

/* ================= ② cloud-link：对云的四个接口 ================= */

test('register：POST + JSON，带 nodeId 与 platform；解出 shortId/vipExpireMs/allow', async () => {
  const file = tmpStore()
  const ff = fakeFetch({ '/register': ok200({ ok: true, shortId: 'A1B2C3D4E5F6', vipExpireMs: 42, vipDays: 3, allow: true }) })
  const c = createCloudLink({ autoStart: false, storePath: file, fetch: ff })
  const r = await c.register()
  assert.equal(r.ok, true)
  assert.equal(r.shortId, 'A1B2C3D4E5F6')
  assert.equal(r.vipExpireMs, 42)
  assert.equal(r.vipDays, 3)
  assert.equal(r.allow, true)
  assert.equal(ff.calls.length, 1)
  assert.equal(ff.calls[0].url, DEFAULT_CLOUD_BASE + '/register')
  assert.equal(ff.calls[0].init.method, 'POST')
  assert.equal(ff.calls[0].init.headers['content-type'], 'application/json')
  const sent = JSON.parse(ff.calls[0].init.body)
  assert.equal(sent.nodeId, c.snapshot().nodeId)
  assert.equal(sent.platform, process.platform)
  assert.equal(sent.user, undefined)
  /* 幂等：拿到 shortId 后再 register 不再打网络。 */
  const r2 = await c.register()
  assert.equal(r2.cached, true)
  assert.equal(ff.calls.length, 1)
  /* force 才能再发。 */
  await c.register({ force: true })
  assert.equal(ff.calls.length, 2)
})

test('bind：空 user 直接判不完整（不打网络）；成功回 shortId/vipExpireMs', async () => {
  const ff = fakeFetch({ '/bind': ok200({ ok: true, shortId: 'A1B2C3D4E5F6', vipExpireMs: 99 }) })
  const c = createCloudLink({ autoStart: false, storePath: tmpStore(), fetch: ff })
  const bad = await c.bind({})
  assert.equal(bad.ok, false)
  assert.equal(bad.error, '用户信息不完整')
  assert.equal(ff.calls.length, 0)
  const r = await c.bind({ uid: 'u1', name: '小主', avatar: 'https://a/b.png', 垃圾字段: 'x' })
  assert.equal(r.ok, true)
  assert.equal(r.shortId, 'A1B2C3D4E5F6')
  const sent = JSON.parse(ff.calls[0].init.body)
  assert.deepEqual(sent.user, { uid: 'u1', name: '小主', avatar: 'https://a/b.png' })
  assert.equal(sent.user['垃圾字段'], undefined)
  const snap = c.snapshot()
  assert.equal(snap.shortId, 'A1B2C3D4E5F6')
  assert.equal(snap.vipExpireMs, 99)
  assert.deepEqual({ uid: snap.bound.uid, name: snap.bound.name, avatar: snap.bound.avatar },
    { uid: 'u1', name: '小主', avatar: 'https://a/b.png' })
  assert.ok(snap.bound.ms > 0)
})

test('redeem：成功回 addedDays/vipExpireMs；失败原样带回云端文案', async () => {
  const ff = fakeFetch({ '/redeem': ok200({ ok: true, addedDays: 3, vipExpireMs: 1790000000000, shortId: 'A1B2C3D4E5F6' }) })
  const c = createCloudLink({ autoStart: false, storePath: tmpStore(), fetch: ff })
  const r = await c.redeem('A4K7-2MNP-9QRS-3TVW')
  assert.equal(r.ok, true)
  assert.equal(r.addedDays, 3)
  assert.equal(r.vipExpireMs, 1790000000000)
  assert.equal(r.shortId, 'A1B2C3D4E5F6')
  assert.equal(c.snapshot().vipExpireMs, 1790000000000)
  assert.equal(JSON.parse(ff.calls[0].init.body).code, 'A4K7-2MNP-9QRS-3TVW')
  assert.equal((await c.redeem('')).error, '体验码格式不对')
  const ff2 = fakeFetch({ '/redeem': ok200({ ok: false, error: '体验码已被使用' }) })
  const c2 = createCloudLink({ autoStart: false, storePath: tmpStore(), fetch: ff2 })
  const r2 = await c2.redeem('A4K7-2MNP-9QRS-3TVW')
  assert.equal(r2.ok, false)
  assert.equal(r2.error, '体验码已被使用')
  assert.equal(ff2.calls.length, 1)
})

test('status：刷新 shortId/vip/online/lastSeenMs/user', async () => {
  const ff = fakeFetch({ '/status': ok200({ ok: true, shortId: 'A1B2C3D4E5F6', vipExpireMs: 7,
    online: false, lastSeenMs: 123456, user: { uid: 'u9', name: '奈', avatar: '' } }) })
  const c = createCloudLink({ autoStart: false, storePath: tmpStore(), fetch: ff })
  const r = await c.status()
  assert.equal(r.ok, true)
  assert.equal(r.online, false)
  assert.equal(r.lastSeenMs, 123456)
  assert.equal(r.user.uid, 'u9')
  const snap = c.snapshot()
  assert.equal(snap.vipExpireMs, 7)
  assert.equal(snap.bound.name, '奈')
})

test('断网 / HTTP 500 / 非 JSON / 超时：全部归一成 { ok:false, error }，永不抛', async () => {
  const netErr = async () => { throw new Error('connect ECONNREFUSED') }
  const r1 = await createCloudLink({ autoStart: false, storePath: tmpStore(), fetch: netErr }).register()
  assert.equal(r1.ok, false)
  assert.match(r1.error, /^网络错误/)

  const r2 = await createCloudLink({ autoStart: false, storePath: tmpStore(),
    fetch: fakeFetch({ '/register': { status: 500, json: async () => ({ error: '云端炸了' }) } }) }).register()
  assert.equal(r2.ok, false)
  assert.equal(r2.error, '云端炸了')

  const r3 = await createCloudLink({ autoStart: false, storePath: tmpStore(),
    fetch: fakeFetch({ '/register': { status: 502, json: async () => { throw new Error('not json') } } }) }).register()
  assert.equal(r3.error, '云端返回 HTTP 502')

  const r4 = await createCloudLink({ autoStart: false, storePath: tmpStore(),
    fetch: fakeFetch({ '/register': { status: 200, json: async () => [1, 2] } }) }).register()
  assert.equal(r4.error, '云端响应格式不对')

  const r5 = await createCloudLink({ autoStart: false, storePath: tmpStore(), fetch: hang, timeoutMs: 30 }).register()
  assert.equal(r5.ok, false)
  assert.equal(r5.error, '云端超时')
})

test('云端回 200 但 ok:false（业务失败）也算失败，文案照带', async () => {
  const c = createCloudLink({ autoStart: false, storePath: tmpStore(),
    fetch: fakeFetch({ '/register': ok200({ ok: false, error: 'nodeId 不合法' }) }) })
  const r = await c.register()
  assert.equal(r.ok, false)
  assert.equal(r.error, 'nodeId 不合法')
})

test('snapshot() 永不抛：连没有 fetch 的环境也只回 ok:false', async () => {
  const c = createCloudLink({ autoStart: false, storePath: tmpStore(), fetch: null })
  const r = await c.register()
  assert.equal(r.ok, false)
  const s = c.snapshot()
  assert.equal(s.ok, true)
  assert.equal(s.offline, true)
  assert.equal(s.online, false)
})

/* ================= ③ 持久化：重启后离线也有 shortId/vip/绑定 ================= */

test('缓存的 shortId/vipExpireMs/绑定落盘，重启读回（离线也能显示上次的公网短 ID）', async () => {
  const file = tmpStore()
  const ff = fakeFetch({
    '/redeem': ok200({ ok: true, addedDays: 3, vipExpireMs: 1790000000000, shortId: 'A1B2C3D4E5F6' })
  })
  const c = createCloudLink({ autoStart: false, storePath: file, fetch: ff })
  await c.redeem('A4K7-2MNP-9QRS-3TVW')
  await c.setBound({ uid: 'u1', name: '小主', avatar: 'https://a/b.png' })
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(raw.shortId, 'A1B2C3D4E5F6')
  assert.equal(raw.vipExpireMs, 1790000000000)
  assert.equal(raw.bound.uid, 'u1')
  assert.equal(raw.bound.name, '小主')
  /* 重启：网络彻底不通（hang），仍要读出上次的短 ID 与 VIP。 */
  const c2 = createCloudLink({ autoStart: false, storePath: file, fetch: hang, timeoutMs: 30 })
  const s = c2.snapshot()
  assert.equal(s.shortId, 'A1B2C3D4E5F6')
  assert.equal(s.vipExpireMs, 1790000000000)
  assert.equal(s.bound.uid, 'u1')
  assert.equal(s.online, false)
  assert.equal(s.offline, true)
})

/* ================= ④ 心跳 ================= */

test('心跳：默认 60s、首拍 3s、timer.unref() 都生效', () => {
  const realSetInterval = globalThis.setInterval
  const realSetTimeout = globalThis.setTimeout
  const seen = []
  globalThis.setInterval = (cb, ms) => {
    const t = realSetInterval(cb, ms)
    const orig = t.unref.bind(t)
    let unrefCalled = false
    t.unref = () => { unrefCalled = true; return orig() }
    seen.push({ kind: 'interval', ms, unref: () => unrefCalled, timer: t })
    return t
  }
  globalThis.setTimeout = (cb, ms, ...rest) => {
    const t = realSetTimeout(cb, ms, ...rest)
    if (ms >= 1000) seen.push({ kind: 'timeout', ms, unref: () => true, timer: t })
    return t
  }
  try {
    const c = createCloudLink({ autoStart: false, storePath: tmpStore(), fetch: fakeFetch() })
    c.startHeartbeat()
    const itv = seen.find((s) => s.kind === 'interval')
    assert.ok(itv, '必须起了 setInterval')
    assert.equal(itv.ms, HEARTBEAT_MS)
    assert.equal(itv.unref(), true, '心跳 timer 必须 unref（不能让 DSH 退不掉）')
    const first = seen.find((s) => s.kind === 'timeout')
    assert.ok(first, '必须有首拍延迟')
    assert.equal(first.ms, FIRST_TICK_MS)
    assert.equal(c.stopHeartbeat(), true)
    assert.equal(c.stopHeartbeat(), false)
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.setTimeout = realSetTimeout
  }
})

test('心跳真的会打：首拍 20ms + 每 30ms 一拍，stop 后不再涨', async () => {
  const ff = fakeFetch({ '/status': ok200({ ok: true, shortId: 'A1B2C3D4E5F6' }) })
  const c = createCloudLink({ autoStart: false, storePath: tmpStore(), fetch: ff,
    heartbeatMs: 30, firstDelayMs: 20 })
  c.startHeartbeat()
  await c.tick()
  const n1 = ff.calls.length
  assert.ok(n1 >= 1)
  await new Promise((r) => setTimeout(r, 110))
  const n2 = ff.calls.length
  assert.ok(n2 > n1, '定时器必须自己打心跳，n1=' + n1 + ' n2=' + n2)
  assert.equal(c.stopHeartbeat(), true)
  await new Promise((r) => setTimeout(r, 70))
  assert.equal(ff.calls.length, n2, 'stop 之后不许再打')
})

test('tick 去重：上一发还在飞时，第二发直接复用同一个 promise', async () => {
  let release = null
  const gate = new Promise((r) => { release = r })
  const ff = fakeFetch({ '/status': () => gate.then(() => ok200({ ok: true, shortId: 'A1B2C3D4E5F6' })) })
  const c = createCloudLink({ autoStart: false, storePath: tmpStore(), fetch: ff })
  const p1 = c.tick()
  const p2 = c.tick()
  assert.equal(p1, p2, '同时刻只允许一发在飞')
  release()
  await p1
  assert.equal(ff.calls.length, 1)
})

/* ================= ⑤ lan-server 的三条云路由 ================= */

test('没配 cloud：/info.cloud = null，三条路由 503，绝不 500', async () => {
  const s = await serve()
  try {
    const info = await req(s.base + '/info')
    assert.equal(info.status, 200)
    assert.ok(Object.prototype.hasOwnProperty.call(info.body, 'cloud'), '/info 必须有 cloud 键')
    assert.equal(info.body.cloud, null)
    assert.equal((await req(s.base + '/cloud/status')).status, 503)
    assert.equal((await req(s.base + '/cloud/bind', { method: 'POST', body: '{}' })).status, 503)
    assert.equal((await req(s.base + '/cloud/redeem', { method: 'POST', body: '{"code":"x"}' })).status, 503)
  } finally { await s.close() }
})

test('配了 cloud：/info.cloud 摘短字段，GET /cloud/status 给 pubId，nodeId 一个都不出现', async () => {
  const s = await serve({ cloud: fakeCloud() })
  try {
    const info = await req(s.base + '/info')
    assert.deepEqual(info.body.cloud, { shortId: 'A1B2C3D4E5F6G7H', vipExpireMs: 1790000000000, online: true })
    const st = await req(s.base + '/cloud/status')
    assert.equal(st.status, 200)
    assert.equal(st.body.ok, true)
    assert.equal(st.body.shortId, 'A1B2C3D4E5F6G7H')
    assert.equal(st.body.pubId, st.body.shortId)
    assert.equal(st.body.vipExpireMs, 1790000000000)
    assert.equal(st.body.online, true)
    assert.deepEqual(st.body.bound, { uid: 'u1', name: '小主', avatar: 'https://a/b.png', ms: 123 })
    const txt = JSON.stringify(info.body) + JSON.stringify(st.body)
    assert.equal(txt.indexOf('node-secret-xyz'), -1, 'nodeId 绝不下发')
  } finally { await s.close() }
})

test('POST /cloud/bind：转发 {uid,name,avatar}，回 shortId/vipExpireMs', async () => {
  const c = fakeCloud()
  const s = await serve({ cloud: c })
  try {
    const r = await req(s.base + '/cloud/bind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid: 'u1', name: '小主', avatar: 'https://a/b.png' })
    })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { ok: true, shortId: 'A1B2C3D4E5F6G7H', vipExpireMs: 1790000000000 })
    assert.deepEqual(c.calls[0], ['bind', { uid: 'u1', name: '小主', avatar: 'https://a/b.png' }])
  } finally { await s.close() }
})

test('POST /cloud/redeem：业务失败也回 200 + ok:false + 云端原文案', async () => {
  const c = fakeCloud()
  const s = await serve({ cloud: c })
  try {
    const r = await req(s.base + '/cloud/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: ' A4K7-2MNP-9QRS-3TVW ' })
    })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { ok: false, error: '体验码已被使用' })
    assert.deepEqual(c.calls[0], ['redeem', 'A4K7-2MNP-9QRS-3TVW'])
    /* 非法 JSON 体不许把服务器打崩 */
    const bad = await req(s.base + '/cloud/redeem', { method: 'POST', body: '不是json' })
    assert.equal(bad.status, 200)
    assert.equal(bad.body.ok, false)
  } finally { await s.close() }
})

test('云端对象抛异常：/info.cloud 给 null、云路由 200 + ok:false，绝不 500', async () => {
  const boom = new Error('云端炸了')
  const c = fakeCloud({
    snapshot: () => { throw boom },
    bind: async () => { throw boom },
    redeem: async () => { throw boom }
  })
  const s = await serve({ cloud: c })
  try {
    const info = await req(s.base + '/info')
    assert.equal(info.status, 200)
    assert.equal(info.body.cloud, null)
    const st = await req(s.base + '/cloud/status')
    assert.equal(st.status, 200)
    assert.equal(st.body.ok, false)
    assert.equal(st.body.error, '云端不可用')
    const b = await req(s.base + '/cloud/bind', { method: 'POST', body: '{}' })
    assert.equal(b.status, 200)
    assert.equal(b.body.ok, false)
    assert.equal(b.body.error, '云端不可用')
    const rd = await req(s.base + '/cloud/redeem', { method: 'POST', body: '{"code":"x"}' })
    assert.equal(rd.status, 200)
    assert.equal(rd.body.ok, false)
  } finally { await s.close() }
})

test('云路由在访问码之后：不带 token 一律 401', async () => {
  const s = await serve({ cloud: fakeCloud() })
  try {
    const r = await fetch(s.base + '/cloud/status')
    assert.equal(r.status, 401)
    const r2 = await fetch(s.base + '/cloud/redeem', { method: 'POST', body: '{}' })
    assert.equal(r2.status, 401)
    const info = await fetch(s.base + '/info')
    assert.equal(info.status, 401)
  } finally { await s.close() }
})

test('端到端：真 cloud-link + 真 lan-server，register 后 /cloud/status 能看到短 ID', async () => {
  const ff = fakeFetch({ '/register': ok200({ ok: true, shortId: 'TEST1234ABCDEF', vipExpireMs: 111 }) })
  const cloud = createCloudLink({ autoStart: false, storePath: tmpStore(), fetch: ff, heartbeatMs: 0 })
  const s = await serve({ cloud })
  try {
    const before = await req(s.base + '/cloud/status')
    assert.equal(before.status, 200)
    assert.equal(before.body.ok, true)
    assert.equal(before.body.shortId, '')
    assert.equal(before.body.online, false)
    assert.equal((await req(s.base + '/info')).body.cloud.online, false)
    await cloud.register()
    const after = await req(s.base + '/cloud/status')
    assert.equal(after.body.shortId, 'TEST1234ABCDEF')
    assert.equal(after.body.pubId, 'TEST1234ABCDEF')
    assert.equal(after.body.online, true)
    assert.deepEqual((await req(s.base + '/info')).body.cloud,
      { shortId: 'TEST1234ABCDEF', vipExpireMs: 111, online: true })
  } finally { await s.close() }
})
