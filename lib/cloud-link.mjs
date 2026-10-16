/*
 * 云链路 —— 插件实例（这台电脑）跟云端控制台之间的那条线（第131节 · task-1）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
/* 🔴 G58-A · §A4：云端 register 下发的隧道参数落盘到 tunnel.mjs 的**自动文件**。
   路径常量只认 tunnel.mjs 这一个真相源，别在这边再拼一份（两处写死迟早漂移）。 */
import { TUNNEL_AUTO_PATH } from './tunnel.mjs'

/** 云端基址默认值（不带尾斜杠；路径由 mod 自己拼）。 */
export const DEFAULT_CLOUD_BASE = 'https://gaoshou25.cn/api/cloud'
/** 单请求超时：8 秒。 */
export const CLOUD_TIMEOUT_MS = 8000
/** 心跳间隔：60 秒（不含 jitter —— 单测要能精确断言调用次数）。 */
export const HEARTBEAT_MS = 60 * 1000
/** 首拍延迟：3 秒（Lead 冻结）。给启动流程一点喘息，别和 register 挤在同一个 tick。 */
export const FIRST_TICK_MS = 3000
/**
 * 落盘位置（Lead 2026-10-12 冻结的 storePath 默认值）：
 * 与 dsh-console-token.json 同目录（~/.dsh），插件重装不连坐。
 * 里面存 nodeId（随机串，一旦生成永不改变）+ 已绑定 user + 缓存的 shortId/vipExpireMs。
 */
export const DEFAULT_STORE_FILE = path.join(os.homedir(), '.dsh', 'dsh-console-cloud.json')
/** 旧名（第131节早期草稿叫它 nodeId 文件）；保留别名，免得接线方踩空。 */
export const DEFAULT_NODE_FILE = DEFAULT_STORE_FILE

/**
 * 生成一个新的 nodeId。32 个十六进制字符，跟访问码一个量级。
 * 值本身没有任何含义，只是「这台电脑」在云端的身份凭据。
 */
export function newRawNodeId() {
  let out = ''
  while (out.length < 32) out += Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0')
  return out.slice(0, 32)
}

/** 只认 8~64 位的字母数字（含 - 和 _）；其他一律当没有。 */
export function isValidNodeId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v)
}

/** 去空白后的非空字符串才算「有值」。 */
function text(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : ''
}

/** 云端回来的数字一律规整成非负整数（垃圾/负数 => 0，绝不让 NaN 漏到面板）。 */
function num(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n)
}

/** 从 user 里只挑白名单字段，避免把 App 传进来的杂项原样塞给云端。 */
function pickUser(u) {
  if (!u || typeof u !== 'object') return null
  const out = { uid: text(u.uid), name: text(u.name), avatar: text(u.avatar) }
  if (!out.uid && !out.name && !out.avatar) return null
  return out
}

/** 云端出的短 ID：去空白，最多 32 字符，别让它污染缓存。 */
function pickShortId(v) {
  const s = text(v)
  return s.length > 32 ? s.slice(0, 32) : s
}

/** 解析云端响应体：空体 / 非 JSON / 数组 / 字符串 一律 null，任何形状都不许抛。 */
function safeJson(body) {
  if (body == null) return null
  if (typeof body === 'object') return Array.isArray(body) ? null : body
  try {
    const j = JSON.parse(String(body))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null
  } catch (e) { return null }
}

/** 兜底错误文案：绝不让 error 是 undefined / '[object Object]'。 */
function fail(msg) {
  const s = text(msg)
  return { ok: false, error: s || '云端暂时联系不上' }
}

/**
 * 读落盘 store（破损 / 读不了 / 形状不对 => 空对象，调用方当作全新机器处理）。
 * 只认白名单四个键，别把文件里的杂项读进来。
 */
