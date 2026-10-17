/**
 * 第233节 · 「允许异地（公网）首次配对」开关（插件半）。
 *
 * 用户痛点：DSH 装在云服务器/异地，手机和电脑不在同一个 WiFi，公网永远连不上；
 * 而闸 A（PUB_BLOCKED）把公网来源的 /pair/ticket 与 /claim 一律 403 ⇒ 首次配对死路。
 *
 * 冻结契约：
 *   - 开关默认 **关**（老宿主不传 getRemotePair ⇒ 恒 false，行为与改造前逐字一致）。
 *   - 开关开 ⇒ **只**放行 '/pair/ticket' 与 '/claim' 两条；/ /pair /qr /newcode /web /pet 照旧 403。
 *   - 开关是**实时**的（读 o.getRemotePair() 函数，不是启动时快照），面板点一下立刻生效。
 *   - 公网来源 /claim 错码有计数限流（15 分钟窗口 20 次 ⇒ 429）；局域网直连不计数。
 *   - 票据 5 分钟一次性、6 位码 15 分钟核销 —— 这两条语义不受开关影响。
 *
 * 跑法：node lib/test/remote-pair.spec.mjs
 *
 * ⚠️ 端口段与其它 spec 错开：本文件用 21701 起（21301 pair-cloud / 21501 pair-ticket 已占）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startLanServer } from '../lan-server.mjs'

const TOKEN = 'R'.repeat(64)
const TICKET_RE = /^pt_[0-9a-f]{32}$/
const PUB_MSG = '配对与取码仅限局域网内使用'

let portSeq = 0
const nextPort = () => 21701 + (portSeq++ * 2)

/** 公网来源：TCP 连的是回环，但带转发头 —— 正是 Caddy / 隧道转发进来的形状。 */
const fromPublic = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }
/** 局域网直连：不带任何转发头。 */
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

/* undici 在「上一个用例刚 stop 掉服务器」时偶发 ECONNRESET（本地套接字半关闭竞态，
   与被测代码无关）：重试一次即可，避免闸门出现假红（照 sec-gate.spec 的 rf）。 */
async function rf(fn) {
  try { return await fn() } catch (e) { return await fn() }
}

/* ============================================================
 * ① 默认关：行为与改造前逐字一致
 * ============================================================ */

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

/* ============================================================
 * ② 开关打开：只放两条，别的照旧拦
 * ============================================================ */

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

/* ============================================================
 * ③ 实时性：面板点一下立刻生效（不是启动时快照）
 * ============================================================ */

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

/* ============================================================
 * ④ 公网 /claim 错码限流（开关开才有意义）
 * ============================================================ */

