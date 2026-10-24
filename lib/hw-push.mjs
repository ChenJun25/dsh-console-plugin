import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// =============================================================================
// 第 264 节 · task-4：插件侧当「您的服务器」—— 会话跑完直接调华为 Push REST 推手机。
//
// 为什么单独开一个文件：lib/index.js 是明文 ESM 运行时，改错一个字符整个 DSH 起不来。
// 推送这一摊全部收在这里，index.js 只 import 几个函数 + 挂一个定时器，改错面积最小。
// 为什么零第三方依赖：node 内置 crypto 就能签 PS256（RSASSA-PSS + SHA256 + MGF1 +
// saltLen 32），内置 fetch 就能发 HTTPS，为一个 JWT 引依赖不值当（python 版同理）。
//
// 底线：本文件导出的函数【任何情况下都不抛错】。
// 没配服务账号 / 私钥坏 / 断网 / 华为返回 5xx —— 一律 return { ok:false, reason }，
// 由调用方决定要不要记日志。推送是锦上添花，绝不能让宿主主流程挂掉。
// =============================================================================

export const SA_ENV = 'DSH_HW_PUSH_SA'

// 两个位置都认：用户从 AGC 下下来的 sa json 直接改名丢进 ~/.dsh 就能用，
// 两种命名都常见，多认一个少一次「我明明放了文件为什么说没配」。
export const SA_PATHS = [
  path.join(os.homedir(), '.dsh', 'hw-push-sa.json'),
  path.join(os.homedir(), '.dsh', 'dsh-console-push-sa.json')
]

const AUTH_AUD = 'https://oauth-login.cloud.huawei.com/oauth2/v3/token'
const PUSH_API_BASE = 'https://push-api.cloud.huawei.com/v3/'
const SUCCESS_CODE = '80000000'
const JWT_TTL_SEC = 3600                                       // 华为签发的 JWT 上限就是 1 小时
const SALT_LEN = 32                                            // PS256 的盐长度 = hLen = 32
const MAX_TOKENS = 1000                                        // v3 单次最多 1000 个 token
const SEND_TIMEOUT_MS = 8000
const TTL_MIN = 3600
const TTL_MAX = 1296000                                        // 华为 ttl 上限 15 天
const NOTIFY_TTL = 86400

// 推送 category（华为「场景化消息」分类）。MARKETING = 资讯营销 = 强制静默，不能用。
// WORK = 工作事项提醒（服务与通讯类），需要 AGC 先开通「通知消息自分类权益」；
// 未开通时华为会把未知 category 自动归回资讯营销类，仍然静默但不报错。
const DEFAULT_CATEGORY = 'WORK'

function msgOf(e) {
  try { return String((e && e.message) || e || '') } catch (e2) { return '' }
}

// 完整 push token 等于一张能往用户手机推通知的凭据，日志里只允许出现后 8 位。
function tailOf(v) {
  const s = String(v == null ? '' : v)
  return s.length <= 8 ? s : s.slice(-8)
}

// PEM 里字面的 \n 还原成真换行：AGC 下载的 json 偶尔被二次转义，
// 直接丢给 createPrivateKey 会报 "no start line"；真有换行了就别动。
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

// AGC 服务账号 json 的键有 snake_case 也有 camelCase（不同入口下载的文件不一样），
// 四个必需字段一个都不能少 —— 缺了就当没配，别拿着半个配置去签一个注定失败的 JWT。
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

// 配置来源优先级：调用方显式注入 → 环境变量 DSH_HW_PUSH_SA（整段 json）→ ~/.dsh 两个文件。
// opts 只为测试和「换个路径试试」存在，正常调用直接 loadSa()。
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
      // 环境变量写坏了别原地放弃，继续看文件（用户可能只是环境变量里留了半截）
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

// 只查文件在不在、读不读得动，绝不回内容。
function readable(p) {
  try { fs.accessSync(p, fs.constants.R_OK); return true } catch (e) { return false }
}

// 给 /cmd pushStatus 用：回答「到底缺什么」，人照着就能补上。
// 回的是：sa 有没有、projectId 是哪个、私钥 kid 尾号、期望路径（含每个路径在不在）、
// 手机上报过几条 token；私钥和 sub_account 一律不出门（网页、日志、手机都可能看到）。
// 注意别把完整 token 或私钥塞进来 —— 这个结果会被 App 直接显示。
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

  // 缺项清单：真机上一条条对着看，比猜「我明明配了」快得多。
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
  // 华为 push-send-alert 文档：testMessage=true 时单次推送仅能带 1 个 Token，
  // 每个项目每天 1000 条测试消息（所有设备共用）。实现里已按台拆开发，这里提醒额度消耗。
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

// 华为 v3 REST 不需要先换 access_token：自己签一个 PS256 JWT 直接当 Bearer。
// Header : {kid, typ:"JWT", alg:"PS256"}；Payload: {aud, iss: sub_account, iat, exp}。
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

