/**
 * /mp/* 契约层 —— 让 dsh-console 能直接对 dsh-mobile-plus 的鸿蒙客户端说话。
 *
 * 背景：dsh-mobile-plus 是独立插件，走 ctx.webServer.register 注册 /mp/*，
 * 自带一套 RPC / 配对 / WebSocket。dsh-console 有自己的局域网服务
 * （lib/lan-server.mjs，纯 node:http，端口 8899）和另一套鉴权（token 头）。
 * 客户端只认 mp 的协议，所以这里把 mp 的契约原样实现一遍，让两个客户端
 * 都能连同一个插件，不必装第二个插件。
 *
 * 契约来源（不是猜的，是读 dsh-mobile-plus v0.5.3 源码核对过的）：
 *   - lib/constants.js  PREFIX='/mp'、COOKIE='mp_device'、ALLOW 24 个方法
 *   - lib/rpc.js        信封 { type:'server-response', rpcId, result:{ ok, value } }
 *   - lib/routes.js     路由表与鉴权门禁
 *   - lib/live-stream.js 帧形状（ready / session/event / approval/requested …）
 *
 * 这个文件刻意不 import 任何宿主 API：契约本身是纯逻辑，可以脱离 DSH 单测，
 * 也让「客户端要的」和「插件给的」能被同一份断言锁住。
 */

// ---- 契约常量（与 lib/constants.js 逐字对齐）----

export const PREFIX = '/mp'
export const COOKIE = 'mp_device'
export const TOKEN_TTL_MS = 2 * 60 * 60 * 1000
export const MAX_BODY = 12 * 1024 * 1024
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
export const SESSION_PAGE = 20

/**
 * RPC 白名单。名字与顺序都和宿主一致 —— contract 测试直接比对这两个列表，
 * 任何一侧改动都会立刻失败。
 *
 * 注意里面有三个 sessionController 上不存在的方法（session.attachment 有，
 * 但 skill.list / push.* 没有），它们走 unavailable 信封而不是崩溃。
 */
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

// ---- 路由表 ----

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

/**
 * 从请求路径认出 mp 的方法名，返回 null 表示不是 /mp/api/* 的调用。
 *
 * 宿主 routes.js 的做法是 slice 掉 `${PREFIX}/api/` 前缀再查白名单；这里照抄，
 * 但多挡一层：只认「前缀匹配且剩余部分不含斜杠」的方法名，避免
 * `/mp/api/session.list/extra` 这种畸形路径被误判成合法调用。
 */
export function methodOf(pathname) {
  const raw = String(pathname || '')
  if (!raw.startsWith(ENDPOINTS.rpcPrefix)) return null
  const rest = raw.slice(ENDPOINTS.rpcPrefix.length)
  if (rest === '' || rest.includes('/')) return null
  return isAllowed(rest) ? rest : null
}

/** 非白名单方法要走的是「方法不允许」而不是「路由不存在」，别混。 */
export function isRpcShaped(pathname) {
  return String(pathname || '').startsWith(ENDPOINTS.rpcPrefix)
}

// ---- 鉴权 ----

/**
 * 从 Cookie 头里取出 mp_device 的值。
 * 手写解析而不是引第三方：只有一个键，且要容忍多余空格和属性段。
 */
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

/** 配对成功时下发 Set-Cookie，属性与宿主一致。 */
export function deviceCookieHeader(secret, maxAgeSec = 60 * 60 * 24 * 365) {
  return `${COOKIE}=${encodeURIComponent(secret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`
}

// ---- 信封 ----

/**
 * 成功的 server-response。客户端的 unwrapEnvelope() 取的是 result.value，
 * 所以值必须放在 value 上，不能直接摊在 result 上。
 */
export function wrap(rpcId, value) {
  return { type: 'server-response', rpcId: rpcId || '', result: { ok: true, value } }
}

/**
 * 失败的 server-response。error 必须是 { code, message } 对象 —— 客户端要靠
 * code 区分「插件版本过旧」(forbidden) 和「本设备没配对」，笼统字符串会丢掉。
 */
export function wrapErr(rpcId, code, message, details) {
  const error = { code: String(code || 'error'), message: String(message || '') }
  if (details !== undefined) error.details = details
  return { type: 'server-response', rpcId: rpcId || '', result: { ok: false, error } }
}

