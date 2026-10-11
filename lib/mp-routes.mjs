/**
 * 把 mp 契约挂到 dsh-console 的局域网服务上。
 *
 * 为什么挂这儿而不是 DSH 的 webServer：
 *   lan-server.mjs 开头就写了原因 —— DSH 的 webServer 可能只听 127.0.0.1，
 *   局域网访问不到，所以当年自己起了个绑 0.0.0.0 的服务。鸿蒙客户端要连的
 *   正是局域网地址，所以也得挂在这儿。
 *
 * 与面板那条路的鉴权是**两套并存**的，不是替换：
 *   - 面板 / 微信小程序：x-dsh-console-token 头或 ?token= 参数（tokenOf()）
 *   - 鸿蒙客户端：mp_device Cookie（由 /mp/pair/accept 下发）
 * 两套互不干扰，因为路径前缀不同：/mp/* 走 Cookie，其它走 token。
 *
 * ⚠️ 必须挂在 handler 的**同步路径**上，不能另挂一个 'request' 监听器。
 * Node 的多个 'request' 监听器依次调用且互不等待，而 RPC 必须先读完 body
 * 才能回信封；等异步时 lan-server 的 handler 早已写完 404，响应就废了
 * （实测：期望 401 拿到 404）。所以这里导出的是一个「早返回分支」，
 * 由 lan-server.mjs 在 handler 里显式调用。
 */
import { PREFIX, ENDPOINTS, cookieValue, isRpcShaped, methodOf, wrapErr } from './mp-contract.mjs'

/**
 * 造一个能塞进 lan-server handler 的早返回分支。
 *
 * @param deps { dispatch, store, log }
 *        store 需提供 exchange(token) / isPaired(secret) / revoke(secret)
 * @returns (req, res, pathname) => Promise<boolean>  处理了就返回 true
 */