// token 列表去重、去空、限流上限 1000。传字符串（手机端偶尔逗号拼）也吃。
// 也要吃对象：readPushTokens() 读回来的是 { token, deviceId, deviceModel, updatedAt }，
// 若直接 String(t) 会拼成 "[object Object]"，华为回 80300007 tokenFormatError。
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

// v3 请求体。clickAction.data.sessionId 是 App 收到通知点开后要跳的会话，
// 与 App 侧 onNewWant 里读的 key 逐字对齐，改名会断掉深链。
export function buildBody(opt) {
  const o = opt || {}
  const tokens = normTokens(o.tokens)

  // 🔴 2026-10-19 实测定论：category='MARKETING' 会被华为判为「资讯营销类 = 静默通知」，
  // 通知只进通知中心，不响铃/不振动/不锁屏/无横幅（hilog: remindFlags:0, isSilence）。
  // 服务与通讯类（WORK/ACCOUNT/IM…）才是锁屏+铃声+振动，但**必须先在 AGC 申请
  // 「通知消息自分类权益」**；未开通时华为会把未知 category 自动归回资讯营销类（不报错，仍然静默）。
  // 所以这里默认写 WORK（本应用是「电脑任务跑完了提醒我」，属工作事项提醒），
  // 权益一通过就自动生效，无需再改代码。可用 DSH_HW_PUSH_CATEGORY 临时覆盖。
  const category = String(o.category || process.env.DSH_HW_PUSH_CATEGORY || DEFAULT_CATEGORY)
  const notification = {
    category,
    title: String(o.title == null ? '' : o.title),
    body: String(o.body == null ? '' : o.body),
    clickAction: { actionType: 0, data: { sessionId: String(o.sessionId == null ? '' : o.sessionId) } },
    // 前台不弹系统通知，改由 App 的 pushService.receiveMessage 应用内提示（用户要求，见 m00480）
    // 后台照常弹通知栏；Push Kit 云端会按设备前后台状态决定投递方式
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

// 打一次华为接口。成功判据与文档一致：HTTP 2xx 且 body.code === '80000000'。
// 任何异常都收敛成 { ok:false }，绝不往上抛。
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
    // 失败不抛：调用方只记日志。code 可能是华为业务码，也可能是 HTTP 状态码。
    return { ok: false, code: code || String(res.status), msg: msg || ('HTTP ' + res.status), count: 0 }
  } catch (e) {
    return { ok: false, reason: 'exception', msg: msgOf(e), count: 0 }
  }
}

// 发一条通知。返回 { ok, code?, msg?, count? } 或 { ok:false, reason, msg? }。
//
// ⚠️ 华为硬限制（push-send-alert / 频控文档原文）：
//   「testMessage：测试消息标识，true 表示测试消息。每个项目每天限制发送 1000 条测试消息，
//     单次推送仅能发送一个 Token。」
// 也就是说 testMessage=true 时 target.token 里放两个以上会被整条拒掉，所以这里必须
// 逐个 token 拆成多次发送（任一失败不影响其它，额度按台数消耗）；
// testMessage=false（正式消息）没有这条限制，仍一次带上全部 token。
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

    // 测试消息：单次只能 1 个 token，逐个发。串行而不是并发，免得一秒钟打出一堆请求
    // 把当日 1000 条额度刷得更凶，也便于把每台的结果原样带回去。
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

// =============================================================================
// 会话完成检测：轮询会话列表，把 running 从 true 翻成 false 的那一刻当成「跑完了」。
//
// 为什么用轮询而不是监听事件：插件要能容忍宿主事件接口缺失/改名（this 版本 ctx.on
// 就出现过不可用），轮询 listSessions 是唯一稳定信号；15 秒粒度对「跑完推手机」足够。
// 为什么首次扫描只记基线：插件刚启动时列表里全是历史会话，不设基线会把所有旧会话
// 当成本次刚完成，一口气推几十条。
// =============================================================================

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

  // 同一个会话的同一次完成只推一次：key 用 <id>:<updatedAt>，
  // 同一个会话后面又跑一轮，updatedAt 会变，就能再推一次。
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
    // 不 await：推送慢或失败都不许拖住轮询，异常在这里就地吃掉。
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

  // scan 不碰定时器，测试可以直接喂数组验翻转逻辑。
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
    // 会话被删/归档后别把 id 永远揣在 Map 里，只保留本次列表出现过的
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

  // 宿主会话接口不可用时别每 15 秒刷一行日志（一天能写几千行），
  // 第一次 + 每 20 次（约 5 分钟）报一次足够定位。
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
      // unref：别让一个检测定时器把宿主进程吊着不退
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

  // 自检用：只暴露无副作用的计数，不给外部改内部状态的口子。
  function state() {
    return { running: !!timer, baselined, sessions: lastRunning.size, pushed: pushed.length }
  }

  return { start, stop, tick, scan, state }
}
