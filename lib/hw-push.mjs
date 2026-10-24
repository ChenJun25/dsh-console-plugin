import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SA_ENV = 'DSH_HW_PUSH_SA'

export const SA_PATHS = [
  path.join(os.homedir(), '.dsh', 'hw-push-sa.json'),
  path.join(os.homedir(), '.dsh', 'dsh-console-push-sa.json')
]

const AUTH_AUD = 'https://oauth-login.cloud.huawei.com/oauth2/v3/token'
const PUSH_API_BASE = 'https://push-api.cloud.huawei.com/v3/'
const SUCCESS_CODE = '80000000'
const JWT_TTL_SEC = 3600
const SALT_LEN = 32
const MAX_TOKENS = 1000
const SEND_TIMEOUT_MS = 8000
const TTL_MIN = 3600
const TTL_MAX = 1296000
const NOTIFY_TTL = 86400

const DEFAULT_CATEGORY = 'WORK'

function msgOf(e) {
  try { return String((e && e.message) || e || '') } catch (e2) { return '' }
}

function tailOf(v) {
  const s = String(v == null ? '' : v)
  return s.length <= 8 ? s : s.slice(-8)
}

function fixPem(v) {
  let s = String(v == null ? '' : v).trim()
  if (s.indexOf('\\n') >= 0 || s.indexOf('\\r') >= 0) {
    s = s.split('\\r\\n').join('\n').split('\\n').join('\n').split('\\r').join('\n')
  }
  return s
}

function pick(obj, names) {
  if (!obj || typeof obj !== 'object') return ''
  for (const n of names) {
    const v = obj[n]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && isFinite(v)) return String(v)
  }
  return ''
}

function normSa(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const keyId = pick(raw, ['key_id', 'keyId', 'keyID', 'kid'])
  const subAccount = pick(raw, ['sub_account', 'subAccount', 'subAccountId', 'subaccount'])
  const projectId = pick(raw, ['project_id', 'projectId', 'projectID'])
  const privateKey = fixPem(pick(raw, ['private_key', 'privateKey']))
  if (!keyId || !subAccount || !projectId || !privateKey) return null
  return { keyId, subAccount, projectId, privateKey }
}

function parseSaText(text) {
  try {
    const obj = JSON.parse(String(text == null ? '' : text))
    return normSa(obj)
  } catch (e) {
    return null
  }
}

export function loadSa(opts) {
  const o = opts || {}
  try {
    if (o.saText !== undefined) {
      const text = String(o.saText == null ? '' : o.saText).trim()
      if (!text) return { ok: false, reason: 'no-sa' }
      const sa = parseSaText(text)
      return sa ? { ok: true, sa, source: 'inline' } : { ok: false, reason: 'bad-sa' }
    }

    const envText = o.ignoreEnv ? '' : String(process.env[SA_ENV] || '').trim()
    if (envText) {
      const sa = parseSaText(envText)

      if (sa) return { ok: true, sa, source: 'env' }
    }

    const files = Array.isArray(o.saPaths) ? o.saPaths : SA_PATHS
    for (const p of files) {
      let text = ''
      try { text = fs.readFileSync(p, 'utf8') } catch (e) { continue }
      const sa = parseSaText(text)
      if (sa) return { ok: true, sa, source: 'file' }
    }
    return { ok: false, reason: 'no-sa' }
  } catch (e) {
    return { ok: false, reason: 'load-error', msg: msgOf(e) }
  }
}

export function pushReady(opts) {
  try { return loadSa(opts).ok } catch (e) { return false }
}

function readable(p) {
  try { fs.accessSync(p, fs.constants.R_OK); return true } catch (e) { return false }
}