export function createMpBranch(deps) {
  const { dispatch, store } = deps
  const log = deps.log || (() => {})

  // 前缀要严：/mpx、/mppx 都不能被认领。
  const isMp = (pathname) => pathname === PREFIX || pathname.startsWith(PREFIX + '/')

  function json(res, code, obj) {
    const raw = JSON.stringify(obj)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(raw),
      'cache-control': 'no-store',
    })
    res.end(raw)
  }

  /**
   * 🔴 批次 H · task-6（#A3）· 从 User-Agent 里尽量抠出机型。
   * 客户端（鸿蒙 ArkWeb）自报 deviceModel 是首选；UA 只是兜底 ——
   * 面板上宁可显示一句「未知机型」，也不要让整个名单拿不到。
   * 实测 UA 形如：
   *   Mozilla/5.0 (Phone; OpenHarmony 5.0) … ArkWeb/… Mobile HuaweiBrowser/…
   *   Mozilla/5.0 (Linux; Android 12; HUAWEI Mate 60 Pro Build/HUAWEIMate60) …
   * 策略：取**第一个括号组**按 ';' 切开，丢掉纯系统词（Linux/Android x/…），
   * 剩下的第一段就是机型；再不行匹配 "HUAWEI/HONOR/… 后跟型号"。
   */
  function modelFromUA(ua) {
    const raw = String(ua || '')
    if (raw === '') return ''
    const seg = (raw.match(/\(([^)]*)\)/) || [])[1] || ''
    const SKIP = /^(linux|android|wv|mobile|phone|tablet|openharmony|harmonyos|windows|macintosh|intel|arm|x86|x64|applewebkit|khtml|gecko|like|safari|chrome|arkweb|en-us|zh-cn|zh|us|[a-z]{2}-[a-z]{2})/i
    for (const part of seg.split(';')) {
      const t = part.trim()
      if (t === '' || t.length < 3) continue
      if (SKIP.test(t)) continue
      if (/^[\d.\s]+$/.test(t)) continue              // 纯版本号
      if (/^(Build|AppleWebKit|Chrome|Version|Safari|ArkWeb|HuaweiBrowser)\b/i.test(t)) continue
      return t.replace(/\s*Build\/.*$/i, '').trim().slice(0, 80)
    }
    const m = raw.match(/(HUAWEI|HONOR|HUAWEI-?Nova|honor)\s+([^;)]+)/i)
    if (m) return m[0].trim().slice(0, 80)
    return ''
  }

  /**
   * 🔴 批次 H · task-6（#A3）· 这次请求能不能告诉我们「这是哪台手机」。
   * 优先级：客户端自报（body.deviceModel/deviceName，最准）
   *         → User-Agent 兜底抠机型
   *         → 空串（面板显示「未知机型」，不编造）。
   */
  function aboutOf(req, body) {
    const b = body || {}
    const model = String(b.deviceModel || '').trim() || modelFromUA(req && req.headers && req.headers['user-agent'])
    const name = String(b.deviceName || '').trim()
    return { model: model.slice(0, 80), name: name.slice(0, 80) }
  }

  /**
   * 配对门禁。返回 true 表示已经回了拒绝。
   * 没配对一律 401；配了但不认识这台设备是 403 + forbidden —— 客户端靠这个
   * code 区分「插件版本过旧」和「本设备没配对」，两者处置完全不同。
   */
  function gate(req, res) {
    const secret = cookieValue(req.headers.cookie)
    if (secret === '') {
      json(res, 401, { ok: false, error: 'not-paired' })
      return true
    }
    if (store && typeof store.isPaired === 'function' && !store.isPaired(secret)) {
      json(res, 403, { ok: false, code: 'forbidden', error: 'device-not-paired' })
      return true
    }
    /* 🔴 批次 H · task-6（#A3）：这台设备真的带着有效 Cookie 打进来了 ——
       记一次活动（面板「哪些在线」就靠它），顺手用 UA 补机型（只填空位）。
       放在 isPaired 之后：没配对的请求不许污染登记表。 */
    if (store && typeof store.touch === 'function') store.touch(secret, aboutOf(req, null))
    return false
  }

  function readJson(req, limit) {
    const max = Number(limit) || 12 * 1024 * 1024
    return new Promise((resolve) => {
      let raw = ''
      req.on('data', (c) => {
        raw += c
        if (raw.length > max) { req.destroy(); resolve({}) }
      })
      req.on('end', () => {
        try { resolve(raw ? JSON.parse(raw) : {}) } catch (e) { resolve({}) }
      })
      req.on('error', () => resolve({}))
    })
  }

  return async function branch(req, res, pathname) {
    if (!isMp(pathname)) return false

    // ---- 配对：必须免鉴权，否则客户端换不到 Cookie ----
    if (pathname === ENDPOINTS.accept) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return true }
      const body = await readJson(req, 4096)
      const token = String(body.token || '').trim()
      if (token === '') { json(res, 400, { ok: false, error: '缺少 token' }); return true }
      if (!store || typeof store.exchange !== 'function') {
        json(res, 501, { ok: false, error: '本插件未启用配对' })
        return true
      }
      /* #A3：把客户端自报的机型随配对一起登记（老客户端不带这两个字段 ⇒ 回落到 UA）。 */
      const r = store.exchange(token, aboutOf(req, body))
      if (!r || !r.secret) {
        log('[mp] 配对失败：码无效或已过期')
        json(res, 403, { ok: false, code: 'forbidden', error: '配对码无效或已过期' })
        return true
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `mp_device=${encodeURIComponent(r.secret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`,
      })
      res.end(JSON.stringify({ ok: true, deviceId: r.deviceId || 'mp-device' }))
      return true
    }

    if (pathname === ENDPOINTS.status) {
      if (gate(req, res)) return true
      json(res, 200, { ok: true, paired: true })
      return true
    }

    if (pathname === ENDPOINTS.revoke) {
      if (gate(req, res)) return true
      if (store && typeof store.revoke === 'function') store.revoke(cookieValue(req.headers.cookie))
      json(res, 200, { ok: true })
      return true
    }

    // ---- 其余一律要 Cookie ----
    if (gate(req, res)) return true

    if (isRpcShaped(pathname)) {
      const method = methodOf(pathname)
      // 形状对了但方法不在白名单：这是 forbidden，不是 404。
      if (method === null) { json(res, 200, wrapErr('', 'forbidden', 'method not allowed')); return true }
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return true }
      const body = await readJson(req)
      const rpcId = typeof body.rpcId === 'string' ? body.rpcId : ''
      const payload = body.payload && typeof body.payload === 'object' ? body.payload : {}
      json(res, 200, await dispatch(method, payload, rpcId))
      return true
    }

    // 其余 /mp/*（上传、附件等）还没实现，如实说，不假装成功。
    json(res, 404, { ok: false, error: 'not-implemented', path: pathname })
    return true
  }
}

/**
 * 挂 WebSocket upgrade。node:http 不会把 upgrade 请求交给 'request'，
 * 必须单独监听；ArkTS 客户端连的是 /mp/api/ws/mux 与 /ws/host。
 *
 * @param deps { store, log, onUpgrade(req, socket, head, channel) }
 * @returns 卸载函数
 */
export function mountMpUpgrade(server, deps) {
  const { store, log, onUpgrade } = deps
  const say = log || (() => {})

  const onUp = (req, socket, head) => {
    const pathname = String(req.url || '/').split('?')[0]
    if (pathname !== ENDPOINTS.wsMux && pathname !== ENDPOINTS.wsHost) return
    // 握手前先验 Cookie：未配对一律拒，客户端会退回配对页。
    const secret = cookieValue(req.headers.cookie)
    if (secret === '') {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      say('[mp] WS 握手被拒：未配对')
      return
    }
    if (store && typeof store.isPaired === 'function' && !store.isPaired(secret)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      say('[mp] WS 握手被拒：设备未登记')
      return
    }
    if (typeof onUpgrade === 'function') {
      onUpgrade(req, socket, head, pathname === ENDPOINTS.wsMux ? 'mux' : 'host')
    }
  }

  server.on('upgrade', onUp)
  say('[mp] WS upgrade 路由已挂载')
  return () => server.removeListener('upgrade', onUp)
}
