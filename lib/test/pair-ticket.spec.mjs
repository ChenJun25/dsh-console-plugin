/**
 * task-19 单测（插件半 · #A3）：二维码改「一次性配对票据」。
 *
 * 用户痛点（lead 冻结契约）：二维码里原来直接带 t=<64 位长期访问码>，
 * 谁截一张屏就永久拿到这台电脑的访问码。现在二维码只带 k=<pt_ + 32 位 hex 的一次性票>，
 * 手机必须在局域网内 POST /pair/ticket 用票换回 { token, base, name, c }。
 *
 * 冻结契约（lan-server.mjs 侧的落点）：
 *   - pairPayload({ base, ticket, name, node, cloud }) ⇒ 'k=' + 票，**不再输出 't='**。
 *   - POST /pair/ticket body {ticket}：
 *       成功 200 {ok:true,token,base,name,c}；失败 403 {ok:false,error:'配对票据无效或已过期'}。
 *   - '/pair/ticket' 在 PUB_BLOCKED 里 ⇒ 公网来源 403「配对与取码仅限局域网内使用」。
 *   - 票 TTL 5 分钟、兑换即焚（一次有效）；/newcode 一并作废票。
 *   - 6 位码 /claim 与 c= 公网候选语义不动。
 *
 * ⚠️ 过期用例要确定性：startLanServer 接受测试缝 o.pairTicketTtlMs（不传 = 生产 5 分钟）。
 *
 * 跑法：node lib/test/pair-ticket.spec.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startLanServer, pairPayload } from '../lan-server.mjs'

/* ⚠️ 端口段与其它 spec 错开（node --test 并行跑各文件）：
   18901 preset-info / 19101 device-roster+sec-gate / 19501 cloud-link+host-isolation /
   19601 vip-gate / 19701 device-revoke / 19901 device-revoke-blacklist /
   20901 device-persist / 21101 revoke-uid / 21301 pair-cloud ⇒ 本文件用 21501 起。 */
let liveSeq = 0
const PUBLIC_URL = 'https://console.example.test/dsh-console'
const TOKEN = 'c'.repeat(64)
const tunnelUp = () => ({ enabled: true, ready: true, phase: 'connected', lastError: '',
  serverAddr: '203.0.113.10', remotePort: 8899, since: 1234, publicUrl: PUBLIC_URL })
const TICKET_RE = /^pt_[0-9a-f]{32}$/

async function serve(over = {}) {
  const srv = startLanServer(Object.assign({
    port: 21501 + (liveSeq++ * 2),
    allowShift: true,
    log: () => {},
    getToken: () => TOKEN,
    getInfo: () => ({ name: '我的电脑', nodeId: 'dsh-console', host: 'host-1', dshOk: true,
      dshError: '', version: '9.9.9', agentPreset: 'ptc', agentPresetAvailable: true }),
    listSessions: async () => [],
    runCommand: async () => ({ ok: true }),
    cloud: null,
  }, over))
  const started = await srv.start()
  assert.ok(started, '临时 lan-server 必须起得来（端口段 21501+）')
  const base = 'http://127.0.0.1:' + started.port
  return {
    srv,
    base,
    ticket: async (t, headers) => {
      const r = await fetch(base + '/pair/ticket', {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
        body: JSON.stringify({ ticket: t })
      })
      return { status: r.status, json: await r.json() }
    },
    claim: async (code) => {
      const r = await fetch(base + '/claim', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code })
      })
      return { status: r.status, json: await r.json() }
    },
    close: () => srv.stop(),
  }
}
/* 从载荷里逐键取值（不依赖 URL 类解析 dsh-console:// 这种自定义协议） */
const keysOf = (payload) => {
  const q = payload.slice('dsh-console://pair?'.length)
  const out = {}
  for (const kv of q.split('&')) { const i = kv.indexOf('='); out[kv.slice(0, i)] = kv.slice(i + 1) }
  return out
}
const stripV = (s) => s.replace(/&v=[^&]*$/, '')

/* ============================================================
 * ① 纯函数层：载荷只带 k= 一次性票，长期访问码彻底消失
 * ============================================================ */
