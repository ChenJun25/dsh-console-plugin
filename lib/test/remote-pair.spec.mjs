import test from 'node:test'
import assert from 'node:assert/strict'
import { startLanServer } from '../lan-server.mjs'

const TOKEN = 'R'.repeat(64)
const TICKET_RE = /^pt_[0-9a-f]{32}$/
const PUB_MSG = '配对与取码仅限局域网内使用'

let portSeq = 0
const nextPort = () => 21701 + (portSeq++ * 2)

const fromPublic = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }

const fromLan = undefined

async function serve(over = {}) {
  const o = Object.assign({
    port: nextPort(),
    allowShift: true,
    log: () => {},
    getToken: () => TOKEN,
    getInfo: () => ({ name: '云上电脑', nodeId: 'dsh-console', host: 'host-1', dshOk: true,
      dshError: '', version: '9.9.9' }),
    listSessions: async () => [],
    runCommand: async () => ({ ok: true }),
    cloud: null,
  }, over)
  const srv = startLanServer(o)
  const started = await srv.start()
  assert.ok(started, '临时 lan-server 必须起得来（端口段 21701+）')
  const base = 'http://127.0.0.1:' + started.port + '/dsh-console'
  const post = async (p, body, headers) => {
    const r = await fetch(base + p, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
      body: JSON.stringify(body || {}),
    })
    let json = null
    try { json = await r.json() } catch (e) { json = null }
    return { status: r.status, json }
  }
  return {
    srv, base, post,
    get: async (p, headers) => {
      const r = await fetch(base + p, headers ? { headers } : undefined)
      return { status: r.status, headers: r.headers }
    },
    close: () => srv.stop(),
  }
}

async function rf(fn) {
  try { return await fn() } catch (e) { return await fn() }
}

test('①-a 不传 getRemotePair（老宿主）⇒ 公网 /pair/ticket 与 /claim 仍 403 且文案不变', async () => {
  const s = await serve()
  try {
    const t = await s.post('/pair/ticket', { ticket: 'pt_' + '0123456789abcdef'.repeat(2) }, fromPublic)
    assert.equal(t.status, 403, '默认必须拦（安全栅栏是默认值，不许反过来）')
    assert.equal(t.json.error, PUB_MSG)
    const c = await s.post('/claim', { code: '000000' }, fromPublic)
    assert.equal(c.status, 403)
    assert.equal(c.json.error, PUB_MSG)
  } finally { await s.close() }
})

test('①-b 显式传 getRemotePair: () => false ⇒ 同样 403（不是「传了函数就放行」）', async () => {
  const s = await serve({ getRemotePair: () => false })
  try {
    const t = await s.post('/pair/ticket', { ticket: 'pt_' + 'ff'.repeat(16) }, fromPublic)
    assert.equal(t.status, 403)
    assert.equal(t.json.error, PUB_MSG)
  } finally { await s.close() }
})

test('①-c 开关关着时，公网来源打 / /pair /qr /newcode 也一并 403（一个都不许漏）', async () => {
  const s = await serve({ getRemotePair: () => false })
  try {
    for (const p of ['/', '/pair']) {
      const r = await rf(() => s.get(p, fromPublic))
      assert.equal(r.status, 403, p + ' 必须 403')
    }
    for (const p of ['/qr', '/newcode']) {
      const r = await rf(() => s.get(p, fromPublic))
      assert.equal(r.status, 403, p + ' 必须 403')
    }
  } finally { await s.close() }
})

