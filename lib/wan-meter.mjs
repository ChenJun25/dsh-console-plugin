import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

export const WAN_METER_PATH = path.join(os.homedir(), '.dsh', 'dsh-console-wan-meter.json')

export const WAN_DEFAULT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024
export const WAN_DEFAULT_LIMIT_BPS = 2500000
export const WAN_DEFAULT_UPLOAD_MAX_BYTES = 32 * 1024 * 1024

const SAVE_DEBOUNCE_MS = 400

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function given(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.floor(n) : null
}

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
  let bytes = 0
  let usedBytes = 0

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

    if (timer && typeof timer.unref === 'function') timer.unref()
    saveTimer = timer
  }

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

    flush()
    return bytes
  }

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

      unlimited,
      uploadMaxBytes
    }
  }

  function setLimits(w) {
    if (!w || typeof w !== 'object' || Array.isArray(w)) return snapshot()
    rollMonth()
    const m = typeof w.month === 'string' ? w.month.trim() : ''

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

      unlimited = true
    }
    if (unlimited) {

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

const KA_AGENT = new https.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 1, keepAliveMsecs: 30000 })

function kaAbortError() {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

function kaUnzip(buf, enc) {
  return new Promise((resolve, reject) => {
    const e = String(enc || '').toLowerCase().trim()
    if (e === 'gzip' || e === 'x-gzip') return zlib.gunzip(buf, (err, out) => (err ? reject(err) : resolve(out)))
    if (e === 'deflate') return zlib.inflate(buf, (err, out) => (err ? reject(err) : resolve(out)))
    if (e === 'br') return zlib.brotliDecompress(buf, (err, out) => (err ? reject(err) : resolve(out)))
    return resolve(buf)
  })
}

function kaResponse(status, headers, body) {
  const code = Number(status) || 0
  const make = () => {
    const res = {
      status: code,
      ok: code >= 200 && code < 300,
      headers: headers || {},
      text: async () => body,
      json: async () => JSON.parse(body)
    }

    res.clone = () => make()
    return res
  }
  return make()
}

function kaRequest(url, init) {
  return new Promise((resolve, reject) => {
    const method = String((init && init.method) || 'GET').toUpperCase()
    const headers = Object.assign({}, (init && init.headers) || {})
    const body = init && typeof init.body === 'string' ? init.body : null
    if (body != null && !headers['content-length'] && !headers['Content-Length']) {
      headers['content-length'] = String(Buffer.byteLength(body))
    }
    if (!headers['accept-encoding'] && !headers['Accept-Encoding']) headers['accept-encoding'] = 'gzip, deflate'
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + (url.search || ''),
      method: method,
      headers: headers,
      agent: KA_AGENT
    }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('error', reject)
      res.on('end', () => {
        kaUnzip(Buffer.concat(chunks), res.headers && res.headers['content-encoding'])
          .then((buf) => resolve(kaResponse(res.statusCode, res.headers, buf.toString('utf8'))))
          .catch(reject)
      })
    })
    req.on('error', reject)
    const sig = init && init.signal
    if (sig) {
      if (sig.aborted) req.destroy(kaAbortError())
      else if (typeof sig.addEventListener === 'function') {
        sig.addEventListener('abort', () => { try { req.destroy(kaAbortError()) } catch (e) {} }, { once: true })
      }
    }
    if (body != null) req.end(body)
    else req.end()
  })
}

function makeKeepAliveFetch(fallback, log) {
  const isReset = (e) => {
    const c = String((e && (e.code || e.message)) || '')
    return /ECONNRESET|EPIPE|ECONNABORTED|ETIMEDOUT|socket hang up/i.test(c)
  }
  return async function keepAliveFetch(input, init) {
    let url = null
    try { url = new URL(typeof input === 'string' ? input : String((input && input.url) || '')) } catch (e) { url = null }
    if (!url || url.protocol !== 'https:' || !init || typeof init.body !== 'string') {
      if (typeof fallback === 'function') return fallback(input, init)
      if (typeof globalThis.fetch === 'function') return globalThis.fetch(input, init)
      throw new Error('当前环境没有 fetch')
    }
    try {
      return await kaRequest(url, init)
    } catch (e) {
      if (e && e.name !== 'AbortError' && isReset(e)) {
        log('[wan] 心跳长连接被对端关闭（' + ((e && (e.code || e.message)) || e) + '），重试 1 次')
        return await kaRequest(url, init)
      }
      throw e
    }
  }
}

export function makeWanFetch(opts = {}) {
  const o = opts || {}
  const meter = o.meter && typeof o.meter === 'object' ? o.meter : null
  const onWan = typeof o.onWan === 'function' ? o.onWan : null

  const runtime = typeof o.runtime === 'function' ? o.runtime : null
  const log = typeof o.log === 'function' ? o.log : () => {}
  const fallback = typeof o.fetch === 'function'
    ? o.fetch
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)

  const isStatusUrl = (u) => /\/status(?:[?#].*)?$/.test(String(u || ''))

  const ka = o.keepAlive === false ? null : makeKeepAliveFetch(fallback, log)

  return async function wanFetch(input, init) {
    const real = ka || fallback || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
    if (!real) throw new Error('当前环境没有 fetch')

    let urlStr = ''
    try { urlStr = typeof input === 'string' ? input : String((input && input.url) || '') } catch (e) { urlStr = '' }
    const isStatus = isStatusUrl(urlStr)

    let req = init
    if (isStatus && req && typeof req.body === 'string' && (meter || runtime)) {
      try {
        const payload = JSON.parse(req.body)
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          let changed = false
          if (meter) {
            const s = meter.snapshot()
            payload.wanMonth = s.month
            payload.wanBytes = s.bytes
            changed = true
          }

          if (runtime) {
            let rt = null
            try { rt = runtime() } catch (e) { rt = null }
            if (rt && typeof rt === 'object' && !Array.isArray(rt)) {
              const ver = String(rt.pluginVersion || '').trim()
              const port = Number(rt.lanPort) || 0
              const be = rt.lanBindError
              if (ver) { payload.pluginVersion = ver.slice(0, 32); changed = true }
              if (port > 0 && port <= 65535) { payload.lanPort = Math.floor(port); changed = true }
              if (typeof be === 'string' && be.trim()) { payload.lanBindError = be.trim().slice(0, 300); changed = true }
              else if (be && typeof be === 'object') { payload.lanBindError = be; changed = true }

              const tp = String(rt.tunnelPhase || '').trim()
              if (tp) { payload.tunnelPhase = tp.slice(0, 16); changed = true }
              if (rt.tunnelReady === true || rt.tunnelReady === false) { payload.tunnelReady = rt.tunnelReady === true; changed = true }
            }
          }

          payload.tunnelApi = 1
          changed = true
          if (changed) req = Object.assign({}, req, { body: JSON.stringify(payload) })
        }
      } catch (e) { log('[wan] 心跳请求体注入失败（忽略）：' + ((e && e.message) || e)) }
    }

    const r = await real(input, req)
    if (!isStatus) return r

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
