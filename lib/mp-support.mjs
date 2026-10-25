import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMpBranch, mountMpUpgrade } from './mp-routes.mjs'
import { createDispatcher } from './mp-dispatch.mjs'
import { createLiveUpgrade } from './mp-ws-live.mjs'
import {
  approvalFrame, mergePending, pendingSnapshot, questionFrame,
} from './mp-contract.mjs'

const DEVICE_ONLINE_TTL = 10 * 60 * 1000

const REVOKED_VERSION = 1
let revokedTestSeq = 0

function plainTxt(v) { return String(v == null ? '' : v).trim() }

function resolveRevokedPath(deps) {
  const explicit = plainTxt(deps && deps.revokedPath)
    || plainTxt(process.env && process.env.DSH_CONSOLE_REVOKED_FILE)
  if (explicit !== '') return explicit
  if (process.env && process.env.NODE_TEST_CONTEXT) {
    return path.join(os.tmpdir(),
      'dsh-console-revoked-test-' + process.pid + '-' + (revokedTestSeq++) + '.json')
  }
  return path.join(os.homedir(), '.dsh', 'dsh-console-revoked.json')
}

function revokedEmpty() {
  return { version: REVOKED_VERSION, updatedMs: 0, deviceIds: [], secrets: [], uids: [], entries: [] }
}

function strList(v) {
  if (!Array.isArray(v)) return []
  const seen = new Set()
  const out = []
  for (const x of v) {
    const s = plainTxt(x)
    if (s === '' || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

function readRevoked(file) {
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) { return revokedEmpty() }
  let j = null
  try { j = JSON.parse(raw) } catch (e) { return revokedEmpty() }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return revokedEmpty()
  const entries = []
  if (Array.isArray(j.entries)) {
    for (const e of j.entries) {
      if (!e || typeof e !== 'object') continue
      entries.push({
        deviceId: plainTxt(e.deviceId),
        uid: plainTxt(e.uid),
        secrets: strList(e.secrets),
        revokedMs: Number(e.revokedMs) || 0,
      })
    }
  }
  return {
    version: REVOKED_VERSION,
    updatedMs: Number(j.updatedMs) || 0,
    deviceIds: strList(j.deviceIds),
    secrets: strList(j.secrets),
    uids: strList(j.uids),
    entries,
  }
}

function writeRevoked(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
    return true
  } catch (e) { return false }
}

const DEVICES_VERSION = 1
let devicesTestSeq = 0

function resolveDevicesPath(deps) {
  const explicit = plainTxt(deps && deps.devicesPath)
    || plainTxt(process.env && process.env.DSH_CONSOLE_DEVICES_FILE)
  if (explicit !== '') return explicit
  if (process.env && process.env.NODE_TEST_CONTEXT) {
    return path.join(os.tmpdir(),
      'dsh-console-devices-test-' + process.pid + '-' + (devicesTestSeq++) + '.json')
  }
  return path.join(os.homedir(), '.dsh', 'dsh-console-devices.json')
}

function devicesEmpty() {
  return { version: DEVICES_VERSION, updatedMs: 0, records: [] }
}

function deviceRecFromJson(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const deviceId = plainTxt(r.deviceId)
  const secrets = strList(r.secrets)
  if (deviceId === '' || secrets.length === 0) return null
  return {
    deviceId,
    secrets,
    model: plainTxt(r.model).slice(0, 80),
    name: plainTxt(r.name).slice(0, 80),
    pairedAt: Number(r.pairedAt) || 0,
    lastSeen: Number(r.lastSeen) || 0,
    uid: plainTxt(r.uid).slice(0, 120),
    cloudUid: plainTxt(r.cloudUid).slice(0, 120),
    pubId: plainTxt(r.pubId).slice(0, 120),
    account: plainTxt(r.account).slice(0, 80),
    nickName: plainTxt(r.nickName).slice(0, 80),
    selfAccountUid: plainTxt(r.selfAccountUid).slice(0, 120),
    selfAccountName: plainTxt(r.selfAccountName).slice(0, 80),
  }
}

function readDevices(file) {
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) { return devicesEmpty() }
  let j = null
  try { j = JSON.parse(raw) } catch (e) { return devicesEmpty() }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return devicesEmpty()
  if (j.version !== DEVICES_VERSION) return devicesEmpty()
  const records = []
  if (Array.isArray(j.records)) {
    for (const r of j.records) {
      const rec = deviceRecFromJson(r)
      if (rec) records.push(rec)
    }
  }
  return { version: DEVICES_VERSION, updatedMs: Number(j.updatedMs) || 0, records }
}

