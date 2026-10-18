import os from 'node:os'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'

import { cookieValue } from './mp-contract.mjs'

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { aboutOf } from './mp-routes.mjs'

const boundPortRef = { value: 0 }

const PAIR_TTL = 15 * 60 * 1000

const PHONE_TTL = 2 * 60 * 1000

const LOCAL_LINK_TTL = PHONE_TTL

const DEVICE_ONLINE_TTL = 10 * 60 * 1000
const MAX_TRIES = 20

const PUB_BLOCKED = new Set(['/', '/pair', '/qr', '/newcode', '/claim', '/pair/ticket', '/web', '/pet'])

const REMOTE_PAIR_ALLOWED = new Set(['/pair/ticket', '/claim'])

const CLAIM_FAIL_WINDOW = 15 * 60 * 1000
const CLAIM_FAIL_MAX = 20

const CLOUD_GATED = new Set(['/sessions', '/attachment', '/cmd', '/mp-cookie'])

export function lanAddresses() {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== 'IPv4' && ni.family !== 4) continue
      if (ni.internal) continue
      out.push({ name, address: ni.address })
    }
  }
  out.sort((a, b) => score(a.address) - score(b.address))
  return out
}

function score(ip) {
  if (/^192\.168\./.test(ip)) return 0
  if (/^10\./.test(ip)) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
  return 3
}

export function lanUrls(port) {
  return lanAddresses().map((a) => 'http://' + a.address + ':' + port + '/dsh-console')
}

export function webConsoleUrl(port) {
  return ''
}

