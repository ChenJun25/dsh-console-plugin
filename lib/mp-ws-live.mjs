/**
 * 🔴 0.4.3 · mp 实时流 WebSocket（真打字机的服务端半边）。
 *
 * 背景：dsh-harmony 工程的客户端（LiveClient.ets）连 /mp/api/ws/mux 收实时
 * token——但 dsh-console 的 lan-server 此前只挂了门禁（mountMpUpgrade），
 * 没有帧引擎，upgrade 传 onUpgrade:null，WS 根本建立不起来
 * （手机端打字机不动的服务端根因，2026-10-05 实锤）。
 *
 * 本文件把两块拼上：
 *   ① 帧引擎 acceptWebSocket —— 原样来自 dsh-harmony patches/websocket.js
 *      （零依赖 RFC 6455，313 项断言验证过），拷为 ./websocket.js
 *   ② 帧源 —— 订阅宿主 ctx.on('session/event' | 'approval/request' |
 *      'user-questions/request') 转 async generator（mp-support 的
 *      subscribeHostEvents 早就把 sources 清单列好了，就差这个放大器）
 *
 * 鉴权沿用 mp 那套：mp_device Cookie，未登记直接 401。
 */
import { PREFIX, ENDPOINTS, cookieValue, stripAcp } from './mp-contract.mjs'
import { acceptWebSocket } from './websocket.js'

/**
 * 🔴 0.4.5 · 宿主事件 → App 认得的帧（**翻译层**，本文件最关键的一段）。
 *
 * 为什么必须有它（2026-10-06 实测定位，live-check 假手机抓的真帧）：
 *   宿主 `session/event` 的**回调签名是两参** `(session, event)`，
 *   实证见本仓 lib/index.js:180 的注释（来自 dsh-session/lib/index.js:1462
 *   的 callbackArgs = [session, event]）。event = { type, seq, time, data }。
 *
 *   而 ws 放大器原来写的是 `ctx.on('session/event', (data) => push(data))` ——
 *   只取了**第一个参数**，推到手机上的是 **session 对象**（sess 里有 log 数组，
 *   所以抓包看到的是 `{log:[{type:'permission/preset'…}]}`）。
 *   手机端 asTokenChunk() 要求 `frame.type==='session/event' && frame.event.type==='assistant/chunk'`
 *   → 一个 token 都认不出来 → **打字机永远不动**（握手是 101、帧也真的在到）。
 *
 * 所以这里做两件事：取出第二个参数（真正的 event），再包成客户端契约形状：
 *   { type:'session/event', sessionId, event:{ type:'assistant/chunk', seq, data:{turn,step,chunk} } }
 * 客户端 protocol.ts 的 asTokenChunk 正是按这个形状读的（四种 chunk 形状全兼容）。
 *
 * 只透传 assistant/chunk（文本增量）—— 其它事件形态客户端不认，透传只会污染。
 */
export function toAppFrame(session, ev) {
  const out = framesFromEvent(session, ev)
  return out.length ? out[0] : null
}

/* 🔴 0.4.8 · 宿主不发 assistant/chunk，增量在 assistant/message.data.stream。
   实证（_sess_log.jsonl 55 类事件）：assistant/chunk = 0 次；
   text-chunks 384 / reasoning-chunks 2324，texts 是逐字数组，join('') 即本批文本。
   这里把每个批次翻成客户端 asTokenChunk 认得的 assistant/chunk 帧。 */
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
      /* 🔴 第 98 节 · 这条路把 assistant/message 的 text-chunks 直推手机，
         此前完全不剥 ACP（宿主把 <acp tokens="7" type="text">m00181</acp>
         当正文塞进 stream）——手机端气泡因此能看到裸标记。
         ⚠️ chunk 是碎片，被切开跨批的标签这里剥不掉（
         实测 openOnly=6 / closeOnly=0），残留由客户端 cleanMd 兜底。 */
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

