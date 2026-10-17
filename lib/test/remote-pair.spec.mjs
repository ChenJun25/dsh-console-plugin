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
