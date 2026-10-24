import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 第 289 节 · 公网流量计量（WAN meter）
// 契约：_tmp/289-契约.md §1
//   wanMonth = YYYY-MM（Asia/Shanghai，每月 1 号 00:00 归零 → 靠月份字符串比较，不需要定时任务）
//   wanBytes = 该节点本月累计的公网出站字节数（单调递增，节点重启不归零 → 必须落盘）
// 只计 WAN 链路；LAN 一个字节都不计。

export const WAN_METER_PATH = path.join(os.homedir(), '.dsh', 'dsh-console-wan-meter.json')

// 云端下发前的兜底值（契约 §2）
// 第 293 节 · 用户 m00272 拍板：普通档从 5 GiB/月 提到 10 GiB/月；新增单次上传上限 32 MiB。
// 权益唯一真源在云端（_cloud.py 的 wan_view），这里只是「云端还没回包」时的兜底。
export const WAN_DEFAULT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024
export const WAN_DEFAULT_LIMIT_BPS = 2500000
export const WAN_DEFAULT_UPLOAD_MAX_BYTES = 32 * 1024 * 1024

const SAVE_DEBOUNCE_MS = 400

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

// 🔴 第 293 节：「云端没给这个字段」和「云端给了 0」必须分开。
// 0 = 不限（SVIP 买断三项全 0），缺字段 = 沿用当前值 —— num() 把两者混成一个 0，所以另开一个。
function given(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.floor(n) : null
}

// Asia/Shanghai 恒为 UTC+8（无夏令时），直接用偏移算，避免 Intl 在各运行时差异
export function shanghaiMonthOf(t) {
  const ms = Number(t) > 0 ? Number(t) : Date.now()
  const d = new Date(ms + 8 * 3600 * 1000)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  return y + '-' + (m < 10 ? '0' + m : String(m))
}

export function createWanMeter(opts = {}) {
  const o = opts || {}
  const log = typeof o.log === 'function' ? o.log : () => {}
  const file = typeof o.file === 'string' && o.file.trim() ? o.file.trim() : WAN_METER_PATH
  const now = typeof o.now === 'function' ? o.now : () => Date.now()

  let month = shanghaiMonthOf(now())
  let bytes = 0            // 本节点本月累计（落盘）
  let usedBytes = 0        // 云端下发的「同账号所有节点合计」
  // 第 293 节：unlimited = SVIP 买断总开关；uploadMaxBytes = 单次上传/下载上限（0 = 不限）
  let unlimited = o.unlimited === true
  const _u = given(o.uploadMaxBytes)
  let uploadMaxBytes = _u !== null ? _u : WAN_DEFAULT_UPLOAD_MAX_BYTES
  let quotaBytes = (() => { const q = given(o.quotaBytes); return q !== null ? q : WAN_DEFAULT_QUOTA_BYTES })()
  let limitBps = (() => { const r = given(o.limitBps); return r !== null ? r : WAN_DEFAULT_LIMIT_BPS })()

  let saveTimer = null
  let dirty = false

  function readDisk() {
    try {
      const raw = fs.readFileSync(file, 'utf8')
      const j = JSON.parse(String(raw).replace(/^\uFEFF/, ''))
      if (!j || typeof j !== 'object') return null
      return j
    } catch (e) {
      return null
    }
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    if (!dirty) return false
    const data = { month, bytes, updatedMs: Number(now()) || Date.now() }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 })
      dirty = false
      return true
    } catch (e) {
      log('[wan] 计量落盘失败（仅内存有效）：' + ((e && e.message) || e))
      dirty = false
      return false
    }
  }

  function scheduleSave() {
    if (saveTimer) return
    const timer = setTimeout(() => { saveTimer = null; flush() }, SAVE_DEBOUNCE_MS)
    // 别让计量写盘拖住进程退出
    if (timer && typeof timer.unref === 'function') timer.unref()
    saveTimer = timer
  }

  // 月份变了就归零（读盘 / 累加 / 取值 三处都过一遍，保证跨月第一笔就算新月份）
  function rollMonth() {
    const cur = shanghaiMonthOf(now())
    if (cur === month) return false
    month = cur
    bytes = 0
    usedBytes = 0
    dirty = true
    scheduleSave()
    return true
  }

  function load() {
    const j = readDisk()
    if (!j) { month = shanghaiMonthOf(now()); bytes = 0; return }
    const m = typeof j.month === 'string' ? j.month.trim() : ''
    if (m && m === month) {
      bytes = num(j.bytes)
    } else {
      // 盘上是旧月份（或没有月份）→ 本月从 0 开始
      bytes = 0
      dirty = true
      scheduleSave()
    }
  }

  function record(n) {
    const add = Math.floor(Number(n) || 0)
    if (!(add > 0)) return bytes
    rollMonth()
    bytes += add
    dirty = true
    // 每传完一个文件落一次盘（频率很低，一次一个 ~100 字节小 JSON），保证重启不丢计量
    flush()
    return bytes
  }

  // 闸门用：本月已用 = max(云端账号合计, 本节点实际累计)，取大的更保守
  function used() {
    rollMonth()
    return Math.max(usedBytes, bytes)
  }

  function snapshot() {
    rollMonth()
    return {
      month,
      bytes,
      usedBytes: Math.max(usedBytes, bytes),
      quotaBytes,
      limitBps,
      // 第 293 节：三项权益（单次体积 / 月流量 / 限速）都要能被 lan-server 读到，0 一律表示不限
      unlimited,
      uploadMaxBytes
    }
  }

  // 云端心跳回包 { plan, unlimited, uploadMaxBytes, quotaBytes, limitBps, month, usedBytes }
  // → 缓存权益（契约 §2）
  // 🔴 第 293 节：0 = 不限！unlimited 是总开关（SVIP 买断时云端三项全下发 0）。
  function setLimits(w) {
    if (!w || typeof w !== 'object' || Array.isArray(w)) return snapshot()
    rollMonth()
    const m = typeof w.month === 'string' ? w.month.trim() : ''
    // 月份对不上（云端还没刷新到本月）就不采信这个 usedBytes，归 0 让闸门只看本节点累计
    usedBytes = (!m || m === month) ? num(w.usedBytes) : 0
    const flag = typeof w.unlimited === 'boolean' ? w.unlimited : null
    const q = given(w.quotaBytes)
    const r = given(w.limitBps)
    const u = given(w.uploadMaxBytes)
    if (q !== null) quotaBytes = q
    if (r !== null) limitBps = r
    if (u !== null) uploadMaxBytes = u
    if (flag !== null) {
      unlimited = flag
    } else if ((q !== null && q === 0) || (r !== null && r === 0) || (u !== null && u === 0)) {
      // 老云端 / 手写回包没有 unlimited 字段时的兜底：任一维显式给 0 就当买断
      unlimited = true
    }
    if (unlimited) {
      // 买断 = 三项全不限，别留一个「半开」的组合让闸门误判
      quotaBytes = 0
      limitBps = 0
      uploadMaxBytes = 0
    }
    return snapshot()
  }

  function reset() {
    month = shanghaiMonthOf(now())
    bytes = 0
    usedBytes = 0
    dirty = true
    flush()
    return snapshot()
  }

  load()

  return {
    file,
    record,
    used,
    snapshot,
    setLimits,
    reset,
    flush,
    get month() { return month },
    get bytes() { return bytes }
  }
}