export function pushStatus(opts) {
  const o = opts || {}
  const paths = Array.isArray(o.saPaths) ? o.saPaths.slice() : SA_PATHS.slice()
  const r = loadSa(o)

  let tokenCount = 0
  if (typeof o.readTokens === 'function') {
    try { const list = o.readTokens(); tokenCount = Array.isArray(list) ? list.filter(Boolean).length : 0 } catch (e) { tokenCount = 0 }
  }

  const existingPaths = []
  for (const p of paths) if (readable(p)) existingPaths.push(p)

  const problems = []
  if (!r.ok) {
    if (r.reason === 'bad-sa') {
      problems.push('服务账号 json 能读到但字段不全/私钥不对：需要 key_id、sub_account、project_id、private_key 四项')
    } else if (r.reason === 'load-error') {
      problems.push('读服务账号失败：' + String(r.msg || ''))
    } else {
      problems.push('没有服务账号：把 AGC 下载的服务账号 json 存成 ' + paths[0] + '（或设环境变量 ' + SA_ENV + '）')
    }
  }
  if (tokenCount <= 0) problems.push('还没有手机上报过 push token（App 里打开推送开关，让手机把 deviceToken 发上来）')

  if (o.test !== false) {
    problems.push('testMessage=true（测试消息）：每台设备一次推送算 1 条额度，每天 1000 条所有设备共用；多设备会按台数消耗。要发正式通知请设 DSH_HW_PUSH_TEST=0')
  }

  const base = {
    ok: r.ok === true,
    ready: r.ok === true && tokenCount > 0,
    env: SA_ENV,
    expectedPaths: paths,
    existingPaths,
    tokenCount,
    testMessage: o.test !== false,
    problems
  }

  if (!r.ok) return Object.assign(base, { reason: r.reason || 'no-sa' })
  return Object.assign(base, {
    source: r.source,
    projectId: r.sa.projectId,
    keyIdTail: tailOf(r.sa.keyId)
  })
}

const b64url = (buf) => Buffer.from(buf).toString('base64url')

export function buildJwt(sa, ttl) {
  if (!sa || !sa.keyId || !sa.subAccount || !sa.privateKey) throw new Error('服务账号字段不全')
  const iat = Math.floor(Date.now() / 1000)
  let life = (ttl === undefined || ttl === null) ? JWT_TTL_SEC : Number(ttl)
  if (!isFinite(life) || life <= 0) life = JWT_TTL_SEC
  life = Math.min(Math.max(Math.round(life), 60), JWT_TTL_SEC)

  const header = { kid: String(sa.keyId), typ: 'JWT', alg: 'PS256' }
  const payload = { aud: AUTH_AUD, iss: String(sa.subAccount), iat, exp: iat + life }
  const input = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload))
  const key = crypto.createPrivateKey({ key: sa.privateKey, format: 'pem' })
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input, 'ascii'), {
    key,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: SALT_LEN
  })
  return input + '.' + b64url(sig)
}

export function normTokens(input) {
  const raw = Array.isArray(input)
    ? input
    : (typeof input === 'string' ? input.split(',') : [])
  const out = []
  for (const t of raw) {
    const v = (t && typeof t === 'object') ? t.token : t
    const s = String(v == null ? '' : v).trim()
    if (s && out.indexOf(s) < 0) out.push(s)
  }
  return out.slice(0, MAX_TOKENS)
}

export function buildBody(opt) {
  const o = opt || {}
  const tokens = normTokens(o.tokens)

  const category = String(o.category || process.env.DSH_HW_PUSH_CATEGORY || DEFAULT_CATEGORY)
  const notification = {
    category,
    title: String(o.title == null ? '' : o.title),
    body: String(o.body == null ? '' : o.body),
    clickAction: { actionType: 0, data: { sessionId: String(o.sessionId == null ? '' : o.sessionId) } },

    foregroundShow: false,
    badge: { addNum: 1 }
  }
  if (o.notifyId !== undefined && o.notifyId !== null && o.notifyId !== '') {
    const n = Number(o.notifyId)
    if (isFinite(n)) notification.notifyId = Math.round(n)
  }

  let ttl = (o.ttl === undefined || o.ttl === null) ? NOTIFY_TTL : Number(o.ttl)
  if (!isFinite(ttl)) ttl = NOTIFY_TTL
  ttl = Math.min(Math.max(Math.round(ttl), TTL_MIN), TTL_MAX)

  return {
    payload: { notification },
    target: { token: tokens },
    pushOptions: { testMessage: o.test !== false, ttl }
  }
}

