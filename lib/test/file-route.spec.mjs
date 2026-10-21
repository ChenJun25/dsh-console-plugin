// 第 289 节 · GET /file 路由集成测试（起真 HTTP 服务，本地环回）
// 跑法：node lib/test/file-route.spec.mjs
// 覆盖契约 §3：404 无此文件 / WAN 32MB 闸 413 / WAN 配额闸 429 / 200 流式头 / WAN 计量 / 令牌桶限速 / LAN 不限不计量
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { startLanServer } from '../lan-server.mjs'
import { createWanMeter } from '../wan-meter.mjs'

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  ✅ ' + label) }
  else { fail += 1; console.log('  ❌ ' + label + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))) }
}
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), label, { got: a, want: b }) }

const TOKEN = 'file-route-test-token'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-file-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 造文件：普通小图 / 普通文本 / 33MB 超限大文件 / 1.5MiB 限速用文件
const PNG = path.join(TMP, 'shot.png')
fs.writeFileSync(PNG, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9]))
const TXT = path.join(TMP, 'note.txt')
fs.writeFileSync(TXT, 'hello 第289节')
function sparse(fp, bytes) {
  const fd = fs.openSync(fp, 'w')
  fs.writeSync(fd, Buffer.alloc(16))
  fs.ftruncateSync(fd, bytes)
  fs.closeSync(fd)
  return fp
}
const HUGE = sparse(path.join(TMP, 'huge.bin'), 33 * 1024 * 1024)
const MID = sparse(path.join(TMP, 'mid.bin'), Math.floor(1.5 * 1024 * 1024))
const DIR = path.join(TMP, 'adir')
fs.mkdirSync(DIR)

const METER_FILE = path.join(TMP, 'wan-meter.json')
const meter = createWanMeter({ file: METER_FILE, log: () => {} })
const cloudWan = { month: '', usedBytes: 0, quotaBytes: 10 * 1024 * 1024 * 1024, limitBps: 2500000 }   // 第 293 节：默认档月流量 10 GiB

function makeServer(extra) {
  const opts = Object.assign({
    // 8899 是正式实例常用端口；这里用高位端口 + allowShift，被占就自动 +1
    port: 18877,
    allowShift: true,
    getToken: () => TOKEN,
    getInfo: () => ({ name: 'test', host: 'test-host', dshOk: true, dshError: '' }),
    listSessions: async () => [],
    runCommand: async () => ({}),
    log: () => {},
    mp: null,
    wanMeter: meter,
    getWanLimits: () => cloudWan
  }, extra || {})
  return startLanServer(opts)
}

async function req(base, p, opt) {
  const o = opt || {}
  const headers = {}
  if (o.token !== false) headers['x-dafeiyu-token'] = o.token || TOKEN
  if (o.wan) headers['x-forwarded-for'] = '203.0.113.9'
  if (o.headers) Object.assign(headers, o.headers)
  return fetch(base + p, { headers })
}

async function readJson(r) { try { return await r.json() } catch (e) { return null } }

const main = makeServer()
const started = await main.start()
if (!started) { console.log('❌ 服务起不来（端口全被占？）'); process.exit(1) }
const PORT = started.port
const BASE = 'http://127.0.0.1:' + PORT + '/dsh-console'

console.log('【1】404 闸门（无此文件）')
{
  let r = await req(BASE, '/file')
  eq(r.status, 404, 'path 为空 → 404')
  eq((await readJson(r)).error, 'no-such-file', '错误码 no-such-file')

  r = await req(BASE, '/file?path=' + encodeURIComponent('relative/note.txt'))
  eq(r.status, 404, '相对路径 → 404（只认绝对路径）')

  r = await req(BASE, '/file?path=' + encodeURIComponent(path.join(TMP, 'nope.bin')))
  eq(r.status, 404, '文件不存在 → 404')

  r = await req(BASE, '/file?path=' + encodeURIComponent(DIR))
  eq(r.status, 404, '目录（非普通文件）→ 404')
}

