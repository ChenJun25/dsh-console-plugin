import { PREFIX, ENDPOINTS, cookieValue, stripAcp } from './mp-contract.mjs'
import { acceptWebSocket } from './websocket.js'

export function toAppFrame(session, ev) {
  const out = framesFromEvent(session, ev)
  return out.length ? out[0] : null
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
              log('[mp-ws] 下发助手增量 ' + f.event.data.chunk.type + '（turn '
                + String(f.event.data.turn) + '，第 ' + emitted + ' 帧）')
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