test('②-a 开关开 ⇒ 公网来源 /pair/ticket 用有效票能换回 token（异地首配主通路）', async () => {
  const s = await serve({ getRemotePair: () => true })
  try {
    const d = await s.srv.panelData(true)
    const k = d.payload.slice(d.payload.indexOf('k=') + 2).split('&')[0]
    assert.match(k, TICKET_RE, '面板载荷里的 k= 必须是 pt_ + 32 位 hex')
    const r = await s.post('/pair/ticket', { ticket: k }, fromPublic)
    assert.equal(r.status, 200, '开关开 ⇒ 公网票据兑换必须放行')
    assert.equal(r.json.ok, true)
    assert.equal(r.json.token, TOKEN, '换回来的就是长期访问码')
    assert.equal(r.json.base, d.base, 'base 口径仍与面板一致')
  } finally { await s.close() }
})

test('②-b 开关开 ⇒ 公网来源 /claim 用当前 6 位码能换回 token', async () => {
  const s = await serve({ getRemotePair: () => true })
  try {
    const code = s.srv.getPairCode()
    assert.match(code, /^\d{6}$/)
    const r = await s.post('/claim', { code }, fromPublic)
    assert.equal(r.status, 200, '开关开 ⇒ 公网输码必须放行')
    assert.equal(r.json.ok, true)
    assert.equal(r.json.token, TOKEN)
  } finally { await s.close() }
})

test('②-c 开关开也不放宽其他页：/ /pair /qr /newcode /web /pet 仍 403', async () => {
  const s = await serve({ getRemotePair: () => true })
  try {
    for (const p of ['/', '/pair', '/qr', '/newcode', '/web', '/pet']) {
      const r = await rf(() => s.get(p, fromPublic))
      assert.equal(r.status, 403, p + ' 不在放行名单里，必须继续 403')
    }
  } finally { await s.close() }
})

test('②-d 公网来源 /pair/ticket 错票 ⇒ 403 是业务文案「配对票据无效或已过期」，不是闸文案', async () => {
  const s = await serve({ getRemotePair: () => true })
  try {
    const r = await s.post('/pair/ticket', { ticket: 'pt_' + 'ab'.repeat(16) }, fromPublic)
    assert.equal(r.status, 403)
    assert.equal(r.json.error, '配对票据无效或已过期', '过了闸之后要诚实报「票不对」，别拿闸文案糊弄')
  } finally { await s.close() }
})

test('③ 运行中把开关从关切到开、再切回关 ⇒ 立刻生效（不用重启 DSH）', async () => {
  let on = false
  const s = await serve({ getRemotePair: () => on })
  try {
    const bad = await s.post('/pair/ticket', { ticket: 'pt_' + '00'.repeat(16) }, fromPublic)
    assert.equal(bad.status, 403, '关着的时候先拦')
    on = true
    const opened = await s.post('/pair/ticket', { ticket: 'pt_' + '00'.repeat(16) }, fromPublic)
    assert.notEqual(opened.json.error, PUB_MSG, '打开后不该再被闸 A 拦（错票是业务 403，文案不同）')
    on = false
    const closed = await s.post('/pair/ticket', { ticket: 'pt_' + '00'.repeat(16) }, fromPublic)
    assert.equal(closed.json.error, PUB_MSG, '切回关之后必须立刻恢复拦截')
  } finally { await s.close() }
})

test('④-a 公网来源错码连刷 20 次 ⇒ 第 21 次 429「尝试次数过多，请稍后再试」', async () => {
  const s = await serve({ getRemotePair: () => true })
  try {
    const code = s.srv.getPairCode()

    const wrong = (code[0] === '0' ? '1' : '0') + code.slice(1)
    assert.notEqual(wrong, code)
    let last = null
    for (let i = 0; i < 20; i += 1) {
      last = await s.post('/claim', { code: wrong }, fromPublic)
      assert.equal(last.status, 403, '前 20 次仍是普通错码 403')
    }
    const blocked = await s.post('/claim', { code: wrong }, fromPublic)
    assert.equal(blocked.status, 429, '到上限后必须 429（防 6 位码爆破）')
    assert.equal(blocked.json.error, '尝试次数过多，请稍后再试')

    const right = await s.post('/claim', { code }, fromPublic)
    assert.equal(right.status, 429, '限流窗口内连正确码也拒（否则等于没限）')
  } finally { await s.close() }
})

