
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createWanMeter,
  makeWanFetch,
  shanghaiMonthOf,
  WAN_DEFAULT_QUOTA_BYTES,
  WAN_DEFAULT_LIMIT_BPS
} from '../wan-meter.mjs'

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  ✅ ' + label) }
  else { fail += 1; console.log('  ❌ ' + label + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))) }
}
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), label, { got: a, want: b }) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-wan-'))
function tmpFile(n) { return path.join(TMP, 'meter-' + n + '.json') }
function writeMeter(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj, null, 2))
}
function readMeter(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return null } }

const T_OCT = Date.UTC(2026, 9, 20, 3, 0, 0)
const T_SEP_END = Date.UTC(2026, 8, 30, 15, 59, 59)
const T_OCT_START = Date.UTC(2026, 8, 30, 16, 0, 0)

console.log('【1】Asia/Shanghai 月份')
eq(shanghaiMonthOf(T_OCT), '2026-10', '2026-10-20 → 2026-10')
eq(shanghaiMonthOf(T_SEP_END), '2026-09', '上海时间 9/30 23:59:59 → 2026-09')
eq(shanghaiMonthOf(T_OCT_START), '2026-10', '上海时间 10/1 00:00:00 → 2026-10（跨零点即换月）')
eq(shanghaiMonthOf(Date.UTC(2026, 11, 31, 16, 0, 0)), '2027-01', '跨年 12/31 16:00Z → 2027-01')

console.log('【2】record 累加 + 落盘（重启不归零）')
{
  const f = tmpFile('a')
  const m1 = createWanMeter({ file: f, now: () => T_OCT, log: () => {} })
  eq(m1.snapshot().bytes, 0, '新建计量从 0 开始')
  m1.record(1000)
  m1.record(234)
  eq(m1.snapshot().bytes, 1234, '同实例累加 1000+234=1234')
  const disk = readMeter(f)
  ok(!!disk && disk.bytes === 1234, '落盘 bytes=1234', disk)
  ok(!!disk && disk.month === '2026-10', '落盘月份 month=2026-10', disk)

  const m2 = createWanMeter({ file: f, now: () => T_OCT, log: () => {} })
  eq(m2.snapshot().bytes, 1234, '新实例（模拟重启）读到 1234，不归零')
  m2.record(66)
  eq(m2.snapshot().bytes, 1300, '新实例继续累加 → 1300')
}

console.log('【3】record 非法值不动账')
{
  const f = tmpFile('b')
  const m = createWanMeter({ file: f, now: () => T_OCT, log: () => {} })
  m.record(0); m.record(-5); m.record(NaN); m.record(undefined); m.record('abc')
  eq(m.snapshot().bytes, 0, '0/负数/NaN/undefined/字符串都记 0 字节')
}

console.log('【4】月份切换归零')
{
  const f = tmpFile('c')
  writeMeter(f, { month: '2026-09', bytes: 999999, updatedMs: T_SEP_END })
  const m = createWanMeter({ file: f, now: () => T_OCT, log: () => {} })
  eq(m.snapshot().month, '2026-10', '盘上是 9 月，实例月份 = 2026-10')
  eq(m.snapshot().bytes, 0, '跨月读盘后 bytes 归零（不继承 9 月的 999999）')
  m.record(321)
  eq(m.snapshot().bytes, 321, '新月份从 0 起累加 → 321')
  const disk = readMeter(f)
  eq(disk && disk.month, '2026-10', '盘上月份被改写成 2026-10')
}

console.log('【5】同一实例跨月自动归零（不需要定时任务）')
{
  const f = tmpFile('d')
  let t = T_SEP_END
  const m = createWanMeter({ file: f, now: () => t, log: () => {} })
  m.record(5000)
  eq(m.snapshot().bytes, 5000, '9 月先记 5000')
  t = T_OCT_START
  eq(m.snapshot().month, '2026-10', '过了 10-01 00:00（上海）月份自动变 2026-10')
  eq(m.snapshot().bytes, 0, '跨月后 bytes 自动归零')
  m.record(7)
  eq(m.snapshot().bytes, 7, '新月份重新累加 7')
}

console.log('【6】云端下发额度缓存（契约 §2）')
{
  const f = tmpFile('e')
  const m = createWanMeter({ file: f, now: () => T_OCT, log: () => {} })
  eq(m.snapshot().quotaBytes, WAN_DEFAULT_QUOTA_BYTES, '默认额度 10 GiB = 10737418240')
  eq(m.snapshot().quotaBytes, 10737418240, '默认额度数字确认为 10737418240（第 293 节 5→10 GiB）')
  eq(m.snapshot().limitBps, WAN_DEFAULT_LIMIT_BPS, '默认限速 2500000 B/s = 20 Mbps')
  eq(m.snapshot().limitBps, 2500000, '默认限速数字确认为 2500000')

  m.setLimits({ month: '2026-10', usedBytes: 123456789, quotaBytes: 21474836480, limitBps: 4000000 })
  const s = m.snapshot()
  eq(s.usedBytes, 123456789, '采信云端 usedBytes（同账号合计）')
  eq(s.quotaBytes, 21474836480, '采信云端 quotaBytes（买断 20 GiB）')
  eq(s.limitBps, 4000000, '采信云端 limitBps')

  m.setLimits({ month: '2026-09', usedBytes: 999999999, quotaBytes: 5368709120, limitBps: 2500000 })
  const s2 = m.snapshot()
  eq(s2.usedBytes, 0, '云端月份不等于本月 → usedBytes 不采信（归 0 而不是被拉高）')
  eq(s2.quotaBytes, 5368709120, '额度仍然更新')
  eq(s2.limitBps, 2500000, '限速仍然更新')

  m.setLimits(null)
  m.setLimits([])
  m.setLimits('x')
  eq(m.snapshot().quotaBytes, 5368709120, '非法回包不炸也不改额度')
}

