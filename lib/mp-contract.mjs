export const PREFIX = '/mp'
export const COOKIE = 'mp_device'
export const TOKEN_TTL_MS = 2 * 60 * 60 * 1000
export const MAX_BODY = 12 * 1024 * 1024
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
export const SESSION_PAGE = 20

export const ALLOW = [
  'workspace.list',
  'workspace.create',
  'host.listDirectory',
  'agentPreset.list',
  'session.list',
  'session.create',
  'session.history',
  'session.prompt',
  'session.cancel',
  'session.attachment',
  'session.models',
  'session.selectModel',
  'skill.list',
  'command.list',
  'command.execute',
  'mobile.pending',
  'mobile.respond',
  'quota.read',
  'host.restart',
  'session.pins',
  'session.pin',
  'push.key',
  'push.subscribe',
  'push.unsubscribe',
]

const ALLOW_SET = new Set(ALLOW)

export function isAllowed(method) {
  return ALLOW_SET.has(String(method || ''))
}

export const ENDPOINTS = {
  accept: `${PREFIX}/pair/accept`,
  status: `${PREFIX}/pair/status`,
  issue: `${PREFIX}/pair/issue`,
  revoke: `${PREFIX}/pair/revoke`,
  wsMux: `${PREFIX}/api/ws/mux`,
  wsHost: `${PREFIX}/api/ws/host`,
  rpcPrefix: `${PREFIX}/api/`,
  upload: `${PREFIX}/api/mobile.upload`,
  attachment: `${PREFIX}/api/attachment`,
  setup: `${PREFIX}/setup`,
}

export function methodOf(pathname) {
  const raw = String(pathname || '')
  if (!raw.startsWith(ENDPOINTS.rpcPrefix)) return null
  const rest = raw.slice(ENDPOINTS.rpcPrefix.length)
  if (rest === '' || rest.includes('/')) return null
  return isAllowed(rest) ? rest : null
}

export function isRpcShaped(pathname) {
  return String(pathname || '').startsWith(ENDPOINTS.rpcPrefix)
}

export function cookieValue(header, name = COOKIE) {
  const raw = String(header || '')
  if (raw === '') return ''
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return ''
}

export function deviceCookieHeader(secret, maxAgeSec = 60 * 60 * 24 * 365) {
  return `${COOKIE}=${encodeURIComponent(secret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`
}

export function wrap(rpcId, value) {
  return { type: 'server-response', rpcId: rpcId || '', result: { ok: true, value } }
}

export function wrapErr(rpcId, code, message, details) {
  const error = { code: String(code || 'error'), message: String(message || '') }
  if (details !== undefined) error.details = details
  return { type: 'server-response', rpcId: rpcId || '', result: { ok: false, error } }
}

export function wrapUnavailable(rpcId, message) {
  return wrapErr(rpcId, 'unavailable', message || '服务不可用')
}

export function wrapBadRequest(rpcId, message) {
  return wrapErr(rpcId, 'bad-request', message || 'bad request')
}

export function parseRpcBody(body) {
  const raw = body && typeof body === 'object' ? body : {}
  const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : {}
  return { rpcId: typeof raw.rpcId === 'string' ? raw.rpcId : '', payload }
}

export function readyFrame(channel, clientId) {
  return {
    type: 'ready',
    clientId: clientId || `${channel}-${Date.now().toString(36)}`,
  }
}

export function pongFrame() {
  return { type: 'pong' }
}

export function sessionEventFrame(sessionId, event) {
  return { type: 'session/event', sessionId: sessionId || '', event }
}

export function sessionStatusFrame(sessionId, running) {
  return { type: 'host/session-status', sessionId: sessionId || '', running: running === true }
}

function looksLikeAcpTailGarbage(rest) {
  if (typeof rest !== "string") return false
  const s = rest.trim()
  if (s === "") return true
  if (s.indexOf("｜｜DSML｜｜") !== -1) return true
  if (/<\s*\/?\s*｜/.test(s)) return true
  const stripped = s
    .replace(/<[^<>]{0,60}>/g, "")
    .replace(/m\d{3,}/g, "")
    .replace(/[\s|｜·、，。]+/g, "")
  if (stripped === "") return true
  const hasCJK = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/.test(s)
  const hasLetters = /[A-Za-z]{2,}/.test(stripped)
  return !hasCJK && !hasLetters && stripped.length <= 12
}
export function stripAcp(t) {
  if (typeof t !== 'string' || t === '' || t.indexOf('<acp') === -1) return t
  let out = ''
  let i = 0
  while (i < t.length) {
    const open = t.indexOf('<acp', i)
    if (open === -1) { out += t.slice(i); break }
    const tagEnd = t.indexOf('>', open)
    if (tagEnd === -1) { out += t.slice(i); break }
    const tag = t.slice(open, tagEnd + 1)

    if (!/^<acp(\s[^>]*)?\/?>$/.test(tag)) { out += t.slice(i, open + 1); i = open + 1; continue }
    out += t.slice(i, open)
    if (tag.slice(-2) === '/>') { i = tagEnd + 1; continue }
    let depth = 1
    let j = tagEnd + 1
    while (depth > 0) {
      const nOpen = t.indexOf('<acp', j)
      const nClose = t.indexOf('</acp>', j)
      if (nClose === -1) break
      if (nOpen !== -1 && nOpen < nClose) {
        const ne = t.indexOf('>', nOpen)
        if (ne === -1 || ne > nClose) { depth--; j = nClose + 6; continue }
        depth += 1; j = ne + 1
      } else { depth -= 1; j = nClose + 6 }
    }
    if (depth !== 0) {

      if (looksLikeAcpTailGarbage(t.slice(tagEnd + 1))) break
      out += tag; i = tagEnd + 1; continue
    }
    i = j
  }
  return out
}