test('④-b 局域网直连刷同样的错码不限流（本地调试不能被自己挡住）', async () => {
  const s = await serve({ getRemotePair: () => true })
  try {
    const code = s.srv.getPairCode()
    const wrong = (code[0] === '0' ? '1' : '0') + code.slice(1)
    for (let i = 0; i < 25; i += 1) {
      const r = await s.post('/claim', { code: wrong })
      assert.equal(r.status, 403, '局域网直连第 ' + (i + 1) + ' 次仍是普通 403')
    }
    const ok = await s.post('/claim', { code })
    assert.equal(ok.status, 200, '局域网直连不受公网限流影响')
  } finally { await s.close() }
})

test('⑤-a panelData 带 remotePair 布尔键：默认 false、开关开 true', async () => {
  const off = await serve()
  try {
    const d = await off.srv.panelData(false)
    assert.equal(typeof d.remotePair, 'boolean', 'remotePair 必须是布尔键（面板据此画灯）')
    assert.equal(d.remotePair, false, '默认必须是关')
  } finally { await off.close() }

  const on = await serve({ getRemotePair: () => true })
  try {
    const d = await on.srv.panelData(false)
    assert.equal(d.remotePair, true)
  } finally { await on.close() }
})

test('⑤-b srv.getRemotePair() 暴露实时状态（宿主自查 / 排查用）', async () => {
  let on = false
  const s = await serve({ getRemotePair: () => on })
  try {
    assert.equal(s.srv.getRemotePair(), false)
    on = true
    assert.equal(s.srv.getRemotePair(), true)
  } finally { await s.close() }
  const legacy = await serve()
  try {
    assert.equal(legacy.srv.getRemotePair(), false, '老宿主不传 ⇒ 恒 false')
  } finally { await legacy.close() }
})

const PAID_MSG = '异地配对需要先开通公网访问服务'

const fakeCloudVip = (vipExpireMs) => ({
  snapshot: () => ({ ok: true, nodeId: 'n', shortId: 'A1B2C3D4E5F6G7H', tunnelSid: 'ABCDEFGHIJKLMNO',
    vipExpireMs, online: true, offline: false, lastSeenMs: 0, bound: null }),
})

test('⑥-a VIP 已过期 ⇒ 公网 /claim 与 /pair/ticket 都被会员闸拦，文案是「异地配对需要先开通公网访问服务」', async () => {
  const s = await serve({ getRemotePair: () => true, cloud: fakeCloudVip(Date.now() - 60 * 1000) })
  try {

    const t = await s.post('/pair/ticket', { ticket: 'pt_' + 'aa'.repeat(16) }, fromPublic)
    assert.equal(t.status, 403, 'VIP 过期时公网票据兑换必须拦')
    assert.equal(t.json.error, PAID_MSG, '必须是会员闸文案（别拿「局域网」文案糊弄，用户会去翻开关）')
    const c = await s.post('/claim', { code: '000000' }, fromPublic)
    assert.equal(c.status, 403, 'VIP 过期时公网输码必须拦')
    assert.equal(c.json.error, PAID_MSG)

    assert.notEqual(c.json.error, '配对码不对或已过期')
  } finally { await s.close() }
})

