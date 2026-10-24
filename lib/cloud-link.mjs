import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { TUNNEL_AUTO_PATH } from './tunnel.mjs'

export const DEFAULT_CLOUD_BASE = 'https://dshconsole.pw/api/cloud'

export const CLOUD_TIMEOUT_MS = 8000

export const HEARTBEAT_MS = 30 * 1000

export const FIRST_TICK_MS = 3000

export const DEFAULT_STORE_FILE = path.join(os.homedir(), '.dsh', 'dsh-console-cloud.json')

export const DEFAULT_NODE_FILE = DEFAULT_STORE_FILE

export function newRawNodeId() {
  let out = ''
  while (out.length < 32) out += Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0')
  return out.slice(0, 32)
}

export function isValidNodeId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v)
}

function text(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : ''
}

function num(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n)
}

function pickUser(u) {
  if (!u || typeof u !== 'object') return null
  const out = { uid: text(u.uid), name: text(u.name), avatar: text(u.avatar) }
  if (!out.uid && !out.name && !out.avatar) return null
  return out
}

function pickShortId(v) {
  const s = text(v)
  return s.length > 32 ? s.slice(0, 32) : s
}

function deriveTunnelSid(t) {
  try {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return ''
    const direct = text(t.tunnelSid) || text(t.sid)
    if (/^[A-Z0-9]{15}$/.test(direct)) return direct
    const urls = [text(t.publicUrl)]
    if (Array.isArray(t.locations)) for (const x of t.locations) urls.push(text(x))
    for (const u of urls) {
      const m = u.match(/\/dsh-console\/([A-Z0-9]{15})(?:[/?#]|$)/)
      if (m) return m[1]
    }
    const m2 = text(t.name).match(/^dsh-([A-Z0-9]{15})$/)
    if (m2) return m2[1]
    return ''
  } catch (e) { return '' }
}

function safeJson(body) {
  if (body == null) return null
  if (typeof body === 'object') return Array.isArray(body) ? null : body
  try {
    const j = JSON.parse(String(body))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null
  } catch (e) { return null }
}

function fail(msg) {
  const s = text(msg)
  return { ok: false, error: s || '云端暂时联系不上' }
}

function readStore(file) {
  try {
    if (!file || !fs.existsSync(file)) return {}
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    if (isValidNodeId(parsed.nodeId)) out.nodeId = String(parsed.nodeId).trim()
    if (isValidNodeId(parsed.shortId)) out.shortId = String(parsed.shortId).trim()
    if (isValidNodeId(parsed.tunnelSid)) out.tunnelSid = String(parsed.tunnelSid).trim()
    if (typeof parsed.vipExpireMs === 'number') out.vipExpireMs = num(parsed.vipExpireMs)
    if (parsed.bound && typeof parsed.bound === 'object' && !Array.isArray(parsed.bound)) {
      const u = pickUser(parsed.bound)
      if (u) out.bound = Object.assign({}, u, { ms: num(parsed.bound.ms) })
    }
    return out
  } catch (e) { return {} }
}

export function createCloudLink(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}

  const storePath = text(opts.storePath) || text(opts.file) || DEFAULT_STORE_FILE

  const tunnelAutoPath = text(opts.autoPath) || TUNNEL_AUTO_PATH

  const onTunnel = typeof opts.onTunnel === 'function' ? opts.onTunnel : null

  let lastTunnelJson = ''
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : CLOUD_TIMEOUT_MS

  const heartbeatMs = Number(opts.heartbeatMs) > 0 ? Number(opts.heartbeatMs) : HEARTBEAT_MS

  const firstDelayMs = Number(opts.firstDelayMs) >= 0 ? Number(opts.firstDelayMs) : FIRST_TICK_MS

  const config = opts.config && typeof opts.config === 'object' ? opts.config : {}

  const getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : null
  const saveConfig = typeof opts.saveConfig === 'function' ? opts.saveConfig : null

  const autoStart = opts.autoStart !== false

  const initialRegister = opts.initialRegister !== false
  const platform = text(opts.platform) || (() => {
    try { return text(process.platform) } catch (e) { return '' }
  })()

  const base = (text(opts.base) || text(process.env.DSH_CLOUD_API) || DEFAULT_CLOUD_BASE)
    .replace(/\/+$/, '')

  const doFetch = (opts.fetch === null || opts.fetch === false)
    ? null
    : (typeof opts.fetch === 'function'
      ? opts.fetch
      : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null))

  function cfgNodeId() {
    if (getConfig) {
      try {
        const c = getConfig()
        const id = c && typeof c.nodeId === 'string' ? c.nodeId.trim() : ''
        if (isValidNodeId(id)) return id
      } catch (e) {}
    }
    const id2 = config && typeof config.nodeId === 'string' ? config.nodeId.trim() : ''
    return isValidNodeId(id2) ? id2 : ''
  }

  function persistStore() {
    let ok = false
    if (saveConfig) {
      try { saveConfig({ nodeId }); ok = true } catch (e) { ok = false }
    }
    const data = { nodeId }
    if (shortId) data.shortId = shortId
    if (tunnelSid) data.tunnelSid = tunnelSid
    if (vipExpireMs) data.vipExpireMs = vipExpireMs
    if (bound) data.bound = { uid: bound.uid, name: bound.name, avatar: bound.avatar, ms: num(bound.ms) }
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true })
      fs.writeFileSync(storePath, JSON.stringify(data, null, 2), { mode: 0o600 })
      ok = true
    } catch (e) {
      if (!ok) log('[cloud] 落盘失败（' + ((e && e.message) || e) + '），本次仅内存有效')
    }
    return ok
  }

  function writeAutoTunnel(t) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return false
    const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter((x) => x !== '') : [])
    const data = {
      enabled: true,

      type: text(t.type) || 'http',
      name: text(t.name),
      serverAddr: text(t.serverAddr),
      serverPort: num(t.serverPort),
      authToken: text(t.authToken),
      customDomains: arr(t.customDomains),
      locations: arr(t.locations),
      publicUrl: text(t.publicUrl),
      updatedMs: Date.now()
    }
    const json = JSON.stringify(data, null, 2)
    try {
      fs.mkdirSync(path.dirname(tunnelAutoPath), { recursive: true })
      fs.writeFileSync(tunnelAutoPath, json, { mode: 0o600 })
      log('[cloud] 隧道自动配置已落盘：type=' + data.type + ' locations=' + JSON.stringify(data.locations))
    } catch (e) {
      log('[cloud] 隧道自动配置落盘失败（' + ((e && e.message) || e) + '），本次仅内存有效')
      return false
    }

    const stable = JSON.stringify(Object.assign({}, data, { updatedMs: 0 }))
    if (onTunnel && stable !== lastTunnelJson) {
      lastTunnelJson = stable
      try { onTunnel(data) } catch (e) { log('[cloud] 隧道补拉回调失败（忽略）：' + ((e && e.message) || e)) }
    } else {
      lastTunnelJson = stable
    }
    return true
  }

  const disk = readStore(storePath)

  let shortId = disk.shortId || ''

  let tunnelSid = disk.tunnelSid || ''
  let vipExpireMs = disk.vipExpireMs || 0
  let online = false
  let lastSeenMs = 0
  let bound = disk.bound || null

  let heartbeatTimer = null
  let firstTickTimer = null
  let inflightPromise = null
  let inflight = false

  let lastPersisted = ''
  function persistIfChanged() {
    const key = shortId + '|' + tunnelSid + '|' + vipExpireMs + '|' + (bound ? bound.uid + ':' + bound.name + ':' + bound.avatar : '')
    if (key === lastPersisted) return false
    lastPersisted = key
    return persistStore()
  }

  let nodeId = text(opts.nodeId)
  if (!isValidNodeId(nodeId)) nodeId = cfgNodeId()
  if (!isValidNodeId(nodeId)) nodeId = disk.nodeId || ''
  if (!isValidNodeId(nodeId)) {
    nodeId = newRawNodeId()
    persistStore()
  }

  function noteActivity(t) {
    const now = Number(t) || Date.now()
    lastSeenMs = now
    online = true
  }

  function applyNode(j, t) {
    if (!j || typeof j !== 'object') return
    const sid = pickShortId(j.shortId)
    if (sid) shortId = sid
    if (j.vipExpireMs != null) vipExpireMs = num(j.vipExpireMs)
    if (j.online != null) online = j.online === true
    if (j.lastSeenMs != null) lastSeenMs = num(j.lastSeenMs)
    const u = pickUser(j.user)
    if (u) bound = Object.assign({}, u, { ms: Number(t) || Date.now() })

    persistIfChanged()

    if (j.tunnel && typeof j.tunnel === 'object') writeAutoTunnel(j.tunnel)

    const ts2 = pickShortId(j.tunnelSid) || deriveTunnelSid(j.tunnel)
    if (ts2 && ts2 !== tunnelSid) { tunnelSid = ts2; persistIfChanged() }
  }

  async function call(pathname, body) {
    if (!doFetch) return fail('当前环境没有 fetch')
    const ctrl = new AbortController()
    const timer = setTimeout(() => { try { ctrl.abort() } catch (e) {} }, timeoutMs)
    let r = null
    try {
      r = await doFetch(base + pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal
      })
    } catch (e) {
      clearTimeout(timer)
      const m = (e && e.message) || String(e)
      return fail(e && e.name === 'AbortError' ? '云端超时' : '网络错误：' + m)
    }
    clearTimeout(timer)
    if (!r || typeof r !== 'object') return fail('云端响应格式不对')
    const status = Number(r.status) || 0
    let raw = null
    try { raw = typeof r.json === 'function' ? await r.json() : r.body } catch (e) { raw = null }
    if (status && (status < 200 || status >= 300)) {
      const j0 = safeJson(raw)
      const msg = j0 ? text(j0.error) : ''
      return { ok: false, error: msg || ('云端返回 HTTP ' + status), status }
    }
    const j = safeJson(raw)
    if (!j) return fail('云端响应格式不对')
    return { ok: true, status, body: j }
  }

  async function register(o2 = {}, user) {
    if (!o2.force && shortId) return { ok: true, shortId, vipExpireMs, cached: true }
    const u = pickUser(user || o2.user)
    const payload = { nodeId }
    if (platform) payload.platform = platform
    if (u) payload.user = u
    const res = await call('/register', payload)
    if (!res.ok) return res
    const j = res.body
    if (j.ok === false) return fail(j.error)
    const t = Date.now()
    applyNode(j, t)
    noteActivity(t)
    log('[cloud] 注册成功 shortId=' + (shortId || '(无)'))
    return { ok: true, shortId, vipExpireMs, vipDays: num(j.vipDays), allow: j.allow === true }
  }

  async function bind(user) {
    const u = pickUser(user)
    if (!u) return fail('用户信息不完整')
    const res = await call('/bind', { nodeId, user: u })
    if (!res.ok) return res
    const j = res.body
    if (j.ok === false) return fail(j.error)
    const t = Date.now()
    applyNode(j, t)
    bound = Object.assign({}, u, { ms: t })
    noteActivity(t)
    persistIfChanged()
    log('[cloud] 绑定成功 shortId=' + (shortId || '(无)'))
    return { ok: true, shortId, vipExpireMs }
  }

  async function redeem(code) {
    const c = text(code)
    if (!c) return fail('体验码格式不对')
    const res = await call('/redeem', { nodeId, code: c })
    if (!res.ok) return res
    const j = res.body
    if (j.ok === false) return fail(j.error)
    const t = Date.now()
    applyNode(j, t)
    noteActivity(t)
    log('[cloud] 兑换成功 +' + num(j.addedDays) + ' 天，VIP 到 ' + vipExpireMs)
    return { ok: true, addedDays: num(j.addedDays), vipExpireMs, shortId }
  }

  async function publishPairCode(code, publicUrl, ttlMs) {
    const c = text(code)
    if (!/^[0-9]{6}$/.test(c)) return fail('配对码必须是 6 位数字')
    if (!nodeId) return fail('nodeId 不可用')

    const ttl = Math.min(Math.max(num(ttlMs) || 0, 60 * 1000), 15 * 60 * 1000)
    const payload = { nodeId, code: c, publicUrl: text(publicUrl), ttlMs: ttl }
    const res = await call('/pair/publish', payload)
    if (!res.ok) return { ok: false, expMs: 0, error: text(res.error) }
    const j = res.body || {}
    if (j.ok === false) return { ok: false, expMs: 0, error: text(j.error) || '云端拒绝了配对码' }
    return { ok: true, expMs: num(j.expMs), error: '' }
  }

  async function status() {
    if (!nodeId) return fail('nodeId 不可用')
    const res = await call('/status', { nodeId })
    if (!res.ok) return res
    const j = res.body
    if (j.ok === false) return fail(j.error)
    const t = Date.now()
    applyNode(j, t)
    return {
      ok: true,
      shortId,
      vipExpireMs,
      online,
      lastSeenMs,
      user: bound ? { uid: bound.uid, name: bound.name, avatar: bound.avatar } : null
    }
  }

  function snapshot() {
    try {
      const b = bound
        ? { uid: bound.uid, name: bound.name, avatar: bound.avatar, ms: num(bound.ms) }
        : null
      return {
        ok: true,
        nodeId,
        shortId,
        tunnelSid,
        vipExpireMs,
        online,
        lastSeenMs,
        bound: b,
        offline: !online
      }
    } catch (e) {
      return { ok: false, offline: true, nodeId: '', shortId: '', tunnelSid: '', vipExpireMs: 0,
        online: false, lastSeenMs: 0, bound: null }
    }
  }

  function setBound(user) {
    const u = pickUser(user)
    bound = u ? Object.assign({}, u, { ms: Date.now() }) : null
    persistIfChanged()
    return snapshot()
  }

  function tick() {
    if (inflight) return inflightPromise
    inflight = true
    const p = (async () => {
      try {
        const r = await status()
        if (!r.ok) log('[cloud] 心跳失败：' + r.error)
        return r
      } catch (e) {

        log('[cloud] 心跳异常：' + ((e && e.message) || e))
        return fail((e && e.message) || e)
      } finally {
        inflight = false
      }
    })()
    inflightPromise = p
    return p
  }

  function startHeartbeat(ms) {
    if (heartbeatTimer) return false
    const every = Number(ms) > 0 ? Number(ms) : heartbeatMs
    if (!every) return false

    if (!firstTickTimer && firstDelayMs > 0) {
      const t1 = setTimeout(() => { firstTickTimer = null; tick() }, firstDelayMs)
      if (typeof t1.unref === 'function') t1.unref()
      firstTickTimer = t1
    }
    const timer = setInterval(() => { tick() }, every)
    if (typeof timer.unref === 'function') timer.unref()
    heartbeatTimer = timer
    return true
  }

  function stopHeartbeat() {
    const had = heartbeatTimer != null || firstTickTimer != null
    if (firstTickTimer) {
      try { clearTimeout(firstTickTimer) } catch (e) {}
      firstTickTimer = null
    }
    if (heartbeatTimer) {
      try { clearInterval(heartbeatTimer) } catch (e) {}
      heartbeatTimer = null
    }
    return had
  }

  function drain(ms) {
    const wait = Number(ms) > 0 ? Number(ms) : 0
    if (!inflightPromise || !wait) return Promise.resolve()
    return Promise.race([
      inflightPromise.catch(() => {}),
      new Promise((r) => { const t2 = setTimeout(r, wait); if (typeof t2.unref === 'function') t2.unref() })
    ])
  }

  async function start() {
    let first = null
    if (initialRegister) {
      try { first = await register() } catch (e) { first = fail((e && e.message) || e) }
    }
    startHeartbeat()
    return { ok: true, shortId, vipExpireMs, heartbeat: heartbeatTimer != null, first }
  }

  async function reportOffline() {
    if (!nodeId) return false
    try {
      const res = await call('/offline', { nodeId })
      if (!res || !res.ok) return false
      const j = res.body || {}
      if (j.ok === false) return false
      log('[cloud] 已上报离线，云端立刻判定这台电脑下线')
      return true
    } catch (e) {
      return false
    }
  }

  async function stop() {
    stopHeartbeat()

    await reportOffline()
    await drain(1000)
    return true
  }

  const api = {
    get base() { return base },
    get timeoutMs() { return timeoutMs },
    get storePath() { return storePath },
    get heartbeatMs() { return heartbeatMs },
    get nodeId() { return nodeId },
    get shortId() { return shortId },

    register,
    status,
    bind,
    redeem,
    tick,

    publishPairCode,

    snapshot,
    setBound,
    persistStore,

    start,
    stop,
    startHeartbeat,
    stopHeartbeat,

    reportOffline
  }

  if (autoStart) {
    try {
      Promise.resolve().then(() => api.start()).catch((e) => {
        log('[cloud] 自启动失败：' + ((e && e.message) || e))
      })
    } catch (e) {
      log('[cloud] 自启动失败：' + ((e && e.message) || e))
    }
  }

  return api
}

export default {
  createCloudLink,
  DEFAULT_CLOUD_BASE,
  CLOUD_TIMEOUT_MS,
  HEARTBEAT_MS,
  DEFAULT_NODE_FILE
}
