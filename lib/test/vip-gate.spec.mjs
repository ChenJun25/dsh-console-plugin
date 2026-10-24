import test from 'node:test'
import assert from 'node:assert/strict'
import { startLanServer } from '../lan-server.mjs'

const TOKEN = 'TOK-134'
const GATE_MSG = '公网服务未开通或已过期，请在 App 设置页用兑换码续期'

let portSeq = 0
const nextPort = () => 19601 + (portSeq++ * 2)

const cloudLive = () => ({
  snapshot: () => ({
    ok: true, nodeId: 'node-1', shortId: 'ab12cd', vipExpireMs: Date.now() + 86400000,
    online: true, lastSeenMs: Date.now(), bound: null, offline: false
  })
})

const cloudExpired = () => ({
  snapshot: () => ({
    ok: true, nodeId: 'node-1', shortId: 'ab12cd', vipExpireMs: Date.now() - 60_000,
    online: true, lastSeenMs: Date.now(), bound: null, offline: false
  })
})

const cloudOfflineButAlive = () => ({
  snapshot: () => ({
    ok: false, nodeId: '', shortId: '', vipExpireMs: Date.now() + 86400000,
    online: false, lastSeenMs: Date.now(), bound: null, offline: true
  })
})

const cloudGarbage = () => ({ snapshot: () => ({ ok: true, vipExpireMs: 'soon', offline: false }) })

const cloudThrows = () => ({
  snapshot: () => { throw new Error('snapshot boom：云端缓存读崩了') }
})

async function serve(over = {}) {
  const o = Object.assign({
    port: nextPort(),
    allowShift: true,
    log: () => {},
    getToken: () => TOKEN,
    getInfo: () => ({ name: '我的电脑', nodeId: 'dsh-console', host: 'host-1', dshOk: true, version: '0.5.1' }),
    listSessions: async () => [],
    runCommand: async () => ({ ok: true })
  }, over)
  const srv = startLanServer(o)
  const started = await srv.start()
  assert.ok(started, 'lan server 必须起得来（端口占用且不许顺延时它会 resolve(null)）')
  return { srv, base: 'http://127.0.0.1:' + started.port + '/dsh-console' }
}

const fromPublic = { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } }

const fromLan = {}

async function rf(url, init) {
  try { return await fetch(url, init) } catch (e) { return await fetch(url, init) }
}

const info = (base, init) => rf(base + '/info?token=' + TOKEN, init)

test('a 公网来源 + VIP 未过期 ⇒ /info 200（有 VIP 就能用公网）', async () => {
  const s = await serve({ cloud: cloudLive() })
  const r = await info(s.base, fromPublic)
  assert.equal(r.status, 200, 'VIP 未过期时公网必须放行')
  const j = await r.json()
  assert.equal(j.ok, true)
  assert.equal(j.cloud.vipExpireMs > Date.now(), true, '/info.cloud 仍照常下发到期时间')
  await s.srv.stop()
})

test('a-2 断网（offline:true）但缓存 VIP 未过期 ⇒ 仍 200（不靠在线状态卡人）', async () => {
  const s = await serve({ cloud: cloudOfflineButAlive() })
  const r = await info(s.base, fromPublic)
  assert.equal(r.status, 200, 'VIP 只看到期时间，不看 online')
  await s.srv.stop()
})

test('b 公网 + VIP 已过期 ⇒ /info 仍 200（移出闸 C），业务路由仍 403', async () => {
  const s = await serve({ cloud: cloudExpired() })

  const r = await info(s.base, fromPublic)
  assert.equal(r.status, 200, '起公网 /info 不再 403（App 探活要拿 publicUrls 才能连上）')
  const j = await r.json()
  assert.equal(j.ok, true)
  assert.ok(Array.isArray(j.publicUrls), '/info 必须仍带 publicUrls（公网候选地址的证据源）')
  assert.equal('cloud' in j, true, '/info 必须仍带 cloud 快照（面板靠它显示 VIP 到期）')

  const ses = await rf(s.base + '/sessions?token=' + TOKEN, fromPublic)
  assert.equal(ses.status, 403, 'VIP 过期后公网业务路由必须拦下')
  const sj = await ses.json()
  assert.equal(sj.ok, false)
  assert.equal(sj.error, GATE_MSG)
  assert.ok(String(sj.error).includes('兑换码'), '文案必须告诉用户去哪续期')
  await s.srv.stop()
})