function writeDevices(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
    return true
  } catch (e) { return false }
}

export function createDeviceStore(deps) {

  const ID_MAX = 120
  const ACC_MAX = 80

  let identityFn = (deps && typeof deps.identity === 'function') ? deps.identity : null

  const devices = new Map()

  const devicesFile = resolveDevicesPath(deps)
  let devicesDirtyMs = 0

  const revokedFile = resolveRevokedPath(deps)
  let revoked = readRevoked(revokedFile)
  const revokedDeviceId = (v) => { const s = plainTxt(v); return s !== '' && revoked.deviceIds.indexOf(s) >= 0 }
  const revokedSecret = (v) => { const s = plainTxt(v); return s !== '' && revoked.secrets.indexOf(s) >= 0 }
  const revokedUid = (v) => { const s = plainTxt(v); return s !== '' && revoked.uids.indexOf(s) >= 0 }

  function reloadRevoked() { revoked = readRevoked(revokedFile); return revoked }
  function persistRevoked() {
    revoked.updatedMs = Date.now()
    return writeRevoked(revokedFile, revoked)
  }

  function secretsOfDevice(deviceId) {
    const want = plainTxt(deviceId)
    const out = []
    if (want === '') return out
    for (const [sec, rec] of devices) {
      if (plainTxt(rec && rec.deviceId) === want) out.push(sec)
    }
    return out
  }

  function markRevoked(deviceId, uid, secrets) {
    const dev = plainTxt(deviceId)
    const u = plainTxt(uid)
    const secs = strList(secrets)
    let ent = null
    for (const e of revoked.entries) {
      if (e.deviceId === dev && dev !== '') { ent = e; break }
    }
    if (!ent && u !== '') {
      for (const e of revoked.entries) {
        if (e.uid === u) { ent = e; break }
      }
    }
    if (!ent) {
      ent = { deviceId: dev, uid: u, secrets: [], revokedMs: Date.now() }
      revoked.entries.push(ent)
    }
    if (dev !== '' && ent.deviceId === '') ent.deviceId = dev
    if (u !== '' && ent.uid === '') ent.uid = u
    if (dev !== '' && revoked.deviceIds.indexOf(dev) < 0) revoked.deviceIds.push(dev)
    if (u !== '' && revoked.uids.indexOf(u) < 0) revoked.uids.push(u)
    for (const s of secs) {
      if (ent.secrets.indexOf(s) < 0) ent.secrets.push(s)
      if (revoked.secrets.indexOf(s) < 0) revoked.secrets.push(s)
    }

    persistDevices(true)
    return persistRevoked()
  }

  function clearRevoked(deviceId, uid) {
    const dev = plainTxt(deviceId)
    const u = plainTxt(uid)
    const secs = []

    const devs = []
    for (const e of revoked.entries) {
      const hit = (dev !== '' && e.deviceId === dev) || (u !== '' && e.uid === u)
      if (!hit) continue
      if (e.deviceId !== '' && devs.indexOf(e.deviceId) < 0) devs.push(e.deviceId)
      for (const s of e.secrets) if (secs.indexOf(s) < 0) secs.push(s)
    }
    for (const s of secretsOfDevice(dev)) if (secs.indexOf(s) < 0) secs.push(s)
    for (const d of devs) revoked.deviceIds = revoked.deviceIds.filter((x) => x !== d)
    const rm = (arr, v) => arr.filter((x) => x !== v)
    if (dev !== '') { revoked.deviceIds = rm(revoked.deviceIds, dev) }
    for (const d of devs) revoked.deviceIds = rm(revoked.deviceIds, d)
    if (u !== '') { revoked.uids = rm(revoked.uids, u) }
    for (const s of secs) revoked.secrets = rm(revoked.secrets, s)
    revoked.entries = revoked.entries.filter((e) => !((dev !== '' && e.deviceId === dev) || (u !== '' && e.uid === u)))

    persistDevices(true)
    return persistRevoked()
  }

  const DEVICES_WRITE_MIN_MS = 5000

  function deviceRecords() {
    const seen = new Set()
    const records = []
    for (const [sec, rec] of devices) {
      if (!rec || seen.has(rec)) continue
      seen.add(rec)
      const secrets = []
      for (const [s2, r2] of devices) {
        if (r2 === rec) secrets.push(s2)
      }
      records.push({
        deviceId: String(rec.deviceId || ''),
        secrets,
        model: String(rec.model || ''),
        name: String(rec.name || ''),
        pairedAt: Number(rec.pairedAt) || 0,
        lastSeen: Number(rec.lastSeen) || 0,
        uid: String(rec.uid || ''),
        cloudUid: String(rec.cloudUid || ''),
        pubId: String(rec.pubId || ''),
        account: String(rec.account || ''),
        nickName: String(rec.nickName || ''),
        selfAccountUid: String(rec.selfAccountUid || ''),
        selfAccountName: String(rec.selfAccountName || ''),
      })
    }
    return records
  }

  function persistDevices(force) {
    const now = Date.now()
    if (!force && now - devicesDirtyMs < DEVICES_WRITE_MIN_MS) return false
    devicesDirtyMs = now
    return writeDevices(devicesFile, {
      version: DEVICES_VERSION, updatedMs: now, records: deviceRecords(),
    })
  }

  function restoreDevices() {
    const data = readDevices(devicesFile)
    let restored = 0
    for (const r of data.records) {
      const dev = plainTxt(r.deviceId)
      if (dev === '' || revokedDeviceId(dev)) continue
      const secrets = r.secrets.filter((s) => !revokedSecret(s))
      if (secrets.length === 0) continue
      let rec = null
      for (const [, d] of devices) {
        if (d && d !== null && plainTxt(d.deviceId) === dev) { rec = d; break }
      }
      if (!rec) {
        rec = {
          deviceId: dev, model: r.model, name: r.name,
          pairedAt: Number(r.pairedAt) || 0, lastSeen: Number(r.lastSeen) || 0,
          uid: r.uid, cloudUid: r.cloudUid, pubId: r.pubId,
          account: r.account, nickName: r.nickName,
          selfAccountUid: r.selfAccountUid, selfAccountName: r.selfAccountName,
        }
      } else {
        if (!rec.model && r.model) rec.model = r.model
        if (!rec.name && r.name) rec.name = r.name
        fillIdentity(rec, r)
        if ((Number(r.lastSeen) || 0) > (Number(rec.lastSeen) || 0)) rec.lastSeen = Number(r.lastSeen) || 0
        const p = Number(r.pairedAt) || 0
        if (p > 0 && (!(Number(rec.pairedAt) || 0) || p < (Number(rec.pairedAt) || 0))) rec.pairedAt = p
      }
      for (const s of secrets) devices.set(s, rec)
      restored += 1
    }
    return restored
  }

  restoreDevices()

  function txt(v, max) { const s = String(v == null ? '' : v).trim(); return s === '' ? '' : s.slice(0, max) }

  function identityKey(uid) { const u = txt(uid, ID_MAX); return u === '' ? '' : 'u:' + u }

  function identityFrom(about, base) {
    const b = about || {}
    const ext = base || null
    const cloudUid = txt(b.cloudUid, ID_MAX) || txt(ext && (ext.cloudUid || ext.uid), ID_MAX)
    return {
      uid: txt(b.uid, ID_MAX),
      cloudUid,
      pubId: txt(b.pubId || b.shortId, ID_MAX) || txt(ext && (ext.pubId || ext.shortId), ID_MAX),
      account: txt(b.account || b.nickName, ACC_MAX) || txt(ext && (ext.account || ext.name), ACC_MAX),
      nickName: txt(b.nickName || b.account || ext && ext.name, ACC_MAX),

      selfAccountUid: txt(b.accountUid, ID_MAX),
      selfAccountName: txt(b.accountName, ACC_MAX)
    }
  }

  function currentIdentity() {
    if (typeof identityFn !== 'function') return null
    try {
      const r = identityFn()
      if (!r || typeof r !== 'object') return null
      const id = identityFrom({}, r)
      return (id.cloudUid === '' && id.pubId === '' && id.account === '') ? null : id
    } catch (e) { return null }
  }

  function fillIdentity(rec, id) {
    if (!rec || !id) return rec
    if (!rec.uid && id.uid) rec.uid = id.uid
    if (!rec.cloudUid && id.cloudUid) rec.cloudUid = id.cloudUid
    if (!rec.pubId && id.pubId) rec.pubId = id.pubId
    if (!rec.account && id.account) rec.account = id.account
    if (!rec.nickName && id.nickName) rec.nickName = id.nickName

    if (!rec.selfAccountUid && id.selfAccountUid) rec.selfAccountUid = id.selfAccountUid
    if (!rec.selfAccountName && id.selfAccountName) rec.selfAccountName = id.selfAccountName
    return rec
  }

  function mergeInto(target, src) {
    if (!target || !src || target === src) return
    if (!target.model && src.model) target.model = src.model
    if (!target.name && src.name) target.name = src.name
    fillIdentity(target, src)
    const ts = Number(target.lastSeen) || 0
    const ss = Number(src.lastSeen) || 0
    if (ss > ts) target.lastSeen = ss
    const tp = Number(target.pairedAt) || 0
    const sp = Number(src.pairedAt) || 0
    if (sp > 0 && (tp === 0 || sp < tp)) target.pairedAt = sp
  }

  function mergeSameIdentity(target) {
    const key = identityKey(target && target.uid)
    if (key === '') return
    const losers = []
    for (const [sec, rec] of devices) {
      if (rec !== target && identityKey(rec.uid) === key) losers.push([sec, rec])
    }
    for (const [sec, rec] of losers) {
      mergeInto(target, rec)
      devices.set(sec, target)
    }
  }

  function aliasTo(from, to) {
    if (!from || !to || from === to) return
    for (const [sec, rec] of devices) {
      if (rec === from) devices.set(sec, to)
    }
  }

  function findByIdentity(uid) {
    const key = identityKey(uid)
    if (key === '') return null
    let best = null
    for (const rec of devices.values()) {
      if (identityKey(rec.uid) !== key) continue
      if (!best || (Number(rec.lastSeen) || 0) > (Number(best.lastSeen) || 0)) best = rec
    }
    return best
  }

  function mint(about) {

    const guard = identityFrom(about, null)
    if (guard.uid !== '') {
      let hitRec = null
      for (const rec of devices.values()) {
        if (plainTxt(rec && rec.uid) === guard.uid) { hitRec = rec; break }
      }
      if (revokedUid(guard.uid) || (hitRec && revokedDeviceId(hitRec.deviceId))) return null
    }
    const secret = crypto.randomBytes(24).toString('hex')
    const deviceId = 'mp-' + secret.slice(0, 8)
    const now = Date.now()
    const model = String((about && about.model) || '').slice(0, 80)
    const name = String((about && about.name) || '').slice(0, 80)
    const id = identityFrom(about, currentIdentity())

    if (id.uid !== '') {
      const canon = findByIdentity(id.uid)
      if (canon) {
        fillIdentity(canon, id)
        canon.lastSeen = now
        devices.set(secret, canon)
        mergeSameIdentity(canon)

        persistDevices(true)
        return { secret, deviceId: canon.deviceId }
      }
    }
    const rec = {
      deviceId, model, name, pairedAt: now, lastSeen: now,
      uid: id.uid, cloudUid: id.cloudUid, pubId: id.pubId, account: id.account, nickName: id.nickName,

      selfAccountUid: id.selfAccountUid, selfAccountName: id.selfAccountName
    }
    devices.set(secret, rec)

    mergeSameIdentity(rec)

    persistDevices(true)
    return { secret, deviceId }
  }

  return {

    exchange(token, about) {
      const t = String(token || '').trim()

      if (!/^\d{6}$/.test(t)) return null

      const id = identityFrom(about, null)
      let hitRec = null
      if (id.uid !== '') {
        for (const rec of devices.values()) {
          if (plainTxt(rec && rec.uid) === id.uid) { hitRec = rec; break }
        }
      }

      clearRevoked(hitRec ? hitRec.deviceId : '', id.uid)

      clearRevoked('', id.uid)
      return mint(about)
    },

    mint,
    isPaired(secret) {
      return devices.has(String(secret || ''))
    },
    revoke(secret) {
      devices.delete(String(secret || ''))

      persistDevices(true)
    },

    revokeUid(uid) {
      const want = String(uid == null ? '' : uid).trim()
      if (want === '') return 0
      let removed = 0

      for (const [sec, rec] of devices) {
        if (String((rec && rec.uid) || '') === want) {
          devices.delete(sec)
          removed += 1
        }
      }

      if (removed > 0) persistDevices(true)
      return removed
    },

    revokeDevice(deviceId) {
      const want = String(deviceId == null ? '' : deviceId).trim()
      if (want === '') return 0
      let removed = 0
      const hitSecs = []
      let hitUid = ''

      for (const [sec, rec] of devices) {
        if (String((rec && rec.deviceId) || '') === want) {
          devices.delete(sec)
          hitSecs.push(sec)
          if (hitUid === '' && rec && rec.uid) hitUid = String(rec.uid)
          removed += 1
        }
      }

      if (removed > 0) markRevoked(want, hitUid, hitSecs)
      return removed
    },

    unrevoke(q) {
      try {
        const o = q || {}
        const dev = plainTxt(o.deviceId)
        const u = plainTxt(o.uid)
        if (dev === '' && u === '') return false
        clearRevoked(dev, u)

        return true
      } catch (e) {
        return false
      }
    },

    isRevoked(q) {
      const o = q || {}
      reloadRevoked()
      if (revokedSecret(o.secret)) return true
      if (revokedDeviceId(o.deviceId)) return true
      const u = plainTxt(o.uid)
      if (u === '') return false
      if (revokedUid(u)) return true
      let rec = null
      for (const d of devices.values()) {
        if (plainTxt(d && d.uid) === u) { rec = d; break }
      }
      return !!(rec && revokedDeviceId(rec.deviceId))
    },

    touch(secret, about) {
      const k = String(secret || '')
      if (k === '') return false
      const d = devices.get(k)
      if (!d) return false

      if (revokedSecret(k) || revokedDeviceId(d.deviceId)) return false
      d.lastSeen = Date.now()
      if (about) {
        if (!d.model && about.model) d.model = String(about.model).slice(0, 80)
        if (!d.name && about.name) d.name = String(about.name).slice(0, 80)
      }

      fillIdentity(d, identityFrom(about, currentIdentity()))
      mergeSameIdentity(d)

      persistDevices(false)
      return true
    },

    list() {
      const now = Date.now()
      const out = []
      const seen = new Set()

      const byKey = new Map()
      for (const [sec, d] of devices) {
        if (seen.has(d)) continue

        if (revokedDeviceId(d.deviceId) || revokedSecret(sec)) continue
        seen.add(d)
        const key = identityKey(d.uid)
        if (key === '') { out.push(d); continue }
        const prev = byKey.get(key)
        if (!prev || (Number(d.lastSeen) || 0) > (Number(prev.lastSeen) || 0)) byKey.set(key, d)
      }
      for (const d of byKey.values()) out.push(d)

      const hasUid = (u) => txt(u, ID_MAX) !== ''
      let mergedRec = false
      const byDev = new Map()
      const kept = []
      for (const d of out) {
        const devId = String(d.deviceId || '')
        if (devId === '') { kept.push(d); continue }
        const prev = byDev.get(devId)
        if (!prev) { byDev.set(devId, d); kept.push(d); continue }

        if (!hasUid(d.uid) && hasUid(prev.uid)) {
          mergeInto(prev, d); aliasTo(d, prev); mergedRec = true; continue
        }
        if (hasUid(d.uid) && !hasUid(prev.uid)) {
          mergeInto(d, prev); aliasTo(prev, d); mergedRec = true
          const i = kept.indexOf(prev)
          if (i >= 0) kept[i] = d
          byDev.set(devId, d)
          continue
        }

        kept.push(d)
      }
      const rows = kept.map((d) => ({
        deviceId: String(d.deviceId || ''),
        model: String(d.model || ''),
        name: String(d.name || ''),
        pairedAt: Number(d.pairedAt) || 0,
        lastSeen: Number(d.lastSeen) || 0,
        online: (now - (Number(d.lastSeen) || 0)) < DEVICE_ONLINE_TTL,

        uid: String(d.uid || ''),
        cloudUid: String(d.cloudUid || ''),
        pubId: String(d.pubId || ''),
        account: String(d.account || d.nickName || ''),

        accountUid: String(d.selfAccountUid || ''),
        accountName: String(d.selfAccountName || '')
      }))
      rows.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || b.lastSeen - a.lastSeen)

      if (mergedRec) persistDevices(false)
      return rows
    },

    setIdentity(fn) {
      identityFn = typeof fn === 'function' ? fn : null
      return typeof identityFn === 'function'
    },
    get size() { return devices.size },
  }
}

