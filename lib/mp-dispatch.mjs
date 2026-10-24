import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ALLOW, MAX_UPLOAD_BYTES, SESSION_PAGE,
  approvalResponseBody, questionResponseBody,
  wrap, wrapBadRequest, wrapErr, wrapUnavailable,
} from './mp-contract.mjs'

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

function errOf(e) {
  const message = (e && e.message) || String(e)
  const code = (e && typeof e.code === 'string') ? e.code : 'error'
  return { code, message }
}

export function createDispatcher(ctx, log, tracker, state) {
  const ctl = ctx && typeof ctx.get === 'function' ? ctx.get('sessionController') : null
  const svc = (name) => (ctx && typeof ctx.get === 'function' ? ctx.get(name) : null)

  const can = (method) => !!ctl && typeof ctl[method] === 'function'
  const unsupported = (m) => wrapUnavailable('', `${m} 在 dsh-console 上不可用（宿主无此能力）`)

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

    all.sort((a, b) => b.updatedAt - a.updatedAt)
    const after = String((payload && payload.cursor) || '')
    if (after === '') {
      return { items: all.slice(0, SESSION_PAGE), hasMore: all.length > SESSION_PAGE, nextCursor: cursorOf(all[SESSION_PAGE - 1]) }
    }
    const idx = all.findIndex((s) => cursorOf(s) === after)
    if (idx === -1) {

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

  function extractEvents(h) {
    if (Array.isArray(h)) return h
    if (h && Array.isArray(h.events)) return h.events
    if (h && h.value && Array.isArray(h.value.events)) return h.value.events
    if (h && h.history && Array.isArray(h.history.events)) return h.history.events
    if (h && Array.isArray(h.records)) return h.records
    return []
  }

  const handlers = {

    'workspace.list': async (payload, rpcId) => {
      if (can('list')) {
        const r = await ctl.list({}, timeout(T_LIST))
        const items = (r && r.items ? r.items : r) || []

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

      return wrapUnavailable(rpcId, 'dsh-console 不能建工作区')
    },

    'host.listDirectory': async (payload, rpcId) => {
      const path = String((payload && payload.path) || '')
      if (path === '') return wrapBadRequest(rpcId, '缺少 path')
      const p = svc('host') || svc('fileSystem')
      if (p && typeof p.listDirectory === 'function') {
        return wrap(rpcId, await p.listDirectory({ path }, timeout(T_DEFAULT)))
      }

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

        const text = String(p.text || '')
        if (text !== '') content.push({ type: 'text', text })
        for (const a of (Array.isArray(p.attachments) ? p.attachments : [])) {
          const id = String((a && (a.attachmentId || a.id)) || a || '')
          if (id !== '') content.push({ type: 'attachment', attachmentId: id })
        }
      }

      if (content.length === 0) return wrapBadRequest(rpcId, '消息是空的')

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

    'skill.list': async (payload, rpcId) => {

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

      const text = `/${name}${p.args ? ' ' + String(p.args) : ''}`
      return wrap(rpcId, await ctl.prompt({
        requestId: `mp-${rpcId || Date.now().toString(36)}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, timeout(T_PROMPT)))
    },

    'mobile.pending': async (payload, rpcId) => {
      if (!tracker) return wrap(rpcId, { approvals: [], questions: [] })
      return wrap(rpcId, tracker.snapshot())
    },

    'mobile.respond': async (payload, rpcId) => {
      if (!tracker) return wrapUnavailable(rpcId, '没有审批追踪器')
      const p = payload || {}
      const sessionId = String(p.sessionId || '')
      const type = String(p.type || '')

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

      return wrap(rpcId, { key: '', unsupported: 'harmony-no-web-push' })
    },
    'push.subscribe': async (payload, rpcId) => wrap(rpcId, { ok: false, unsupported: true }),
    'push.unsubscribe': async (payload, rpcId) => wrap(rpcId, { ok: true }),
  }

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