function readStore(file) {
  try {
    if (!file || !fs.existsSync(file)) return {}
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    if (isValidNodeId(parsed.nodeId)) out.nodeId = String(parsed.nodeId).trim()
    if (isValidNodeId(parsed.shortId)) out.shortId = String(parsed.shortId).trim()
    if (typeof parsed.vipExpireMs === 'number') out.vipExpireMs = num(parsed.vipExpireMs)
    if (parsed.bound && typeof parsed.bound === 'object' && !Array.isArray(parsed.bound)) {
      const u = pickUser(parsed.bound)
      if (u) out.bound = Object.assign({}, u, { ms: num(parsed.bound.ms) })
    }
    return out
  } catch (e) { return {} }
}

/**
 * 创建云链路实例。
 *
 * 返回对象（Lead 冻结的最小面）：
 *   snapshot()  只读缓存快照，**永不抛**；云端不可达时 online=false / offline=true
 *   bind(user)  绑定用户
 *   redeem(code) 兑换体验码
 *   tick()      心跳一拍（打 /status）
 *   另有 register/status/start/stop/startHeartbeat/stopHeartbeat/setBound/nodeId/shortId
 *
 * @param {object} opts
 *   getConfig   插件配置读取（() => config）；有 nodeId 就用它
 *   saveConfig  配置写回（(patch) => void）；落盘 nodeId 的第一选择
 *   base        云端基址（优先于 DSH_CLOUD_API 与默认值）
 *   file        nodeId 落盘文件（默认 ~/.dsh/dsh-console-cloud-node.json）
 *   fetch       注入的 fetch（单测用；缺省 globalThis.fetch）
 *   timeoutMs   单请求超时（默认 8000）
 *   heartbeatMs 心跳间隔（默认 60000；传 0 / false 表示不起心跳）
 *   autoStart   是否在 start() 里先打一次 register（默认 true）
 *   nodeId      直接注入 nodeId（跳过落盘；单测用）
 *   platform    上报的系统标识（默认 process.platform）
 *   log         日志回调（默认静默；插件日志由 index.js 统一收）
 */
