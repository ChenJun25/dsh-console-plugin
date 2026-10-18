import { PREFIX, ENDPOINTS, cookieValue, isRpcShaped, methodOf, wrapErr } from './mp-contract.mjs'

export function modelFromUA(ua) {
  const raw = String(ua || '')
  if (raw === '') return ''
  const seg = (raw.match(/\(([^)]*)\)/) || [])[1] || ''
  const SKIP = /^(linux|android|wv|mobile|phone|tablet|openharmony|harmonyos|windows|macintosh|intel|arm|x86|x64|applewebkit|khtml|gecko|like|safari|chrome|arkweb|en-us|zh-cn|zh|us|[a-z]{2}-[a-z]{2})/i
  for (const part of seg.split(';')) {
    const t = part.trim()
    if (t === '' || t.length < 3) continue
    if (SKIP.test(t)) continue
    if (/^[\d.\s]+$/.test(t)) continue
    if (/^(Build|AppleWebKit|Chrome|Version|Safari|ArkWeb|HuaweiBrowser)\b/i.test(t)) continue
    return t.replace(/\s*Build\/.*$/i, '').trim().slice(0, 80)
  }
  const m = raw.match(/(HUAWEI|HONOR|HUAWEI-?Nova|honor)\s+([^;)]+)/i)
  if (m) return m[0].trim().slice(0, 80)
  return ''
}

export function uidFromQuery(req) {
  try {
    const url = new URL(String((req && req.url) || '/'), 'http://x')
    return String(url.searchParams.get('deviceUid') || '').trim()
  } catch (e) { return '' }
}

export function accountFromQuery(req) {
  try {
    const url = new URL(String((req && req.url) || '/'), 'http://x')
    return {
      uid: String(url.searchParams.get('accountUid') || '').trim(),
      name: String(url.searchParams.get('accountName') || '').trim(),
    }
  } catch (e) { return { uid: '', name: '' } }
}

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

  const qa = accountFromQuery(req)
  const accUid = String(b.accountUid || '').trim() || qa.uid
  const accName = String(b.accountName || '').trim() || qa.name
  return {
    model: model.slice(0, 80), name: name.slice(0, 80), uid: uid.slice(0, 120),
    accountUid: accUid.slice(0, 120), accountName: accName.slice(0, 80)
  }
}

export function createMpBranch(deps) {
  const { dispatch, store } = deps
  const log = deps.log || (() => {})

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

    if (pathname === ENDPOINTS.accept) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return true }
      const body = await readJson(req, 4096)
      const token = String(body.token || '').trim()
      if (token === '') { json(res, 400, { ok: false, error: '缺少 token' }); return true }
      if (!store || typeof store.exchange !== 'function') {
        json(res, 501, { ok: false, error: '本插件未启用配对' })
        return true
      }

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

    if (gate(req, res)) return true

    if (isRpcShaped(pathname)) {
      const method = methodOf(pathname)

      if (method === null) { json(res, 200, wrapErr('', 'forbidden', 'method not allowed')); return true }
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return true }
      const body = await readJson(req)
      const rpcId = typeof body.rpcId === 'string' ? body.rpcId : ''
      const payload = body.payload && typeof body.payload === 'object' ? body.payload : {}
      json(res, 200, await dispatch(method, payload, rpcId))
      return true
    }

    json(res, 404, { ok: false, error: 'not-implemented', path: pathname })
    return true
  }
}

export function mountMpUpgrade(server, deps) {
  const { store, log, onUpgrade } = deps
  const say = log || (() => {})

  const onUp = (req, socket, head) => {
    const pathname = String(req.url || '/').split('?')[0]
    if (pathname !== ENDPOINTS.wsMux && pathname !== ENDPOINTS.wsHost) return

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