const PENDING_TTL_MS = (() => {
  const raw = process.env && process.env.DSH_MP_PENDING_TTL_MS
  const n = Number(raw)
  return (typeof raw === 'string' && raw !== '' && Number.isFinite(n) && n >= 0)
    ? n
    : 10 * 60 * 1000
})()

const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

export function approvalOutcomeOf(body) {
  const raw = String((body && body.outcome) || '').trim().toLowerCase()
  if (raw === 'allow' || raw === 'allowed' || raw === 'allowed-once') return 'allowed-once'
  if (raw === 'deny' || raw === 'denied' || raw === 'reject' || raw === 'rejected') return 'rejected'
  if (raw.indexOf('cancel') === 0) return 'cancelled'
  return 'unavailable'
}

function normalizeApprovalOutcome(value) {
  return APPROVAL_OUTCOMES.indexOf(value) >= 0 ? value : 'unavailable'
}

export function createPendingTracker() {

  const approvals = new Map()
  const questions = new Map()
  let seq = 0

  const slotsOf = (kind) => (kind === 'question' ? questions : approvals)

  const fallbackOf = (kind) => (kind === 'question' ? { answers: [] } : 'unavailable')

  function settle(kind, id, value) {
    const slots = slotsOf(kind)
    const slot = slots.get(id)
    if (slot === undefined) return false
    slots.delete(id)
    if (slot.timer) {
      try { clearTimeout(slot.timer) } catch (e) {  }
      slot.timer = null
    }
    if (typeof slot.resolve === 'function') {
      const fn = slot.resolve
      slot.resolve = null
      try { fn(value) } catch (e) {  }
    }
    return true
  }

  function register(kind, id, frame) {

    if (slotsOf(kind).has(id)) settle(kind, id, fallbackOf(kind))
    slotsOf(kind).set(id, { frame, resolve: null, timer: null })
    const slot = slotsOf(kind).get(id)
    if (PENDING_TTL_MS > 0) {
      slot.timer = setTimeout(() => { settle(kind, id, fallbackOf(kind)) }, PENDING_TTL_MS)

      if (slot.timer && typeof slot.timer.unref === 'function') slot.timer.unref()
    }
    return id
  }

  return {

    addApproval(req) {
      const f = approvalFrame(req)

      const declared = String((req && (req.approvalId || req.id)) || '')
      const callId = String((req && req.callId) || '')
      const id = declared !== ''
        ? declared
        : (callId !== ''
          ? callId
          : 'ap-' + String((req && req.toolName) || 'tool') + '-' + (++seq))
      f.approvalId = id
      return register('approval', id, f)
    },

    addQuestion(req) {
      const f = questionFrame(req)

      const wait = req && req.wait

      const raw = String((req && req.rpcId) || (wait && wait.callId) || '')
      const id = raw !== '' ? raw : 'q-' + (++seq)
      f.rpcId = id
      return register('question', id, f)
    },

    attachResolve(id, resolve, kind) {
      const key = String(id || '')
      if (key === '' || typeof resolve !== 'function') return false
      let slot = null
      if (kind === 'question') slot = questions.get(key)
      else if (kind === 'approval') slot = approvals.get(key)
      else slot = approvals.get(key) || questions.get(key)
      if (!slot) return false
      slot.resolve = resolve
      return true
    },

    list() {
      return {
        approvals: [...approvals.values()].map((s) => s.frame),
        questions: [...questions.values()].map((s) => s.frame),
      }
    },

    snapshot() {
      return pendingSnapshot({
        list: () => [...approvals.values()].map((s) => s.frame),
        questions: () => [...questions.values()].map((s) => s.frame),
      })
    },

    resolveApproval(body) {
      const id = String((body && body.approvalId) || '')
      const outcome = approvalOutcomeOf(body)
      const existed = settle('approval', id, outcome)
      return { ok: true, resolved: existed, approvalId: id, outcome }
    },
    resolveQuestion(body) {
      const id = String((body && (body.rpcId || body.id)) || '')
      const answers = Array.isArray(body && body.answers) ? body.answers : []

      const existed = settle('question', id, { answers })
      return { ok: true, resolved: existed, rpcId: id }
    },

    takeApproval(approvalId) {
      const slot = approvals.get(String(approvalId || ''))
      return slot ? slot.frame : null
    },
    takeQuestion(rpcId) {
      const slot = questions.get(String(rpcId || ''))
      return slot ? slot.frame : null
    },
    get counts() {
      return { approvals: approvals.size, questions: questions.size }
    },

    dispose() {
      for (const id of [...approvals.keys()]) settle('approval', id, fallbackOf('approval'))
      for (const id of [...questions.keys()]) settle('question', id, fallbackOf('question'))
    },
  }
}