async function postOnce(url, jwt, body, timeoutMs) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + jwt,
        'push-type': '0'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })

    let text = ''
    try { text = await res.text() } catch (e) { text = '' }
    let json = null
    try { json = text ? JSON.parse(text) : null } catch (e) { json = null }

    const code = (json && json.code !== undefined && json.code !== null) ? String(json.code) : ''
    const msg = (json && (json.msg || json.message)) ? String(json.msg || json.message) : ''
    if (res.status >= 200 && res.status < 300 && code === SUCCESS_CODE) {
      return { ok: true, code, msg: msg || 'ok', count: body.target.token.length }
    }

    return { ok: false, code: code || String(res.status), msg: msg || ('HTTP ' + res.status), count: 0 }
  } catch (e) {
    return { ok: false, reason: 'exception', msg: msgOf(e), count: 0 }
  }
}

export async function sendPush(opt) {
  const o = opt || {}
  const log = typeof o.log === 'function' ? o.log : () => {}
  try {
    const tokens = normTokens(o.tokens)
    if (!tokens.length) return { ok: false, reason: 'no-token' }
    if (!String(o.title == null ? '' : o.title).trim()) return { ok: false, reason: 'no-title' }

    let sa = (o.sa && o.sa.keyId && o.sa.privateKey) ? o.sa : null
    if (!sa) {
      const r = loadSa(o.saOpts)
      if (!r.ok) return { ok: false, reason: r.reason || 'no-sa' }
      sa = r.sa
    }

    let jwt = ''
    try {
      jwt = buildJwt(sa, o.jwtTtl)
    } catch (e) {
      return { ok: false, reason: 'sign', msg: 'JWT 签名失败：' + msgOf(e) }
    }

    const base = String(o.apiBase || PUSH_API_BASE).replace(/\/+$/, '')
    const url = base + '/' + encodeURIComponent(sa.projectId) + '/messages:send'
    const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : SEND_TIMEOUT_MS
    const body = buildBody(Object.assign({}, o, { tokens }))
    const isTest = body.pushOptions.testMessage !== false

    if (isTest && tokens.length > 1) {
      const results = []
      let sent = 0
      for (const tk of tokens) {
        const oneBody = buildBody(Object.assign({}, o, { tokens: [tk] }))
        const r = await postOnce(url, jwt, oneBody, timeoutMs)
        results.push({
          ok: r.ok === true,
          tokenTail: tailOf(tk),
          code: r.code,
          msg: r.msg,
          reason: r.reason
        })
        if (r.ok) sent += 1
      }
      const failed = tokens.length - sent
      log('hw-push: 测试消息逐台发送 project=' + sa.projectId +
        ' 共 ' + tokens.length + ' 台 成功 ' + sent + ' 失败 ' + failed +
        '（testMessage=true 单次仅 1 个 token）')
      return { ok: sent > 0, sent, failed, count: sent, results }
    }

    log('hw-push: 发送通知 project=' + sa.projectId +
      ' token=' + tailOf(tokens[0]) + ' 共 ' + tokens.length + ' 台' +
      ' test=' + (isTest ? 'yes' : 'no'))

    return await postOnce(url, jwt, body, timeoutMs)
  } catch (e) {
    return { ok: false, reason: 'exception', msg: msgOf(e) }
  }
}

export const WATCH_INTERVAL_MS = 15000
const DEDUP_MAX = 50