console.log('【2】LAN 直传：200 + 契约头 + 不计量')
{
  const r = await req(BASE, '/file?path=' + encodeURIComponent(PNG))
  eq(r.status, 200, 'LAN 拿图 → 200')
  eq(r.headers.get('content-type'), 'image/png', 'Content-Type 由扩展名推（image/png）')
  eq(r.headers.get('content-length'), String(fs.statSync(PNG).size), 'Content-Length = 文件大小')
  eq(r.headers.get('x-file-bytes'), String(fs.statSync(PNG).size), 'x-file-bytes = 文件大小')
  eq(r.headers.get('x-file-name'), 'shot.png', 'x-file-name 是 basename（shot.png）')
  const buf = Buffer.from(await r.arrayBuffer())
  eq(buf.length, fs.statSync(PNG).size, 'body 字节数与文件一致')
  eq(buf[0], 0x89, 'body 首字节正确（流式没搬错）')

  const r2 = await req(BASE, '/file?path=' + encodeURIComponent(TXT))
  eq(r2.headers.get('content-type'), 'application/octet-stream', '未知扩展名 → application/octet-stream')
  eq(await r2.text(), 'hello 第289节', '文本内容一字不差（UTF-8）')

  eq(meter.snapshot().bytes, 0, 'LAN 传完不计量（bytes 仍为 0）')

  const r3 = await req(BASE, '/file?path=' + encodeURIComponent(HUGE))
  eq(r3.status, 200, 'LAN 传 33MB 大文件 → 200（局域网不限 32MB）')
  try { await r3.body.cancel() } catch (e) {}
  eq(meter.snapshot().bytes, 0, 'LAN 传 33MB 也不计量')
}

console.log('【3】WAN 计量 + 200')
{
  const before = meter.snapshot().bytes
  const r = await req(BASE, '/file?path=' + encodeURIComponent(TXT), { wan: true })
  eq(r.status, 200, 'WAN 拿 13 字节文件 → 200')
  await r.arrayBuffer()
  await sleep(60)
  const size = Buffer.byteLength('hello 第289节')
  eq(meter.snapshot().bytes, before + size, 'WAN 按实际写出字节计量（+' + size + '）')

  const r2 = await req(BASE, '/file?path=' + encodeURIComponent(TXT), { wan: true })
  await r2.arrayBuffer()
  await sleep(60)
  eq(meter.snapshot().bytes, before + size * 2, '第二次 WAN 继续累加（+' + size * 2 + '）')
}

console.log('【4】WAN 32MB 单次闸 → 413')
{
  const r = await req(BASE, '/file?path=' + encodeURIComponent(HUGE), { wan: true })
  eq(r.status, 413, 'WAN 传 33MB → 413')
  const j = await readJson(r)
  eq(j.error, 'file-too-large', 'error=file-too-large')
  eq(j.limitBytes, 33554432, 'limitBytes=33554432（32MB）')
  eq(j.sizeBytes, 33 * 1024 * 1024, 'sizeBytes 回实际大小')
  eq(j.scope, 'wan', 'scope=wan')
}

console.log('【5】WAN 月度配额闸 → 429')
{
  const snap = meter.snapshot()
  const quota = snap.quotaBytes
  meter.setLimits({ month: snap.month, usedBytes: quota, quotaBytes: quota, limitBps: 2500000 })
  const r = await req(BASE, '/file?path=' + encodeURIComponent(TXT), { wan: true })
  eq(r.status, 429, '本月已用 ≥ 额度 → 429')
  const j = await readJson(r)
  eq(j.error, 'wan-quota-exceeded', 'error=wan-quota-exceeded')
  eq(j.usedBytes, quota, 'usedBytes 回当前用量')
  eq(j.quotaBytes, quota, 'quotaBytes 回额度')

  const r2 = await req(BASE, '/file?path=' + encodeURIComponent(TXT))
  eq(r2.status, 200, '同一时刻 LAN 仍然 200（配额只管公网）')
  await r2.arrayBuffer()

  meter.setLimits({ month: snap.month, usedBytes: 0, quotaBytes: quota, limitBps: 2500000 })
  const r3 = await req(BASE, '/file?path=' + encodeURIComponent(TXT), { wan: true })
  eq(r3.status, 200, '额度恢复后 WAN 又能下')
  await r3.arrayBuffer()
}