export function createCloudLink(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  /* 落盘文件（Lead 冻结名 storePath）：缺省 ~/.dsh/dsh-console-cloud.json。
     opts.file 是早期草稿的名字，保留当别名。 */
  const storePath = text(opts.storePath) || text(opts.file) || DEFAULT_STORE_FILE
  /* 隧道自动文件（§A4）：默认 ~/.dsh/dsh-console-tunnel.auto.json；单测用 opts.autoPath 注入临时路径，
     绝不允许单测碰到真实的手写配置或宿主文件。 */
  const tunnelAutoPath = text(opts.autoPath) || TUNNEL_AUTO_PATH
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : CLOUD_TIMEOUT_MS
  /* 心跳间隔默认 60s（Lead 冻结）。传 heartbeatMs:0/false 表示不起心跳（单测用）。 */
  const heartbeatMs = Number(opts.heartbeatMs) > 0 ? Number(opts.heartbeatMs) : HEARTBEAT_MS
  /* 首次心跳延迟：默认 3s（Lead 冻结），把启动瞬间的 register 错开，别挤在一起。 */
  const firstDelayMs = Number(opts.firstDelayMs) >= 0 ? Number(opts.firstDelayMs) : FIRST_TICK_MS
  /* 面板配置里的 cloud 段（可能 {}）：只有 nodeId 一个键会用到，读不到就退回落盘文件。 */
  const config = opts.config && typeof opts.config === 'object' ? opts.config : {}
  /* Lead 冻结签名里的两个落盘钩子（index.js 传进来时优先用配置）：
     getConfig() -> 插件配置对象；saveConfig({ nodeId }) -> 写回配置。
     没传就退回 ~/.dsh 的 nodeId 文件（与 dsh-console-token.json 同目录、同样 0600）。 */
  const getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : null
  const saveConfig = typeof opts.saveConfig === 'function' ? opts.saveConfig : null
  /** 构造后是否自动 start()（打一次 register + 起心跳）。默认 true；单测传 false。 */
  const autoStart = opts.autoStart !== false
  /** start() 里是否先打一次 register。默认 true。 */
  const initialRegister = opts.initialRegister !== false
  const platform = text(opts.platform) || (() => {
    try { return text(process.platform) } catch (e) { return '' }
  })()

  /**
   * base 在构造时就定下来（而不是每次请求现读环境变量）：
   * 插件里环境变量是启动一次就固定的，单测也才能注入。
   * 优先级：opts.base > DSH_CLOUD_API > 默认值；尾斜杠一律去掉。
   */
  const base = (text(opts.base) || text(process.env.DSH_CLOUD_API) || DEFAULT_CLOUD_BASE)
    .replace(/\/+$/, '')

  /* fetch 三态：
       opts.fetch 是函数       -> 用它（单测/自定义）
       opts.fetch === null/false -> 明确表示「没有 fetch」，绝不回落到全局 fetch
                                   （单测拿它验「当前环境没有 fetch」的分支，
                                    也防止测试无意间打到真云端）
       没传                     -> 全局 fetch（老 Node 没有则 null，call() 会回错误对象） */
  const doFetch = (opts.fetch === null || opts.fetch === false)
    ? null
    : (typeof opts.fetch === 'function'
      ? opts.fetch
      : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null))

  /**
   * 从插件配置里读 nodeId。两条路都试：getConfig()（index.js 注入的读函数）
   * 优先，其次构造时传进来的 config.cloud 段。抛错 / 形状不对一律当没有。
   */
  function cfgNodeId() {
    if (getConfig) {
      try {
        const c = getConfig()
        const id = c && typeof c.nodeId === 'string' ? c.nodeId.trim() : ''
        if (isValidNodeId(id)) return id
      } catch (e) {}
    }
    const id2 = config && typeof config.nodeId === 'string' ? config.nodeId.trim() : ''
    return isValidNodeId(id2) ? id2 : ''
  }

  /**
   * 把内存缓存整份写回落盘 store（Lead 冻结：nodeId + bound + 缓存的 shortId/vipExpireMs）。
   * 两条路都试：插件配置（saveConfig({nodeId})）优先，storePath 文件兜底。
   * 目录自己 mkdir（-p 语义），文件 0600 —— 与 dsh-console-token.json 同规矩。
   * **永不抛**：两条都失败就留在内存，本次生命周期仍然稳定，只是重启会换。
   */
  function persistStore() {
    let ok = false
    if (saveConfig) {
      try { saveConfig({ nodeId }); ok = true } catch (e) { ok = false }
    }
    const data = { nodeId }
    if (shortId) data.shortId = shortId
    if (vipExpireMs) data.vipExpireMs = vipExpireMs
    if (bound) data.bound = { uid: bound.uid, name: bound.name, avatar: bound.avatar, ms: num(bound.ms) }
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true })
      fs.writeFileSync(storePath, JSON.stringify(data, null, 2), { mode: 0o600 })
      ok = true
    } catch (e) {
      if (!ok) log('[cloud] 落盘失败（' + ((e && e.message) || e) + '），本次仅内存有效')
    }
    return ok
  }

  /**
   * 🔴 G58-A · §A4：把云端下发的隧道参数落盘到**自动文件**（tunnelAutoPath）。
   * 为什么单独一个文件：手写文件是用户自己维护的；云端值随时会变（短号/域名/locations），
   * 这里每次拿到就**整份覆盖**这一个文件，绝不往用户手写的 TUNNEL_CONFIG_PATH 里写一个字。
   * tunnel.mjs 的 readTunnelConfig() 把两层合并、**自动文件优先** ⇒ 新用户「装上即自动有隧道」
   * （改造前没有手写文件就整条静默关闭）。
   * 形状与 cloud.py 的 tunnel_config_for() 一一对应：
   *   { enabled:true, type:'http', name, serverAddr, serverPort, authToken, customDomains, locations, publicUrl }
   * 永不抛（与 persistStore 同规矩）：写不了只记一句日志，本次进程内 shortId 照常可用。
   */
  function writeAutoTunnel(t) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return false
    const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter((x) => x !== '') : [])
    const data = {
      enabled: true,
      /* 云端只下发 http（vhost 按 customDomains/locations 分派）；缺省也给 http ——
         tcp 需要 remotePort，云端这条链路根本不下发它。 */
      type: text(t.type) || 'http',
      name: text(t.name),
      serverAddr: text(t.serverAddr),
      serverPort: num(t.serverPort),
      authToken: text(t.authToken),
      customDomains: arr(t.customDomains),
      locations: arr(t.locations),
      publicUrl: text(t.publicUrl),
      updatedMs: Date.now()
    }
    try {
      fs.mkdirSync(path.dirname(tunnelAutoPath), { recursive: true })
      fs.writeFileSync(tunnelAutoPath, JSON.stringify(data, null, 2), { mode: 0o600 })
      log('[cloud] 隧道自动配置已落盘：type=' + data.type + ' locations=' + JSON.stringify(data.locations))
      return true
    } catch (e) {
      log('[cloud] 隧道自动配置落盘失败（' + ((e && e.message) || e) + '），本次仅内存有效')
      return false
    }
  }

  /* ---- 先读一次落盘 store：nodeId 与缓存的 shortId/vip/绑定都在里面 ---- */
  const disk = readStore(storePath)

  /* ---- 内存缓存（单一数据源：面板与 /info.cloud 都从这里读）----
     shortId：云端下发的公网短 ID；'' = 还没注册成功（先用盘上缓存顶着，离线也能显示）
     vipExpireMs：VIP 到期毫秒时间戳；0 = 没有
     online / lastSeenMs：云端状态（或本地成功通信后的乐观值）
     bound：最后一次成功绑定的 {uid,name,avatar,ms}；null = 没绑过 */
  let shortId = disk.shortId || ''
  let vipExpireMs = disk.vipExpireMs || 0
  let online = false
  let lastSeenMs = 0
  let bound = disk.bound || null

  let heartbeatTimer = null
  let firstTickTimer = null
  let inflightPromise = null
  let inflight = false

  /** 把「缓存的 shortId/vip/绑定」落回磁盘（只在真的变了时调，省 IO）。 */
  let lastPersisted = ''
  function persistIfChanged() {
    const key = shortId + '|' + vipExpireMs + '|' + (bound ? bound.uid + ':' + bound.name + ':' + bound.avatar : '')
    if (key === lastPersisted) return false
    lastPersisted = key
    return persistStore()
  }

  // ---- nodeId：一旦生成永不改变（写盘成功后才返回，避免「这次用了下次又换」）----
  let nodeId = text(opts.nodeId)
  if (!isValidNodeId(nodeId)) nodeId = cfgNodeId()
  if (!isValidNodeId(nodeId)) nodeId = disk.nodeId || ''
  if (!isValidNodeId(nodeId)) {
    nodeId = newRawNodeId()
    persistStore()
  }


  /** 本地记一笔「刚刚通信成功」：online 立刻亮，不用等下一次 status。 */
  function noteActivity(t) {
    const now = Number(t) || Date.now()
    lastSeenMs = now
    online = true
  }

  /**
   * 把云端一份节点快照合并进缓存。
   * 只覆盖云端明确给了的字段：某次没回 shortId，不能把上一次的擦掉。
   */
  function applyNode(j, t) {
    if (!j || typeof j !== 'object') return
    const sid = pickShortId(j.shortId)
    if (sid) shortId = sid
    if (j.vipExpireMs != null) vipExpireMs = num(j.vipExpireMs)
    if (j.online != null) online = j.online === true
    if (j.lastSeenMs != null) lastSeenMs = num(j.lastSeenMs)
    const u = pickUser(j.user)
    if (u) bound = Object.assign({}, u, { ms: Number(t) || Date.now() })
    // 云端给了新数据就顺手落盘：重启后（甚至离线）面板还能显示上次的短 ID / VIP。
    persistIfChanged()
    /* 🔴 G58-A · §A4：register / bind / status 三个响应体各带一个 tunnel 字段（cloud.py 三处接线），
       这里统一在 applyNode 收口 —— 三条路都会经过它，拿到就整份刷自动文件。
       register() 的**返回值一个字不加**（cloud-link.spec.mjs 对它有 deepEqual 严格断言）。 */
    if (j.tunnel && typeof j.tunnel === 'object') writeAutoTunnel(j.tunnel)
  }

  /**
   * 单次云请求。永不 throw：
   *   没注入 fetch（老 Node）        -> {ok:false,error:'当前环境没有 fetch'}
   *   超时 / 断网 / DNS 失败          -> {ok:false,error:'云端超时'|'网络错误：...'}
   *   HTTP 非 2xx                    -> {ok:false,error:'云端返回 HTTP 500'}
   *   200 但体不是 JSON 对象          -> {ok:false,error:'云端响应格式不对'}
   */
  async function call(pathname, body) {
    if (!doFetch) return fail('当前环境没有 fetch')
    const ctrl = new AbortController()
    const timer = setTimeout(() => { try { ctrl.abort() } catch (e) {} }, timeoutMs)
    let r = null
    try {
      r = await doFetch(base + pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal
      })
    } catch (e) {
      clearTimeout(timer)
      const m = (e && e.message) || String(e)
      return fail(e && e.name === 'AbortError' ? '云端超时' : '网络错误：' + m)
    }
    clearTimeout(timer)
    if (!r || typeof r !== 'object') return fail('云端响应格式不对')
    const status = Number(r.status) || 0
    let raw = null
    try { raw = typeof r.json === 'function' ? await r.json() : r.body } catch (e) { raw = null }
    if (status && (status < 200 || status >= 300)) {
      const j0 = safeJson(raw)
      const msg = j0 ? text(j0.error) : ''
      return { ok: false, error: msg || ('云端返回 HTTP ' + status), status }
    }
    const j = safeJson(raw)
    if (!j) return fail('云端响应格式不对')
    return { ok: true, status, body: j }
  }

  /**
   * 注册（幂等）：同一个 nodeId 重复注册，云端必须回同一个 shortId 且不重置 VIP。
   * 本地策略：已经有 shortId 时默认跳过网络请求；要强制刷用 register({ force: true })。
   */
  async function register(o2 = {}, user) {
    if (!o2.force && shortId) return { ok: true, shortId, vipExpireMs, cached: true }
    const u = pickUser(user || o2.user)
    const payload = { nodeId }
    if (platform) payload.platform = platform
    if (u) payload.user = u
    const res = await call('/register', payload)
    if (!res.ok) return res
    const j = res.body
    if (j.ok === false) return fail(j.error)
    const t = Date.now()
    applyNode(j, t)
    noteActivity(t)
    log('[cloud] 注册成功 shortId=' + (shortId || '(无)'))
    return { ok: true, shortId, vipExpireMs, vipDays: num(j.vipDays), allow: j.allow === true }
  }

  /**
   * 绑定用户：云端在 nodeId 不存在时会自己先 register，这边不用管。
   * 成功即把 bound 记进缓存（面板与 /info.cloud 立刻能看到）。
   */
  async function bind(user) {
    const u = pickUser(user)
    if (!u) return fail('用户信息不完整')
    const res = await call('/bind', { nodeId, user: u })
    if (!res.ok) return res
    const j = res.body
    if (j.ok === false) return fail(j.error)
    const t = Date.now()
    applyNode(j, t)
    bound = Object.assign({}, u, { ms: t })
    noteActivity(t)
    persistIfChanged()
    log('[cloud] 绑定成功 shortId=' + (shortId || '(无)'))
    return { ok: true, shortId, vipExpireMs }
  }

  /**
   * 兑换体验码。云端失败也是 HTTP 200 + { ok:false, error }：
   *   体验码格式不对 / 体验码不存在 / 体验码已被使用 / 体验码已过期
   * 文案原样带回给 App，这边不翻译不改写。
   */
  async function redeem(code) {
    const c = text(code)
    if (!c) return fail('体验码格式不对')
    const res = await call('/redeem', { nodeId, code: c })
    if (!res.ok) return res
    const j = res.body
    if (j.ok === false) return fail(j.error)
    const t = Date.now()
    applyNode(j, t)
    noteActivity(t)
    log('[cloud] 兑换成功 +' + num(j.addedDays) + ' 天，VIP 到 ' + vipExpireMs)
    return { ok: true, addedDays: num(j.addedDays), vipExpireMs, shortId }
  }

  /** 查云端状态（心跳打的就是它）：刷新 shortId / vip / online / lastSeen / bound。 */
  async function status() {
    if (!nodeId) return fail('nodeId 不可用')
    const res = await call('/status', { nodeId })
    if (!res.ok) return res
    const j = res.body
    if (j.ok === false) return fail(j.error)
    const t = Date.now()
    applyNode(j, t)
    return {
      ok: true,
      shortId,
      vipExpireMs,
      online,
      lastSeenMs,
      user: bound ? { uid: bound.uid, name: bound.name, avatar: bound.avatar } : null
    }
  }

  /**
   * 给面板 / App 读的只读快照。**永不抛**（契约要求）：
   *   - 正常：{ ok:true, nodeId, shortId, vipExpireMs, online, lastSeenMs, bound, offline }
   *     offline = !online（云端还没联系上 / 已经掉了），调用方据此显示「离线」。
   *   - 内部出任何意外：{ ok:false, offline:true, ...安全默认值 }，绝不把异常扔出去。
   * 返回的是拷贝，调用方改它不会污染缓存。
   */
  function snapshot() {
    try {
      const b = bound
        ? { uid: bound.uid, name: bound.name, avatar: bound.avatar, ms: num(bound.ms) }
        : null
      return {
        ok: true,
        nodeId,
        shortId,
        vipExpireMs,
        online,
        lastSeenMs,
        bound: b,
        offline: !online
      }
    } catch (e) {
      return { ok: false, offline: true, nodeId: '', shortId: '', vipExpireMs: 0,
        online: false, lastSeenMs: 0, bound: null }
    }
  }

  /** 插件/App 侧拿到绑定信息时反向写入缓存（不走网络）。 */
  function setBound(user) {
    const u = pickUser(user)
    bound = u ? Object.assign({}, u, { ms: Date.now() }) : null
    persistIfChanged()
    return snapshot()
  }

  /**
   * 心跳一拍：打一次 /status。**同一时刻只允许一发在飞** ——
   * 上一发还没回来（比如断网卡满 8 秒）就跳过这一拍，请求不会越堆越多。
   * 单次失败不影响下一拍（只写日志）。永不抛。
   */
  function tick() {
    if (inflight) return inflightPromise
    inflight = true
    const p = (async () => {
      try {
        const r = await status()
        if (!r.ok) log('[cloud] 心跳失败：' + r.error)
        return r
      } catch (e) {
        // status 自身承诺不抛；这一层是双保险，绝不让定时器把进程带崩。
        log('[cloud] 心跳异常：' + ((e && e.message) || e))
        return fail((e && e.message) || e)
      } finally {
        inflight = false
      }
    })()
    inflightPromise = p
    return p
  }

  /**
   * 起心跳定时器。timer.unref() 是硬要求：
   * 心跳绝不能成为「DSH 退了进程还留着」的理由。
   */
  function startHeartbeat(ms) {
    if (heartbeatTimer) return false
    const every = Number(ms) > 0 ? Number(ms) : heartbeatMs
    if (!every) return false
    /* Lead 冻结：首拍延迟 3s，之后每 60s 一拍。首拍用 setTimeout 单独扛，
       免得「第一次要等满 60s」——App 那边等不起。 */
    if (!firstTickTimer && firstDelayMs > 0) {
      const t1 = setTimeout(() => { firstTickTimer = null; tick() }, firstDelayMs)
      if (typeof t1.unref === 'function') t1.unref()
      firstTickTimer = t1
    }
    const timer = setInterval(() => { tick() }, every)
    if (typeof timer.unref === 'function') timer.unref()
    heartbeatTimer = timer
    return true
  }

  /** 停心跳（stop() 会调它；重复调安全）。 */
  function stopHeartbeat() {
    const had = heartbeatTimer != null || firstTickTimer != null
    if (firstTickTimer) {
      try { clearTimeout(firstTickTimer) } catch (e) {}
      firstTickTimer = null
    }
    if (heartbeatTimer) {
      try { clearInterval(heartbeatTimer) } catch (e) {}
      heartbeatTimer = null
    }
    return had
  }

  /** 退出前的等待点：把还在飞的那一发等完（带超时，绝不卡死）。 */
  function drain(ms) {
    const wait = Number(ms) > 0 ? Number(ms) : 0
    if (!inflightPromise || !wait) return Promise.resolve()
    return Promise.race([
      inflightPromise.catch(() => {}),
      new Promise((r) => { const t2 = setTimeout(r, wait); if (typeof t2.unref === 'function') t2.unref() })
    ])
  }

  /**
   * 启动：可选先打一次 register（autoStart !== false），再起心跳。
   * 永不抛，返回值只描述「这一步发生了什么」，好让 index.js 打日志。
   */
  async function start() {
    let first = null
    if (initialRegister) {
      try { first = await register() } catch (e) { first = fail((e && e.message) || e) }
    }
    startHeartbeat()
    return { ok: true, shortId, vipExpireMs, heartbeat: heartbeatTimer != null, first }
  }

  /** 停：清定时器 + 等最后那一发（最多 1 秒，避免拖住进程退出）。 */
  async function stop() {
    stopHeartbeat()
    await drain(1000)
    return true
  }

  const api = {
    get base() { return base },
    get timeoutMs() { return timeoutMs },
    get storePath() { return storePath },
    get heartbeatMs() { return heartbeatMs },
    get nodeId() { return nodeId },
    get shortId() { return shortId },
    // 云端四招（契约要求 snapshot/bind/redeem/tick 四项，register/status 是底层）
    register,
    status,
    bind,
    redeem,
    tick,
    // 缓存
    snapshot,
    setBound,
    persistStore,
    // 生命周期
    start,
    stop,
    startHeartbeat,
    stopHeartbeat
  }

  /* 🔴 工厂侧自启动（契约硬要求）：index.js 可能只 `const cloud = createCloudLink({...})`
     而不显式 start()。这种情况下注册与心跳也**必须**起来，否则 App 永远拿不到公网短 ID。
     整个 self-start 包在 try/catch + .catch 里：工厂调用者绝不能因为云端/网络问题被打断。
     测试请传 autoStart:false。 */
  if (autoStart) {
    try {
      Promise.resolve().then(() => api.start()).catch((e) => {
        log('[cloud] 自启动失败：' + ((e && e.message) || e))
      })
    } catch (e) {
      log('[cloud] 自启动失败：' + ((e && e.message) || e))
    }
  }

  return api
}

export default {
  createCloudLink,
  DEFAULT_CLOUD_BASE,
  CLOUD_TIMEOUT_MS,
  HEARTBEAT_MS,
  DEFAULT_NODE_FILE
}