/** 宿主 unavailable 的标准说法：能力不存在，而不是出错。 */
export function wrapUnavailable(rpcId, message) {
  return wrapErr(rpcId, 'unavailable', message || '服务不可用')
}

/** 请求体不是一个合法信封时的回包。 */
export function wrapBadRequest(rpcId, message) {
  return wrapErr(rpcId, 'bad-request', message || 'bad request')
}

/**
 * 拆出 { rpcId, payload }。
 * 客户端 POST 的体是 { rpcId, payload }；rpcId 缺失时按空串回，
 * 因为宿主也允许这样（见 rpc.js 里 requestId 的兜底逻辑）。
 */
export function parseRpcBody(body) {
  const raw = body && typeof body === 'object' ? body : {}
  const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : {}
  return { rpcId: typeof raw.rpcId === 'string' ? raw.rpcId : '', payload }
}

// ---- 实时帧 ----

/**
 * WebSocket 连上后第一帧。客户端认这个才把状态从 connecting 拉到 open，
 * 缺了它界面会一直转圈。
 */
export function readyFrame(channel, clientId) {
  return {
    type: 'ready',
    clientId: clientId || `${channel}-${Date.now().toString(36)}`,
  }
}

/** 客户端每隔一段时间发这个；回 pong 让它知道链路还活着。 */
export function pongFrame() {
  return { type: 'pong' }
}

/** 把宿主事件包成 mux 帧。与宿主 live-stream.js 的形状一致。 */
export function sessionEventFrame(sessionId, event) {
  return { type: 'session/event', sessionId: sessionId || '', event }
}

/** 会话列表页的运行指示器。host 通道专用。 */
export function sessionStatusFrame(sessionId, running) {
  return { type: 'host/session-status', sessionId: sessionId || '', running: running === true }
}

/**
 * 剥掉正文里的 ACP 元数据标记（宿主会把 <acp tokens="7" type="text">m00181</acp>
 * 当正文塞进 content / stream 里，真机截图实锤助手气泡直接显示出来）。
 *
 * 只剥**配对完整的 acp 标签**与自闭合 <acp … />：普通尖括号文本（<div>、a<b、1<2）
 * 不受影响。只有开标签没闭标签时**先看尾巴是正文还是残渣**（见
 * looksLikeAcpTailGarbage）：尾巴是正文 → 原样保留（宁可留一个可见的坏标签，
 * 也不吞掉后面的正常正文）；尾巴是畸形残片 → 从该 <acp 起到字符串结尾整段丢弃。
 *
 * 第 101 节 · task-4（问题清单 #56「ACP 残留 = 0」）：补的正是后半条。全量 33 个
 * 会话实测只剩 1 处未配对残片（session-7f37d36e-835e-4b66-adca-3f9289476031
 * turn 11 response 尾部：一个 acp 开标签后跟着 m04776 与全角竖线包裹的伪 DSML
 * 标签 parameter / invoke / calls），旧规则把它原样发给手机端气泡。
 *
 * 手写扫描而不是裸正则：① 嵌套也能配平；② 未配对可原样保留。
 * 客户端 Session.ets 的 cleanMd 也有一份同样的兜底（历史正文 / 流式正文）。
 */
/** <acp …> 之后没有 </acp> 时，这段尾巴是「被截断的坏标记残渣」还是「正常正文」？
 *  true  = 残渣（连同开标签整段丢弃）；false = 正文（开标签原样留下）。
 *
 * 真实样本（session-7f37d36e-835e-4b66-adca-3f9289476031 turn 11 response 尾部）：
 *   <acp tokens="5" string="true">m04776 后接全角竖线包裹的伪 DSML 标签，
 *   再往后就是串尾、没有 </acp>。
 *
 * 判定顺序（宁可留标记也不吞正文，所以每条都要求「确实是残渣特征」）：
 *  ① 尾巴全空 → 空标签残渣；
 *  ② 含全角竖线包裹的伪 DSML 标签 → 残渣；
 *  ③ 去掉标签碎片、mNNNNN 引用 id、空白与标点后什么都不剩 → 残渣；
 *  ④ 既无 CJK 也无连续英文字母、且剩余极短（≤12 码点）→ 残渣。
 * 有 CJK 的短尾巴（例如 m00181 后跟一句中文正文、只是没闭合标签）⇒ 判为正文，保留。
 */
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
    // 只认「完整标签」：<acp> / <acp 属性…> / <acp … />（<acpx 之类不算）
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
      /* 没配对（到串尾都找不到 </acp>）。分两种：尾巴是畸形残片 → 从 <acp 起到
         结尾整段丢弃（out 里已经只写了标签之前的正文）；尾巴是正常正文 →
         原样保留标签，不吞正文。第 101 节 · task-4：这一分支就是
         「ACP 残留 = 0」的最后漏口。 */
      if (looksLikeAcpTailGarbage(t.slice(tagEnd + 1))) break
      out += tag; i = tagEnd + 1; continue
    }
    i = j
  }
  return out
}

