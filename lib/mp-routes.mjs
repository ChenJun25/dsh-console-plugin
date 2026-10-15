/**
 * 把 mp 契约挂到 dsh-console 的局域网服务上。
 *
 * 为什么挂这儿而不是 DSH 的 webServer：
 *   lan-server.mjs 开头就写了原因 —— DSH 的 webServer 可能只听 127.0.0.1，
 *   局域网访问不到，所以当年自己起了个绑 0.0.0.0 的服务。鸿蒙客户端要连的
 *   正是局域网地址，所以也得挂在这儿。
 *
 * 与面板那条路的鉴权是**两套并存**的，不是替换：
 *   - 面板 / 手机端：x-dsh-console-token 头或 ?token= 参数（tokenOf()）
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
 * 🔴 第170节 · 修复「面板已连接手机台数虚高」（Bug B）。
 *
 * 这两个函数原来是 createMpBranch() 的**闭包私有**函数，只有 accept / gate 两条
 * 手机通路能用到。lan-server.mjs 的 /mp-cookie（已配对设备免输码换 Cookie）当初
 * 只把 6 位面板码递给 issueForCode()，**手机自报的 deviceUid 被整条链路吃掉了** ——
 * 结果 createDeviceStore.mint() 拿不到 uid，每次重连都新开一行（用户实测 1 台真机
 * 攒出 15 行）。现在把同一套解析逻辑导出，让 /mp-cookie 那条通路也能带上身份。
 *
 * ⚠️ 导出只是搬个家：函数体一个字没改，accept / gate 的调用点也不变。
 * 归一范围与 mp-routes 内的 80/80/120 上限一致（model/name/uid 三个 key 的取值
 * 优先级也与原来的 aboutOf 完全相同：body 优先，query 兜底，UA 最后兜底）。
 */
export function modelFromUA(ua) {
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
 * 🔴 第135节 · task-5（#A3 数据面）· 可选身份字段 deviceUid（**手机自己的设备标识**）。
 * 抠不到就是空串 ⇒ store 退回 deviceId 语义（各算一台，行为与老版一致）。
 * ⚠️ 它**不是**云端 bound.uid（那是账号 openId，同一个账号下两台手机会撞车）；
 *    那个值只由 lan-server 从 cloud 快照补到 cloudUid，绝不参与去重。
 */
/* 🔴 第193节 · task-1（B）：App 会在 query 上多带两个键（空串不追加）：
   accountUid  = 手机登录账号的华为 openId（hwOpenId 优先，否则 hwUid）
   accountName = 手机登录账号昵称（hwNick）
   **只读、不兜底**：手机上没登录 / 老 App 不带这两个键 ⇒ 空串。
   这里绝不拿本机云绑定补 —— App 侧靠它判「这台手机登录的账号是不是我自己」。 */
export function uidFromQuery(req) {
  try {
    const url = new URL(String((req && req.url) || '/'), 'http://x')
    return String(url.searchParams.get('deviceUid') || '').trim()
  } catch (e) { return '' }
}

/** 手机自报的登录账号（query 上的 accountUid / accountName）。抠不到就是空串。 */
export function accountFromQuery(req) {
  try {
    const url = new URL(String((req && req.url) || '/'), 'http://x')
    return {
      uid: String(url.searchParams.get('accountUid') || '').trim(),
      name: String(url.searchParams.get('accountName') || '').trim(),
    }
  } catch (e) { return { uid: '', name: '' } }
}

/**
 * 这次请求能不能告诉我们「这是哪台手机」。优先级：客户端自报（body.deviceModel/
 * deviceName，最准）→ query（App 那条「字段挂 query」的通路）→ User-Agent 兜底抠机型
 * → 空串（面板显示「未知机型」，不编造）。
 *
 * 🔴 第170节：body 的两个 key 一个字都没改（App 侧 LanClient.ets:3502-3506 /
 * 3544-3556 写死了它们）；这里**只新增** query 上的 deviceModel/deviceName 兜底，
 * 供 /mp-cookie 这种「只带 query、不带 body」的通路使用。取值顺序仍是「后写的优先
 * 于先写的」，与改动前逐字一致，不会改变任何既有输入的解析结果。
 */
export function aboutOf(req, body) {
  const b = body || {}
  let q = null
  try {
    const url = new URL(String((req && req.url) || '/'), 'http://x')
    q = {
      deviceModel: String(url.searchParams.get('deviceModel') || '').trim(),
      deviceName: String(url.searchParams.get('deviceName') || '').trim(),
    }
  } catch (e) { q = null }
  const qm = q ? q.deviceModel : ''
  const qn = q ? q.deviceName : ''
  const model = String(b.deviceModel || '').trim() || qm
    || modelFromUA(req && req.headers && req.headers['user-agent'])
  const name = String(b.deviceName || '').trim() || qn
  const uid = String(b.deviceUid || '').trim() || uidFromQuery(req)
  /* 🔴 第193节 · task-1（B）· 手机自报的登录账号：**body 优先，其次 query**。
     ⚠️ 契约（与 App 侧冻结）：这两个字段**绝不允许任何本机云绑定兜底** ——
     手机没自报就是空串。老插件认不得新键只会忽略 ⇒ 向后兼容；
     不带新键的既有输入解析结果与改动前逐字一致。 */
  const qa = accountFromQuery(req)
  const accUid = String(b.accountUid || '').trim() || qa.uid
  const accName = String(b.accountName || '').trim() || qa.name
  return {
    model: model.slice(0, 80), name: name.slice(0, 80), uid: uid.slice(0, 120),
    accountUid: accUid.slice(0, 120), accountName: accName.slice(0, 80)
  }
}

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
      /* 🔴 安全红线：先过门禁 —— 没有合法已配对 Cookie 一律 401/403。
         绝不因为 body 里带了 deviceUid 就放行：deviceUid 是手机自报的明文，
         谁都能编一个；只有 Cookie 才能证明「这台设备真的配过对」。 */
      if (gate(req, res)) return true
      /* 🔴 第194节 · task-9：设备自己在 App「节点管理」里请求下线 ——
         POST { deviceUid } ⇒ 按手机自报的 uid 删掉它名下所有记录（面板列表同步消失）。
         老客户端不带 body / 老 store 没有 revokeUid / uid 为空 ⇒ 逐字保持旧行为
         （只删当前这张 Cookie 对应的那条记录，回 {ok:true}）。 */
      if (req.method === 'POST') {
        const body = await readJson(req, 4096)
        const uid = String(body.deviceUid || '').trim()
        if (uid !== '' && store && typeof store.revokeUid === 'function') {
          const removed = store.revokeUid(uid)
          json(res, 200, { ok: true, removed })
          return true
        }
      }
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
