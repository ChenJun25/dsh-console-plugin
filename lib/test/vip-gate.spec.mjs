/**
 * 第134节 · task-6 单测（闸 C）· 公网可用性绑定 VIP（兑换码取代「只给自己电脑开的白名单」）。
 *
 * 为什么必须真起服务 + 真 fetch（照 sec-gate.spec.mjs / cloud-link.spec.mjs）：
 *   这道闸判的是「请求从哪来（转发头）+ 本节点 VIP 有没有过期」两个运行时状态，
 *   拿假 req 测等于自己给自己出题；只有真 http 才能证明 X-Forwarded-For 与
 *   o.cloud.snapshot() 的组合确实改变了状态码。
 *
 * 覆盖（每条都带真访问码走完整链路，不绕 token 那道闸）：
 *   a. 公网来源 + VIP 未过期 + GET /info?token=… ⇒ 200
 *   b. 公网来源 + VIP 已过期 ⇒ 🔴 第214节起 /info 仍 200（/info 已移出闸 C），
 *      但业务路由（/sessions 等）仍 403，文案含「兑换码」
 *   c. 公网来源 + o.cloud=null ⇒ 200（🔴 fail-open：不许把用户锁死）
 *   d. 局域网直连（无转发头）+ VIP 已过期 ⇒ 200（在家连 WiFi 不受影响）
 *   e. DSH_CLOUD_GATE=off + 公网 + VIP 已过期 ⇒ 业务路由 200（用户自救后门）
 *
 * 🔴 第214节为什么把 /info 移出 CLOUD_GATED（lib/lan-server.mjs:92）：
 *   App 探活靠 /info 体里的 publicUrls（与 cloud 快照）才能把公网候选地址落表；
 *   会员过期时 /info 被闸 C 拦成 403 ⇒ 手机永远探不通、永久卡「连不上」（用户实报）。
 *   所以本文件里凡是「证明闸 C 还在生效」的断言，一律打业务路由（/sessions 最省事），
 *   不再用 /info；/info 只用来证明「探活那两样东西（publicUrls / cloud）还在」。
 * 外加边界：snapshot 抛异常 / vipExpireMs 不是数字 / 逐条业务路由的覆盖面 /
 *           /cloud/status 这类不在集合里的路由不被误伤 / 闸在 401 之前。
 *
 * ⚠️ 端口：lan-server 的 `Number(o.port) || 8899` 让 port:0 落回 8899（宿主上被占），
 *    所以用高位端口 + allowShift；19601 段与 sec-gate(19101) / device-roster(19101)
 *    / preset-info(18901) / cloud-link(19501) 全部错开，避免并行跑测试互撞。
 * 跑法：node --test lib/test/vip-gate.spec.mjs
 *   （第214节起不加 --test-force-exit：仓库既有结论是它会触发 libuv async.c:76 崩溃。
 *     不加也没事——用例全绿时每个 srv 都 stop 了，没有句柄泄漏，进程自然退出；
 *     若有用例断言先抛、漏掉了 stop，才会挂住不退出，那本身就是失败信号。）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startLanServer } from '../lan-server.mjs'

const TOKEN = 'TOK-134'
const GATE_MSG = '公网服务未开通或已过期，请在 App 设置页用兑换码续期'

let portSeq = 0
const nextPort = () => 19601 + (portSeq++ * 2)

/* ---------------- 假云链路：只实现本闸要用的 snapshot() ---------------- */

/** VIP 有效：到期时间在未来。 */
const cloudLive = () => ({
  snapshot: () => ({
    ok: true, nodeId: 'node-1', shortId: 'ab12cd', vipExpireMs: Date.now() + 86400000,
    online: true, lastSeenMs: Date.now(), bound: null, offline: false
  })
})

/** VIP 已过期：exp > ts 不成立（云端 cloud.py 的 allow 判据）。 */
const cloudExpired = () => ({
  snapshot: () => ({
    ok: true, nodeId: 'node-1', shortId: 'ab12cd', vipExpireMs: Date.now() - 60_000,
    online: true, lastSeenMs: Date.now(), bound: null, offline: false
  })
})