// ---- 审批 / 提问 ----

/**
 * plan-review 的判定规则，从宿主 public/js/net/pending.js 抄来。
 * 客户端的 PromptStore 也用同一套，两边不一致会出现「面板按提问处理、
 * 宿主按计划待审处理」然后回错类型。
 */
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

/**
 * 会话 id 回填 —— 宿主事件里根本没有 sessionId，只有 agent。
 *
 * asar 实锤（asar:289867-289869 的 Agent 声明原文）：
 *   export interface Agent { readonly id: SessionId; readonly session: Session; ... }
 * 也就是说 **agent.id 本身就是 SessionId**（宿主里 agent 与 session 共享同一 id；
 * AgentRegistry 的 typert lookup 拿 wire 'agentId' 也是当 SessionId 去 get(id)）。
 *
 * 宿主 ApprovalRequestEvent / AskUserQuestionRequestEvent 的声明里都没有 sessionId
 * （审批只有 agent/toolName/callId?/reason?/displayReason?/signal?；提问只有
 * questions/agent?/signal?/wait?），所以不打这里的话 frame.sessionId 恒为空串，
 * 手机端会把整条待决项丢掉（看不到卡片 / 点了也没用）。
 * 取值顺序：显式 sessionId（老宿主与既有契约测试在用）→ agent.id →
 * agent.session.id（宿主自己也这么取：this.agent.session.id）。提问事件的
 * agent 是可选的，而 waterfall 调用点会 `{ ...request, agent }` 合进取，通常有值。
 */
export function sessionIdOf(req) {
  const explicit = String((req && req.sessionId) || '')
  if (explicit !== '') return explicit
  const agent = req && req.agent
  if (!agent) return ''
  return String(agent.id || (agent.session && agent.session.id) || '')
}

/**
 * 把宿主的 approval/request 事件转成客户端认识的帧。
 * approvalId 只认宿主真给的 approvalId / id；真宿主两者都没有（见 addApproval：
 * 由 tracker 用 callId 或合成 id 补上）。sessionId 由 agent 回填（见 sessionIdOf）。
 */
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

/**
 * 客户端回审批时的请求体。宿主从 payload.rpcId / payload.approvalId 里解析，
 * 没有信封级 rpcId，所以字段必须平铺（这是之前踩过的坑）。
 */
export function approvalResponseBody(sessionId, payload) {
  return {
    type: 'approval',
    sessionId,
    approvalId: String((payload && payload.approvalId) || ''),
    rpcId: String((payload && payload.rpcId) || ''),
    outcome: String((payload && payload.outcome) || 'deny'),
  }
}

/**
 * 客户端回提问时的请求体。answers 每一项的 custom 为空时省略，
 * 否则空串会覆盖掉用户已选的选项。
 */
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

// ---- 待决快照 ----

/**
 * mobile.pending 的快照形状。
 *
 * 客户端每 10s 轮询一次并把结果合并进本地状态，合并时按 rpcId 保留用户
 * 已填的答案 —— 如果这里每次都把 answers 清空，用户打了一半的回答会消失。
 * answers 只在这里生成一次，之后由 mergePending 负责保留。
 */
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

/**
 * 合并轮询快照：保留已填答案。
 * 宿主每 10s 推一次空 answers，不合并的话用户输入会周期性消失。
 */
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
