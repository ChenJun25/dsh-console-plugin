
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-imgmeter-'))
const TMP_HOME = path.join(TMP, 'home')
fs.mkdirSync(TMP_HOME, { recursive: true })
process.env.USERPROFILE = TMP_HOME
process.env.HOME = TMP_HOME
process.env.DSH_CONSOLE_INBOX = path.join(TMP, 'inbox')
fs.mkdirSync(process.env.DSH_CONSOLE_INBOX, { recursive: true })

process.env.DSH_CLOUD_GATE = 'off'

const { startLanServer } = await import('../lan-server.mjs')
const { createWanMeter, shanghaiMonthOf, WAN_METER_PATH } = await import('../wan-meter.mjs')

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  ✅ ' + label) }
  else { fail += 1; console.log('  ❌ ' + label + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))) }
}
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), label, { got: a, want: b }) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TOKEN = 'image-meter-test-token'
const GI = 1024 * 1024 * 1024

ok(String(WAN_METER_PATH).startsWith(TMP_HOME), '计量文件已重定向到临时家目录（' + WAN_METER_PATH + '）')

const METER_FILE = path.join(TMP, 'attachment-meter.json')
const meter = createWanMeter({ file: METER_FILE, log: () => {} })
const cloudWan = { month: '', usedBytes: 0, quotaBytes: 10 * GI, limitBps: 2500000 }

const SMALL = Buffer.from('附件出站测试 hello 图片', 'utf8')
const MID = Buffer.alloc(Math.floor(1.5 * 1024 * 1024), 5)
let attData = SMALL
let attMime = 'image/png'
let attOfCalls = 0

const attServer = startLanServer({
  port: 18879,
  allowShift: true,
  getToken: () => TOKEN,
  getInfo: () => ({ name: 'test', host: 'test-host', dshOk: true, dshError: '' }),
  listSessions: async () => [],
  runCommand: async () => ({}),
  log: () => {},
  mp: null,
  wanMeter: meter,
  getWanLimits: () => cloudWan,
  attachmentOf: async (id) => { attOfCalls += 1; return { mime: attMime, name: id + '.png', data: attData } }
})
const attStarted = await attServer.start()
if (!attStarted) { console.log('❌ 附件服务起不来（端口全被占？）'); process.exit(1) }
const ATT_BASE = 'http://127.0.0.1:' + attStarted.port + '/dsh-console'

async function getAttachment(opt) {
  const o = opt || {}
  const headers = {}
  if (o.token !== false) headers['x-dafeiyu-token'] = o.token || TOKEN
  if (o.wan) headers['x-forwarded-for'] = '203.0.113.9'
  return fetch(ATT_BASE + '/attachment?id=' + encodeURIComponent(o.id || 'att-1'), { headers })
}

console.log('【A1】局域网取图：原样直出、不计量、不节流')
{
  const t0 = Date.now()
  const r = await getAttachment({ id: 'a1' })
  const buf = Buffer.from(await r.arrayBuffer())
  const ms = Date.now() - t0
  eq(r.status, 200, 'LAN /attachment → 200')
  eq(r.headers.get('content-type'), 'image/png', 'Content-Type = 附件自己的 mime')
  eq(Number(r.headers.get('content-length')), SMALL.length, 'Content-Length = buf.length（契约沿用）')
  eq(buf.length, SMALL.length, '实际字节数一致')
  eq(buf.toString('utf8'), SMALL.toString('utf8'), '内容一字不差')
  eq(meter.snapshot().bytes, 0, 'LAN 取图不计量（bytes 仍 0）')
  ok(ms < 1000, 'LAN 不节流：' + ms + 'ms', { ms })
  ok(attOfCalls >= 1, 'attachmentOf 真的被调用了')
}

console.log('【A2】公网取图：按实际字节计量，只记一次')
{
  const before = meter.snapshot().bytes
  const r = await getAttachment({ id: 'a2', wan: true })
  const buf = Buffer.from(await r.arrayBuffer())
  eq(r.status, 200, 'WAN /attachment → 200')
  eq(buf.length, SMALL.length, 'WAN 出站字节数完整')
  await sleep(80)
  eq(meter.snapshot().bytes, before + SMALL.length, 'WAN 取图计入公网额度（+' + SMALL.length + '，且只记一次）')
}