// 包一层 fetch 给 cloud-link 用（契约 §1/§2）：
//   请求 /status 时 body 补 { wanMonth, wanBytes }；回包里 { wan:{month,usedBytes,quotaBytes,limitBps} }
//   缓存进 meter（setLimits）并回调 onWan，供 lan-server 的闸门/限速读取。
// 放在这里而不是 index.js 内部，是为了能单测（不依赖 DSH ctx）。
export function makeWanFetch(opts = {}) {
  const o = opts || {}
  const meter = o.meter && typeof o.meter === 'object' ? o.meter : null
  const onWan = typeof o.onWan === 'function' ? o.onWan : null
  const log = typeof o.log === 'function' ? o.log : () => {}
  const fallback = typeof o.fetch === 'function'
    ? o.fetch
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)

  const isStatusUrl = (u) => /\/status(?:[?#].*)?$/.test(String(u || ''))

  return async function wanFetch(input, init) {
    const real = fallback || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
    if (!real) throw new Error('当前环境没有 fetch')

    let urlStr = ''
    try { urlStr = typeof input === 'string' ? input : String((input && input.url) || '') } catch (e) { urlStr = '' }
    const isStatus = isStatusUrl(urlStr)

    let req = init
    if (isStatus && meter && req && typeof req.body === 'string') {
      try {
        const payload = JSON.parse(req.body)
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const s = meter.snapshot()
          payload.wanMonth = s.month
          payload.wanBytes = s.bytes
          req = Object.assign({}, req, { body: JSON.stringify(payload) })
        }
      } catch (e) { log('[wan] 心跳请求体注入失败（忽略）：' + ((e && e.message) || e)) }
    }

    const r = await real(input, req)
    if (!isStatus) return r

    // clone 一份读，原响应体留给 cloud-link 自己 r.json()
    try {
      const raw = typeof r.clone === 'function' ? await r.clone().text() : ''
      const j = raw ? JSON.parse(raw) : null
      const w = j && typeof j === 'object' && j.wan && typeof j.wan === 'object' && !Array.isArray(j.wan) ? j.wan : null
      if (w) {
        if (meter && typeof meter.setLimits === 'function') meter.setLimits(w)
        if (onWan) onWan(w)
      }
    } catch (e) { log('[wan] 心跳回包解析失败（忽略）：' + ((e && e.message) || e)) }
    return r
  }
}
