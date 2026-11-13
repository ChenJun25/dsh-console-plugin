
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const OSS_MAX_PER_DAY = 3
export const OSS_MIN_INTERVAL_MS = 10 * 60 * 1000
export const OSS_MAX_BYTES_PER_DAY = 200 * 1024 * 1024

const GATE_FILE = path.join(os.homedir(), '.dsh', 'dl-gate.json')

function dayKey(d) {
  const t = d || new Date()
  const p = (n) => String(n).padStart(2, '0')
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate())
}

function readGate() {
  try {
    const j = JSON.parse(fs.readFileSync(GATE_FILE, 'utf8'))
    if (j && typeof j === 'object') return j
  } catch (_) { }
  return {}
}

function writeGate(g) {
  try {
    fs.mkdirSync(path.dirname(GATE_FILE), { recursive: true })
    fs.writeFileSync(GATE_FILE, JSON.stringify(g))
  } catch (_) { }
}

function ossRec(g) {
  const today = dayKey()
  if (g && g.day === today && g.oss && typeof g.oss === 'object') {
    return { count: Number(g.oss.count) || 0, bytes: Number(g.oss.bytes) || 0, lastMs: Number(g.oss.lastMs) || 0 }
  }
  return { count: 0, bytes: 0, lastMs: 0 }
}

export function ossGateCheck() {
  const rec = ossRec(readGate())
  if (rec.count >= OSS_MAX_PER_DAY) return { ok: false, reason: 'daily-count' }
  if (rec.bytes >= OSS_MAX_BYTES_PER_DAY) return { ok: false, reason: 'daily-bytes' }
  if (rec.lastMs > 0 && (Date.now() - rec.lastMs) < OSS_MIN_INTERVAL_MS) return { ok: false, reason: 'interval' }
  return { ok: true }
}

export function ossGateCommit(bytes) {
  const today = dayKey()
  const g = readGate()
  const rec = ossRec(g)
  rec.count += 1
  rec.bytes += Math.max(0, Number(bytes) || 0)
  rec.lastMs = Date.now()
  writeGate({ day: today, oss: rec, updatedMs: Date.now() })
  return rec
}

export function ossGateState() {
  const rec = ossRec(readGate())
  return {
    day: dayKey(),
    used: rec.count,
    maxPerDay: OSS_MAX_PER_DAY,
    bytes: rec.bytes,
    maxBytesPerDay: OSS_MAX_BYTES_PER_DAY,
    minIntervalMs: OSS_MIN_INTERVAL_MS,
    lastMs: rec.lastMs
  }
}

const manualCounts = new Map()

export function nextManualAttempt(kind) {
  const k = String(kind || 'dl')
  const n = (manualCounts.get(k) || 0) + 1
  manualCounts.set(k, n)
  return n
}

export function manualAttemptOf(kind) {
  return manualCounts.get(String(kind || 'dl')) || 0
}

export function resetManualAttempt(kind) {
  manualCounts.delete(String(kind || 'dl'))
}

export function manualSourcePlan(attempt, opts) {
  const o = opts || {}
  const hasOss = !!String(o.ossBase || '').trim()
  const n = Number(attempt) || 0
  if (n <= 1) return { ids: ['github'], skipOss: true }
  if (n === 2 && hasOss) {

    if (ossGateCheck().ok) return { ids: ['oss'], skipOss: false }
    return { ids: null, skipOss: true }
  }
  return { ids: null, skipOss: !hasOss }
}

export function pickBases(bases, plan) {
  const p = plan || {}
  const ids = Array.isArray(p.ids) ? p.ids : null
  const out = []
  for (const b of (Array.isArray(bases) ? bases : [])) {
    const id = String((b && b.id) || '')
    const base = String((b && b.base) || '').trim()
    if (!base) continue
    if (ids && ids.indexOf(id) < 0) continue
    if (p.skipOss === true && id === 'oss') continue
    out.push({ id: id, base: base })
  }
  return out
}