test('b-2 vipExpireMs 读不到数字 ⇒ 业务路由 403（脏缓存不算有效；/info 仍 200）', async () => {
  const s = await serve({ cloud: cloudGarbage() })
  const r = await rf(s.base + '/sessions?token=' + TOKEN, fromPublic)
  assert.equal(r.status, 403, '脏缓存只当「没有有效 VIP」')
  assert.notEqual(r.status, 500, '脏缓存也不许 500')
  assert.equal((await r.json()).error, GATE_MSG)
  assert.equal((await info(s.base, fromPublic)).status, 200, '/info 起不在闸 C 名单里')
  await s.srv.stop()
})

test('b-3 snapshot() 抛异常 ⇒ 业务路由 403（吞异常按无效；/info 仍 200，绝不 500）', async () => {
  const s = await serve({ cloud: cloudThrows() })
  const r = await rf(s.base + '/sessions?token=' + TOKEN, fromPublic)
  assert.equal(r.status, 403, 'snapshot 抛异常只能当「没有有效 VIP」')
  assert.notEqual(r.status, 500, '云端读崩了也不许 500')
  assert.equal((await r.json()).error, GATE_MSG)
  const ir = await info(s.base, fromPublic)
  assert.equal(ir.status, 200, '/info 探活不能被云端异常拖垮')
  assert.notEqual(ir.status, 500, '/info 也绝不许 500')
  await s.srv.stop()
})

test('b-4 公网 + VIP 过期：/sessions /attachment /cmd /mp-cookie 逐条都在闸里', async () => {
  const s = await serve({ cloud: cloudExpired() })
  const ses = await rf(s.base + '/sessions?token=' + TOKEN, fromPublic)
  assert.equal(ses.status, 403, '/sessions 是业务路由，必须拦')
  const att = await rf(s.base + '/attachment?id=x&token=' + TOKEN, fromPublic)
  assert.equal(att.status, 403, '/attachment 必须拦')
  const cmd = await rf(s.base + '/cmd', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', 'x-dsh-console-token': TOKEN },
    body: JSON.stringify({ op: 'noop', payload: {} })
  })
  assert.equal(cmd.status, 403, '/cmd 能操控 DSH，必须拦')
  const ck = await rf(s.base + '/mp-cookie?token=' + TOKEN, fromPublic)
  assert.equal(ck.status, 403, '/mp-cookie 能换长期 Cookie，必须拦')
  for (const r of [ses, att, cmd, ck]) assert.equal((await r.json()).error, GATE_MSG)
  await s.srv.stop()
})

test('b-5 闸排在 401 之前：公网 + 过期 + 错码 ⇒ 业务路由 403（先判公网资格）', async () => {
  const s = await serve({ cloud: cloudExpired() })
  const r = await rf(s.base + '/sessions?token=wrong', fromPublic)
  assert.equal(r.status, 403, '闸 C 在 tokenOf 那道 401 之前（位置铁律）')
  assert.equal((await r.json()).error, GATE_MSG)

  const ir = await rf(s.base + '/info?token=wrong', fromPublic)
  assert.equal(ir.status, 401, '/info 不在闸 C 名单里，错码就该是 401「访问码不对」')
  assert.equal((await ir.json()).error, '访问码不对')
  await s.srv.stop()
})

test('c 公网来源 + o.cloud=null ⇒ 200（🔴 fail-open：云端没了也不许锁死用户）', async () => {
  const s = await serve({ cloud: null })
  const r = await info(s.base, fromPublic)
  assert.equal(r.status, 200, '没接云链路时必须放行')
  assert.equal((await r.json()).ok, true)
  await s.srv.stop()
})

test('c-2 默认（不传 cloud 键）也等于 null ⇒ 公网 200（老插件不受影响）', async () => {
  const s = await serve()
  assert.equal((await info(s.base, fromPublic)).status, 200, '老插件 / 单测场景一律放行')
  await s.srv.stop()
})

test('d 局域网直连 + VIP 已过期 ⇒ 200（在家连 WiFi 永远能用）', async () => {
  const s = await serve({ cloud: cloudExpired() })
  const r = await info(s.base, fromLan)
  assert.equal(r.status, 200, 'isRemoteLink 为假就完全不看 VIP')
  assert.equal((await r.json()).ok, true)

  assert.equal((await rf(s.base + '/sessions?token=' + TOKEN, fromLan)).status, 200)
  await s.srv.stop()
})

