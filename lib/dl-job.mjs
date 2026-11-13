
const jobs = new Map()

export function jobBegin(kind) {
  const k = String(kind || 'dl')
  const prev = jobs.get(k)
  if (prev && prev.running === true) return null
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const j = {
    kind: k,
    running: true,
    phase: 'starting',
    source: '',
    pct: 0,
    got: 0,
    total: 0,
    startedMs: Date.now(),
    endedMs: 0,
    error: ''
  }
  Object.defineProperty(j, 'ctrl', { value: ctrl, enumerable: false, writable: true })
  jobs.set(k, j)
  return j
}

export function jobSignal(j) {
  return (j && j.ctrl) ? j.ctrl.signal : undefined
}

export function jobUpdate(j, patch) {
  if (!j || !patch) return
  if (patch.pct !== undefined) j.pct = Math.max(0, Math.min(100, Math.round(Number(patch.pct) || 0)))
  if (patch.got !== undefined) j.got = Number(patch.got) || 0
  if (patch.total !== undefined) j.total = Number(patch.total) || 0
  if (patch.phase !== undefined) j.phase = String(patch.phase)
  if (patch.source !== undefined) j.source = String(patch.source)
  if (patch.error !== undefined) j.error = String(patch.error)
}

export function jobProgressFn(j) {
  if (!j) return undefined
  return (pct, got, total) => { jobUpdate(j, { pct: pct, got: got, total: total, phase: 'downloading' }) }
}

export function jobAlive(j) {
  return !!(j && j.running === true)
}

export function jobFinish(j, ok, error) {
  if (!j) return
  j.running = false
  j.phase = ok === true ? 'done' : (j.phase === 'cancelling' ? 'cancelled' : 'error')
  j.pct = ok === true ? 100 : j.pct
  j.error = String(error || '')
  j.endedMs = Date.now()
}

export function jobSnapshot() {
  const out = []
  for (const j of jobs.values()) {
    out.push({
      kind: j.kind,
      running: j.running === true,
      phase: j.phase,
      source: j.source,
      pct: j.pct,
      got: j.got,
      total: j.total,
      ms: (j.endedMs || Date.now()) - j.startedMs,
      error: j.error
    })
  }
  return out
}

export function jobOf(kind) {
  const j = jobs.get(String(kind || 'dl'))
  if (!j) return null
  return {
    kind: j.kind,
    running: j.running === true,
    phase: j.phase,
    source: j.source,
    pct: j.pct,
    got: j.got,
    total: j.total,
    ms: (j.endedMs || Date.now()) - j.startedMs,
    error: j.error
  }
}

export function jobCancel(kind) {
  const k = String(kind || 'dl')
  const j = jobs.get(k)
  if (!j) return { ok: false, reason: 'no-job' }
  if (j.running !== true) return { ok: false, reason: 'not-running' }
  j.phase = 'cancelling'
  try {
    if (j.ctrl) j.ctrl.abort()
  } catch (_) { }
  return { ok: true, kind: k }
}
