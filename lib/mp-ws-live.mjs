import { PREFIX, ENDPOINTS, cookieValue, stripAcp } from './mp-contract.mjs'
import { acceptWebSocket } from './websocket.js'

export function toAppFrame(session, ev) {
  const out = framesFromEvent(session, ev)
  return out.length ? out[0] : null
}

const INJECT_SOURCE_KINDS = new Set([
  'team-message', 'time-context', 'runtime-context', 'agent-instructions',
  'skill-catalog', 'checkpoint', 'model-selection', 'subagent-settled',
  'agent-message', 'tool-jobs', 'repeat-tool-reminder', 'background-job',
  'ptc-mode',
])

const INJECT_TEXT_RES = [
  /^\s*<system-reminder>/i,
  /^\s*Time sampled while preparing turn /i,
  /^\s*Current runtime context\./i,
  /^\s*This is an automatically generated checkpoint /i,
  /^\s*\[model changed:/i,
  /^\s*Background subagent /i,
  /^\s*Team message team-message-/i,
  /^\s*Agent [0-9a-fA-F-]{8,} sent a message:/i,
  /^\s*background job /i,
  /^\s*<goal_round[\s>]/i,
]

function userSourceKind(data) {
  if (!data || typeof data !== 'object') return ''
  const s = data.source
  if (typeof s === 'string') return s
  if (s && typeof s === 'object') return String(s.kind || '')
  return ''
}

function userContentText(content) {
  if (content === undefined || content === null) return ''
  if (typeof content === 'string') return stripAcp(content)
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    if (b.type !== 'text') continue
    if (typeof b.text === 'string' && b.text !== '') parts.push(b.text)
  }
  return stripAcp(parts.join(String.fromCharCode(10)))
}

function isRealUserAsk(data) {
  if (!data || typeof data !== 'object') return false
  const k = userSourceKind(data)
  if (k === 'goal') return false
  if (k.indexOf('plugin:') === 0) return false
  if (INJECT_SOURCE_KINDS.has(k)) return false
  return true
}

function isInjectedAskText(text) {
  const t = String(text || '')
  if (t === '') return true
  for (const re of INJECT_TEXT_RES) { if (re.test(t)) return true }
  return false
}
export function framesFromEvent(session, ev) {
  const out = []
  if (!session || !ev || typeof ev !== 'object') return out
  const sid = String(session.id || (session.header && session.header.id) || '')
  if (!sid) return out
  const et = String(ev.type || '')
  if (et === 'assistant/message') {
    const d0 = ev.data || {}
    const st = d0.stream
    if (!Array.isArray(st)) return out
    const turn = Number(d0.turn) || 0
    const step = Number(d0.step) || 0
    for (const item of st) {
      if (!item || typeof item !== 'object') continue
      const it = item.type
      if (it !== 'text-chunks' && it !== 'reasoning-chunks') continue
      const arr = item.texts
      if (!Array.isArray(arr) || !arr.length) continue

      const s = stripAcp(arr.join(''))
      if (!s) continue
      out.push({
        type: 'session/event',
        sessionId: sid,
        event: {
          type: 'assistant/chunk',
          seq: Number(ev.seq) || 0,
          data: {
            turn: turn,
            step: step,
            chunk: {
              type: it === 'reasoning-chunks' ? 'reasoning-delta' : 'text-delta',
              text: s
            }
          }
        }
      })
    }
    return out
  }

  if (et === 'user/message') {
    const msg = ev.data || {}
    if (isRealUserAsk(msg)) {
      const text = userContentText(msg.content)
      if (text !== '' && !isInjectedAskText(text)) {
        out.push({
          type: 'session/event',
          sessionId: sid,
          event: {
            type: 'user/message',
            seq: Number(ev.seq) || 0,
            data: { text: text.length > 400 ? text.slice(0, 400) : text },
          },
        })
      }
    }
    return out
  }
  if (et !== 'assistant/chunk') return out
  const data = ev.data || {}
  const c = data.chunk
  if (!c || typeof c !== 'object') return out
  if (c.type !== 'text-delta' && c.type !== 'reasoning-delta') return out
  if (typeof c.text !== 'string' || c.text === '') return out
  const ctext = stripAcp(c.text)
  if (ctext === '') return out
  out.push({
    type: 'session/event',
    sessionId: sid,
    event: {
      type: 'assistant/chunk',
      seq: Number(ev.seq) || 0,
      data: { turn: data.turn, step: data.step, chunk: { type: c.type, text: ctext } },
    },
  })
  return out
}