console.log('【6】WAN 令牌桶限速（不动 sendJson）')
{
  cloudWan.month = meter.snapshot().month
  cloudWan.usedBytes = 0
  cloudWan.limitBps = 300000
  const t0 = Date.now()
  const r = await req(BASE, '/file?path=' + encodeURIComponent(MID), { wan: true })
  eq(r.status, 200, 'WAN 限速下的 1.5MiB 文件 → 200')
  const buf = Buffer.from(await r.arrayBuffer())
  const ms = Date.now() - t0
  eq(buf.length, fs.statSync(MID).size, '限速后 body 依然完整（1.5MiB 一个字节不少）')
  ok(ms >= 1000, '限速生效：1.5MiB @ 300KB/s 用时 ' + ms + 'ms ≥ 1000ms（桶满 1MiB 后开始等令牌）', { ms })

  cloudWan.limitBps = 300000
  const t1 = Date.now()
  const r2 = await req(BASE, '/file?path=' + encodeURIComponent(MID), { wan: true })
  eq(r2.status, 200, '限速下第二次请求也 200')
  await r2.arrayBuffer()
  const ms1 = Date.now() - t1

  cloudWan.limitBps = 2500000
  const t2 = Date.now()
  const r3 = await req(BASE, '/file?path=' + encodeURIComponent(MID), { wan: true })
  eq(r3.status, 200, '恢复 20Mbps 后 → 200')
  await r3.arrayBuffer()
  const ms2 = Date.now() - t2
  ok(ms2 < ms1, '限速值真的在生效：' + ms1 + 'ms (300KB/s) > ' + ms2 + 'ms (2.5MB/s)', { slow: ms1, fast: ms2 })

  const t3 = Date.now()
  const r4 = await req(BASE, '/file?path=' + encodeURIComponent(MID))
  eq(r4.status, 200, 'LAN 同样 1.5MiB → 200')
  await r4.arrayBuffer()
  const ms3 = Date.now() - t3
  ok(ms3 < 1000, 'LAN 不节流：1.5MiB 用时 ' + ms3 + 'ms < 1000ms', { ms: ms3 })
}

console.log('【7】token 闸仍在前（/file 不绕过访问码）')
{
  const r = await req(BASE, '/file?path=' + encodeURIComponent(TXT), { token: false })
  eq(r.status, 401, '不带 token → 401')
  const r2 = await req(BASE, '/file?path=' + encodeURIComponent(TXT), { token: 'wrong' })
  eq(r2.status, 401, 'token 不对 → 401')
}

main.stop()
await sleep(80)

console.log('【8】WAN + 未开通公网服务 → 403（/file 仍在 CLOUD_GATED 里）')
{
  const deadCloud = { snapshot: () => ({ shortId: '', vipExpireMs: 0, online: false }) }
  const m2 = makeServer({ cloud: deadCloud })
  const s2 = await m2.start()
  if (!s2) { ok(false, '第二台测试服务起不来'); } 
  const P2 = s2 ? s2.port : 0
  const B2 = 'http://127.0.0.1:' + P2 + '/dsh-console'
  const r = await req(B2, '/file?path=' + encodeURIComponent(TXT), { wan: true })
  eq(r.status, 403, 'WAN 且服务已过期 → 403（公网闸）')
  const r2 = await req(B2, '/file?path=' + encodeURIComponent(TXT))
  eq(r2.status, 200, '同一台机器 LAN 访问仍 200')
  await r2.arrayBuffer()
  m2.stop()
  await sleep(80)
}

console.log('【9】/cloud/status 两种形状都发（契约 §5 扁平 + 嵌套，App 两路都能读）')
{
  const liveCloud = { snapshot: () => ({ shortId: 'ABC123', vipExpireMs: 1767225600000, online: true }) }
  const lim = { month: '2026-10', usedBytes: 1234, quotaBytes: 5 * 1024 * 1024 * 1024, limitBps: 2500000 }
  const m3 = makeServer({ cloud: liveCloud, getWanLimits: () => lim })
  const s3 = await m3.start()
  if (!s3) { ok(false, '第三台测试服务起不来') }
  const P3 = s3 ? s3.port : 0
  const B3 = 'http://127.0.0.1:' + P3 + '/dsh-console'
  const r = await req(B3, '/cloud/status')
  eq(r.status, 200, '/cloud/status → 200')
  const j = (await readJson(r)) || {}
  ok(j.wan && typeof j.wan === 'object', '带嵌套 wan 对象（App wanOf 形状 1）')
  eq(j.wan && j.wan.month, '2026-10', 'wan.month')
  eq(j.wan && j.wan.quotaBytes, lim.quotaBytes, 'wan.quotaBytes')
  eq(j.wan && j.wan.limitBps, lim.limitBps, 'wan.limitBps')
  ok((j.wan && j.wan.usedBytes) >= 1234, 'wan.usedBytes ≥ 云端值')
  eq(j.wanMonth, '2026-10', '扁平 wanMonth 仍在（形状 2 不回归）')
  eq(j.wanQuotaBytes, lim.quotaBytes, '扁平 wanQuotaBytes 仍在')
  eq(j.wanLimitBps, lim.limitBps, '扁平 wanLimitBps 仍在')
  m3.stop()
  await sleep(80)
}

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) {}

console.log('')
console.log(fail === 0 ? '✅ 全部通过' : '❌ 有失败')
console.log('pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