console.log('【A3】公网额度用尽：429 wan-quota-exceeded；同一时刻局域网照样 200')
{
  const saved = cloudWan.usedBytes
  cloudWan.usedBytes = 10 * GI
  const before = meter.snapshot().bytes
  const r = await getAttachment({ id: 'a3', wan: true })
  const j = (await r.json().catch(() => null)) || {}
  eq(r.status, 429, 'WAN 超额 → 429')
  eq(j.error, 'wan-quota-exceeded', '错误码 = wan-quota-exceeded')
  eq(j.quotaBytes, 10 * GI, '回包带 quotaBytes')
  eq(j.usedBytes, 10 * GI, '回包带 usedBytes')
  await sleep(60)
  eq(meter.snapshot().bytes, before, '被 429 拦下的请求不计量')

  const r2 = await getAttachment({ id: 'a3-lan' })
  const buf2 = Buffer.from(await r2.arrayBuffer())
  eq(r2.status, 200, '★ 同一时刻 LAN 取图仍 200（局域网完全不限量）')
  eq(buf2.length, SMALL.length, 'LAN 内容完整')
  await sleep(60)
  eq(meter.snapshot().bytes, before, 'LAN 不计量')
  cloudWan.usedBytes = saved
}

console.log('【A4】公网出站限速：1.5MiB 在 300KB/s 下必须明显慢于 2.5MB/s，局域网永远直通')
{
  attData = MID
  const slow = 300 * 1024
  const fast = 2500000

  cloudWan.limitBps = slow
  const t0 = Date.now()
  const r1 = await getAttachment({ id: 'a4-slow', wan: true })
  const b1 = Buffer.from(await r1.arrayBuffer())
  const msSlow = Date.now() - t0
  eq(r1.status, 200, '限速取图仍 200')
  eq(b1.length, MID.length, '限速不影响完整性')

  cloudWan.limitBps = fast
  const t1 = Date.now()
  const r2 = await getAttachment({ id: 'a4-fast', wan: true })
  const b2 = Buffer.from(await r2.arrayBuffer())
  const msFast = Date.now() - t1
  eq(b2.length, MID.length, '高速档内容完整')

  const t2 = Date.now()
  const r3 = await getAttachment({ id: 'a4-lan' })
  const b3 = Buffer.from(await r3.arrayBuffer())
  const msLan = Date.now() - t2
  eq(b3.length, MID.length, 'LAN 内容完整')

  ok(msSlow > msFast * 2, 'WAN 限速生效：300KB/s=' + msSlow + 'ms 明显慢于 2.5MB/s=' + msFast + 'ms', { msSlow, msFast })
  ok(msLan < 500, 'LAN 完全不受限速影响：' + msLan + 'ms', { msLan })
  cloudWan.limitBps = fast
  attData = SMALL
}

console.log('【A5】token 闸：没带访问码 → 401（图片通道不是后门）')
{
  const r = await getAttachment({ id: 'a5', token: false })
  eq(r.status, 401, '无 token → 401')
}

attServer.stop()

let liveSeq = 0
async function bootPlugin(seedBytes) {

  fs.mkdirSync(path.dirname(WAN_METER_PATH), { recursive: true })
  fs.writeFileSync(WAN_METER_PATH, JSON.stringify({ month: shanghaiMonthOf(Date.now()), bytes: seedBytes, updatedMs: Date.now() }))

  const routes = {}
  const disposers = []
  const prompts = []
  const conn = { fetch: { register: (r) => { routes[r.path] = r; return () => {} } } }
  const ctl = {
    projections: async () => ({ asOfSeq: 0, values: {} }),
    list: async () => ({ items: [] }),
    prompt: async (req) => { prompts.push(req); return { ok: true, seq: prompts.length } }
  }
  const ctx = {
    get: (n) => {
      if (n === 'connection') return conn
      if (n === 'sessionController') return ctl
      if (n === 'agents') return { get: () => null }
      if (n === 'settings') return { update: async () => {}, namespace: () => null }
      return null
    },
    on: () => () => {},
    effect: (fn) => { try { const d = fn(); if (typeof d === 'function') disposers.push(d) } catch (e) {} return () => {} }
  }
  const mod = await import('../index.js?t=' + Math.random())
  await mod.apply(ctx, { port: 18900 + (liveSeq++ * 2), allowShiftPort: true })
  const stateRoute = routes['/api/dsh-console/state']
  if (!stateRoute) throw new Error('/api/dsh-console/state 没注册上')
  const panel = await (await stateRoute.fetch(new Request('http://127.0.0.1/api/dsh-console/state?light=1'))).json()
  if (!(panel.port > 0)) throw new Error('panelData 没给出真实端口')
  const base = 'http://127.0.0.1:' + panel.port

  return {
    base,
    prompts,
    readMeter() { try { return JSON.parse(fs.readFileSync(WAN_METER_PATH, 'utf8')) } catch (e) { return null } },
    deviceState: async () => (await stateRoute.fetch(new Request('http://127.0.0.1/api/dsh-console/state?light=1'))).json(),
    cmd: async (payload, opt) => {
      const o = opt || {}
      const headers = { 'content-type': 'application/json', 'x-dafeiyu-token': panel.token }
      if (o.wan) headers['x-forwarded-for'] = '203.0.113.9'
      const r = await fetch(base + '/dsh-console/cmd', {
        method: 'POST',
        headers,
        body: JSON.stringify({ op: 'uploadImage', payload })
      })
      return { status: r.status, body: await r.json().catch(() => null) }
    },
    close: async () => {
      for (const d of disposers.reverse()) { try { d() } catch (e) {} }
      await new Promise((r) => setTimeout(r, 60))
    }
  }
}