function bridgeEventFrames(ctx, signal, log) {
  const queue = []
  let notify = null
  const wake = () => { if (notify) { const n = notify; notify = null; n() } }
  const push = (f) => { queue.push(f); wake() }
  const disposers = []
  let emitted = 0
  const on = (evt) => {
    if (typeof ctx.on !== 'function') return
    try {
      const d = ctx.on(evt, (a, b) => {
        if (evt === 'session/event') {
          const list = framesFromEvent(a, b)
          if (!list.length) return
          for (const f of list) {
            emitted++
            if (emitted <= 8) {
              const ld = (f.event && f.event.data) ? f.event.data : {}
              const ch = ld.chunk
              const lb = ch && typeof ch === 'object' ? ch.type : String(f.event && f.event.type)
              log('[mp-ws] 下发助手增量 ' + lb + '（turn ' + String(ld.turn) + '，第 ' + emitted + ' 帧）')
            }
            push(f)
          }
          return
        }

        push(b && typeof b === 'object' ? b : a)
      })
      if (typeof d === 'function') disposers.push(d)
    } catch (e) {
      log('[mp-ws] 订阅 ' + evt + ' 失败: ' + ((e && e.message) || e))
    }
  }
  on('session/event')
  on('approval/request')
  on('user-questions/request')

  const heartbeat = setInterval(() => { push({ type: 'pong' }) }, 10000)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  const cleanup = () => {
    clearInterval(heartbeat)
    for (const d of disposers) { try { d() } catch (e) {  } }
  }
  if (typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', cleanup, { once: true })
  }
  return async function* () {
    try {
      while (!signal.aborted) {
        while (queue.length) { yield queue.shift() }
        await new Promise((res) => {
          notify = res
          if (typeof signal.addEventListener === 'function') {
            signal.addEventListener('abort', res, { once: true })
          }
        })
      }
    } finally {
      cleanup()
    }
  }()
}

export function createLiveUpgrade(deps) {
  const log = deps.log || (() => {})
  const store = deps.store
  const tracker = deps.tracker

  const onStream = typeof deps.onStream === 'function' ? deps.onStream : null
  const wsPaths = new Set([ENDPOINTS.wsMux, ENDPOINTS.wsHost])

  return function onUpgrade(req, socket, head) {
    let pathname = '/'
    try { pathname = String(req.url || '/').split('?')[0] } catch (e) {  }

    pathname = pathname.replace(/^\/(?:dsh-console|dafeiyu|dsh-dafeiyu-panel)/, '') || '/'
    if (!wsPaths.has(pathname)) return

    const secret = cookieValue(req.headers.cookie)
    if (secret === '' || !store || typeof store.isPaired !== 'function' || !store.isPaired(secret)) {
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
      } catch (e) {  }
      log('[mp-ws] 握手被拒：Cookie 未登记')
      return
    }

    const pingLink = () => { if (onStream) { try { onStream(req, 'ping') } catch (e) {  } } }
    if (onStream) { try { onStream(req, 'open') } catch (e) {  } }
    log('[mp-ws] 实时流已连接 ' + pathname)
    acceptWebSocket(req, socket, head, {
      openFrames: (signal) => bridgeEventFrames(deps.ctx, signal, log),
      onFrame: (f) => {

        if (tracker && typeof tracker.onFrame === 'function') {
          try { tracker.onFrame(f) } catch (e) {  }
        }
      },

      touch: pingLink,
      onClose: () => {
        if (onStream) { try { onStream(req, 'close') } catch (e) {  } }
        log('[mp-ws] 实时流断开 ' + pathname)
      },
    })
  }
}