test('task-19 ① pairPayload：出 k= 一次性票、绝不出 t=；空票 ⇒ 一个字节都不加', () => {
  const tk = 'pt_' + '0123456789abcdef'.repeat(2)
  const p = pairPayload({ base: 'http://192.168.1.5:8899/dsh-console', ticket: tk,
    name: '我的电脑', node: 'dsh-console' })
  const k = keysOf(p)
  assert.deepEqual(Object.keys(k), ['b', 'k', 'n', 'i', 'v'], '键序必须是 b/k/n/i/v（t= 已移除）')
  assert.equal(k.k, tk, 'k= 就是票本身（encodeURIComponent 后原样可还原）')
  assert.equal(/[?&]t=/.test(p), false, '🔴 载荷里绝不许出现 t= 长期访问码（本任务主修点）')
  assert.equal(p.includes(TOKEN), false, '访问码一个字节都不进载荷')
  assert.equal(stripV(p),
    'dsh-console://pair?b=' + encodeURIComponent('http://192.168.1.5:8899/dsh-console') +
    '&k=' + encodeURIComponent(tk) + '&n=' + encodeURIComponent('我的电脑') + '&i=dsh-console',
    '去掉动态 v= 后格式逐字可预期')
  const noTicket = pairPayload({ base: 'http://192.168.1.5:8899/dsh-console', ticket: '',
    name: '我的电脑', node: 'dsh-console' })
  assert.deepEqual(Object.keys(keysOf(noTicket)), ['b', 'n', 'i', 'v'], '票为空 ⇒ 不加 k= 键')
  console.log('   [证据] 载荷 = ' + p)
})

/* ============================================================
 * ② 端到端：二维码/载荷里的票 ⇒ POST /pair/ticket 换回 token/base/name/c
 * ============================================================ */
test('task-19 ② 票据兑换：200 {token,base,name,c}，token 与面板访问码一致、c 与载荷 c= 同源', async () => {
  const s = await serve({ tunnelStatus: tunnelUp })
  try {
    const p = await s.srv.panelData(true)
    assert.equal(p.payload.includes('t=' + TOKEN), false, 'panelData 的载荷同样不含长期访问码')
    const k = keysOf(p.payload)
    assert.match(k.k, TICKET_RE, 'panelData 载荷里的 k= 必须是 pt_ + 32 位 hex')
    assert.equal(decodeURIComponent(k.c || ''), p.cloud, 'c= 仍与 panelData.cloud 同源（task-11 不回归）')

    const r = await s.ticket(k.k)
    assert.equal(r.status, 200, '有效票必须 200')
    assert.deepEqual(Object.keys(r.json).sort(), ['base', 'c', 'name', 'ok', 'token'], '响应键集合一字不差')
    assert.equal(r.json.ok, true)
    assert.equal(r.json.token, TOKEN, '换回来的就是长期访问码')
    assert.equal(r.json.base, p.base, 'base 口径与面板一致（局域网地址）')
    assert.equal(r.json.name, '我的电脑')
    assert.equal(r.json.c, PUBLIC_URL, 'c 与隧道候选同源')
    console.log('   [证据] 票换取结果 = ' + JSON.stringify(Object.assign({}, r.json, { token: '<64位访问码>' })))
  } finally { await s.close() }
})

/* ============================================================
 * ③ 兑换即焚：同一张票第二次必须 403
 * ============================================================ */
test('task-19 ③ 兑换即焚：一张票只能用一次，第二次 403', async () => {
  const s = await serve()
  try {
    const p = await s.srv.panelData(false)
    const tk = keysOf(p.payload).k
    const first = await s.ticket(tk)
    assert.equal(first.status, 200, '第一次兑换成功')
    const second = await s.ticket(tk)
    assert.equal(second.status, 403, '第二次必须 403')
    assert.deepEqual(second.json, { ok: false, error: '配对票据无效或已过期' }, '403 响应体逐字固定')
    console.log('   [证据] 第一次 ' + first.status + ' / 第二次 ' + second.status + ' ' + JSON.stringify(second.json))
  } finally { await s.close() }
})

/* ============================================================
 * ④ TTL：过期票 403；面板刷新会生成新票（v= 让二维码重画）
 * ============================================================ */
test('task-19 ④ 票过期（TTL 注入 30ms）⇒ 403；且新一次取票是另一张票', async () => {
  const s = await serve({ pairTicketTtlMs: 30 })
  try {
    const p1 = await s.srv.panelData(false)
    const tk1 = keysOf(p1.payload).k
    await new Promise((r) => setTimeout(r, 80))
    const expired = await s.ticket(tk1)
    assert.equal(expired.status, 403, '过期票必须 403')
    assert.deepEqual(expired.json, { ok: false, error: '配对票据无效或已过期' })
    const p2 = await s.srv.panelData(false)
    const tk2 = keysOf(p2.payload).k
    assert.notEqual(tk2, tk1, '过期后再取票必须换一张')
    assert.match(tk2, TICKET_RE)
    const ok = await s.ticket(tk2)
    assert.equal(ok.status, 200, '新票必须能用')
    console.log('   [证据] 过期票 ' + expired.status + ' / 新票 ' + ok.status)
  } finally { await s.close() }
})

