/**
 * 第130节 · 插件侧安全硬化 —— 公网来源拒绝免鉴权页 + Web 控制台彻底关闭。
 *
 * 为什么必须真起服务 + 真 fetch（照 test/mp-routes.spec.mjs / lib/test/preset-info.spec.mjs）：
 * 这次改的全是「请求从哪来」的分支判定（isRemoteLink 看 X-Forwarded-For / X-Real-IP），
 * 拿假 req 对象测等于自己给自己出题 —— 真 http 才能证明转发头确实改变了状态码。
 *
 * 覆盖四段：
 *   ① 公网来源（带转发头）打免鉴权页 ⇒ 403「配对与取码仅限局域网内使用」
 *   ② 局域网 / 回环（不带转发头）打同样的页 ⇒ 200，行为一个字不改
 *   ③ 带访问码的路由（/info /sessions）与手机公网通道（/mp/*）不被这道闸误伤
 *   ④ /web 与 /pet 无条件 403（内网也关），webUrl 只剩空键、webQrDataUrl 不再生成
 *
 * ⚠️ 端口：lan-server 的 `Number(o.port) || 8899` 让 port:0 落回 8899（宿主上被占），
 *    所以用高位端口 + allowShift；起点与 18777/18888/18901 错开，避免并行跑测试时互撞。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startLanServer, webConsoleUrl } from '../lan-server.mjs'

const TOKEN = 'TOK-130'

let portSeq = 0
const nextPort = () => 19101 + (portSeq++ * 2)

/* 手机走公网的那条路（/mp/*）的替身：只证明「闸排在它后面、拦不到它」。
   真接线（cookie 门禁、24 个 RPC）由 test/mp-e2e.spec.mjs 覆盖，这里不重复。 */
const mpStub = {
  branch: async (req, res, pathname) => {
    if (!String(pathname || '').startsWith('/mp/')) return false
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, via: 'mp' }))
    return true
  },
}