export function subscribeHostEvents(ctx, tracker, log) {
  const disposers = []
  const on = (evt, fn, options) => {
    if (typeof ctx.on !== 'function') return
    try {
      const d = options === undefined ? ctx.on(evt, fn) : ctx.on(evt, fn, options)
      if (typeof d === 'function') disposers.push(d)
    } catch (e) {
      log('[mp] 订阅 ' + evt + ' 失败: ' + ((e && e.message) || e))
    }
  }

  function claim(event, kind) {
    const label = kind === 'approval' ? '审批' : '提问'

    const forwarding = (next) => {
      try {
        return typeof next === 'function' ? next() : undefined
      } catch (e) {
        log('[mp] ' + event + ' 委托下一环失败: ' + ((e && e.message) || e))
        return undefined
      }
    }
    return function claimed(req, next) {
      let id = ''
      try {
        id = kind === 'approval' ? tracker.addApproval(req) : tracker.addQuestion(req)
        log('[mp] 收到' + label + '请求 ' + id)
      } catch (e) {
        log('[mp] ' + event + ' 记录失败: ' + ((e && e.message) || e))
        return forwarding(next)
      }
      if (!id) return forwarding(next)

      if (typeof next !== 'function') return undefined
      return new Promise((resolve) => {

        let settled = false
        const finish = (value) => {
          if (settled) return
          settled = true
          resolve(value)
        }

        let releaseDelivery = null
        const openDelivery = () => {
          try {
            if (kind !== 'question' || !req || typeof req !== 'object') return
            if (typeof AbortController !== 'function' || typeof AbortSignal === 'undefined') return
            if (typeof AbortSignal.any !== 'function') return
            const current = req.signal
            if (current !== undefined && !(current instanceof AbortSignal)) return
            const ctl = new AbortController()
            req.signal = current instanceof AbortSignal ? AbortSignal.any([current, ctl.signal]) : ctl.signal
            releaseDelivery = () => {
              try {
                ctl.abort(new Error('dsh-console-plugin: 提问已在手机上答复，撤回电脑端等待'))
              } catch (e) {  }
            }
          } catch (e) {

            releaseDelivery = null
            log('[mp] ' + event + ' 注入撤回信号失败（电脑端卡片可能不自动摘）: ' + ((e && e.message) || e))
          }
        }

        const settleFromPhone = (value) => {

          log('[mp] 提问 ' + id + ' 由手机侧兑现：answers=' + String(value && value.answers ? value.answers.length : 0))
          if (!settled) {
            const release = releaseDelivery
            releaseDelivery = null
            if (release) release()
          }
          finish(value)
        }
        let attached = false
        try {
          attached = tracker.attachResolve(id, settleFromPhone, kind)
        } catch (e) {
          log('[mp] ' + event + ' 挂句柄失败: ' + ((e && e.message) || e))
        }

        if (!attached) { finish(forwarding(next)); return }

        openDelivery()

        let hostPromise = null
        try { hostPromise = next() } catch (e) {
          log('[mp] ' + event + ' 放行宿主链失败: ' + ((e && e.message) || e))
        }
        if (hostPromise && typeof hostPromise.then === 'function') {
          hostPromise.then((value) => {
            if (kind === 'approval') {
              const outcome = normalizeApprovalOutcome(value)

              if (outcome === 'unavailable') return
              finish(outcome)

              try { tracker.resolveApproval({ approvalId: id, outcome }) } catch (e) {  }
            } else if (value !== undefined && value !== null) {

              log('[mp] 提问 ' + id + ' 由宿主侧兑现：answers=' + String(value && value.answers ? value.answers.length : 0))
              finish(value)
              try { tracker.resolveQuestion({ rpcId: id }) } catch (e) {  }
            }
          }, () => {  })
        }

        const signal = req && req.signal
        if (signal && typeof signal.addEventListener === 'function') {
          try {
            signal.addEventListener('abort', () => {

              if (kind === 'question' && hostPromise !== null) {
                log('[mp] 提问 ' + id + ' 的信号 abort（宿主链已放行，不抢答，等宿主结果）')
                return
              }
              try {
                if (kind === 'approval') tracker.resolveApproval({ approvalId: id, outcome: 'cancelled' })
                else tracker.resolveQuestion({ rpcId: id })
              } catch (e) {  }
            }, { once: true })
          } catch (e) {  }
        }
      })
    }
  }

  on('approval/request', claim('approval/request', 'approval'), { prepend: true })
  on('user-questions/request', claim('user-questions/request', 'question'), { prepend: true })

  return {

    sources: [
      { event: 'session/event', global: true },
      { event: 'approval/request', global: false },
      { event: 'user-questions/request', global: false },
    ],
    dispose() {
      for (const d of disposers) {
        try { d() } catch (e) {  }
      }
    },
  }
}