test('d-2 局域网直连 + 脏缓存/抛异常的 cloud ⇒ 200（闸根本不进）', async () => {
  const s1 = await serve({ cloud: cloudGarbage() })
  assert.equal((await info(s1.base, fromLan)).status, 200)
  await s1.srv.stop()
  const s2 = await serve({ cloud: cloudThrows() })
  assert.equal((await info(s2.base, fromLan)).status, 200)
  await s2.srv.stop()
})

test('d-3 X-Real-IP 单值也算公网来源 ⇒ 过期时业务路由 403（不是只认 X-Forwarded-For）', async () => {
  const s = await serve({ cloud: cloudExpired() })
  const r = await rf(s.base + '/sessions?token=' + TOKEN, { headers: { 'x-real-ip': '203.0.113.7' } })
  assert.equal(r.status, 403, 'X-Real-IP 单值同样要被认成公网来源（/info 恒 200 证明不了这一点）')
  await s.srv.stop()
})

for (const v of ['off', '0', 'false']) {
  test('e DSH_CLOUD_GATE=' + v + ' + 公网 + VIP 过期 ⇒ 业务路由 200（整条闸门失效）', async () => {
    const old = process.env.DSH_CLOUD_GATE
    process.env.DSH_CLOUD_GATE = v
    const s = await serve({ cloud: cloudExpired() })
    try {
      const r = await rf(s.base + '/sessions?token=' + TOKEN, fromPublic)
      assert.equal(r.status, 200, '开关打开时必须放行')
      assert.equal((await r.json()).ok, true)
    } finally {
      if (old === undefined) delete process.env.DSH_CLOUD_GATE
      else process.env.DSH_CLOUD_GATE = old
      await s.srv.stop()
    }
  })
}

test('e-4 环境变量写别的值（如 on）不关闸 ⇒ 公网 + 过期业务路由仍 403', async () => {
  const old = process.env.DSH_CLOUD_GATE
  process.env.DSH_CLOUD_GATE = 'on'
  const s = await serve({ cloud: cloudExpired() })
  try {
    const r = await rf(s.base + '/sessions?token=' + TOKEN, fromPublic)
    assert.equal(r.status, 403, '只有 off/0/false 才算关')
    assert.equal((await r.json()).error, GATE_MSG)
  } finally {
    if (old === undefined) delete process.env.DSH_CLOUD_GATE
    else process.env.DSH_CLOUD_GATE = old
    await s.srv.stop()
  }
})

test('f 公网 + 过期：/cloud/status 不在 CLOUD_GATED 里 ⇒ 不返回闸的 403', async () => {
  const s = await serve({ cloud: cloudExpired() })
  const r = await rf(s.base + '/cloud/status?token=' + TOKEN, fromPublic)
  assert.notEqual(r.status, 403, '/cloud/status 是续期入口，必须永远打得开（否则没法自救）')
  assert.equal(r.status, 200)
  await s.srv.stop()
})

test('f-2 公网 + 过期：OPTIONS 预检仍 204（预检不带业务数据，不该被拦）', async () => {
  const s = await serve({ cloud: cloudExpired() })
  const r = await rf(s.base + '/info', { method: 'OPTIONS', headers: { 'x-forwarded-for': '203.0.113.7' } })
  assert.equal(r.status, 204, 'OPTIONS 在闸之前 return（位置：o.mp.branch → OPTIONS → 闸 A → 闸 C）')
  await s.srv.stop()
})

test('f-3 公网 + 过期：/mp/api/* 交给更早的 mp 分支，闸 C 碰不到（手机走公网的生命线）', async () => {
  const mpStub = {
    branch: async (req, res, pathname) => {
      if (!String(pathname || '').startsWith('/mp/')) return false
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, via: 'mp' }))
      return true
    }
  }
  const s = await serve({ cloud: cloudExpired(), mp: mpStub })
  const r = await rf(s.base + '/mp/api/session.list', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify({ rpcId: 'r1', payload: {} })
  })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).via, 'mp')
  await s.srv.stop()
})

test('f-4 公网 + 过期：/pair 仍是闸 A 的文案（两道闸各管一段，别串味）', async () => {
  const s = await serve({ cloud: cloudExpired() })
  const r = await rf(s.base + '/pair', fromPublic)
  assert.equal(r.status, 403)
  assert.equal((await r.json()).error, '配对与取码仅限局域网内使用', '/pair 归闸 A，不是闸 C')
  await s.srv.stop()
})
