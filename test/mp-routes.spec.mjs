/**
 * /mp/* 挂载的集成测试 —— 起一个真的 http.Server，用真的 fetch 打过去。
 *
 * 为什么非要真 socket：门禁、状态码、Cookie 往返这三样最容易在单测里
 * 「因为没走网络所以看不出来」。这里逐个都走真 HTTP。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { createMpBranch } from '../lib/mp-routes.mjs'
import { createDispatcher } from '../lib/mp-dispatch.mjs'

let n = 0
const ok = (t) => { n++; console.log('  ok - ' + t) }
const section = (t) => console.log('\n' + t)
const noop = () => {}

/** 起一个带 /mp/* 的服务，返回 baseUrl 与关闭函数。 */
async function serve(over = {}) {
  const calls = []
  const ctl = {
    async list() { return { items: [{ sessionId: 's1', title: 't', cwd: 'w', updatedAt: 5 }] } },
    async history() { return { events: [{ seq: 1, type: 'user/message' }] } },
    async prompt() { return { accepted: true } },
  }
  const secrets = new Map([['goodsecret', 'device-1']])
  const store = {
    isPaired: (s) => secrets.has(s),
    exchange: (token) => (token === '123456' ? { secret: 'goodsecret', deviceId: 'device-1' } : null),
    revoke: (s) => secrets.delete(s),
    ...over.store,
  }
  const dispatch = createDispatcher({ get: (k) => (k === 'sessionController' ? ctl : null) },
    (m) => calls.push(m), over.tracker || null, { pins: new Set() })

  // 复刻 lan-server.mjs 的 handler 形状：/mp/* 走早返回分支，其它一律 404。
  // 这正是实测踩过的坑 —— 另挂监听器会被这里抢先写掉 404。
  const branch = createMpBranch({ dispatch, store, log: noop })
  const server = http.createServer(async (req, res) => {
    const pathname = String(req.url || '/').split('?')[0]
    if (await branch(req, res, pathname)) return
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not mp')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port
  return { base, server, calls, secrets, close: () => new Promise((r) => server.close(r)) }
}

const withCookie = (c) => ({ Cookie: 'mp_device=' + c })

/* ---------------- 门禁 ---------------- */
section('鉴权门禁')

{
  const s = await serve()
  const r = await fetch(s.base + '/mp/api/session.list', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rpcId: 'r1', payload: {} }),
  })
  assert.equal(r.status, 401)
  assert.equal((await r.json()).error, 'not-paired')
  await s.close()
  ok('an RPC with no cookie is refused with 401, before anything else runs')
}

{
  const s = await serve()
  const r = await fetch(s.base + '/mp/api/session.list', {
    method: 'POST', headers: { ...withCookie('wrongsecret') },
    body: JSON.stringify({ rpcId: 'r1', payload: {} }),
  })
  assert.equal(r.status, 403)
  const body = await r.json()
  // The client reads this code and says "plugin too old"; a 401 would be read
  // as "this device is not paired" and send the user to the wrong screen.
  assert.equal(body.code, 'forbidden')
  await s.close()
  ok('a wrong cookie is 403 forbidden, which the client reads differently from 401')
}

{
  const s = await serve()
  // Non-/mp traffic must be untouched — the WeChat mini program still works.
  const r = await fetch(s.base + '/sessions')
  assert.equal(r.status, 404)
  assert.equal(await r.text(), 'not mp')
  await s.close()
  ok('non-/mp routes fall through to the existing handler untouched')
}

{
  const s = await serve()
  // /mp-ish prefixes that are not ours must not be stolen.
  for (const p of ['/mpx/api/session.list', '/mppx/api']) {
    const r = await fetch(s.base + p)
    assert.equal(r.status, 404, p)
  }
  await s.close()
  ok('a path that merely starts with similar letters is not claimed')
}

/* ---------------- 配对 ---------------- */
section('配对换 Cookie')

{
  const s = await serve()
  const bad = await fetch(s.base + '/mp/pair/accept', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: '000000' }),
  })
  assert.equal(bad.status, 403)
  assert.equal((await bad.json()).code, 'forbidden')
  await s.close()
  ok('a wrong pairing code is refused with the code the client can explain')
}