test('⑥-b VIP 有效 ⇒ 会员闸放行到原业务逻辑（错码/错票仍是业务文案，正确码 200）', async () => {
  const s = await serve({ getRemotePair: () => true, cloud: fakeCloudVip(Date.now() + 3600 * 1000) })
  try {
    const code = s.srv.getPairCode()
    const wrong = (code[0] === '0' ? '1' : '0') + code.slice(1)
    assert.notEqual(wrong, code)
    const badCode = await s.post('/claim', { code: wrong }, fromPublic)
    assert.equal(badCode.status, 403)
    assert.equal(badCode.json.error, '配对码不对或已过期', '过了会员闸就该是业务文案')
    const okCode = await s.post('/claim', { code }, fromPublic)
    assert.equal(okCode.status, 200, 'VIP 有效 ⇒ 公网输码必须能换到 token')
    assert.equal(okCode.json.token, TOKEN)

    const badTicket = await s.post('/pair/ticket', { ticket: 'pt_' + 'bb'.repeat(16) }, fromPublic)
    assert.equal(badTicket.status, 403)
    assert.equal(badTicket.json.error, '配对票据无效或已过期', '票据仍由业务层判，文案不变')
    const d = await s.srv.panelData(true)
    const k = d.payload.slice(d.payload.indexOf('k=') + 2).split('&')[0]
    assert.match(k, TICKET_RE)
    const okTicket = await s.post('/pair/ticket', { ticket: k }, fromPublic)
    assert.equal(okTicket.status, 200, 'VIP 有效 ⇒ 有效票必须换回 token')
    assert.equal(okTicket.json.token, TOKEN)
  } finally { await s.close() }
})

test('⑥-c 没配云链路（o.cloud 缺省）⇒ fail-open 放行（老插件/本机未上云照旧能用）', async () => {
  const s = await serve({ getRemotePair: () => true })
  try {
    const code = s.srv.getPairCode()
    const r = await s.post('/claim', { code }, fromPublic)
    assert.equal(r.status, 200, 'cloud 不在场时不许拿会员闸拦人（否则把没上云的用户全堵死）')
    assert.equal(r.json.token, TOKEN)
  } finally { await s.close() }
})

test('⑥-d 局域网配对完全不受会员闸影响：VIP 过期时局域网 /claim 仍 200', async () => {
  const s = await serve({ getRemotePair: () => true, cloud: fakeCloudVip(Date.now() - 60 * 1000) })
  try {
    const code = s.srv.getPairCode()
    const r = await s.post('/claim', { code }, fromLan)
    assert.equal(r.status, 200, '局域网直连（无转发头）必须一行不受影响')
    assert.equal(r.json.token, TOKEN)
  } finally { await s.close() }
})

test('⑥-e 云对象在场但 snapshot 抛异常 ⇒ 与「服务不可用」同待遇，公网配对拦（不 fail-open）', async () => {
  const s = await serve({
    getRemotePair: () => true,
    cloud: { snapshot: () => { throw new Error('云端炸了') } },
  })
  try {
    const c = await s.post('/claim', { code: '000000' }, fromPublic)
    assert.equal(c.status, 403, '配了云但拿不到会员状态 ⇒ 按未开通处理（与闸 C 口径一致）')
    assert.equal(c.json.error, PAID_MSG)
  } finally { await s.close() }
})