const IMG_RAW = 3000
const IMG_B64 = Buffer.alloc(IMG_RAW, 3).toString('base64')
const imgPayload = () => ({ sessionId: 'sess-img-1', text: '看这张图', images: [{ mediaType: 'image/png', name: 'a.png', data: IMG_B64 }] })
const decoded = Math.floor((IMG_B64.length * 3) / 4)
eq(decoded, IMG_RAW, '前置：base64 解码字节数 = 3000')

console.log('【B1】公网额度已满：uploadImage 必须报超额，且一分钱都不记')
{
  const s = await bootPlugin(10 * GI)
  try {
    const r = await s.cmd(imgPayload(), { wan: true })
    eq(r.status, 500, 'WAN 超额 → /cmd 归一成 500（外层 catch）')
    ok(String((r.body && r.body.error) || '').indexOf('本月公网流量已用完') >= 0, '错误文案 = 本月公网流量已用完…：' + String((r.body && r.body.error) || ''))
    eq(s.prompts.length, 0, '被闸掉的请求一张图都没发出去')
    const m = s.readMeter()
    eq(m && m.bytes, 10 * GI, '超额时不记账（计量文件没被改大）')

    const r2 = await s.cmd(imgPayload(), { wan: false })
    eq(r2.status, 200, '★ 同一时刻 LAN 发图 → 200（局域网完全不限量）')
    eq(r2.body && r2.body.ok, true, 'LAN 对外信封 ok=true')
    eq(s.prompts.length, 1, 'LAN 的图真的发进会话了')
    await sleep(60)
    const m2 = s.readMeter()
    eq(m2 && m2.bytes, 10 * GI, 'LAN 发图不计量')
  } finally { await s.close() }
}

console.log('【B2】公网正常发图：按解码后字节计量，只记一次')
{
  const s = await bootPlugin(0)
  try {
    const r = await s.cmd(imgPayload(), { wan: true })
    eq(r.status, 200, 'WAN 发图 → 200')
    eq(r.body && r.body.ok, true, '外层信封 ok=true')
    eq(s.prompts.length, 1, '图真的发进会话了')
    await sleep(80)
    const m = s.readMeter()
    eq(m && m.bytes, decoded, 'WAN 图片上行计入公网额度（+' + decoded + '，只记一次）')

    const r2 = await s.cmd(imgPayload(), { wan: false })
    eq(r2.status, 200, 'LAN 发图 → 200')
    await sleep(80)
    const m2 = s.readMeter()
    eq(m2 && m2.bytes, decoded, 'LAN 发图一个字节都不计')
    eq(s.prompts.length, 2, '两张图都发进会话了')
  } finally { await s.close() }
}

console.log('【B3】累计到接近额度：再发一张跨线的图 → 报超额；额度内仍正常')
{
  const s = await bootPlugin(10 * GI - 100)
  try {
    const r = await s.cmd(imgPayload(), { wan: true })
    eq(r.status, 500, '只剩 100 字节时 WAN 发 3000 字节 → 超额 500')
    ok(String((r.body && r.body.error) || '').indexOf('本月公网流量已用完') >= 0, '超额文案正确')
    eq(s.prompts.length, 0, '超额请求没发出去')
  } finally { await s.close() }
}

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) {}

console.log('\n===== image-meter: pass=' + pass + ' fail=' + fail + ' =====')
process.exit(fail === 0 ? 0 : 1)