test('④-a 公网来源错码连刷 20 次 ⇒ 第 21 次 429「尝试次数过多，请稍后再试」', async () => {
  const s = await serve({ getRemotePair: () => true })
  try {
    const code = s.srv.getPairCode()
    // 用一定不会等于当前码的错码（当前码首位取反）
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
    // 就算这时输入正确码也进不去 —— 限流是硬门，窗口内不给试
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

/* ============================================================
 * ⑤ 面板数据与 return 对象暴露开关状态（面板要画灯）
 * ============================================================ */

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

/* ============================================================
 * ⑥ 第234节 · 异地配对的**会员闸**（remotePairPaid）
 *
 * 为什么必须补：隧道从第234节起按「节点短号」发 ⇒ **没绑定/没付费的机器也有 publicUrl**，
 * 于是「开关打开 ⇒ 公网 /claim 放行」等于给未付费机器开了一扇公网首配的门。
 * 口径（与闸 C 的 CLOUD_GATED 完全一致，别拧）：
 *   · 没配云链路（o.cloud 不在场）⇒ **fail-open 放行**（此时压根没有公网入口）；
 *   · 配了云链路 ⇒ 只认 isCloudLive()（VIP 未过期）；云对象在场但 snapshot 抛 ⇒ 同「服务不可用」，拦。
 * ============================================================ */

const PAID_MSG = '异地配对需要先开通公网访问服务'

/** 伪云链路：只管快照里的会员到期时间（闸用不到别的字段）。 */
const fakeCloudVip = (vipExpireMs) => ({
  snapshot: () => ({ ok: true, nodeId: 'n', shortId: 'A1B2C3D4E5F6G7H', tunnelSid: 'ABCDEFGHIJKLMNO',
    vipExpireMs, online: true, offline: false, lastSeenMs: 0, bound: null }),
})

test('⑥-a VIP 已过期 ⇒ 公网 /claim 与 /pair/ticket 都被会员闸拦，文案是「异地配对需要先开通公网访问服务」', async () => {
  const s = await serve({ getRemotePair: () => true, cloud: fakeCloudVip(Date.now() - 60 * 1000) })
  try {
    /* ①②两张卡都拍：漏一条就等于没卡住 */
    const t = await s.post('/pair/ticket', { ticket: 'pt_' + 'aa'.repeat(16) }, fromPublic)
    assert.equal(t.status, 403, 'VIP 过期时公网票据兑换必须拦')
    assert.equal(t.json.error, PAID_MSG, '必须是会员闸文案（别拿「局域网」文案糊弄，用户会去翻开关）')
    const c = await s.post('/claim', { code: '000000' }, fromPublic)
    assert.equal(c.status, 403, 'VIP 过期时公网输码必须拦')
    assert.equal(c.json.error, PAID_MSG)
    /* 拦在业务逻辑之前：文案不能是「配对码不对或已过期」 */
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

/* ============================================================
 * ⑦ 第235节 · task-4 · 异地配对码（用户 m01926：面板不告诉地址，只给码）
 *
 * 契约：
 *   · 开关关 ⇒ remotePairCode===''（不显示、也不上报）；
 *   · 开关开 ⇒ 面板给 6 位数字码 + 剩余毫秒，并由插件 fire-and-forget 上报云端一次；
 *   · 上报失败 ⇒ 只把原因写进 remotePairCodeErr，**绝不换码**（换码会让用户手机上那个号瞬间失效）。
 * ============================================================ */

/** 伪云链路：只桩 publishPairCode（异地码上报通道），顺手记下每次调用的参数。 */
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

/* 让 fire-and-forget 的 .then 链跑完（只等微任务 + 一个宏任务，不 sleep 等网络）。 */
const flush = () => new Promise((r) => setTimeout(r, 0))

test('⑦-a 开关关 ⇒ panelData 的 remotePairCode 是空串、leftMs 是 0，且一次都不上报云端', async () => {
  const cloud = fakeCloudPublish(() => Promise.resolve({ ok: true, expMs: Date.now() + 15 * 60 * 1000 }))
  const s = await serve({ cloud })                      // getRemotePair 缺省 ⇒ 恒 false
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
    /* 同一毫秒内再读一次：码不许变、也不许重新上报（续报间隔 60s）。 */
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

/* ============================================================
 * ⑧ 第236节 · task-5 · /claim **两个码都认**（局域网码 + 异地配对码）
 *
 * 断链背景：task-4 起异地码由插件本地生成、上报云端做映射；手机经云端
 * /api/cloud/pair/lookup 换到 publicUrl 后，要拿**这个异地码**去打公网 /claim。
 * 以前 /claim 只比局域网码 ⇒ 异地输码永远 403，整条链路是断的。
 * 铁律：错误文案/状态码一个字不许变；异地码同样**一次性**核销。
 * ============================================================ */

test('⑧-a 开关开 + 面板取过码 ⇒ 用异地码打 /claim 也 200 拿到 token', async () => {
  const cloud = fakeCloudPublish(() => Promise.resolve({ ok: true, expMs: Date.now() + 15 * 60 * 1000 }))
  const s = await serve({ getRemotePair: () => true, cloud })
  try {
    const d = await s.srv.panelData(false)          // 面板一开就有码（ensureRemoteCode）
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
    /* ⚠️ 实测语义（别再写成「核销后 remoteCode === ''」）：
       核销发生在成功分支中段（remoteCode/remoteExp/remotePubAt/remotePubErr 全清），
       但同一次请求**末尾**的 panelData(false) 又会 ensure 出一个**新码**并重新上报
       —— 那是给「再配一台手机」用的，面板刷新即见。
       所以可观测的正确状态是：旧码不在内部了、新码是另一个 6 位数、leftMs 为正。 */
    const fresh = s.srv.peekRemoteCode()
    assert.match(fresh, /^[0-9]{6}$/, '成功分支末尾会立刻备好下一个码')
    assert.notEqual(fresh, remoteCode, '旧码必须已被核销（内部换成了新码）')
    assert.ok(s.srv.remoteCodeLeftMs() > 0, '新码剩余时间必须为正')
    /* 防御 1/100 万 撞号：万一新码恰好等于旧码，先刷掉再验一次性语义。 */
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
    on = false                                     // 面板点「关闭」
    const dead = await s.post('/claim', { code: remoteCode }, fromLan)
    assert.equal(dead.status, 403, '开关关掉后异地码必须立刻作废（不能靠 15 分钟过期兜底）')
    assert.equal(dead.json.error, '配对码不对或已过期')
    /* 局域网码不受牵连：关掉异地开关不许影响本地配对 */
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
    /* 造一个两个码都不是的 6 位数（000000 有 1/100 万概率撞上，撞了就换一个） */
    let junk = '000000'
    if (junk === remoteCode || junk === localCode) junk = '111111'
    assert.notEqual(junk, remoteCode)
    assert.notEqual(junk, localCode)
    const first = await s.post('/claim', { code: junk }, fromPublic)
    assert.equal(first.status, 403, '两个码都不对 ⇒ 仍是 403')
    assert.equal(first.json.error, '配对码不对或已过期', '文案一个字不许变')
    /* 已用掉 1 次，再刷 19 次到上限，第 21 次必须 429（限流没有被这次改动绕过） */
    for (let i = 0; i < 19; i += 1) {
      const r = await s.post('/claim', { code: junk }, fromPublic)
      assert.equal(r.status, 403, '第 ' + (i + 2) + ' 次仍是 403')
    }
    const blocked = await s.post('/claim', { code: junk }, fromPublic)
    assert.equal(blocked.status, 429, '到上限必须 429（防爆破没有被「两个码都认」改松）')
    assert.equal(blocked.json.error, '尝试次数过多，请稍后再试')
  } finally { await s.close() }
})