console.log('【7】used() = max(云端合计, 本节点累计)')
{
  const f = tmpFile('f')
  const m = createWanMeter({ file: f, now: () => T_OCT, log: () => {} })
  m.record(100)
  eq(m.used(), 100, '云端没下发时按本节点累计 100 算')
  m.setLimits({ month: '2026-10', usedBytes: 500 })
  eq(m.used(), 500, '云端合计更大 → 取 500（闸门更保守）')
  m.record(600)
  eq(m.used(), 700, '本节点累计 700 超过云端 500 → 取 700')
}

console.log('【8】reset')
{
  const f = tmpFile('g')
  const m = createWanMeter({ file: f, now: () => T_OCT, log: () => {} })
  m.record(4321)
  m.reset()
  eq(m.snapshot().bytes, 0, 'reset 后归零')
  eq(readMeter(f) && readMeter(f).bytes, 0, 'reset 同时落盘归零')
}

console.log('【9】落盘文件坏掉不炸')
{
  const f = tmpFile('h')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, '{ 这不是 JSON')
  const m = createWanMeter({ file: f, now: () => T_OCT, log: () => {} })
  eq(m.snapshot().bytes, 0, '坏 JSON → 当 0 处理，不抛异常')
  m.record(9)
  eq(m.snapshot().bytes, 9, '之后能正常记账')
}

console.log('【10】makeWanFetch：心跳请求体补 wanMonth/wanBytes，回包 wan 缓存')
{
  const f = tmpFile('i')
  const meter = createWanMeter({ file: f, now: () => T_OCT, log: () => {} })
  meter.record(2048)

  let seen = null
  const fakeFetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) }
    return new Response(JSON.stringify({
      ok: true, shortId: 'ABCDEFGHIJKLMNO',
      wan: { month: '2026-10', usedBytes: 5368709120 - 1, quotaBytes: 5368709120, limitBps: 1250000 }
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  let cached = null
  const wanFetch = makeWanFetch({ meter, fetch: fakeFetch, onWan: (w) => { cached = w }, log: () => {} })
  const r = await wanFetch('https://example.test/api/cloud/status', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodeId: 'n1' })
  })
  eq(r.status, 200, '/status → 200 原样返回')
  eq(seen.body.nodeId, 'n1', '原来的 nodeId 没被吃掉')
  eq(seen.body.wanMonth, '2026-10', '请求体补了 wanMonth')
  eq(seen.body.wanBytes, 2048, '请求体补了 wanBytes（本月累计）')
  const j = await r.json()
  eq(j.shortId, 'ABCDEFGHIJKLMNO', '原响应体仍可读（clone 没消耗掉）')
  eq(cached && cached.limitBps, 1250000, 'onWan 收到云端 wan')
  eq(meter.snapshot().limitBps, 1250000, 'meter 采信云端 limitBps')
  eq(meter.snapshot().quotaBytes, 5368709120, 'meter 采信云端 quotaBytes')
  eq(meter.snapshot().usedBytes, 5368709120 - 1, 'meter 采信云端 usedBytes（月份对得上）')

  let seen2 = null
  const f2 = async (url, init) => { seen2 = JSON.parse(init.body); return new Response('{"ok":true}', { status: 200 }) }
  const wf2 = makeWanFetch({ meter, fetch: f2, log: () => {} })
  await wf2('https://example.test/api/cloud/register', { method: 'POST', body: JSON.stringify({ nodeId: 'n2' }) })
  eq(seen2.wanMonth, undefined, '/register 不注入 wanMonth')
  eq(seen2.wanBytes, undefined, '/register 不注入 wanBytes')

  const f3 = async () => new Response('{"ok":true,"shortId":"X"}', { status: 200 })
  const wf3 = makeWanFetch({ meter, fetch: f3, onWan: () => { cached = 'WRONG' }, log: () => {} })
  const r3 = await wf3('https://example.test/api/cloud/status', { method: 'POST', body: '{"nodeId":"n3"}' })
  eq(r3.status, 200, '老云端（无 wan）仍 200')
  eq(cached === 'WRONG', false, '无 wan 时 onWan 不被调用')
}

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) {}

console.log('')
console.log(fail === 0 ? '✅ 全部通过' : '❌ 有失败')
console.log('pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
