
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { startLanServer } from '../lan-server.mjs'
import { createWanMeter } from '../wan-meter.mjs'

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  ✅ ' + label) }
  else { fail += 1; console.log('  ❌ ' + label + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))) }
}
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), label, { got: a, want: b }) }

const TOKEN = 'upload-route-test-token'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-upload-'))
const INBOX = path.join(TMP, 'inbox')
fs.mkdirSync(INBOX, { recursive: true })
process.env.DSH_CONSOLE_INBOX = INBOX
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const METER_FILE = path.join(TMP, 'wan-meter.json')
const meter = createWanMeter({ file: METER_FILE, log: () => {} })
const cloudWan = { month: '', usedBytes: 0, quotaBytes: 10 * 1024 * 1024 * 1024, limitBps: 2500000 }

const SMALL = Buffer.from('上传测试 hello', 'utf8')
const MID = Buffer.alloc(Math.floor(1.5 * 1024 * 1024), 7)
const HUGE = Buffer.alloc(33 * 1024 * 1024, 9)

let sinkCalls = []
function makeServer(extra) {
  const opts = Object.assign({
    port: 18878,
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

const BASE_BASE = 'http://127.0.0.1:'

function q(name, sessionId) {
  let s = '?name=' + encodeURIComponent(name)
  if (sessionId) s += '&sessionId=' + encodeURIComponent(sessionId)
  return s
}

async function post(base, p, opt) {
  const o = opt || {}
  const headers = {}
  if (o.token !== false) headers['x-dafeiyu-token'] = o.token || TOKEN
  if (o.wan) headers['x-forwarded-for'] = '203.0.113.9'
  if (o.headers) Object.assign(headers, o.headers)
  const init = { method: 'POST', headers }
  if (o.body !== undefined) init.body = o.body
  if (o.stream) { init.body = o.stream; init.duplex = 'half' }
  if (o.signal) init.signal = o.signal
  return fetch(base + p, init)
}

async function readJson(r) { try { return await r.json() } catch (e) { return null } }

const main = makeServer()
const started = await main.start()
if (!started) { console.log('❌ 服务起不来（端口全被占？）'); process.exit(1) }
const PORT = started.port
const BASE = BASE_BASE + PORT + '/dsh-console'

console.log('【1】局域网直传：200 + 落 inbox + 不计量')
{
  const r = await post(BASE, '/upload' + q('note.txt', 'sess-1'), { body: SMALL })
  eq(r.status, 200, 'LAN 小文件 → 200')
  const j = (await readJson(r)) || {}
  eq(j.ok, true, 'ok=true')
  eq(j.bytes, SMALL.length, 'bytes = 实际写入字节数')
  eq(j.name, 'note.txt', 'name = note.txt')
  ok(typeof j.path === 'string' && path.dirname(j.path) === INBOX, 'path 落在 inbox 里（' + j.path + '）')
  ok(fs.existsSync(j.path), '文件真的存在')
  eq(fs.readFileSync(j.path).toString('utf8'), SMALL.toString('utf8'), '内容一字不差')
  eq(meter.snapshot().bytes, 0, 'LAN 上传不计量（bytes 仍 0）')
  eq(j.notified, false, '没给 sessionId 走真 prompt 时 notified=false（测试里 ctl 为 null）')
  ok(!fs.readdirSync(INBOX).some((n) => n.startsWith('.incoming-')), '临时文件已 rename 掉，没留 .incoming-')
}

console.log('【2】局域网 33MB：不限 32MB、不限速、不计量')
{
  const t0 = Date.now()
  const r = await post(BASE, '/upload' + q('big-lan.bin'), { body: HUGE })
  const ms = Date.now() - t0
  eq(r.status, 200, 'LAN 传 33MB → 200（局域网不限 32MB）')
  const j = (await readJson(r)) || {}
  eq(j.bytes, HUGE.length, '33MB 一个字节不少')
  eq(fs.statSync(j.path).size, HUGE.length, '落盘大小正确')
  eq(meter.snapshot().bytes, 0, 'LAN 传 33MB 也不计量')
  ok(ms < 8000, 'LAN 不节流：33MB 用时 ' + ms + 'ms', { ms })
}

console.log('【3】公网计量：按实际字节累加，只记一次')
{
  const before = meter.snapshot().bytes
  const r = await post(BASE, '/upload' + q('wan.txt', 'sess-2'), { body: SMALL, wan: true })
  eq(r.status, 200, 'WAN 小文件 → 200')
  const j = (await readJson(r)) || {}
  eq(j.bytes, SMALL.length, 'WAN bytes = 实际字节数')
  await sleep(60)
  eq(meter.snapshot().bytes, before + SMALL.length, 'WAN 上行计入公网额度（+' + SMALL.length + '）')

  const r2 = await post(BASE, '/upload' + q('wan2.txt', 'sess-2'), { body: SMALL, wan: true })
  await r2.arrayBuffer()
  await sleep(60)
  eq(meter.snapshot().bytes, before + SMALL.length * 2, '第二次 WAN 继续累加，没重复记（+' + SMALL.length * 2 + '）')
}

console.log('【4】公网 32MB 单次闸 → 413（读 body 之前就拒）')
{
  const before = meter.snapshot().bytes
  let status = 0
  let j = null
  try {
    const r = await post(BASE, '/upload' + q('huge.bin'), { body: HUGE, wan: true })
    status = r.status
    j = (await readJson(r)) || {}
  } catch (e) {
    ok(false, '413 响应没拿到（连接被掐太早）：' + ((e && e.message) || e))
  }
  eq(status, 413, 'WAN 传 33MB → 413')
  if (j) {
    eq(j.error, 'file-too-large', 'error=file-too-large')
    eq(j.limitBytes, 33554432, 'limitBytes=33554432（32MB）')
    eq(j.sizeBytes, HUGE.length, 'sizeBytes 回实际大小')
    eq(j.scope, 'wan', 'scope=wan')
  }
  await sleep(120)
  eq(meter.snapshot().bytes, before, '被 413 拒掉的上传不计量（一字节都没收）')
  ok(!fs.existsSync(path.join(INBOX, 'huge.bin')), '413 后 inbox 里没有 huge.bin')
}

console.log('【5】公网月额度闸 → 429（局域网不受影响）')
{
  const snap = meter.snapshot()
  const quota = snap.quotaBytes
  meter.setLimits({ month: snap.month, usedBytes: quota, quotaBytes: quota, limitBps: 2500000 })

  const r = await post(BASE, '/upload' + q('over.txt'), { body: SMALL, wan: true })
  eq(r.status, 429, '本月已用 ≥ 额度 → 429')
  const j = (await readJson(r)) || {}
  eq(j.error, 'wan-quota-exceeded', 'error=wan-quota-exceeded')
  eq(j.usedBytes, quota, 'usedBytes 回当前用量')
  eq(j.quotaBytes, quota, 'quotaBytes 回额度')

  const r2 = await post(BASE, '/upload' + q('over-lan.txt'), { body: SMALL })
  eq(r2.status, 200, '同一时刻 LAN 上传仍然 200（配额只管公网）')
  await r2.arrayBuffer()

  meter.setLimits({ month: snap.month, usedBytes: 0, quotaBytes: quota, limitBps: 2500000 })
  const r3 = await post(BASE, '/upload' + q('back.txt'), { body: SMALL, wan: true })
  eq(r3.status, 200, '额度恢复后 WAN 又能传')
  await r3.arrayBuffer()
}

console.log('【6】公网上传限速（令牌桶对入站生效）')
{
  cloudWan.month = meter.snapshot().month
  cloudWan.usedBytes = 0
  cloudWan.limitBps = 300000

  const t0 = Date.now()
  const r = await post(BASE, '/upload' + q('mid-wan.bin'), { body: MID, wan: true })
  eq(r.status, 200, 'WAN 限速下的 1.5MiB 上传 → 200')
  const j = (await readJson(r)) || {}
  const ms1 = Date.now() - t0
  eq(j.bytes, MID.length, '限速后落盘字节数依然完整（1.5MiB 一个字节不少）')
  eq(fs.statSync(j.path).size, MID.length, '限速后磁盘上也是 1.5MiB')
  ok(ms1 >= 1000, '限速生效：1.5MiB @ 300KB/s 用时 ' + ms1 + 'ms ≥ 1000ms', { ms: ms1 })

  cloudWan.limitBps = 2500000
  const t1 = Date.now()
  const r2 = await post(BASE, '/upload' + q('mid-wan2.bin'), { body: MID, wan: true })
  eq(r2.status, 200, '恢复 20Mbps 后 → 200')
  await r2.arrayBuffer()
  const ms2 = Date.now() - t1
  ok(ms2 < ms1, '限速值真的在生效：' + ms1 + 'ms (300KB/s) > ' + ms2 + 'ms (2.5MB/s)', { slow: ms1, fast: ms2 })

  const t2 = Date.now()
  const r3 = await post(BASE, '/upload' + q('mid-lan.bin'), { body: MID })
  eq(r3.status, 200, 'LAN 同样 1.5MiB → 200')
  await r3.arrayBuffer()
  const ms3 = Date.now() - t2
  ok(ms3 < 1000, 'LAN 不节流：1.5MiB 用时 ' + ms3 + 'ms < 1000ms', { ms: ms3 })
}

console.log('【7】重名去重：note.txt → note-2.txt')
{
  const r = await post(BASE, '/upload' + q('dup.txt'), { body: Buffer.from('第一次') })
  const j1 = (await readJson(r)) || {}
  eq(path.basename(j1.path), 'dup.txt', '第一次叫 dup.txt')
  const r2 = await post(BASE, '/upload' + q('dup.txt'), { body: Buffer.from('第二次') })
  const j2 = (await readJson(r2)) || {}
  eq(path.basename(j2.path), 'dup-2.txt', '第二次自动变 dup-2.txt')
  const r3 = await post(BASE, '/upload' + q('dup.txt'), { body: Buffer.from('第三次') })
  const j3 = (await readJson(r3)) || {}
  eq(path.basename(j3.path), 'dup-3.txt', '第三次变 dup-3.txt')
  eq(fs.readFileSync(j1.path).toString('utf8'), '第一次', '老文件没被覆盖')
  eq(fs.readFileSync(j3.path).toString('utf8'), '第三次', '新内容落在新名字上')
}

console.log('【8】文件名清洗：路径分隔符不给口子')
{
  const r = await post(BASE, '/upload' + q('../../evil/name.txt'), { body: Buffer.from('x') })
  eq(r.status, 200, '带 ../ 的文件名 → 200（被清洗成普通文件名）')
  const j = (await readJson(r)) || {}
  ok(!j.path.includes('evil' + path.sep) , 'path 没被写到 inbox 外面（' + j.path + '）')
  eq(path.dirname(j.path), INBOX, '落盘目录仍是 inbox')
  ok(!fs.existsSync(path.join(TMP, 'evil')), '没在临时目录外面造出 evil 目录')
}

console.log('【9】局域网 chunked 照收，公网 chunked 才 411')
{

  let r
  try {
    r = await post(BASE, '/upload' + q('chunked-lan.txt'), { stream: Readable.toWeb(Readable.from([SMALL])) })
  } catch (e) {
    ok(false, '局域网 chunked 请求失败：' + ((e && e.message) || e))
  }
  if (r) {
    eq(r.status, 200, '局域网 chunked（无 Content-Length）→ 200')
    const j = (await readJson(r)) || {}
    eq(j.bytes, SMALL.length, '局域网 chunked 字节数正确')
  }

  let rw
  try {
    rw = await post(BASE, '/upload' + q('chunked-wan.txt'), { stream: Readable.toWeb(Readable.from([SMALL])), wan: true })
  } catch (e) {
    ok(false, '公网 chunked 请求失败：' + ((e && e.message) || e))
  }
  if (rw) {
    eq(rw.status, 411, '公网 chunked（无 Content-Length）→ 411')
    eq(((await readJson(rw)) || {}).error, 'length-required', 'error=length-required')
  }
}

console.log('【10】缺 name → 400；token 闸仍在前 → 401')
{
  const r = await post(BASE, '/upload', { body: SMALL })
  eq(r.status, 400, '没有 name → 400')
  eq(((await readJson(r)) || {}).error, '缺少 name', 'error=缺少 name')

  const r2 = await post(BASE, '/upload' + q('a.txt'), { body: SMALL, token: false })
  eq(r2.status, 401, '不带 token → 401')
  const r3 = await post(BASE, '/upload' + q('a.txt'), { body: SMALL, token: 'wrong' })
  eq(r3.status, 401, 'token 不对 → 401')
}

console.log('【11】uploadSink 注入：拿到临时文件 + 字节数，sink 负责最终落地')
{
  const seen = []
  const m2 = makeServer({
    uploadSink: async (info) => {
      seen.push({ name: info && info.name, bytes: info && info.bytes, sessionId: info && info.sessionId, tmpExists: fs.existsSync(info && info.tmpPath), tmpPath: info && info.tmpPath })
      const out = path.join(INBOX, 'sink-' + (info && info.name))
      fs.renameSync(info.tmpPath, out)
      return { path: out, name: path.basename(out), bytes: info && info.bytes, notified: true }
    }
  })
  const s2 = await m2.start()
  if (!s2) { ok(false, '第二台测试服务起不来') }
  const B2 = BASE_BASE + (s2 ? s2.port : 0) + '/dsh-console'
  const r = await post(B2, '/upload' + q('sink.txt', 'sess-9'), { body: SMALL, wan: true })
  eq(r.status, 200, '自定义 sink → 200')
  const j = (await readJson(r)) || {}
  eq(j.notified, true, 'sink 返回的 notified 透传出去')
  eq(seen.length, 1, 'sink 只调一次')
  if (seen[0]) {
    eq(seen[0].name, 'sink.txt', 'sink 拿到 name')
    eq(seen[0].bytes, SMALL.length, 'sink 拿到实际字节数')
    eq(seen[0].sessionId, 'sess-9', 'sink 拿到 sessionId')
    eq(seen[0].tmpExists, true, 'sink 调用那一刻临时文件还在（让 sink 自己 rename）')
    ok(!fs.existsSync(seen[0].tmpPath), 'sink 处理完临时文件已移走')
  }
  m2.stop()
  await sleep(80)
}

main.stop()
await sleep(80)

console.log('【12】/upload 在 CLOUD_GATED 里：公网 + 服务过期 → 403')
{
  const deadCloud = { snapshot: () => ({ shortId: '', vipExpireMs: 0, online: false }) }
  const m3 = makeServer({ cloud: deadCloud })
  const s3 = await m3.start()
  if (!s3) { ok(false, '第三台测试服务起不来') }
  const B3 = BASE_BASE + (s3 ? s3.port : 0) + '/dsh-console'
  const r = await post(B3, '/upload' + q('gated.txt'), { body: SMALL, wan: true })
  eq(r.status, 403, 'WAN 且服务已过期 → 403（公网闸）')
  const r2 = await post(B3, '/upload' + q('gated-lan.txt'), { body: SMALL })
  eq(r2.status, 200, '同一台机器 LAN 上传仍 200')
  await r2.arrayBuffer()
  m3.stop()
  await sleep(80)
}

console.log('【13】/cmd 透传 wan meta（legacy uploadFile 靠它判公网）')
{
  const metas = []
  const m4 = makeServer({
    runCommand: async (op, payload, meta) => { metas.push({ op, meta }); return { ok: true } }
  })
  const s4 = await m4.start()
  if (!s4) { ok(false, '第四台测试服务起不来') }
  const B4 = BASE_BASE + (s4 ? s4.port : 0) + '/dsh-console'

  const r = await post(B4, '/cmd', { body: Buffer.from(JSON.stringify({ op: 'uploadFile', payload: { sessionId: 'x', data: 'AAAA' } })), wan: true, headers: { 'content-type': 'application/json' } })
  eq(r.status, 200, 'WAN /cmd → 200')
  const r2 = await post(B4, '/cmd', { body: Buffer.from(JSON.stringify({ op: 'uploadFile', payload: { sessionId: 'x', data: 'AAAA' } })), headers: { 'content-type': 'application/json' } })
  eq(r2.status, 200, 'LAN /cmd → 200')
  eq(metas.length, 2, 'runCommand 被调两次')
  if (metas[0]) {
    eq(metas[0].meta && metas[0].meta.wan, true, 'WAN 请求透传 meta.wan=true')
    eq(metas[0].meta && metas[0].meta.limitBytes, 33554432, 'meta.limitBytes=32MB')
    eq(typeof (metas[0].meta && metas[0].meta.record), 'function', 'meta.record 是记账函数')
  }
  if (metas[1]) eq(metas[1].meta && metas[1].meta.wan, false, 'LAN 请求透传 meta.wan=false')
  m4.stop()
  await sleep(80)
}

console.log('')
console.log(fail === 0 ? '✅ 全过：' + pass + ' 项' : '❌ 挂了 ' + fail + ' 项 / 共 ' + (pass + fail) + ' 项')
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) { }
process.exit(fail === 0 ? 0 : 1)