export function createPushWatcher(opts) {
  const o = opts || {}
  const readSessions = typeof o.readSessions === 'function' ? o.readSessions : null
  const readTokens = typeof o.readTokens === 'function' ? o.readTokens : () => []
  const log = typeof o.log === 'function' ? o.log : () => {}
  const send = typeof o.send === 'function' ? o.send : sendPush
  const ready = typeof o.ready === 'function' ? o.ready : pushReady
  const intervalMs = Number(o.intervalMs) > 0 ? Number(o.intervalMs) : WATCH_INTERVAL_MS
  const test = o.test !== false

  const lastRunning = new Map()
  const pushed = []
  let timer = null
  let baselined = false
  let stopped = false
  let readFails = 0

  function remember(key) {
    pushed.push(key)
    while (pushed.length > DEDUP_MAX) pushed.shift()
  }

  function deliver(item) {
    const id = String(item && item.id ? item.id : '')
    if (!id) return false
    const key = id + ':' + (Number(item && item.updatedAt) || 0)
    if (pushed.indexOf(key) >= 0) return false
    remember(key)

    let readyNow = false
    try { readyNow = ready() === true } catch (e) { readyNow = false }
    if (!readyNow) {
      log('push: 没配华为服务账号（~/.dsh/hw-push-sa.json），跳过会话 ' + id)
      return false
    }

    let toks = []
    try { toks = normTokens(readTokens()) } catch (e) { toks = [] }
    if (!toks.length) {
      log('push: 还没有手机上报过 push token，跳过会话 ' + id)
      return false
    }

    const title = String((item && item.title) || '').trim() || id.slice(0, 16)

    Promise.resolve()
      .then(() => send({
        tokens: toks,
        title: '「' + title + '」生成完成',
        body: '点此查看结果',
        sessionId: id,
        test,
        log
      }))
      .then((r) => {
        if (r && r.ok) log('push: 已推送会话 ' + id + ' 到 ' + (r.count || toks.length) + ' 台设备')
        else log('push: 推送会话 ' + id + ' 失败：' + JSON.stringify({ code: r && r.code, reason: r && r.reason, msg: r && r.msg }))
      })
      .catch((e) => { log('push: 推送会话 ' + id + ' 异常（忽略）：' + msgOf(e)) })
    return true
  }

  function scan(items) {
    const list = Array.isArray(items) ? items : []
    if (!baselined) {
      for (const s of list) {
        if (s && s.id) lastRunning.set(String(s.id), s.running === true)
      }
      baselined = true
      log('push: 会话完成检测就绪，基线 ' + lastRunning.size + ' 个会话（历史状态不推）')
      return
    }
    for (const s of list) {
      if (!s || !s.id) continue
      const id = String(s.id)
      const cur = s.running === true
      const prev = lastRunning.get(id)
      lastRunning.set(id, cur)
      if (prev === true && !cur) deliver(s)
    }

    const alive = new Set()
    for (const s of list) if (s && s.id) alive.add(String(s.id))
    for (const k of Array.from(lastRunning.keys())) {
      if (!alive.has(k)) lastRunning.delete(k)
    }
  }

  function tick() {
    if (stopped || !readSessions) return
    let p
    try { p = readSessions() } catch (e) { onReadFail(e); return }
    if (!p || typeof p.then !== 'function') return
    p.then((items) => {
      try { scan(items) } catch (e) { log('push: 扫描异常（忽略）：' + msgOf(e)) }
    }, (e) => { onReadFail(e) })
  }

  function onReadFail(e) {
    readFails += 1
    if (readFails === 1 || readFails % 20 === 0) {
      log('push: 读会话列表失败（第 ' + readFails + ' 次，忽略）：' + msgOf(e))
    }
  }

  function start() {
    if (timer) {
      log('push: 会话完成检测已在跑，不重复创建')
      return false
    }
    if (!readSessions) {
      log('push: 拿不到 readSessions，跳过会话完成检测')
      return false
    }
    stopped = false
    try {
      timer = setInterval(tick, intervalMs)

      if (timer && typeof timer.unref === 'function') timer.unref()
    } catch (e) {
      timer = null
      log('push: 会话完成检测启动失败（忽略）：' + msgOf(e))
      return false
    }
    let readyNow = false
    try { readyNow = ready() === true } catch (e) { readyNow = false }
    log('push: 会话完成检测启动，间隔 ' + intervalMs + 'ms，服务账号=' + (readyNow ? '已配' : '未配（只记日志不推）'))
    tick()
    return true
  }

  function stop() {
    stopped = true
    if (timer) {
      try { clearInterval(timer) } catch (e) { }
      timer = null
    }
  }

  function state() {
    return { running: !!timer, baselined, sessions: lastRunning.size, pushed: pushed.length }
  }

  return { start, stop, tick, scan, state }
}