{
  const s = await serve()
  const r = await fetch(s.base + '/mp/pair/accept', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: '123456' }),
  })
  assert.equal(r.status, 200)
  const raw = r.headers.get('set-cookie')
  assert.ok(raw, 'Set-Cookie is present')
  // ArkTS reads the response header as a JSON string, so the name must survive.
  assert.ok(raw.startsWith('mp_device=goodsecret'), raw)
  assert.ok(raw.includes('HttpOnly'), 'HttpOnly is set')
  assert.ok(raw.includes('Path=/'), 'path is scoped to the root')
  const body = await r.json()
  assert.equal(body.ok, true)
  assert.ok(body.deviceId, 'a device id comes back in the body too')
  await s.close()
  ok('a good code returns a Set-Cookie the client can actually store')
}

{
  // The full client flow: accept -> carry the cookie -> call an RPC.
  const s = await serve()
  const pair = await fetch(s.base + '/mp/pair/accept', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: '123456' }),
  })
  const cookie = pair.headers.get('set-cookie').split(';')[0]
  const r = await fetch(s.base + '/mp/api/session.list', {
    method: 'POST', headers: { Cookie: cookie },
    body: JSON.stringify({ rpcId: 'r1', payload: {} }),
  })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.type, 'server-response')
  assert.equal(body.result.ok, true)
  assert.equal(body.result.value.items[0].sessionId, 's1')
  await s.close()
  ok('pair then call works end to end, which is the flow the app performs')
}

{
  const s = await serve()
  const st = await fetch(s.base + '/mp/pair/status', { headers: withCookie('goodsecret') })
  assert.equal(st.status, 200)
  assert.equal((await st.json()).paired, true)
  await s.close()
  ok('pair/status reports paired for a known device')
}

/* ---------------- RPC ---------------- */
section('RPC 往返')

{
  const s = await serve()
  const r = await fetch(s.base + '/mp/api/session.history', {
    method: 'POST', headers: withCookie('goodsecret'),
    body: JSON.stringify({ rpcId: 'r9', payload: { sessionId: 's1', maxMessages: 20 } }),
  })
  const body = await r.json()
  assert.equal(body.rpcId, 'r9', 'rpcId survives the round trip')
  assert.equal(body.result.value.events[0].seq, 1)
  await s.close()
  ok('an RPC returns the envelope with rpcId echoed')
}

{
  const s = await serve()
  const r = await fetch(s.base + '/mp/api/evil.method', {
    method: 'POST', headers: withCookie('goodsecret'),
    body: JSON.stringify({ rpcId: 'r', payload: {} }),
  })
  assert.equal(r.status, 200, 'an unknown method is still HTTP 200')
  const body = await r.json()
  assert.equal(body.result.error.code, 'forbidden')
  await s.close()
  ok('a method off the allowlist comes back 200 + forbidden, not 404')
}

{
  // A path under /mp/api/ with an extra segment is still RPC-shaped, so it
  // answers forbidden rather than 404 — the client reads the code either way,
  // and treating it as "no such route" would hide a client bug.
  const s = await serve()
  const r = await fetch(s.base + '/mp/api/session.list/extra', {
    method: 'POST', headers: withCookie('goodsecret'),
    body: JSON.stringify({ rpcId: 'r', payload: {} }),
  })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).result.error.code, 'forbidden')
  await s.close()
  ok('a malformed method path is refused as forbidden, never mis-dispatched')
}

{
  const s = await serve()
  const r = await fetch(s.base + '/mp/api/session.list', {
    method: 'GET', headers: withCookie('goodsecret'),
  })
  assert.equal(r.status, 405)
  await s.close()
  ok('a GET on the RPC path is refused; the client always POSTs')
}

{
  // A body that is not JSON must not take the server down.
  const s = await serve()
  const r = await fetch(s.base + '/mp/api/session.list', {
    method: 'POST', headers: withCookie('goodsecret'),
    body: 'not json at all',
  })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).result.ok, true, 'it degrades to an empty payload')
  await s.close()
  ok('a non-JSON body degrades to an empty payload instead of crashing')
}

/* ---------------- 并发 ---------------- */
section('并发与稳定性')

{
  const s = await serve()
  const reqs = Array.from({ length: 20 }, (_, i) =>
    fetch(s.base + '/mp/api/session.list', {
      method: 'POST', headers: withCookie('goodsecret'),
      body: JSON.stringify({ rpcId: 'c' + i, payload: {} }),
    }).then((r) => r.json()))
  const out = await Promise.all(reqs)
  assert.equal(out.length, 20)
  assert.equal(out.filter((b) => b.result.ok).length, 20, 'every concurrent call succeeds')
  const ids = new Set(out.map((b) => b.rpcId))
  assert.equal(ids.size, 20, 'responses are not crossed between requests')
  await s.close()
  ok('20 concurrent calls all succeed with no crossed responses')
}

console.log(`\n${n} 项挂载集成断言通过`)