export function isLanAddress(ip) {
  let s = String(ip == null ? '' : ip).trim()
  if (s === '') return false
  const pct = s.indexOf('%')
  if (pct > 0) s = s.slice(0, pct)
  const lc = s.toLowerCase()
  if (lc === '::1' || lc === '0:0:0:0:0:0:0:1') return true
  if (/^fe80:/.test(lc)) return true
  if (/^f[cd][0-9a-f]{2}:/.test(lc)) return true
  if (/^::ffff:/i.test(s)) s = s.slice(7)                 // IPv4-mapped IPv6
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return false
  const a = Number(m[1]); const b = Number(m[2])
  if (a === 127) return true
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

export function isLoopbackAddress(ip) {
  let s = String(ip == null ? '' : ip).trim()
  if (s === '') return false
  const pct = s.indexOf('%')
  if (pct > 0) s = s.slice(0, pct)
  const lc = s.toLowerCase()
  if (lc === '::1' || lc === '0:0:0:0:0:0:0:1') return true
  if (lc.indexOf('::ffff:') === 0) s = s.slice(7)         // IPv4-mapped IPv6
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  return !!m && Number(m[1]) === 127
}

export function isPeerDeviceAddress(ip) {
  if (isLoopbackAddress(ip)) return false
  return isLanAddress(ip)
}

export function forwardedFor(req) {
  let h = null
  try { h = req && req.headers ? req.headers : null } catch (e) { h = null }
  if (!h) return ''
  const pick = (v) => {
    const s = Array.isArray(v) ? (v.length ? v[0] : '') : v
    if (typeof s !== 'string') return ''
    return s.split(',')[0].trim()
  }
  return pick(h['x-forwarded-for']) || pick(h['x-real-ip'])
}

export function isRemoteLink(req) { return forwardedFor(req) !== '' }

function blankTunnel() {
  return {
    enabled: false,
    ready: false,
    phase: 'disabled',
    lastError: '',
    serverAddr: '',
    remotePort: 0,
    since: 0,
    publicUrl: ''
  }
}

function realPort(o) {
  if (typeof boundPortRef.value === 'number' && boundPortRef.value > 0) return boundPortRef.value
  return o && o.port ? o.port : 0
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')

  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-dsh-console-token, x-dafeiyu-token')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

async function readBody(req, limit) {

  const max = Number(limit) || 1e6
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => {
      b += c
      if (b.length > max) { req.destroy(); resolve({}) }
    })
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}) } catch (e) { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function tokenOf(req, url) {
  const h = String(
    req.headers['x-dsh-console-token'] ||

    req.headers['x-dafeiyu-token'] ||
    ''
  ).trim()
  if (h) return h
  return String(url.searchParams.get('token') || '').trim()
}

let pairSeq = 0

export function pairPayload({ base, ticket, name, node, cloud }) {
  const q = []
  if (base) q.push('b=' + encodeURIComponent(String(base)))

  if (ticket) q.push('k=' + encodeURIComponent(String(ticket)))
  if (name) q.push('n=' + encodeURIComponent(String(name)))
  if (node) q.push('i=' + encodeURIComponent(String(node)))

  if (cloud) q.push('c=' + encodeURIComponent(String(cloud)))

  pairSeq += 1
  q.push('v=' + Date.now().toString(36) + '-' + pairSeq)
  return 'dsh-console://pair?' + q.join('&')
}

export async function qrDataUrl(text, opts = {}) {
  try {
    const mod = await import('qrcode')
    return await mod.toDataURL(text, {
      margin: 1,
      width: opts.width || 360,
      errorCorrectionLevel: 'M',
      color: { dark: opts.dark || '#0a1220', light: opts.light || '#ffffff' }
    })
  } catch (e) {
    return null
  }
}

function pickBase(o, info) {
  const ports = Array.isArray(info && info.ports) ? info.ports : []
  if (ports.length) return String(ports[0])
  const urls = lanUrls(realPort(o))
  return urls.length ? urls[0] : ''
}

export function startLanServer(o) {
  const log = o.log || (() => {})
  let server = null
  let boundPort = 0

  const remotePairOn = () => (typeof o.getRemotePair === 'function' ? o.getRemotePair() === true : false)

  let claimFail = { n: 0, resetAt: 0 }

  let pairCode = ''
  let pairExp = 0

  let phoneLastSeen = 0

  function ensurePairCode() {
    const t = Date.now()
    if (!pairCode || t > pairExp) {
      pairCode = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
      pairExp = t + PAIR_TTL
      if (typeof o.onPairCode === 'function') o.onPairCode(pairCode, pairExp)
    }
    return pairCode
  }
  function currentPairCode() {
    if (!pairCode || Date.now() > pairExp) return ''
    return pairCode
  }
  function setPairCode(v) { pairCode = v || ''; pairExp = 0 }

  const PAIR_TICKET_TTL = Number.isFinite(Number(o.pairTicketTtlMs)) && Number(o.pairTicketTtlMs) > 0
    ? Number(o.pairTicketTtlMs)
    : 5 * 60 * 1000
  let pairTicket = ''
  let pairTicketExp = 0
  function ensurePairTicket() {
    const t = Date.now()
    if (!pairTicket || t > pairTicketExp) {
      pairTicket = 'pt_' + crypto.randomBytes(16).toString('hex')
      pairTicketExp = t + PAIR_TICKET_TTL
    }
    return pairTicket
  }
  function currentPairTicket() {
    if (!pairTicket || Date.now() > pairTicketExp) return ''
    return pairTicket
  }
  function clearPairTicket() { pairTicket = ''; pairTicketExp = 0 }

  const REMOTE_CODE_TTL = 15 * 60 * 1000
  const REMOTE_CODE_REPUBLISH_MS = 60 * 1000
  let remoteCode = ''
  let remoteExp = 0
  let remotePubAt = 0
  let remotePubErr = ''
  let remotePublishing = false

  function publishRemoteCode(now) {
    const c = cloudMod()
    if (!c) return
    if (typeof c.publishPairCode !== 'function') {
      remotePubErr = '当前云端版本不支持异地配对码'
      return
    }
    if (remotePublishing) return
    const code = remoteCode
    const ttlMs = Math.min(REMOTE_CODE_TTL, Math.max(60 * 1000, remoteExp - now))
    const publicUrl = publicUrlsNow()[0] || ''
    remotePublishing = true

    remotePubAt = now
    let p = null
    try {
      p = c.publishPairCode(code, publicUrl, ttlMs)
    } catch (e) {
      remotePublishing = false
      remotePubErr = String((e && e.message) || e)
      remotePubAt = 0
      return
    }
    Promise.resolve(p).then((r) => {
      if (r && r.ok === true) { remotePubErr = ''; return }
      remotePubErr = (r && typeof r.error === 'string' && r.error) ? r.error : '云端拒绝了配对码'
      if (remoteCode === code) remotePubAt = 0
    }, (e) => {
      remotePubErr = String((e && e.message) || e)
      if (remoteCode === code) remotePubAt = 0
    }).then(() => { remotePublishing = false }, () => { remotePublishing = false })
  }

  function ensureRemoteCode() {
    if (!remotePairOn()) {
      remoteCode = ''
      remoteExp = 0
      remotePubAt = 0
      remotePubErr = ''
      return ''
    }
    const t = Date.now()
    if (!remoteCode || t > remoteExp) {
      remoteCode = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
      remoteExp = t + REMOTE_CODE_TTL
      remotePubAt = 0
      remotePubErr = ''
    }
    if (remotePubAt === 0 || (t - remotePubAt) >= REMOTE_CODE_REPUBLISH_MS) publishRemoteCode(t)
    return remoteCode
  }

  function currentRemoteCode() {
    if (!remotePairOn()) return ''
    if (!remoteCode) return ''
    if (Date.now() > remoteExp) return ''
    return remoteCode
  }

  function safeInfo() {
    const urls = lanUrls(realPort(o))
    try {
      const info = o.getInfo() || {}
      return {
        name: info.name || '',
        nodeId: info.nodeId || '',
        host: info.host || os.hostname(),
        dshOk: !!info.dshOk,
        dshError: info.dshError || '',
        version: info.version || '',
        ports: urls,

        agentPreset: info.agentPreset || '',
        agentPresetAvailable: !!info.agentPresetAvailable,

        latestVersion: info.latestVersion || '',

        publicUrls: publicUrlsNow()
      }
    } catch (e) {

      return { name: '', nodeId: '', host: os.hostname(), dshOk: false, ports: urls,
        agentPreset: '', agentPresetAvailable: false, latestVersion: '', publicUrls: publicUrlsNow() }
    }
  }

  let localLinkAt = 0
  let remoteLinkAt = 0

  let localLinkWho = ''
  let remoteLinkWho = ''

  const liveStreams = new Map()

  function markLink(chain, secret) {
    const who = String(secret || '')
    const at = Date.now()
    if (chain === 'remote') {
      remoteLinkAt = at
      if (who !== '') remoteLinkWho = who
    } else if (chain === 'local') {
      localLinkAt = at
      if (who !== '') localLinkWho = who
    }
  }

  function clearLinkIfOwner(chain, secret) {
    const who = String(secret || '')
    if (who === '') return
    if (chain === 'remote') {
      if (remoteLinkWho === who) { remoteLinkAt = 0; remoteLinkWho = '' }
    } else if (chain === 'local') {
      if (localLinkWho === who) { localLinkAt = 0; localLinkWho = '' }
    }
  }

  function linkState(nowMs) {
    const now = Number(nowMs) || Date.now()
    const fresh = (t) => t > 0 && (now - t) < LOCAL_LINK_TTL
    return { localLink: fresh(localLinkAt), remoteLink: fresh(remoteLinkAt) }
  }
  function tunnelNow() {
    try {
      const t = typeof o.tunnelStatus === 'function' ? o.tunnelStatus() : null
      const base = blankTunnel()
      if (!t || typeof t !== 'object') return base
      const phase = ['disabled', 'starting', 'connected', 'reconnecting', 'error'].indexOf(String(t.phase)) >= 0
        ? String(t.phase) : 'disabled'
      return {
        enabled: t.enabled === true,
        ready: t.ready === true,
        phase: phase,
        lastError: typeof t.lastError === 'string' ? t.lastError : '',
        serverAddr: typeof t.serverAddr === 'string' ? t.serverAddr : '',
        remotePort: Number(t.remotePort) || 0,
        since: Number(t.since) || 0,

        publicUrl: typeof t.publicUrl === 'string' ? t.publicUrl : ''
      }
    } catch (e) { return blankTunnel() }
  }

  function publicUrlsNow() {
    const t = tunnelNow()
    if (t.enabled !== true || t.ready !== true || t.phase !== 'connected') return []
    return (typeof t.publicUrl === 'string' && t.publicUrl !== '') ? [t.publicUrl] : []
  }

  function identityOf() {
    const c = cloudMod()
    if (!c || typeof c.snapshot !== 'function') return null
    try {
      const s = c.snapshot()
      if (!s || typeof s !== 'object') return null
      const b = (s.bound && typeof s.bound === 'object') ? s.bound : null
      const cloudUid = String((b && b.uid) || '').trim().slice(0, 120)
      const account = String((b && b.name) || '').trim().slice(0, 80)
      const pubId = String(s.shortId || s.pubId || '').trim().slice(0, 120)
      if (cloudUid === '' && account === '' && pubId === '') return null
      return { cloudUid, pubId, account, nickName: account }
    } catch (e) { return null }
  }

  function bindStoreIdentity() {
    try {
      const store = o.mp && o.mp.store
      if (store && typeof store.setIdentity === 'function') store.setIdentity(identityOf)
    } catch (e) {  }
  }

  function identTxt(v, max) {
    const s = String(v == null ? '' : v).trim()
    return s === '' ? '' : s.slice(0, max)
  }

  function withIdentity(row) {
    const id = identityOf()
    const out = Object.assign({}, row)
    const uid = identTxt(row && row.uid, 120)
    const cloudUid = identTxt(row && row.cloudUid, 120) || identTxt(id && id.cloudUid, 120)
    const pubId = identTxt(row && (row.pubId || row.shortId), 120) || identTxt(id && (id.pubId || id.shortId), 120)
    const account = identTxt(row && (row.account || row.nickName), 80) || identTxt(id && (id.account || id.name), 80)
    if (uid !== '') out.uid = uid
    if (cloudUid !== '') out.cloudUid = cloudUid
    if (pubId !== '') out.pubId = pubId
    if (account !== '') out.account = account
    return out
  }

  function deviceRoster() {
    try {
      const store = o.mp && o.mp.store
      if (!store || typeof store.list !== 'function') return []
      bindStoreIdentity()
      const list = store.list()
      if (!Array.isArray(list)) return []

      return list.map(withIdentity)
    } catch (e) { return [] }
  }

  function rosterCounts() {
    const devices = deviceRoster()
    return {
      devices: devices,
      deviceCount: devices.length,
      onlineCount: devices.filter((d) => d.online).length
    }
  }

  function cloudMod() {
    const c = o.cloud
    return c && typeof c === 'object' ? c : null
  }

  function cloudErr(e) {
    const s = typeof e === 'string' ? e.trim() : ''
    return s || '云端不可用'
  }

  function cloudNum(v) {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }

  function cloudView() {
    const c = cloudMod()
    if (!c || typeof c.snapshot !== 'function') return null
    try {
      const s = c.snapshot()
      if (!s || typeof s !== 'object') return null
      return {
        shortId: typeof s.shortId === 'string' ? s.shortId : '',
        vipExpireMs: Number(s.vipExpireMs) || 0,
        online: s.online === true
      }
    } catch (e) { return null }
  }

  function cloudTunnelSid() {
    const c = cloudMod()
    if (!c || typeof c.snapshot !== 'function') return ''
    try {
      const s = c.snapshot()
      return (s && typeof s === 'object' && typeof s.tunnelSid === 'string') ? s.tunnelSid : ''
    } catch (e) { return '' }
  }

  function isCloudLive() {
    const c = cloudMod()
    if (!c || typeof c.snapshot !== 'function') return false
    try {
      const s = c.snapshot()
      if (!s || typeof s !== 'object') return false
      const exp = Number(s.vipExpireMs)
      return Number.isFinite(exp) && exp > Date.now()
    } catch (e) { return false }
  }

  function remotePairPaid() {
    if (!cloudMod()) return true
    return isCloudLive()
  }

  function linkSubscribed() {

    if (!cloudMod()) return undefined
    let online = false
    try {
      const s = cloudMod().snapshot()
      online = !!s && s.online === true
    } catch (e) { online = false }
    if (!online) return undefined
    return isCloudLive()
  }

  function cloudStatusBody() {
    const c = cloudMod()
    const v = cloudView()
    if (!v) return { ok: false, error: '云端不可用' }
    let bound = null
    try {
      const b = c.snapshot() && c.snapshot().bound
      bound = b && typeof b === 'object'
        ? { uid: String(b.uid || ''), name: String(b.name || ''), avatar: String(b.avatar || ''),
            ms: Number(b.ms) || 0 }
        : null
    } catch (e) { bound = null }
    return {
      ok: true,
      shortId: v.shortId,

      pubId: v.shortId,
      vipExpireMs: v.vipExpireMs,
      online: v.online,
      bound
    }
  }

  function noteDevice(req) {

    let secret = ''
    try {

      let ip = ''
      try { ip = req && req.socket ? String(req.socket.remoteAddress || '') : '' } catch (e2) { ip = '' }
      try { secret = cookieValue(req.headers.cookie) } catch (e3) { secret = '' }

      const remoteNow = isRemoteLink(req)
      const chain = remoteNow ? 'remote' : (isPeerDeviceAddress(ip) ? 'local' : '')

      if (chain !== '') {

        if (secret !== '') {
          const prev = (chain === 'remote')
            ? (localLinkWho === secret ? 'local' : '')
            : (remoteLinkWho === secret ? 'remote' : '')
          if (prev !== '') clearLinkIfOwner(prev, secret)
        }
        markLink(chain, secret)
      }
      if (typeof o.onRequestLink === 'function') o.onRequestLink(req)
    } catch (e) {}
    try {
      if (secret === '') return
      const store = o.mp && o.mp.store

      if (store && typeof store.touch === 'function') store.touch(secret, identityOf())
    } catch (e) {}
  }

  function noteStreamLink(req, mode) {
    try {
      const secret = cookieValue(req && req.headers ? req.headers.cookie : '')
      if (secret === '') return
      let ip = ''
      try { ip = req && req.socket ? String(req.socket.remoteAddress || '') : '' } catch (e2) { ip = '' }
      const chain = isRemoteLink(req) ? 'remote' : (isPeerDeviceAddress(ip) ? 'local' : '')
      if (chain === '') return
      const key = secret + '|' + chain
      if (mode === 'close') {
        const n = (liveStreams.get(key) || 0) - 1
        if (n > 0) { liveStreams.set(key, n); return }
        liveStreams.delete(key)

        clearLinkIfOwner(chain, secret)
        return
      }
      noteDevice(req)
      phoneLastSeen = Date.now()

      if (mode === 'open') liveStreams.set(key, (liveStreams.get(key) || 0) + 1)
    } catch (e) {  }
  }

  async function panelData(withQr) {
    const info = safeInfo()
    const token = o.getToken()
    const base = pickBase(o, info)
    const code = ensurePairCode()

    const now = Date.now()
    const roster = rosterCounts()
    const phoneFresh = phoneLastSeen > 0 && (now - phoneLastSeen) < PHONE_TTL

    const deviceFresh = roster.devices.some(
      (d) => (now - (Number(d.lastSeen) || 0)) < DEVICE_ONLINE_TTL
    )

    const cloud = publicUrlsNow().join(',')
    const out = {
      ok: true,
      name: info.name || info.host,
      host: info.host,
      dshOk: info.dshOk,
      dshError: info.dshError,
      port: realPort(o),
      base: base,
      token: token,
      code: code,
      codeLeftMs: Math.max(0, pairExp - Date.now()),
      ports: info.ports,
      phoneLastSeen: phoneLastSeen,
      phoneOnline: phoneFresh || deviceFresh,
      payload: pairPayload({ base, ticket: ensurePairTicket(), name: info.name || info.host, node: info.nodeId, cloud })
    }

    out.webUrl = ''

    out.version = info.version || ''
    out.latestVersion = info.latestVersion || ''
    out.updateState = typeof o.getUpdateState === 'function' ? o.getUpdateState() : null

    out.devices = roster.devices
    out.deviceCount = roster.deviceCount
    out.onlineCount = roster.onlineCount

    out.tunnel = tunnelNow()
    out.publicUrls = publicUrlsNow()

    out.cloud = cloud

    out.remotePair = remotePairOn()

    const rpCode = ensureRemoteCode()
    out.remotePairCode = rpCode
    out.remotePairCodeLeftMs = rpCode ? Math.max(0, remoteExp - now) : 0
    out.remotePairCodeErr = rpCode ? remotePubErr : ''

    const link = linkState(now)
    out.localLink = link.localLink
    out.remoteLink = link.remoteLink

    const sub = linkSubscribed()
    if (typeof sub === 'boolean') out.linkSubscribed = sub
    if (withQr) {
      out.qrDataUrl = await qrDataUrl(out.payload, { width: 360 })

    }
    return out
  }

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://x')

    const m = url.pathname.match(/^\/(?:dsh-console|dafeiyu|dsh-dafeiyu-panel)(?:\/([A-Z0-9]{15}))?/)
    const seg = (m && m[1]) ? m[1] : ''
    if (seg) {
      const cv = cloudView()
      const mine = (cv && typeof cv.shortId === 'string') ? cv.shortId : ''

      const tSid = cloudTunnelSid()
      if (seg !== mine && (tSid === '' || seg !== tSid)) {
        return sendJson(res, 404, { ok: false, error: '短号 ' + seg + ' 不是这台机器' })
      }
    }
    const p = url.pathname.replace(/^\/(?:dsh-console|dafeiyu|dsh-dafeiyu-panel)(?:\/[A-Z0-9]{15})?/, '') || '/'

    if (o.mp && typeof o.mp.branch === 'function') {

      const pathname = p
      try {
        if (await o.mp.branch(req, res, pathname)) return
      } catch (e) {
        log('[mp] 分支出错: ' + ((e && e.message) || e))
        try { sendJson(res, 500, { ok: false, error: 'mp 内部错误' }) } catch (x) {  }
        return
      }
    }

    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return }

    if (isRemoteLink(req) && PUB_BLOCKED.has(p)) {

      if (!(remotePairOn() && REMOTE_PAIR_ALLOWED.has(p))) {

        return sendJson(res, 403, { ok: false, error: '配对与取码仅限局域网内使用', reason: 'remote-pair-off' })
      }

      if (!remotePairPaid()) {

        return sendJson(res, 403, { ok: false, error: '异地配对需要先开通公网访问服务', reason: 'need-vip' })
      }
    }

    const gateOff = ['off', '0', 'false'].indexOf(
      String((process.env && process.env.DSH_CLOUD_GATE) || '').trim().toLowerCase()
    ) >= 0
    if (!gateOff && o.cloud && isRemoteLink(req) && CLOUD_GATED.has(p) && !isCloudLive()) {
      return sendJson(res, 403, {
        ok: false,
        error: '公网服务未开通或已过期，请在 App 设置页用兑换码续期'
      })
    }

    if (p === '/web') {
      return sendJson(res, 403, { ok: false, error: 'Web 控制台已关闭' })
    }

    if (p === '/pet') {
      return sendJson(res, 403, { ok: false, error: 'Web 控制台已关闭' })
    }

    if (p === '/claim' && req.method === 'POST') {
      const body = await readBody(req)
      const code = String(body.code || '').trim()

      log('[claim] 收到配对码请求 ' + req.socket.remoteAddress +
          ' 输入=' + (code ? code.slice(0, 2) + '****' : '(空)') +
          ' 当前有效码=' + (currentPairCode() ? '存在(剩' + Math.max(0, Math.round((pairExp - Date.now()) / 1000)) + 's)' : '无(空或已过期)'))

      const remoteClaim = isRemoteLink(req)
      const noteClaimFail = () => {
        if (!remoteClaim) return
        const t = Date.now()
        if (!(claimFail.resetAt > t)) claimFail = { n: 0, resetAt: t + CLAIM_FAIL_WINDOW }
        claimFail.n += 1
      }
      if (remoteClaim && claimFail.resetAt > Date.now() && claimFail.n >= CLAIM_FAIL_MAX) {
        log('[claim] ✗ 公网来源错码次数超限（' + claimFail.n + ' 次），拒绝到窗口结束')

        return sendJson(res, 429, { ok: false, error: '尝试次数过多，请稍后再试', reason: 'too-many' })
      }
      if (!/^\d{6}$/.test(code)) {
        log('[claim] ✗ 不是 6 位数字')
        noteClaimFail()

        return sendJson(res, 400, { ok: false, error: '配对码是 6 位数字', reason: 'bad-format' })
      }

      const localCodeNow = currentPairCode()
      const rpCodeNow = currentRemoteCode()
      const isLocalHit = localCodeNow !== '' && code === localCodeNow
      const isRemoteHit = rpCodeNow !== '' && code === rpCodeNow
      if (!isLocalHit && !isRemoteHit) {
        log('[claim] ✗ 码不对或已过期（用户输入前两位 ' + code.slice(0, 2) + '**，' +
            '局域网码=' + (localCodeNow ? '有' : '无') + ' 异地码=' + (rpCodeNow ? '有' : '无') + '）')
        noteClaimFail()

        return sendJson(res, 403, { ok: false, error: '配对码不对或已过期', reason: 'code-mismatch' })
      }
      claimFail = { n: 0, resetAt: 0 }
      if (isLocalHit) setPairCode('')

      if (isRemoteHit) {
        remoteCode = ''
        remoteExp = 0
        remotePubAt = 0
        remotePubErr = ''
      }
      phoneLastSeen = Date.now()

      try {
        const mpx0 = o.mp || {}
        const about0 = aboutOf(req, null)
        if (mpx0.store && typeof mpx0.store.unrevoke === 'function') {
          mpx0.store.unrevoke({ uid: String(about0.uid || ''), deviceId: '' })
          log('[claim] 已按 uid 解黑（重新配对 = 重新授权）')
        }
      } catch (e) {  }

      const hitLabel = (isLocalHit && isRemoteHit)
        ? '局域网码+异地码'
        : (isRemoteHit ? '异地码' : '局域网码')
      log('[claim] ✓ 配对成功（' + hitLabel + '），' +
          (isRemoteHit ? '异地码已核销' : '码已核销'))
      const d = await panelData(false)
      return sendJson(res, 200, {
        ok: true, token: d.token, base: d.base, name: d.name,

        c: d.cloud,
        note: '配对成功。这个码已作废。'
      })
    }

    if (p === '/pair/ticket' && req.method === 'POST') {
      const body = await readBody(req)
      const ticket = String(body.ticket || '').trim()

      log('[pair/ticket] 收到票据请求 ' + req.socket.remoteAddress +
          ' 带票=' + (ticket ? '是' : '否(空)') +
          ' 当前有效票=' + (currentPairTicket() ? '存在(剩' + Math.max(0, Math.round((pairTicketExp - Date.now()) / 1000)) + 's)' : '无(空或已过期)'))
      if (!/^pt_[0-9a-f]{32}$/.test(ticket) || ticket !== currentPairTicket()) {
        log('[pair/ticket] ✗ 票无效或已过期')
        return sendJson(res, 403, { ok: false, error: '配对票据无效或已过期' })
      }
      clearPairTicket()
      phoneLastSeen = Date.now()

      try {
        const mpx0 = o.mp || {}
        const about0 = aboutOf(req, null)
        if (mpx0.store && typeof mpx0.store.unrevoke === 'function') {
          mpx0.store.unrevoke({ uid: String(about0.uid || ''), deviceId: '' })
          log('[pair/ticket] 已按 uid 解黑（重新扫码 = 重新授权）')
        }
      } catch (e) {  }
      log('[pair/ticket] ✓ 票据换取访问码成功，票已作废')
      const d = await panelData(false)
      return sendJson(res, 200, {
        ok: true, token: d.token, base: d.base, name: d.name,

        c: d.cloud
      })
    }

    if (p === '/qr') {
      const dataUrl = await qrDataUrl((await panelData(false)).payload, { width: 360 })
      if (!dataUrl) return sendJson(res, 500, { ok: false, error: '二维码生成失败' })
      const buf = Buffer.from(String(dataUrl).split(',')[1] || '', 'base64')
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      })
      return res.end(buf)
    }

    if (p === '/newcode') {
      setPairCode('')
      clearPairTicket()
      const d = await panelData(true)
      return sendJson(res, 200, { ok: true, code: d.code, payload: d.payload, qrDataUrl: d.qrDataUrl })
    }

    if (tokenOf(req, url) !== o.getToken()) {
      return sendJson(res, 401, { ok: false, error: '访问码不对' })
    }

    {

      const gateEnv = String(process.env.DSH_DEVICE_GATE || '').trim().toLowerCase()
      const deviceGateOn = (gateEnv === 'on' || gateEnv === '1' || gateEnv === 'true')
      const deviceGateOff = !deviceGateOn

      const isCloudOp = (p === '/cloud/status' || p === '/cloud/bind' || p === '/cloud/redeem')
      if (!deviceGateOff && !isCloudOp) {
        try {
          const devSecret = cookieValue(req.headers.cookie)
          const devStore = o.mp && o.mp.store
          if (devSecret !== '' && devStore && typeof devStore.isRevoked === 'function') {

            if (devStore.isRevoked({ secret: devSecret, uid: '', deviceId: '' })) {
              log('[device-gate] 已撤销设备被拦：' + p)
              return sendJson(res, 403, { ok: false, error: 'device-revoked' })
            }
          }
        } catch (e) {

        }
      }
    }

    try {
      if (p === '/info') {
        phoneLastSeen = Date.now()
        noteDevice(req)

        const roster = rosterCounts()

        const subFlag = linkSubscribed()
        const linkExtra = typeof subFlag === 'boolean' ? { linkSubscribed: subFlag } : {}

        const rpCode = ensureRemoteCode()
        const rpLeft = rpCode ? Math.max(0, remoteExp - Date.now()) : 0
        const rpErr = rpCode ? remotePubErr : ''

        return sendJson(res, 200, Object.assign({ ok: true }, safeInfo(), {
          devices: roster.devices,
          deviceCount: roster.deviceCount,
          onlineCount: roster.onlineCount,
          tunnel: tunnelNow(),

          publicUrls: publicUrlsNow(),

          ...linkState(),

          cloud: cloudView(),

          remotePairCode: rpCode,
          remotePairCodeLeftMs: rpLeft,
          remotePairCodeErr: rpErr
        }, linkExtra))
      }

      if (p === '/cloud/status' && req.method === 'GET') {
        phoneLastSeen = Date.now()
        noteDevice(req)
        const c = cloudMod()
        if (!c || typeof c.snapshot !== 'function') {
          return sendJson(res, 503, { ok: false, error: '云端不可用' })
        }
        return sendJson(res, 200, cloudStatusBody())
      }
      if (p === '/cloud/bind' && req.method === 'POST') {
        const c = cloudMod()
        if (!c || typeof c.bind !== 'function') {
          return sendJson(res, 503, { ok: false, error: '云端不可用' })
        }
        phoneLastSeen = Date.now()
        noteDevice(req)

        let body = {}
        try { body = await readBody(req, 64 * 1024) || {} } catch (e) { body = {} }
        let out = null
        try {
          out = await c.bind({ uid: body.uid, name: body.name, avatar: body.avatar })
        } catch (e) { out = null }
        if (!out || typeof out !== 'object' || out.ok !== true) {
          return sendJson(res, 200, { ok: false, error: cloudErr(out && out.error) })
        }
        return sendJson(res, 200, {
          ok: true,
          shortId: typeof out.shortId === 'string' ? out.shortId : '',
          vipExpireMs: cloudNum(out.vipExpireMs)
        })
      }
      if (p === '/cloud/redeem' && req.method === 'POST') {
        const c = cloudMod()
        if (!c || typeof c.redeem !== 'function') {
          return sendJson(res, 503, { ok: false, error: '云端不可用' })
        }
        phoneLastSeen = Date.now()
        noteDevice(req)
        let body = {}
        try { body = await readBody(req, 16 * 1024) || {} } catch (e) { body = {} }
        const code = typeof body.code === 'string' ? body.code.trim() : ''
        let out = null
        try { out = await c.redeem(code) } catch (e) { out = null }
        if (!out || typeof out !== 'object' || out.ok !== true) {

          return sendJson(res, 200, { ok: false, error: cloudErr(out && out.error) })
        }
        return sendJson(res, 200, {
          ok: true,
          addedDays: cloudNum(out.addedDays),
          vipExpireMs: cloudNum(out.vipExpireMs),
          shortId: typeof out.shortId === 'string' ? out.shortId : ''
        })
      }

      if (p === '/mp-cookie') {
        phoneLastSeen = Date.now()
        noteDevice(req)
        const mpx = o.mp || {}

        const about = aboutOf(req, null)

        const revokeEnv = String(process.env.DSH_DEVICE_GATE || '').trim().toLowerCase()
        const revokeGateOn = (revokeEnv === 'on' || revokeEnv === '1' || revokeEnv === 'true')
        if (revokeGateOn && mpx.store && typeof mpx.store.isRevoked === 'function') {
          let phoneSecret = ''
          try { phoneSecret = cookieValue(req.headers.cookie) } catch (e) { phoneSecret = '' }
          if (mpx.store.isRevoked({ secret: phoneSecret, uid: about.uid, deviceId: '' })) {
            return sendJson(res, 403, { ok: false, error: 'device-revoked' })
          }
        }
        let cookie = ''
        if (typeof mpx.issueDevice === 'function') {
          cookie = mpx.issueDevice(about)
        } else if (typeof mpx.issueForCode === 'function') {
          cookie = mpx.issueForCode(currentPairCode(), about)
        } else {
          return sendJson(res, 501, { ok: false, error: 'mp 未启用' })
        }
        if (!cookie) { return sendJson(res, 409, { ok: false, error: '签发失败，请重启 DSH 后重试' }) }
        return sendJson(res, 200, { ok: true, cookie })
      }
      if (p === '/sessions') {
        phoneLastSeen = Date.now()
        noteDevice(req)
        const list = await o.listSessions()
        return sendJson(res, 200, { ok: true, count: list.length, sessions: list })
      }

      if (p === '/attachment' && req.method === 'GET') {
        const id = String(url.searchParams.get('id') || '').trim()
        if (!id) return sendJson(res, 404, { ok: false, error: 'no-such-attachment' })
        phoneLastSeen = Date.now()
        noteDevice(req)
        let got = null
        try {
          got = typeof o.attachmentOf === 'function' ? await o.attachmentOf(id) : null
        } catch (e) {
          log('[attachment] 读附件出错 ' + id + ': ' + ((e && e.message) || e))
          got = null
        }
        if (!got || !got.data) return sendJson(res, 404, { ok: false, error: 'no-such-attachment' })
        const buf = Buffer.isBuffer(got.data) ? got.data : Buffer.from(got.data)
        if (!buf.length) return sendJson(res, 404, { ok: false, error: 'no-such-attachment' })
        res.writeHead(200, {
          'Content-Type': got.mime || 'application/octet-stream',
          'Content-Length': buf.length,
          'Cache-Control': 'private, max-age=86400, immutable',
          'Access-Control-Allow-Origin': '*'
        })
        return res.end(buf)
      }
      if (p === '/cmd' && req.method === 'POST') {

        const body = await readBody(req, 36e6)
        const op = String(body.op || '')
        if (!op) return sendJson(res, 400, { ok: false, error: '缺少 op' })
        return sendJson(res, 200, { ok: true, result: await o.runCommand(op, body.payload || {}) })
      }
      return sendJson(res, 404, { ok: false, error: '未知路径 /dsh-console' + p })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) })
    }
  }

  return {
    start() {
      return new Promise((resolve) => {
        const basePort = Number(o.port) || 8899
        let tries = 0
        const attempt = (port) => {
          tries += 1
          server = http.createServer((req, res) => {
            handler(req, res).catch(() => {
              try { sendJson(res, 500, { ok: false, error: '内部错误' }) } catch (e) {  }
            })
          })

          if (o.mp && typeof o.mp.onUpgrade === 'function') {
            server.on('upgrade', o.mp.onUpgrade)
          }
          server.on('error', (e) => {
            try { server.close() } catch (x) {  }
            server = null
            if (e && e.code === 'EADDRINUSE' && tries < MAX_TRIES) {

              if (!o.allowShift) {
                log('⚠ 端口 ' + port + ' 被占用。')
                log('  手机只认 8899，请关掉占用它的程序（多半是旧的 dsh-console 实例）再重启 DSH。')
                log('  确实要换端口：给插件配置加 "port": 8900，并让手机端同步改。')
                resolve(null)
                return
              }
              log('  端口 ' + port + ' 被占用，换一个…')
              setTimeout(() => attempt(port + 1), 120)
              return
            }
            log('⚠ 局域网服务起不来：' + ((e && e.message) || e))
            resolve(null)
          })
          server.listen(port, '0.0.0.0', () => {
            const addr = server.address()
            boundPort = (addr && addr.port) || port
            boundPortRef.value = boundPort
            const urls = lanUrls(boundPort)
            const code = ensurePairCode()
            log('  ── 扫码连接已就绪 ──')
            if (!urls.length) log('  ⚠ 没找到局域网 IP。确认电脑连着 WiFi/网线。')
            log('  配对码：' + code)
            if (boundPort !== basePort) log('  （端口自动换成了 ' + boundPort + '）')
            if (o.mp && typeof o.mp.onUpgrade === 'function') {
              log('  鸿蒙客户端：' + (urls[0] || '?') + '/mp  （配对码换 Cookie 后可用）')
            }
            resolve({ port: boundPort, urls, code })
          })
        }
        attempt(basePort)
      })
    },
    stop() {
      if (server) { try { server.close() } catch (e) {  } }
      server = null
      boundPortRef.value = 0
    },
    get port() { return boundPort },
    get urls() { return lanUrls(boundPort) },
    getPairCode() { return ensurePairCode() },
    peekPairCode() { return currentPairCode() },
    getPhoneLastSeen() { return phoneLastSeen },

    getRemotePair() { return remotePairOn() },

    ensureRemoteCode,
    peekRemoteCode() { return remoteCode },

    refreshRemoteCode() {
      remoteCode = ''
      remoteExp = 0
      remotePubAt = 0
      remotePubErr = ''
      return ensureRemoteCode()
    },

    remoteCodeLeftMs() { return remoteCode ? Math.max(0, remoteExp - Date.now()) : 0 },

    noteStreamLink,

    setMp(mp) { o.mp = mp || null },

    setTunnel(fn) { o.tunnelStatus = typeof fn === 'function' ? fn : null },
    panelData
  }
}

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const PET_DIR_CANDIDATES = [
  process.env.DSH_CONSOLE_PET_DIR,
  join(PLUGIN_DIR, '..', 'assets'),
  'D:/dsh-console-hm/images'
].filter((d) => typeof d === 'string' && d !== '')

function petPath(fileName) {
  let first = null
  for (const dir of PET_DIR_CANDIDATES) {
    const p = dir + '/' + fileName
    try { if (fs.existsSync(p)) return p } catch (e) {  }
    if (first === null) first = dir
  }

  return (first === null ? 'D:/dsh-console-hm/images' : first) + '/' + fileName
}

function sendPet(res, theme, o) {
  const configured = theme === 'light'
    ? (o && o.petLightPath)
    : (o && o.petDarkPath)
  const file = configured || petPath(theme === 'light' ? 'pet.png' : 'pet-dark.png')
  try {
    const buf = fs.readFileSync(file)
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(buf)
  } catch (e) {

    const transparent = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': transparent.length,
      'Cache-Control': 'no-store'
    })
    res.end(transparent)
  }
}