/* ============================================================
 * ⑤ 公网来源一律 403（PUB_BLOCKED），局域网/回环不受影响
 * ============================================================ */
test('task-19 ⑤ 带转发头（公网来源）打 /pair/ticket ⇒ PUB_BLOCKED 403，局域网照常 200', async () => {
  const s = await serve()
  try {
    const p = await s.srv.panelData(false)
    const tk = keysOf(p.payload).k
    const remote = await s.ticket(tk, { 'x-forwarded-for': '203.0.113.7' })
    assert.equal(remote.status, 403, '公网来源必须被闸 A 拦下')
    /* 🔴 第237节 · task-7：闸 A 的 403 新增 reason:'remote-pair-off'（只增字段，文案不变）。 */
    assert.equal(remote.json.error, '配对与取码仅限局域网内使用', '与 /claim 同一条闸、同一句文案')
    assert.equal(remote.json.reason, 'remote-pair-off', '新增的 reason 码')
    const lan = await s.ticket(tk)
    assert.equal(lan.status, 200, '公网来的那次不许把票消耗掉，局域网仍能兑换')
    const tokenPath = await (async () => {
      const r = await fetch(s.base + '/pair/ticket', { method: 'GET' })
      return { status: r.status, json: await r.json() }
    })()
    assert.deepEqual(tokenPath.json, { ok: false, error: '访问码不对' }, '非 POST 不命中票据分支（落到 tokenOf 401）')
    console.log('   [证据] 公网 ' + remote.status + " '" + remote.json.error + "' / 局域网 " + lan.status + ' / GET ' + tokenPath.status)
  } finally { await s.close() }
})

/* ============================================================
 * ⑥ 形状校验 + /newcode 作废旧票 + c 空串（没隧道）不回归
 * ============================================================ */
test('task-19 ⑥ 票形状非法一律 403；/newcode 作废旧票；没隧道 ⇒ c 是空串不是缺键', async () => {
  const s = await serve()
  try {
    for (const bad of ['', 'pt_', 'pt_zzz', 'pt_' + 'a'.repeat(31), 'pt_' + 'A'.repeat(32), '123456']) {
      const r = await s.ticket(bad)
      assert.equal(r.status, 403, '非法票必须 403：' + JSON.stringify(bad))
      assert.deepEqual(r.json, { ok: false, error: '配对票据无效或已过期' })
    }
    const p = await s.srv.panelData(false)
    const oldTicket = keysOf(p.payload).k
    const nc = await fetch(s.base + '/newcode')
    assert.equal(nc.status, 200, '/newcode 免 token')
    const afterNew = await s.ticket(oldTicket)
    assert.equal(afterNew.status, 403, '/newcode 之后旧票必须作废')
    const p2 = await s.srv.panelData(false)
    const fresh = await s.ticket(keysOf(p2.payload).k)
    assert.equal(fresh.status, 200, '换码后的新票必须能用')
    assert.equal(Object.prototype.hasOwnProperty.call(fresh.json, 'c'), true, 'c 键必须存在')
    assert.equal(fresh.json.c, '', '没隧道 ⇒ c 是空串（不是缺键、不是 null）')
    assert.equal(keysOf(p2.payload).c, undefined, '没隧道 ⇒ 载荷里没有 c= 键（task-11 红线不回归）')
    console.log('   [证据] 非法票全 403 / /newcode 作废旧票 403 / 新票 c=' + JSON.stringify(fresh.json.c))
  } finally { await s.close() }
})

/* ============================================================
 * ⑦ 6 位码那条老通路语义不变（用户在场的补救路径）
 * ============================================================ */
test('task-19 ⑦ /claim（6 位码）语义一字不变：对码 200 带 token、错码 403、用一次作废', async () => {
  const s = await serve()
  try {
    const p = await s.srv.panelData(false)
    const wrong = String(Number(p.code) === 111111 ? 222222 : 111111).padStart(6, '0')
    const bad = await s.claim(wrong)
    assert.equal(bad.status, 403)
    /* 🔴 第237节 · task-7：新增 reason:'code-mismatch'，文案仍逐字不变。 */
    assert.equal(bad.json.error, '配对码不对或已过期', '错码文案不变')
    assert.equal(bad.json.reason, 'code-mismatch', '新增的 reason 码')
    const good = await s.claim(p.code)
    assert.equal(good.status, 200)
    assert.equal(good.json.token, TOKEN, '6 位码通路照旧直接回访问码（用户在场，契约 E 明确不删）')
    const again = await s.claim(p.code)
    assert.equal(again.status, 403, '同一码不能用第二次')
    console.log('   [证据] /claim 对码 200 token 正确、重复 403')
  } finally { await s.close() }
})
