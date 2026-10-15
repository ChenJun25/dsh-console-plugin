/**
 * /mp/api/{method} 的 RPC 分发器。
 *
 * 把 mp 的 24 个方法映射到 dsh-console 手边真实有的东西 —— 也就是
 * sessionController 和几个 ctx 事件源。映射关系不是猜的：
 *
 *   - sessionController 的方法面读自 ~/.dsh/dsh-console.log 里插件自己的
 *     [probe] 输出（它启动时会把方法名打进日志），不是对着文档猜的；
 *   - mp 侧每个方法读的是 dsh-mobile-plus v0.5.3 的 lib/rpc.js。
 *
 * 13 个方法能直接转发，11 个在 dsh-console 这边没有对应能力。后者一律回
 * unavailable 信封（mp 对「能力不存在」的标准说法），绝不 throw —— 客户端
 * 按 code 分支，unavailable 会显示成一句提示，而崩掉会变成整页空白。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ALLOW, MAX_UPLOAD_BYTES, SESSION_PAGE,
  approvalResponseBody, questionResponseBody,
  wrap, wrapBadRequest, wrapErr, wrapUnavailable,
} from './mp-contract.mjs'

/** 上游超时。历史和大 prompt 慢，给得比 dsh-console 自己那套宽。 */
const T_HISTORY = 20_000
const T_LIST = 15_000
const T_PROMPT = 120_000
const T_DEFAULT = 15_000

function timeout(ms) {
  try {
    return AbortSignal.timeout(ms)
  } catch (_) {
    return undefined
  }
}

/** 把宿主抛出的错误压成 { code, message }，别把栈泄给客户端。 */
function errOf(e) {
  const message = (e && e.message) || String(e)
  const code = (e && typeof e.code === 'string') ? e.code : 'error'
  return { code, message }
}

/**
 * 建分发器。
 *
 * @param ctx        DSH Cordis 上下文，用来取 sessionController 和订阅事件
 * @param log        写日志的函数（dsh-console 有文件日志，别丢进 console.log）
 * @param tracker    审批/提问追踪器，由 index.js 注入（它已经在订阅那两个事件）
 * @param state      dsh-console 自己的运行时状态（读）
 */