export function questionInteractionStatus(questions) {
  const list = Array.isArray(questions) ? questions : []
  if (list.length !== 1) return 'question'
  const q = list[0]
  const intent = q && q.intent
  if (!intent || intent.kind !== 'plan-review') return 'question'
  if (!q.detail) return 'question'
  if (q.multiSelect === true) return 'question'
  const options = Array.isArray(q.options) ? q.options : []
  if (options.length > 2) return 'question'
  return options.some((o) => o && o.label === 'approve') ? 'plan-review' : 'question'
}

export function sessionIdOf(req) {
  const explicit = String((req && req.sessionId) || '')
  if (explicit !== '') return explicit
  const agent = req && req.agent
  if (!agent) return ''
  return String(agent.id || (agent.session && agent.session.id) || '')
}

export function approvalFrame(req) {
  return {
    type: 'approval/requested',
    approvalId: String((req && (req.approvalId || req.id)) || ''),
    rpcId: String((req && req.rpcId) || ''),
    sessionId: sessionIdOf(req),
    toolName: String((req && req.toolName) || 'tool'),
    callId: String((req && req.callId) || ''),
    reason: String((req && req.reason) || ''),
  }
}

export function questionFrame(req) {
  const questions = req && Array.isArray(req.questions) ? req.questions : []
  return {
    type: 'question/requested',
    rpcId: String((req && req.rpcId) || ''),
    sessionId: sessionIdOf(req),
    kind: questionInteractionStatus(questions),
    questions,
  }
}

export function approvalResponseBody(sessionId, payload) {
  return {
    type: 'approval',
    sessionId,
    approvalId: String((payload && payload.approvalId) || ''),
    rpcId: String((payload && payload.rpcId) || ''),
    outcome: String((payload && payload.outcome) || 'deny'),
  }
}

export function questionResponseBody(sessionId, payload) {
  const raw = payload && Array.isArray(payload.answers) ? payload.answers : []
  const answers = []
  for (const a of raw) {
    const item = { id: String((a && a.id) || ''), selected: a && Array.isArray(a.selected) ? a.selected : [] }
    if (typeof a?.custom === 'string' && a.custom !== '') item.custom = a.custom
    answers.push(item)
  }
  return { type: 'question', sessionId, rpcId: String((payload && payload.rpcId) || ''), answers }
}

export function pendingSnapshot(tracker) {
  const approvals = []
  const questions = []
  const seen = new Set()

  if (tracker && typeof tracker.list === 'function') {
    for (const a of tracker.list()) {
      if (!a || seen.has(a.approvalId)) continue
      seen.add(a.approvalId)
      approvals.push({
        approvalId: String(a.approvalId || ''),
        rpcId: String(a.rpcId || ''),
        sessionId: String(a.sessionId || ''),
        toolName: String(a.toolName || 'tool'),
        callId: String(a.callId || ''),
        reason: String(a.reason || ''),
      })
    }
  }

  if (tracker && typeof tracker.questions === 'function') {
    for (const q of tracker.questions()) {
      if (!q || seen.has(q.rpcId)) continue
      seen.add(q.rpcId)
      questions.push({
        rpcId: String(q.rpcId || ''),
        sessionId: String(q.sessionId || ''),
        kind: questionInteractionStatus(q.questions),
        questions: Array.isArray(q.questions) ? q.questions : [],
        answers: [],
      })
    }
  }

  return { approvals, questions }
}

export function mergePending(previous, incoming) {
  const prior = new Map()
  for (const q of (previous && previous.questions) || []) {
    if (q && q.rpcId) prior.set(q.rpcId, q)
  }
  const out = []
  for (const q of (incoming && incoming.questions) || []) {
    const old = prior.get(q.rpcId)
    if (old && Array.isArray(old.answers) && old.answers.length > 0) {
      out.push({ ...q, answers: old.answers })
    } else {
      out.push(q)
    }
  }
  return { approvals: (incoming && incoming.approvals) || [], questions: out }
}