function fakeCloudPublish(impl) {
  const calls = []
  return {
    calls,
    snapshot: () => ({ ok: true, nodeId: 'n', shortId: 'A1B2C3D4E5F6G7H', tunnelSid: 'ABCDEFGHIJKLMNO',
      vipExpireMs: Date.now() + 3600 * 1000, online: true, offline: false, lastSeenMs: 0, bound: null }),
    publishPairCode: (code, publicUrl, ttlMs) => {
      calls.push({ code, publicUrl, ttlMs })
      return impl(code, publicUrl, ttlMs)
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

test('⑦-a 开关关 ⇒ panelData 的 remotePairCode 是空串、leftMs 是 0，且一次都不上报云端', async () => {
  const cloud = fakeCloudPublish(() => Promise.resolve({ ok: true, expMs: Date.now() + 15 * 60 * 1000 }))
  const s = await serve({ cloud })
  try {
    const d = await s.srv.panelData(false)
    assert.equal(s.srv.getRemotePair(), false, '这条用例的前提是开关关着')
    assert.equal(d.remotePairCode, '', '开关关着不许给码（给了用户会以为能用）')
    assert.equal(d.remotePairCodeLeftMs, 0)
    assert.equal(d.remotePairCodeErr, '')
    await flush()
    assert.equal(cloud.calls.length, 0, '开关关着绝不许往云端发码（隐私 + 无谓请求）')
  } finally { await s.close() }
})

test('⑦-b 开关开 ⇒ 6 位数字码 + leftMs > 0，且恰好向云端上报一次（码/ttl 与面板一致）', async () => {
  const cloud = fakeCloudPublish(() => Promise.resolve({ ok: true, expMs: Date.now() + 15 * 60 * 1000 }))
  const s = await serve({ getRemotePair: () => true, cloud })
  try {
    const d = await s.srv.panelData(false)
    assert.match(d.remotePairCode, /^[0-9]{6}$/, '面板上必须是一个 6 位数字码')
    assert.ok(d.remotePairCodeLeftMs > 0, '剩余时间必须为正（倒计时要用）')
    assert.ok(d.remotePairCodeLeftMs <= 15 * 60 * 1000, '不许超过 15 分钟契约上限')
    await flush()
    assert.equal(cloud.calls.length, 1, '同一时刻只许上报一发（不许叠着发）')
    assert.equal(cloud.calls[0].code, d.remotePairCode, '上报的码必须就是面板上那个码')
    assert.ok(cloud.calls[0].ttlMs > 0 && cloud.calls[0].ttlMs <= 15 * 60 * 1000, 'ttl 落在契约区间内')
    assert.equal(typeof cloud.calls[0].publicUrl, 'string', 'publicUrl 一律给字符串（没隧道就给空串）')

    const d2 = await s.srv.panelData(false)
    assert.equal(d2.remotePairCode, d.remotePairCode, '同一个码在有效期内不许换')
    await flush()
    assert.equal(cloud.calls.length, 1, '60s 续报点没到 ⇒ 不许再发')
  } finally { await s.close() }
})

test('⑦-c 上报抛错 ⇒ remotePairCodeErr 非空，但码仍是那个 6 位数字（绝不换码）', async () => {
  const cloud = fakeCloudPublish(() => { throw new Error('云端连不上') })
  const s = await serve({ getRemotePair: () => true, cloud })
  try {
    const d = await s.srv.panelData(false)
    assert.match(d.remotePairCode, /^[0-9]{6}$/, '上报失败也必须照常显示码（用户先看到码，稍后自动重试）')
    assert.notEqual(d.remotePairCodeErr, '', '失败原因必须透出给面板（否则用户永远不知道没同步上）')
    assert.match(String(d.remotePairCodeErr), /云端连不上/, '原文透出，别吞成空串')
    const d2 = await s.srv.panelData(false)
    assert.equal(d2.remotePairCode, d.remotePairCode, '上报失败**不许换码** —— 用户手机上正看着这个号')
    await flush()
    assert.ok(cloud.calls.length >= 1, '失败后会立刻重试（remotePubAt 清回 0）')
  } finally { await s.close() }
})

test('⑧-a 开关开 + 面板取过码 ⇒ 用异地码打 /claim 也 200 拿到 token', async () => {
  const cloud = fakeCloudPublish(() => Promise.resolve({ ok: true, expMs: Date.now() + 15 * 60 * 1000 }))
  const s = await serve({ getRemotePair: () => true, cloud })
  try {
    const d = await s.srv.panelData(false)
    const remoteCode = d.remotePairCode
    assert.match(remoteCode, /^[0-9]{6}$/, '面板必须先给得出异地码')
    const r = await s.post('/claim', { code: remoteCode }, fromLan)
    assert.equal(r.status, 200, '异地码必须能换 token（否则云端 lookup 换来的地址打过来必 403，整条链断）')
    assert.equal(r.json.token, TOKEN)
    assert.equal(typeof r.json.base, 'string')
    assert.equal(typeof r.json.c, 'string', '公网候选串照旧下发（形状一个字不改）')
  } finally { await s.close() }
})

test('⑧-b 异地码核销后立刻再用 ⇒ 403（一次性），且旧码已不在内部状态里', async () => {
  const cloud = fakeCloudPublish(() => Promise.resolve({ ok: true, expMs: Date.now() + 15 * 60 * 1000 }))
  const s = await serve({ getRemotePair: () => true, cloud })
  try {
    const remoteCode = (await s.srv.panelData(false)).remotePairCode
    const ok = await s.post('/claim', { code: remoteCode }, fromLan)
    assert.equal(ok.status, 200)

    const fresh = s.srv.peekRemoteCode()
    assert.match(fresh, /^[0-9]{6}$/, '成功分支末尾会立刻备好下一个码')
    assert.notEqual(fresh, remoteCode, '旧码必须已被核销（内部换成了新码）')
    assert.ok(s.srv.remoteCodeLeftMs() > 0, '新码剩余时间必须为正')

    for (let i = 0; i < 10 && s.srv.peekRemoteCode() === remoteCode; i += 1) s.srv.refreshRemoteCode()
    const again = await s.post('/claim', { code: remoteCode }, fromLan)
    assert.equal(again.status, 403, '同一个异地码不许用第二次（与局域网码同口径）')
    assert.equal(again.json.error, '配对码不对或已过期', '文案一个字不许变')
  } finally { await s.close() }
})

test('⑧-c 开关关 ⇒ 原异地码立刻失效（403），且局域网码照常 200', async () => {
  let on = true
  const cloud = fakeCloudPublish(() => Promise.resolve({ ok: true, expMs: Date.now() + 15 * 60 * 1000 }))
  const s = await serve({ getRemotePair: () => on, cloud })
  try {
    const remoteCode = (await s.srv.panelData(false)).remotePairCode
    assert.match(remoteCode, /^[0-9]{6}$/)
    on = false
    const dead = await s.post('/claim', { code: remoteCode }, fromLan)
    assert.equal(dead.status, 403, '开关关掉后异地码必须立刻作废（不能靠 15 分钟过期兜底）')
    assert.equal(dead.json.error, '配对码不对或已过期')

    const localCode = s.srv.getPairCode()
    const ok = await s.post('/claim', { code: localCode }, fromLan)
    assert.equal(ok.status, 200, '异地开关关着时局域网配对必须照常能用')
    assert.equal(ok.json.token, TOKEN)
  } finally { await s.close() }
})

test('⑧-d 两个码都不对的乱码 ⇒ 仍 403，且公网来源照旧计数限流（第 21 次 429）', async () => {
  const cloud = fakeCloudPublish(() => Promise.resolve({ ok: true, expMs: Date.now() + 15 * 60 * 1000 }))
  const s = await serve({ getRemotePair: () => true, cloud })
  try {
    const remoteCode = (await s.srv.panelData(false)).remotePairCode
    const localCode = s.srv.getPairCode()

    let junk = '000000'
    if (junk === remoteCode || junk === localCode) junk = '111111'
    assert.notEqual(junk, remoteCode)
    assert.notEqual(junk, localCode)
    const first = await s.post('/claim', { code: junk }, fromPublic)
    assert.equal(first.status, 403, '两个码都不对 ⇒ 仍是 403')
    assert.equal(first.json.error, '配对码不对或已过期', '文案一个字不许变')

    for (let i = 0; i < 19; i += 1) {
      const r = await s.post('/claim', { code: junk }, fromPublic)
      assert.equal(r.status, 403, '第 ' + (i + 2) + ' 次仍是 403')
    }
    const blocked = await s.post('/claim', { code: junk }, fromPublic)
    assert.equal(blocked.status, 429, '到上限必须 429（防爆破没有被「两个码都认」改松）')
    assert.equal(blocked.json.error, '尝试次数过多，请稍后再试')
  } finally { await s.close() }
})

test('⑨-a 闸 A 未开异地开关 ⇒ 403 带 reason=remote-pair-off（文案与状态码不变）', async () => {
  const s = await serve()
  try {
    const r = await s.post('/claim', { code: '000000' }, fromPublic)
    assert.equal(r.status, 403, '状态码不许变')
    assert.equal(r.json.error, PUB_MSG, '文案不许变（老 App 靠这句）')
    assert.equal(r.json.reason, 'remote-pair-off', '新增：App 据此提示「去面板开异地配对」')
    assert.equal(r.json.ok, false, 'ok 语义不变')

    const t = await s.post('/pair/ticket', { ticket: 'pt_' + 'cc'.repeat(16) }, fromPublic)
    assert.equal(t.status, 403)
    assert.equal(t.json.reason, 'remote-pair-off', '两条路由同一道闸，reason 必须一致')
  } finally { await s.close() }
})

test('⑨-b 开关开了但会员过期 ⇒ 403 带 reason=need-vip（与 remote-pair-off 分得开）', async () => {
  const s = await serve({ getRemotePair: () => true, cloud: fakeCloudVip(Date.now() - 60 * 1000) })
  try {
    const c = await s.post('/claim', { code: '000000' }, fromPublic)
    assert.equal(c.status, 403)
    assert.equal(c.json.error, PAID_MSG, '文案不许变')
    assert.equal(c.json.reason, 'need-vip', 'App 据此提示「去开通公网服务」')
    assert.notEqual(c.json.reason, 'remote-pair-off', '两种没开通必须分得开（否则 App 只能瞎猜）')
    const t = await s.post('/pair/ticket', { ticket: 'pt_' + 'dd'.repeat(16) }, fromPublic)
    assert.equal(t.json.reason, 'need-vip', '票据路由同一条闸，reason 一致')
  } finally { await s.close() }
})

test('⑨-c 两个码都不对 ⇒ 403 带 reason=code-mismatch（这是真·码不对）', async () => {
  const s = await serve({ getRemotePair: () => true })
  try {
    const localCode = s.srv.getPairCode()
    const junk = localCode === '000000' ? '111111' : '000000'
    const r = await s.post('/claim', { code: junk }, fromPublic)
    assert.equal(r.status, 403)
    assert.equal(r.json.error, '配对码不对或已过期', '文案不许变')
    assert.equal(r.json.reason, 'code-mismatch', 'App 据此提示「码输错了」')
    assert.notEqual(r.json.reason, 'need-vip', '码不对不许误报成会员问题')
  } finally { await s.close() }
})

test('⑨-d 顺带覆盖：400 格式错 ⇒ reason=bad-format、429 限流 ⇒ reason=too-many', async () => {
  const s1 = await serve({ getRemotePair: () => true })
  try {
    const short = await s1.post('/claim', { code: '12' }, fromPublic)
    assert.equal(short.status, 400, '状态码不许变')
    assert.equal(short.json.error, '配对码是 6 位数字', '文案不许变')
    assert.equal(short.json.reason, 'bad-format')
  } finally { await s1.close() }

  const s2 = await serve({ getRemotePair: () => true })
  try {
    const localCode = s2.srv.getPairCode()
    const wrong = (localCode[0] === '0' ? '1' : '0') + localCode.slice(1)
    for (let i = 0; i < 20; i += 1) {
      const r = await s2.post('/claim', { code: wrong }, fromPublic)
      assert.equal(r.status, 403, '前 20 次仍是普通 403')
    }
    const blocked = await s2.post('/claim', { code: wrong }, fromPublic)
    assert.equal(blocked.status, 429, '状态码不许变')
    assert.equal(blocked.json.error, '尝试次数过多，请稍后再试', '文案不许变')
    assert.equal(blocked.json.reason, 'too-many')
  } finally { await s2.close() }
})