export function attachMp(ctx, deps) {
  const log = deps.log || (() => {})
  const isPairCode = deps.isPairCode || (() => true)

  const store = createDeviceStore(deps)
  const tracker = createPendingTracker()
  const subs = subscribeHostEvents(ctx, tracker, log)

  const dispatch = createDispatcher(ctx, log, tracker, { pins: new Set() })

  const branch = createMpBranch({
    dispatch,
    log,
    store: {
      exchange: (token, about) => (isPairCode(token) ? store.exchange(token, about) : null),
      isPaired: (s) => store.isPaired(s),
      revoke: (s) => store.revoke(s),

      revokeUid: (u) => (typeof store.revokeUid === 'function' ? store.revokeUid(u) : 0),

      touch: (s, about) => (typeof store.touch === 'function' ? store.touch(s, about) : false),
    },
  })

  log('[mp] mp 契约已就绪：' + (deps.config && deps.config.enabled === false ? '（未启用）' : '24 个 RPC + WS'))

  return {
    branch,
    tracker,
    store,
    subscriptions: subs,

    onUpgrade: createLiveUpgrade({
      ctx,
      log,
      store: { isPaired: (s) => store.isPaired(s) },
      tracker,

      onStream: deps.onStream,
    }),

    issueForCode(code, about) {

      const r = store.exchange(String(code || '').trim(), about)
      if (!r || !r.secret) return ''
      return `mp_device=${encodeURIComponent(r.secret)}`
    },

    issueDevice(about) {

      const r = store.mint(about)
      if (!r || !r.secret) return ''
      return `mp_device=${encodeURIComponent(r.secret)}`
    },

    attachServer(server, onUpgrade) {
      if (typeof onUpgrade !== 'function') return () => {}
      return mountMpUpgrade(server, {
        store: { isPaired: (s) => store.isPaired(s) },
        log,
        onUpgrade,
      })
    },
    dispose() {

      try { tracker.dispose() } catch (e) {  }
      subs.dispose()
    },
  }
}