/** 断网但缓存里有未过期 VIP ⇒ 仍算有效（不看 online）。 */
const cloudOfflineButAlive = () => ({
  snapshot: () => ({
    ok: false, nodeId: '', shortId: '', vipExpireMs: Date.now() + 86400000,
    online: false, lastSeenMs: Date.now(), bound: null, offline: true
  })
})

/** 读不到数字（脏缓存）：vipExpireMs 非数字 ⇒ 不算有效。 */
const cloudGarbage = () => ({ snapshot: () => ({ ok: true, vipExpireMs: 'soon', offline: false }) })

/** snapshot 自己抛异常 ⇒ 不算有效（任务书明确要求吞掉并当无效）。 */
const cloudThrows = () => ({
  snapshot: () => { throw new Error('snapshot boom：云端缓存读崩了') }
})

/* ---------------- 起真服务 ---------------- */

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

/** 公网来源：TCP 连的是回环，但带转发头 —— 正是 Caddy / 隧道转发进来的形状。 */
const fromPublic = { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } }
/** 局域网直连：手机连同一个 WiFi，不带任何转发头。 */
const fromLan = {}

/** undici 在「上一个用例刚 stop 掉服务器」时偶发 ECONNRESET：重试一次即可，避免假红。 */
async function rf(url, init) {
  try { return await fetch(url, init) } catch (e) { return await fetch(url, init) }
}

/** 带真访问码打 /info（走完整链路：转发头 → 闸 C → token → 路由）。 */
const info = (base, init) => rf(base + '/info?token=' + TOKEN, init)

/* ---------------- a. VIP 有效：公网照常放行 ---------------- */

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

/* -------- b. VIP 过期：/info 仍 200（第214节），业务路由 403 + 兑换码文案 -------- */

test('b 公网 + VIP 已过期 ⇒ /info 仍 200（第214节移出闸 C），业务路由仍 403', async () => {
  const s = await serve({ cloud: cloudExpired() })
  /* 第一半：/info 不再被闸 C 拦 —— 探活证据源必须打得开。 */
  const r = await info(s.base, fromPublic)
  assert.equal(r.status, 200, '第214节起公网 /info 不再 403（App 探活要拿 publicUrls 才能连上）')
  const j = await r.json()
  assert.equal(j.ok, true)
  assert.ok(Array.isArray(j.publicUrls), '/info 必须仍带 publicUrls（公网候选地址的证据源）')
  assert.equal('cloud' in j, true, '/info 必须仍带 cloud 快照（面板靠它显示 VIP 到期）')
  /* 第二半：同一份过期 VIP 下，业务路由仍必须被闸 C 拦下（文案就是 GATE_MSG）。 */
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
  assert.equal((await info(s.base, fromPublic)).status, 200, '/info 第214节起不在闸 C 名单里')
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
  /* /info 第214节已移出闸 C ⇒ 错码就走 401，闸不再抢答 403。 */
  const ir = await rf(s.base + '/info?token=wrong', fromPublic)
  assert.equal(ir.status, 401, '/info 不在闸 C 名单里，错码就该是 401「访问码不对」')
  assert.equal((await ir.json()).error, '访问码不对')
  await s.srv.stop()
})

/* ---------------- c. fail-open ---------------- */

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

/* ---------------- d. 局域网不受影响 ---------------- */

test('d 局域网直连 + VIP 已过期 ⇒ 200（在家连 WiFi 永远能用）', async () => {
  const s = await serve({ cloud: cloudExpired() })
  const r = await info(s.base, fromLan)
  assert.equal(r.status, 200, 'isRemoteLink 为假就完全不看 VIP')
  assert.equal((await r.json()).ok, true)
  /* /sessions /cmd 同理：不带转发头一个都不拦。 */
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

/* ---------------- e. DSH_CLOUD_GATE 自救开关 ---------------- */

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

/* ---------------- f. 别误伤别的路由 ---------------- */

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