async function serve(over = {}) {
  const o = Object.assign({
    port: nextPort(),
    allowShift: true,
    log: () => {},
    getToken: () => TOKEN,
    getInfo: () => ({ name: '我的电脑', nodeId: 'dsh-console', host: 'host-1', dshOk: true, version: '0.5.1' }),
    listSessions: async () => [],
    runCommand: async () => ({ ok: true }),
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

/** undici 在「上一个用例刚 stop 掉服务器」时偶发 ECONNRESET（本地套接字半关闭竞态，
 *  与被测代码无关）：重试一次即可，避免闸门出现假红。 */
async function rf(url, init) {
  try { return await fetch(url, init) } catch (e) { return await fetch(url, init) }
}

const PUB_MSG = '配对与取码仅限局域网内使用'
const CLOSED_MSG = 'Web 控制台已关闭'

/* ---------------- ① 公网来源打免鉴权页 ---------------- */

test('①-a 公网来源打 / 与 /pair ⇒ 403，且文案是「配对与取码仅限局域网内使用」', async () => {
  const s = await serve()
  for (const p of ['/', '/pair']) {
    const r = await rf(s.base + p, fromPublic)
    assert.equal(r.status, 403, p + ' 必须被闸 A 拦下（免鉴权页不能白送给公网）')
    assert.equal((await r.json()).error, PUB_MSG)
  }
  await s.srv.stop()
})

test('①-b 公网来源打 /qr /newcode /claim 一并 403（取码面一个都不能漏）', async () => {
  const s = await serve()
  assert.equal((await rf(s.base + '/qr', fromPublic)).status, 403, '/qr 是免 token 的二维码 PNG')
  assert.equal((await rf(s.base + '/newcode', fromPublic)).status, 403, '/newcode 能刷新配对码')
  const claim = await rf(s.base + '/claim', {
    ...fromPublic,
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify({ code: '000000' }),
  })
  assert.equal(claim.status, 403, '/claim 是拿码换访问码的入口，公网来源直接拒')
  assert.equal((await claim.json()).error, PUB_MSG)
  await s.srv.stop()
})

test('①-c X-Real-IP 单独也能触发闸（不是只认 X-Forwarded-For）', async () => {
  const s = await serve()
  const r = await rf(s.base + '/pair', { headers: { 'x-real-ip': '203.0.113.7' } })
  assert.equal(r.status, 403)
  await s.srv.stop()
})

/* ---------------- ② 局域网 / 回环不受影响 ---------------- */

test('②-a 局域网直连打 / 与 /pair ⇒ 401（页面已删，但不是被闸 A 误伤成 403）', async () => {
  const s = await serve()
  for (const p of ['/', '/pair']) {
    const r = await rf(s.base + p, fromLan)
    assert.equal(r.status, 401, p + ' 第213节起不再有任何页面，掉进 token 闸')
    assert.notEqual((await r.json()).error, PUB_MSG, '局域网直连不许被闸 A 误伤')
  }
  await s.srv.stop()
})

test('②-b 局域网直连 /qr 仍免 token 200（页面上本来就嵌着它）', async () => {
  const s = await serve()
  const r = await rf(s.base + '/qr', fromLan)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'image/png')
  await s.srv.stop()
})

test('②-c 局域网直连 /claim 仍然能走业务逻辑（错码 403 是业务码，不是闸的 403）', async () => {
  const s = await serve()
  const r = await rf(s.base + '/claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '000000' }),
  })
  assert.notEqual((await r.json()).error, PUB_MSG, '不许把局域网直连也拒掉')
  await s.srv.stop()
})

/* ---------------- ③ 别的路由不被误伤 ---------------- */

test('③-a 公网来源 + 正确访问码 ⇒ /info 与 /sessions 照常放行（闸只认那几个免鉴权页）', async () => {
  const s = await serve()
  const info = await rf(s.base + '/info?token=' + TOKEN, fromPublic)
  assert.equal(info.status, 200, '/info 不在 PUB_BLOCKED 里，带对码就该过')
  assert.equal((await info.json()).ok, true)
  const sess = await rf(s.base + '/sessions?token=' + TOKEN, fromPublic)
  assert.equal(sess.status, 200)
  await s.srv.stop()
})

test('③-b 公网来源打 /mp/api/* ⇒ 交给更早的 mp 分支，闸 A 拦不到（手机走公网的生命线）', async () => {
  const s = await serve({ mp: mpStub })
  const r = await rf(s.base + '/mp/api/session.list', {
    ...fromPublic,
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify({ rpcId: 'r1', payload: {} }),
  })
  assert.equal(r.status, 200, 'mp 分支必须在闸 A 之前（它自己用 mp_device Cookie 鉴权）')
  assert.equal((await r.json()).via, 'mp')
  await s.srv.stop()
})

test('③-c 没访问码打 /info 仍是 401「访问码不对」，闸没改这道语义', async () => {
  const s = await serve()
  const r = await rf(s.base + '/info?token=wrong', fromPublic)
  assert.equal(r.status, 401)
  assert.equal((await r.json()).error, '访问码不对')
  await s.srv.stop()
})

/* ---------------- ④ Web 控制台彻底关闭 ---------------- */

test('④-a /web 与 /pet 无条件 403 —— 公网和回环都一样，没有例外分支', async () => {
  const s = await serve()
  for (const p of ['/web', '/pet']) {
    for (const [label, init] of [['公网来源', fromPublic], ['回环直连', fromLan]]) {
      const r = await rf(s.base + p, init)
      assert.equal(r.status, 403, p + '（' + label + '）必须 403')
      /* 公网来源时闸 A 先命中（/web /pet 同时在 PUB_BLOCKED 里），文案是闸 A 那句；
         回环直连时闸 A 不触发，落到 /web 判断块，文案是「Web 控制台已关闭」。
         两条路都要 403，但走的是两道不同的关，文案也各自钉死，不许含糊。 */
      const msg = (await r.json()).error
      const want = label === '公网来源' ? PUB_MSG : CLOSED_MSG
      assert.equal(msg, want, p + '（' + label + '）的 403 应由对应的那道关给出')
    }
  }
  await s.srv.stop()
})

test('④-b 保留 /web 判断块的理由：删掉会掉进 401，变成「有码就能开」', async () => {
  const s = await serve()
  const closed = await rf(s.base + '/web?token=' + TOKEN, fromLan)
  assert.equal(closed.status, 403, '带对访问码也是 403 —— 这才是「关干净」')
  await s.srv.stop()
})

test('④-c panelData：webUrl 键保留但恒为空串，webQrDataUrl 不再生成', async () => {
  const s = await serve()
  const d = await s.srv.panelData(true)
  assert.ok(Object.prototype.hasOwnProperty.call(d, 'webUrl'), 'webUrl 键必须还在（删键会破坏键集合断言）')
  assert.equal(d.webUrl, '', '控制台已关，地址恒为空串')
  assert.ok(!Object.prototype.hasOwnProperty.call(d, 'webQrDataUrl'), '指向死链的二维码不该再编码一次')
  assert.equal(typeof d.qrDataUrl, 'string', '配对用的二维码还在，别误删')
  assert.ok(d.qrDataUrl.startsWith('data:image/'))
  await s.srv.stop()
})

test('④-d webConsoleUrl() 签名保留、恒定返回空串（向后兼容）', () => {
  assert.equal(webConsoleUrl(8899), '')
  assert.equal(webConsoleUrl(0), '')
  assert.equal(webConsoleUrl(undefined), '')
})

test('④-e 配对页彻底删除：/pair 与 / 都不再返回任何 HTML', async () => {
  const s = await serve()
  for (const p of ['/pair', '/']) {
    const r = await rf(s.base + p, fromLan)
    assert.equal(r.status, 401, p + ' 只该掉进 token 闸')
    const body = await r.text()
    assert.ok(!body.includes('<html') && !body.includes('<!DOCTYPE'), p + ' 不许再吐 HTML')
    assert.ok(!body.includes('data:image/png;base64'), p + ' 也不许再嵌二维码')
  }
  // 带对码时是 404（路由真的没了，不是被 token 挡住而已）
  const withTok = await rf(s.base + '/pair?token=' + TOKEN, fromLan)
  assert.equal(withTok.status, 404, '带对码也不该有 /pair 这条路由')
  await s.srv.stop()
})