export function createDispatcher(ctx, log, tracker, state) {
  const ctl = ctx && typeof ctx.get === 'function' ? ctx.get('sessionController') : null
  const svc = (name) => (ctx && typeof ctx.get === 'function' ? ctx.get(name) : null)

  /* ---- 能力探测：宿主版本不同，方法面也不同 ---- */

  const can = (method) => !!ctl && typeof ctl[method] === 'function'
  const unsupported = (m) => wrapUnavailable('', `${m} 在 dsh-console 上不可用（宿主无此能力）`)

  /**
   * 会话投影 → mp 客户端要的字段。
   * 客户端的 session-model.ts 读 sessionId / title / cwd / updatedAt / running /
   * pinned / model，所以这里必须给这些名字，不能给 dsh-console 面板那套。
   */
  function viewSession(s) {
    if (!s) return null
    const p = s.projections && s.projections.values ? s.projections.values : {}
    const id = String(s.sessionId || s.id || '')
    if (id === '') return null
    const sel = s.modelSelection || p.modelSelection || {}
    return {
      sessionId: id,
      title: String(s.title || p.title || ''),
      cwd: String(s.cwd || ''),
      updatedAt: Number(s.updatedAt) || 0,
      running: !!s.running,
      pinned: !!s.pinned,
      workspaceId: String(s.workspaceId || ''),
      model: String(sel.lastUsed || sel.next || ''),
      ...(state && state.pins && state.pins.has(id) ? { pinned: true } : {}),
    }
  }

  async function listSessions(payload) {
    if (!can('list')) throw new Error('这个 DSH 版本没有 sessionController.list')
    const r = await ctl.list({}, timeout(T_LIST))
    const items = (r && r.items ? r.items : r) || []
    const all = items.map(viewSession).filter(Boolean)
    // mp 用 `${updatedAt}:${sessionId}` 游标，客户端原样回传。
    all.sort((a, b) => b.updatedAt - a.updatedAt)
    const after = String((payload && payload.cursor) || '')
    if (after === '') {
      return { items: all.slice(0, SESSION_PAGE), hasMore: all.length > SESSION_PAGE, nextCursor: cursorOf(all[SESSION_PAGE - 1]) }
    }
    const idx = all.findIndex((s) => cursorOf(s) === after)
    if (idx === -1) {
      // 游认不出来（会话已删）时从头给，宁可重复也不要空白页。
      return { items: all.slice(0, SESSION_PAGE), hasMore: all.length > SESSION_PAGE, nextCursor: cursorOf(all[SESSION_PAGE - 1]) }
    }
    // The cursor names the LAST item of the previous page, so the next page
    // starts one past it. Slicing to idx + PAGE is the whole page; the boolean
    // then asks whether anything remains beyond it.
    const start = idx + 1
    const next = all.slice(start, start + SESSION_PAGE)
    return {
      items: next,
      hasMore: all.length > start + next.length,
      nextCursor: cursorOf(next[next.length - 1]),
    }
  }

  function cursorOf(s) {
    return s ? `${s.updatedAt}:${s.sessionId}` : ''
  }

  /** page/history 的返回形状很宽（{records} / {events} / {value:{events}} / 数组），全认。 */
  function extractEvents(h) {
    if (Array.isArray(h)) return h
    if (h && Array.isArray(h.events)) return h.events
    if (h && h.value && Array.isArray(h.value.events)) return h.value.events
    if (h && h.history && Array.isArray(h.history.events)) return h.history.events
    if (h && Array.isArray(h.records)) return h.records
    return []
  }

  /**
   * 逐个 RPC。返回的一定是 server-response 信封，绝不抛 ——
   * 外层 handler 收到非信封就会当成协议错误。
   */
  const handlers = {
    /* ---- 工作区 ---- */
    'workspace.list': async (payload, rpcId) => {
      if (can('list')) {
        const r = await ctl.list({}, timeout(T_LIST))
        const items = (r && r.items ? r.items : r) || []
        // 客户端按 workspaceId 取值，兼容旧的 id，所以两个都带。
        return wrap(rpcId, {
          items: items.map((s) => ({
            workspaceId: String(s.workspaceId || s.cwd || ''),
            id: String(s.workspaceId || s.cwd || ''),
            path: String(s.cwd || ''),
            title: String(s.title || ''),
            sessionIds: [],
            updatedAt: Number(s.updatedAt) || 0,
          })),
        })
      }
      if (can('projections')) {
        const p = await ctl.projections({}, timeout(T_LIST))
        const items = (p && p.items) || []
        return wrap(rpcId, {
          items: items.map((w) => ({
            workspaceId: String(w.workspaceId || w.id || ''),
            id: String(w.workspaceId || w.id || ''),
            path: String(w.path || w.cwd || ''),
            title: String(w.title || ''),
            sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds.map(String) : [],
            updatedAt: Number(w.updatedAt) || 0,
          })),
        })
      }
      return unsupported('workspace.list')
    },

    'workspace.create': async (payload, rpcId) => {
      // sessionController 没有「建工作区」这个概念，只能建会话。
      return wrapUnavailable(rpcId, 'dsh-console 不能建工作区')
    },

    'host.listDirectory': async (payload, rpcId) => {
      const path = String((payload && payload.path) || '')
      if (path === '') return wrapBadRequest(rpcId, '缺少 path')
      const p = svc('host') || svc('fileSystem')
      if (p && typeof p.listDirectory === 'function') {
        return wrap(rpcId, await p.listDirectory({ path }, timeout(T_DEFAULT)))
      }
      // 兜底：至少把目录本身的存在性告诉客户端，别假装成功。
      return wrap(rpcId, { path, entries: [], unavailable: true })
    },

    'agentPreset.list': async (payload, rpcId) => {
      const p = svc('agentPresets') || svc('presets')
      if (p && typeof p.list === 'function') {
        return wrap(rpcId, { items: await p.list({}, timeout(T_DEFAULT)) })
      }
      if (can('resolveAgent')) {
        return wrap(rpcId, { items: [], unavailable: true })
      }
      return unsupported('agentPreset.list')
    },

    /* ---- 会话 ---- */
    'session.list': (payload, rpcId) => listSessions(payload).then((v) => wrap(rpcId, v)),

    'session.create': async (payload, rpcId) => {
      if (!can('create')) return unsupported('session.create')
      const created = await ctl.create({
        ...(payload || {}),
        requestId: `mp-${rpcId || Date.now().toString(36)}`,
      }, timeout(T_DEFAULT))
      return wrap(rpcId, { ...(created || {}), view: viewSession(created) })
    },

    'session.history': async (payload, rpcId) => {
      if (!can('history')) return unsupported('session.history')
      const sessionId = String((payload && payload.sessionId) || '')
      if (sessionId === '') return wrapBadRequest(rpcId, '缺少 sessionId')
      const max = Number((payload && payload.maxMessages) || 50)
      const before = Number(payload && payload.beforeSeq)
      const req = { sessionId, limit: max }
      if (Number.isFinite(before) && before >= 0) req.beforeSeq = before
      const h = await ctl.history(req, timeout(T_HISTORY))
      const events = extractEvents(h)
      return wrap(rpcId, {
        sessionId,
        events,
        hasMore: events.length >= max,
        ...(h && h.maxSeq !== undefined ? { maxSeq: h.maxSeq } : {}),
      })
    },

    /**
     * 发消息。
     *
     * ⚠️ 请求体形状按 mp 的 rpc.js 抄，不是按直觉：mp 把 payload 整体透传给
     * 宿主（`{ requestId, clientTimeZone, ...next }`），文本与图片都在
     * `content` 数组里 —— 块类型是 DSH 官方的 PromptContentPart：
     *   { type:'text', text }
     *   { type:'image', mediaType:'image/png'|..., data: base64, name? }
     * 宿主自己会把 base64 提升成持久附件引用，所以这里不需要碰 attachments
     * 服务。之前这里拼的是 text + attachments，那是 Web 端的形状，错的。
     */
    'session.prompt': async (payload, rpcId) => {
      if (!can('prompt')) return unsupported('session.prompt')
      const p = payload || {}
      const sessionId = String(p.sessionId || '')
      if (sessionId === '') return wrapBadRequest(rpcId, '缺少 sessionId')

      const incoming = Array.isArray(p.content) ? p.content : null
      const content = []
      if (incoming) {
        for (const part of incoming) {
          if (!part || typeof part !== 'object') continue
          if (part.type === 'text' && typeof part.text === 'string' && part.text !== '') {
            content.push({ type: 'text', text: part.text })
          } else if (part.type === 'image' && typeof part.data === 'string' && part.data !== '') {
            const image = { type: 'image', mediaType: String(part.mediaType || 'image/jpeg'), data: part.data }
            if (typeof part.name === 'string' && part.name !== '') image.name = part.name
            content.push(image)
          }
        }
      } else {
        // 兼容只发 text 的老客户端。
        const text = String(p.text || '')
        if (text !== '') content.push({ type: 'text', text })
        for (const a of (Array.isArray(p.attachments) ? p.attachments : [])) {
          const id = String((a && (a.attachmentId || a.id)) || a || '')
          if (id !== '') content.push({ type: 'attachment', attachmentId: id })
        }
      }

      if (content.length === 0) return wrapBadRequest(rpcId, '消息是空的')

      // requestId 的兜底规则也与宿主一致：没有就用 rpcId，
      // 免得宿主去重认不出这次请求。
      let tz = ''
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
      } catch (_) {
        tz = ''
      }
      const request = {
        requestId: String(p.requestId || rpcId || `req-${Date.now().toString(36)}`),
        sessionId,
        mode: 'queue',
        content,
      }
      if (tz !== '') request.clientTimeZone = tz
      return wrap(rpcId, await ctl.prompt(request, timeout(T_PROMPT)) ?? { accepted: true })
    },

    'session.cancel': async (payload, rpcId) => {
      if (!can('cancel')) return unsupported('session.cancel')
      const sessionId = String((payload && payload.sessionId) || '')
      if (sessionId === '') return wrapBadRequest(rpcId, '缺少 sessionId')
      return wrap(rpcId, await ctl.cancel({ sessionId }, timeout(T_DEFAULT)))
    },

    'session.attachment': async (payload, rpcId) => {
      if (!can('attachment')) return unsupported('session.attachment')
      return wrap(rpcId, await ctl.attachment(payload || {}, timeout(T_DEFAULT)))
    },

    'session.models': async (payload, rpcId) => {
      if (!can('modelCatalog')) return unsupported('session.models')
      const v = await ctl.modelCatalog({}, timeout(T_DEFAULT))
      return wrap(rpcId, v)
    },

    'session.selectModel': async (payload, rpcId) => {
      if (!can('selectModel')) return unsupported('session.selectModel')
      const p = payload || {}
      const sessionId = String(p.sessionId || '')
      const model = String(p.model || '')
      if (sessionId === '' || model === '') return wrapBadRequest(rpcId, '缺少 sessionId 或 model')
      return wrap(rpcId, await ctl.selectModel({ sessionId, model }, timeout(T_DEFAULT)))
    },

    /* ---- 技能与命令 ---- */
    'skill.list': async (payload, rpcId) => {
      // probe 出来的方法面里没有 skill —— 宿主把技能挂在 commands 上。
      if (can('commands')) {
        const v = await ctl.commands({}, timeout(T_DEFAULT))
        return wrap(rpcId, { items: [], commands: v })
      }
      return unsupported('skill.list')
    },

    'command.list': async (payload, rpcId) => {
      if (!can('commands')) return unsupported('command.list')
      return wrap(rpcId, await ctl.commands({}, timeout(T_DEFAULT)))
    },

    'command.execute': async (payload, rpcId) => {
      const p = payload || {}
      const sessionId = String(p.sessionId || '')
      const name = String(p.name || '')
      if (sessionId === '' || name === '') return wrapBadRequest(rpcId, '缺少 sessionId 或 name')
      if (!can('prompt')) return unsupported('command.execute')
      // 宿主没有独立的 command.execute，只能以斜杠命令的形式发给会话。
      const text = `/${name}${p.args ? ' ' + String(p.args) : ''}`
      return wrap(rpcId, await ctl.prompt({
        requestId: `mp-${rpcId || Date.now().toString(36)}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, timeout(T_PROMPT)))
    },

    /* ---- 审批与提问 ---- */
    /**
     * 待决快照。客户端每 10s 轮询一次并按 rpcId 合并已填答案，
     * 所以这里只要给出「当前还挂着什么」就够了。
     */
    'mobile.pending': async (payload, rpcId) => {
      if (!tracker) return wrap(rpcId, { approvals: [], questions: [] })
      return wrap(rpcId, tracker.snapshot())
    },

    /**
     * 回审批/提问。请求体是平铺的 —— 宿主从 payload.rpcId 与 payload.approvalId
     * 里解析，没有信封级 rpcId。这点之前踩过，改成包一层会永远回
     * "unknown respond type"。
     */
    'mobile.respond': async (payload, rpcId) => {
      if (!tracker) return wrapUnavailable(rpcId, '没有审批追踪器')
      const p = payload || {}
      const sessionId = String(p.sessionId || '')
      const type = String(p.type || '')

      /* ⚠️ 不再强制 sessionId。宿主的 ApprovalRequestEvent / AskUserQuestionRequestEvent
         声明里压根没有 sessionId（只有 agent 等字段，asar 实锤），只是**老宿主**和
         test/mp-e2e.spec.mjs 用假宿主 emit 时会带上它。真正的对账键是 approvalId /
         rpcId（tracker 里就是按它们存的）。老代码在这里 `sessionId === ''` 直接挡回，
         真机上手机点的「允许」全被 400 拒掉、审批永远挂着 —— 这是用户在真机上
         「点了没反应」的插件侧根因。现在 sessionId 缺失只记一行日志。 */
      if (sessionId === '' && (type === 'approval' || type === 'question')) {
        log('[mp] 回执没带 sessionId（宿主事件不带此字段），按 ' + type + ' 的 id 对账')
      }

      if (type === 'approval') {
        const body = approvalResponseBody(sessionId, p)
        if (body.approvalId === '') return wrapErr(rpcId, 'bad-request', '缺少 approvalId')
        return wrap(rpcId, tracker.resolveApproval(body))
      }
      if (type === 'question') {
        const body = questionResponseBody(sessionId, p)
        if (body.rpcId === '') return wrapErr(rpcId, 'bad-request', '缺少 rpcId')
        return wrap(rpcId, tracker.resolveQuestion(body))
      }
      return wrapErr(rpcId, 'bad-request', 'unknown respond type')
    },

    /* ---- 杂项 ---- */
    'quota.read': async (payload, rpcId) => {
      const q = svc('quota')
      if (q && typeof q.read === 'function') return wrap(rpcId, await q.read({}, timeout(T_DEFAULT)))
      return wrap(rpcId, { unavailable: true })
    },

    'host.restart': async (payload, rpcId) => {
      return wrapUnavailable(rpcId, 'dsh-console 不重启宿主（那会把自己也杀掉）')
    },

    'session.pins': async (payload, rpcId) => {
      return wrap(rpcId, { sessionIds: [...((state && state.pins) || [])] })
    },

    'session.pin': async (payload, rpcId) => {
      const p = payload || {}
      const sessionId = String(p.sessionId || '')
      if (sessionId === '') return wrapBadRequest(rpcId, '缺少 sessionId')
      if (state && state.pins) {
        if (p.pinned === true) state.pins.add(sessionId)
        else state.pins.delete(sessionId)
      }
      return wrap(rpcId, { sessionId, pinned: p.pinned === true })
    },

    'push.key': async (payload, rpcId) => {
      // Web Push 在鸿蒙没有对应能力（客户端已确认不使用），如实回空。
      return wrap(rpcId, { key: '', unsupported: 'harmony-no-web-push' })
    },
    'push.subscribe': async (payload, rpcId) => wrap(rpcId, { ok: false, unsupported: true }),
    'push.unsubscribe': async (payload, rpcId) => wrap(rpcId, { ok: true }),
  }

  /**
   * 入口。返回信封，永远不抛。
   * 白名单外的method 也回信封（code=forbidden），因为客户端靠 code 区分
   * 「插件版本过旧」和「设备没配对」——抛异常会把这两个信号都丢掉。
   */
  return async function dispatch(method, payload, rpcId) {
    const h = handlers[method]
    if (!h) {
      log('[mp] 方法不在白名单: ' + method)
      return wrapErr(rpcId, 'forbidden', `unknown method: ${method}`)
    }
    try {
      return await h(payload || {}, rpcId)
    } catch (e) {
      const { code, message } = errOf(e)
      log('[mp] ' + method + ' 失败: ' + code + ' ' + message)
      return wrapErr(rpcId, code, message)
    }
  }
}

export { ALLOW, MAX_UPLOAD_BYTES }