/**
 * 把宿主事件流桥成 async generator（acceptWebSocket 的 openFrames 契约）。
 * ⚠️ session/event 的回调是 (session, event) 两参 —— 别再写成单参取 data，
 *    那样推出去的是 session 对象，手机端一辈子认不出来（见 toAppFrame 注释）。
 */
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
        /* approval/request、user-questions/request 也走两参：
           第二个参数才是请求体，取不到再退回第一个（旧调用面兜底）。 */
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
  /* 🔴 0.4.5 · 文本心跳（治「会话页过几秒动一下」）。
   *
   * 客户端（LiveClient）有个看门狗：24s 内没收到**文本帧**就判定半死连接、
   * 强制重连；而重连成功会触发一次全量 load() + 清流式态 → 整屏重渲染，
   * 用户看到的就是「过一会儿画面跳一下」。空闲会话根本没有 assistant/chunk
   * 可发，只有控制帧 ping —— 但 ArkTS 的 WebSocket 不会把控制帧暴露成
   * 'message' 事件，所以 lastFrameAt 永远不更新，看门狗必然周期性开火。
   * 解法：每 10s 推一个**文本** `{"type":"pong"}`（客户端 onText 会先更新
   * lastFrameAt，再认出 type==='pong' 忽略它）。
   */
  const heartbeat = setInterval(() => { push({ type: 'pong' }) }, 10000)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  const cleanup = () => {
    clearInterval(heartbeat)
    for (const d of disposers) { try { d() } catch (e) { /* 忽略 */ } }
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

/**
 * 造 lan-server 用的 upgrade handler（server.on('upgrade', handler)）。
 * @param deps { ctx, log, store:{isPaired(secret)}, tracker:{onFrame(frame)} }
 */
export function createLiveUpgrade(deps) {
  const log = deps.log || (() => {})
  const store = deps.store
  const tracker = deps.tracker
  /* 🔴 第191节 · 链路灯回调（lan-server.noteStreamLink）。没有它时全部行为与老版一致。 */
  const onStream = typeof deps.onStream === 'function' ? deps.onStream : null
  const wsPaths = new Set([ENDPOINTS.wsMux, ENDPOINTS.wsHost])

  return function onUpgrade(req, socket, head) {
    let pathname = '/'
    try { pathname = String(req.url || '/').split('?')[0] } catch (e) { /* 忽略 */ }
    /* 🔴 与 lan-server HTTP 路由同一套前缀剥离 —— 手机连的是
     * ws://ip:8899/dsh-console/mp/api/ws/mux（base 带 /dsh-console 前缀），
     * 不剥的话永远匹配不上，WS 建不起来（HTTP 侧有剥、upgrade 侧漏了）。 */
    pathname = pathname.replace(/^\/(?:dsh-console|dafeiyu|dsh-dafeiyu-panel)/, '') || '/'
    if (!wsPaths.has(pathname)) return

    // 门禁：与 mountMpUpgrade 同一套 —— mp_device Cookie 必须是已登记设备
    const secret = cookieValue(req.headers.cookie)
    if (secret === '' || !store || typeof store.isPaired !== 'function' || !store.isPaired(secret)) {
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
      } catch (e) { /* 忽略 */ }
      log('[mp-ws] 握手被拒：Cookie 未登记')
      return
    }

    /* 🔴 第191节 · 用户 m00174：手机连上 WS 后就不再打 HTTP 探活了，两条链路灯因此
       既没人续期（要等 2 分钟 TTL 才灭）、App 被划掉后也没人熄灯。把 WS 的
       连接 / 每 10 秒心跳 / 断开 三个时机都报给 lan-server：
         open  ⇒ 记一笔在场（与 HTTP 探活同一套换链判据）
         ping  ⇒ 心跳即续期
         close ⇒ 这一链上再没有活跃流就**立刻熄灯**（不等 TTL） */
    const pingLink = () => { if (onStream) { try { onStream(req, 'ping') } catch (e) { /* 忽略 */ } } }
    if (onStream) { try { onStream(req, 'open') } catch (e) { /* 忽略 */ } }
    log('[mp-ws] 实时流已连接 ' + pathname)
    acceptWebSocket(req, socket, head, {
      openFrames: (signal) => bridgeEventFrames(deps.ctx, signal, log),
      onFrame: (f) => {
        // 审批/提问帧喂给轮询 tracker，两条通道状态保持一致
        if (tracker && typeof tracker.onFrame === 'function') {
          try { tracker.onFrame(f) } catch (e) { /* 忽略 */ }
        }
      },
      /* 心跳续期：每 10 秒一次，等价于 HTTP 探活那一发（第191节接线前这里是空钩子）。 */
      touch: pingLink,
      onClose: () => {
        if (onStream) { try { onStream(req, 'close') } catch (e) { /* 忽略 */ } }
        log('[mp-ws] 实时流断开 ' + pathname)
      },
    })
  }
}
