/**
 * 局域网服务 —— 手机小程序连过来的那条通道
 *
 * 为什么单独起服务，不挂在 DSH 的 webServer 上？
 *   DSH 的 webServer 可能只听 127.0.0.1（局域网访问不到）。
 *   自己起一个绑 0.0.0.0 的小服务最省事、最可控。
 *
 * 安全：
 *   - 面板显示的二维码和 6 位码都只是「本机可达即可」
 *   - 但 /sessions /cmd 这两个能操控 DSH 的，必须带访问码
 *   - 6 位配对码是一次性的：换到访问码就立刻作废
 */
import os from 'node:os'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
/* 🔴 第130节 · 插件侧安全硬化：Web 控制台页面**彻底关闭**，不再 import web-console.mjs 的 webHtml。
   ⚠️ 文件本体（lib/web-console.mjs）保留不动，只是全仓再无引用（grep 已确认）。 */
/* 🔴 批次 H · task-6（#A3）：解析 mp_device Cookie，把「这台手机在场」记到设备登记表。
   mp-contract.mjs 是零依赖的纯函数模块，不会跟本文件成环。 */
import { cookieValue } from './mp-contract.mjs'
/* 🔴 第170节 · Bug B：/mp-cookie 也要带上手机自报的身份（deviceUid 等），
   复用 mp-routes 里同一套解析（aboutOf 只是从闭包搬成导出，函数体没改）。
   ⚠️ 不成环：mp-routes.mjs 只 import mp-contract.mjs，不 import 本文件。 */
import { aboutOf } from './mp-routes.mjs'

// ⚠️ 真实监听端口的共享盒子。
//    端口可能被系统自动顺延，必须用 listen 之后的真实值；
//    而且模块级的函数（拼二维码地址）也要用到它。
const boundPortRef = { value: 0 }

const PAIR_TTL = 15 * 60 * 1000   // 6 位码 15 分钟过期
// 「手机在线」的判定窗口：最近这么长时间内收到过带对访问码的请求就算在线。
// 小程序没有后台心跳，只有开页面/操作时才发请求（首页 onShow、下拉刷新、发指令），
// 所以 2 分钟是一个折中：太短会频繁闪断，太长则人走了还显示在线。
const PHONE_TTL = 2 * 60 * 1000
/* 🔴 第169节 · task-6 · 「局域网直连」链路灯的有效窗口。
   以前那颗灯只有一个布尔 localLink，置 true 之后**永不复位**：本机任何一次
   127.0.0.1 的请求（面板探活 / 宿主内部请求 / 本机浏览器）都能把它永久点亮，
   手机早就断开了面板还显示「已连接」（用户 2026-10-13 附截图报的假绿）。
   现在只记「最近一次真的从局域网/本机网卡进来的时刻」，读取时按本 TTL 判活。
   取值 = PHONE_TTL（2 分钟）：手机端 /info 心跳是 60s 一发（App Index.ets:289
   HEARTBEAT_MS），2 分钟至少两发、留一整发余量，灯不会闪；与「手机在场」同口径。 */
const LOCAL_LINK_TTL = PHONE_TTL
/* 🔴 第125节 · task-7（方案 C）：逐设备「在线」的判定窗口。
   与 mp-support.mjs:19 的 DEVICE_ONLINE_TTL 同值（10 分钟）—— 面板 onlineCount 一直用它，
   phoneOnline 以前只认 2 分钟的全局单灯，两边口径不一，手机连着也常显灰。
   ⚠️ 故意在这里再写一份字面量：LAN 服务器是零依赖模块，不值当为这一个数去 import 整条
   mp 栈（mp-support → mp-routes → mp-ws-live 一长串）。改任一处都要同步另一处。 */
const DEVICE_ONLINE_TTL = 10 * 60 * 1000
const MAX_TRIES = 20              // 端口被占用时最多顺延几个

/* 🔴 第130节 · 插件侧安全硬化（闸 A）· 「配对与取码」类免鉴权页的白名单。
   这些路径**不需要任何鉴权**就能打开，一旦被公网直接打到（Caddy 没拦住、
   或以后有人把 8899 端口直接放开/端口映射出去），就等于把配对码白送出去。
   公网来源（isRemoteLink 为真，即带 X-Forwarded-For / X-Real-IP）请求这些路径
   一律 403；局域网 / 回环直连不受影响。
   ⚠️ /mp/api/* 等手机走公网的通道**不在**这里 —— 它们在 handler 更早的
   o.mp.branch 分支就被处理并 return 了，本闸永远碰不到它们。 */
const PUB_BLOCKED = new Set(['/', '/pair', '/qr', '/newcode', '/claim', '/web', '/pet'])

/* 🔴 第134节 · task-6 · 公网可用性绑定 VIP（兑换码取代「只给我自己电脑开的白名单」）。
   ── 为什么这里还要再拦一道 ──
   Caddy 的 @lanOnly remote_ip 只管住 / /pair /web /pet /qr /newcode /claim 这类
   **免鉴权页**；带访问码的业务路由（/info /sessions /attachment /cmd /mp-cookie）
   没有任何前置闸，公网知道访问码就能直连。以前服务器上「给自己电脑单独开白名单」
   的做法已经取消：现在这台节点的公网可用性只由「本节点 VIP 是否有效」决定，
   VIP 由兑换码续期（云端 cloud.py 的 allow = vip 未过期）。
   ── 判定边界（严防误伤）──
   · 局域网 / 回环直连（isRemoteLink(req) 为假，不带转发头）**一律不受影响**；
   · 只拦 CLOUD_GATED 这几个业务路由，不碰 /mp/api/*（那条在 o.mp.branch 更早就
     return 了，见本文件 :593）；也不碰 / /pair /qr /newcode /claim（那是闸 A 的活）；
   · 🔴 fail-open 铁律：o.cloud 为 null（没接云链路 / 云端模块初始化失败）⇒ 放行。
     否则云端一坏就把用户彻底锁死，这比「暂时不拦」严重得多。
   · 开关：环境变量 DSH_CLOUD_GATE 为 off / 0 / false 时整条闸门失效（用户自救用）。
   ⚠️ /mp/api/* 不在集合里 —— 它在 o.mp.branch 里更早就 return 了。 */
const CLOUD_GATED = new Set(['/info', '/sessions', '/attachment', '/cmd', '/mp-cookie'])

/* ============================================================
   工具
   ============================================================ */
export function lanAddresses() {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== 'IPv4' && ni.family !== 4) continue
      if (ni.internal) continue
      out.push({ name, address: ni.address })
    }
  }
  out.sort((a, b) => score(a.address) - score(b.address))
  return out
}

function score(ip) {
  if (/^192\.168\./.test(ip)) return 0
  if (/^10\./.test(ip)) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
  return 3
}

export function lanUrls(port) {
  return lanAddresses().map((a) => 'http://' + a.address + ':' + port + '/dsh-console')
}

/**
 * 🔴 第130节 · Web 控制台页面已**彻底关闭**（/web 与 /pet 无条件 403）。
 * 本函数保留只为向后兼容：导出名与签名一个字没改，但**恒定返回空串**，
 * 不再拼任何 http://<ip>:<port>/web 地址。调用点（panelData 的 out.webUrl）也随之恒为空串。
 * ⚠️ 文件本体 lib/web-console.mjs 保留，只是全仓再无 import（grep 已确认）。
 */
export function webConsoleUrl(port) {
  return ''
}

/* ============================================================
   🔴 第 122 节 · task-2（#21-D）· 链路判定 + 隧道状态兜底
   ============================================================ */
/**
 * 这条请求是不是**真的从局域网/本机**过来的。
 * 命中 RFC1918 三段 + 回环 + IPv6 回环/link-local 才算 true。
 * 从公网走到这里的（frpc 隧道、反向代理）一律 false —— 正是「局域网直连灯必须是真的」。
 * 端口写死比较：req.socket.remoteAddress 本身就是纯地址（IPv6 带方括号的写法也一并容错）。
 * ⚠️ 只看对端地址在有反代时会失真（Caddy 反代时对端恒是 127.0.0.1），
 *    所以本函数只回答「这个地址本身是不是内网」；调用方（noteDevice）必须
 *    先用 forwardedFor()/isRemoteLink() 排除转发头 [第125节 · task-7]。
 *    ⚠️ 别把 isLanAddress 直接拿去填 localLink —— 那是旧的假绿来源；
 *       第171节起 noteDevice() 用的是 isPeerDeviceAddress()（回环被剔除，见其注释）。
 */
export function isLanAddress(ip) {
  let s = String(ip == null ? '' : ip).trim()
  if (s === '') return false
  const pct = s.indexOf('%')                    // fe80::1%eth0 这种带 zone 的写法
  if (pct > 0) s = s.slice(0, pct)
  const lc = s.toLowerCase()
  if (lc === '::1' || lc === '0:0:0:0:0:0:0:1') return true
  if (/^fe80:/.test(lc)) return true
  if (/^f[cd][0-9a-f]{2}:/.test(lc)) return true         // 唯一本地地址 fc00::/7
  if (/^::ffff:/i.test(s)) s = s.slice(7)                 // IPv4-mapped IPv6
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return false
  const a = Number(m[1]); const b = Number(m[2])
  if (a === 127) return true
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/**
 * 🔴 第171节 · Bug A · 是不是**本机自己**（回环）来的地址。
 * 单独拆出来的原因：isLanAddress() 把 127.x / ::1 与真私网段混在一起返回 true，
 * 而 noteDevice() 原来直接拿它点「局域网直连」灯 ⇒ 本机任何一发 127.0.0.1 请求
 * （面板自检 / 宿主内部探活 / 本机浏览器）都能把灯点亮，手机根本没连（用户截图实锤）。
 * ⚠️ 别并回 isLanAddress()：那个函数语义是「本机可达即可」，另有调用方。
 */
export function isLoopbackAddress(ip) {
  let s = String(ip == null ? '' : ip).trim()
  if (s === '') return false
  const pct = s.indexOf('%')                    // fe80::1%eth0 / 127.0.0.1%lo 这种带 zone 的写法
  if (pct > 0) s = s.slice(0, pct)
  const lc = s.toLowerCase()
  if (lc === '::1' || lc === '0:0:0:0:0:0:0:1') return true
  if (lc.indexOf('::ffff:') === 0) s = s.slice(7)         // IPv4-mapped IPv6
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  return !!m && Number(m[1]) === 127
}

/**
 * 🔴 第171节 · Bug A · 是不是**真的另一台设备**从局域网连过来的。
 * 回环 ⇒ false；其余沿用 isLanAddress()。公网那条链由调用方先 isRemoteLink() 排除。
 * 🔴 红线：真机从私网段（192.168 / 10 / 172.16-31）连上来**必须仍 true**，绝不把真机判死。
 */
export function isPeerDeviceAddress(ip) {
  if (isLoopbackAddress(ip)) return false
  return isLanAddress(ip)
}

/**
 * 🔴 第125节 · task-7 · 取反代/隧道转发头里的客户端地址（没有就回空串）。
 * Caddy 反代（https://gaoshou25.cn:443 → 127.0.0.1:8899）会把 socket 对端盖成 127.0.0.1，
 * 只看 socket 就会把公网请求判成「局域网直连」（假绿）。
 *   - X-Forwarded-For 可能是「客户端, 代理1, 代理2」，只取第一段；
 *   - X-Real-IP 是单值兜底；
 *   - 两个都没有 ⇒ 空串（直连场景一个字不改）。
 */
export function forwardedFor(req) {
  let h = null
  try { h = req && req.headers ? req.headers : null } catch (e) { h = null }
  if (!h) return ''
  const pick = (v) => {
    const s = Array.isArray(v) ? (v.length ? v[0] : '') : v
    if (typeof s !== 'string') return ''
    return s.split(',')[0].trim()
  }
  return pick(h['x-forwarded-for']) || pick(h['x-real-ip'])
}

/**
 * 🔴 第125节 · task-7 · 这条请求是不是走公网反代/隧道进来的。
 * 判定只看转发头：本机与局域网直连（手机连同一个 WiFi）都不会带这两个头。
 * ⚠️ 绝不能用 isLanAddress(req.socket.remoteAddress) 反推「局域网」—— 反代场景
 * 那个地址恒是 127.0.0.1，公网连上也会亮「局域网直连」。
 */
export function isRemoteLink(req) { return forwardedFor(req) !== '' }

/** 没配隧道 / 老插件 / 单测时的兜底状态：形状与 tunnel.mjs 的 tunnelStatus() 逐字对齐。 */
function blankTunnel() {
  return {
    enabled: false,
    ready: false,
    phase: 'disabled',
    lastError: '',
    serverAddr: '',
    remotePort: 0,
    since: 0,
    publicUrl: ''
  }
}

function realPort(o) {
  if (typeof boundPortRef.value === 'number' && boundPortRef.value > 0) return boundPortRef.value
  return o && o.port ? o.port : 0
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  // 旧版小程序（改名前的包）送的是 x-dafeiyu-token —— 浏览器端预检要放行，
  // 否则图片路由在 Web 控制台取图时会被 CORS 挡下（2026-10-08 第 100 节）。
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-dsh-console-token, x-dafeiyu-token')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store'
  })
  res.end(html)
}

async function readBody(req, limit) {
  // limit 可调：/cmd 要传手机图片（base64 后单图好几 MB），给到 24MB；
  // 配对码等小请求维持默认 1MB 防滥用（2026-10-03 v0.3.1）。
  const max = Number(limit) || 1e6
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => {
      b += c
      if (b.length > max) { req.destroy(); resolve({}) }   // 防超大 body
    })
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}) } catch (e) { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function tokenOf(req, url) {
  const h = String(
    req.headers['x-dsh-console-token'] ||
    // 旧版小程序（改名之前编译的包）送的是这个头，别把它判成"没带访问码"
    req.headers['x-dafeiyu-token'] ||
    ''
  ).trim()
  if (h) return h
  return String(url.searchParams.get('token') || '').trim()
}

/* ============================================================
   二维码载荷
   ============================================================ */

// 「刷新二维码」用的自增计数：保证连续两次生成的载荷一定不同。
// 见下面 pairPayload 里 v= 的注释（2026-10-07 修「刷新二维码不动」）。
let pairSeq = 0

/**
 * 二维码里直接装连接信息，扫完即连 —— 一次交换都不需要。
 *
 *   dsh-console://pair?b=<局域网地址>&t=<访问码>&n=<节点名>&v=<每次不同>
 *
 * 用自定义 scheme 而不是 https://，避免和真实网页域名混淆。
 *
 * ⚠️ 2026-10-07 修「刷新二维码不动」：
 *   载荷原先只由 base/token/name/node 决定，这四个都不随刷新变化 ⇒
 *   点「刷新二维码」后 newCode() 返回的 qrDataUrl 与旧图逐像素相同，
 *   用户的观感就是「按了没反应」。现在追加一个每次都不同的 v=，
 *   内容变了图才会重画。
 *   消费端只按 key 取 b/t/n，未知键安全忽略 ——
 *   微信小程序 pages/addnode/addnode.js:89-92 用
 *   `new RegExp('(?:^|&)' + k + '=([^&]*)')` 逐键取，多余键不影响。
 */
export function pairPayload({ base, token, name, node }) {
  const q = []
  if (base) q.push('b=' + encodeURIComponent(String(base)))
  if (token) q.push('t=' + encodeURIComponent(String(token)))
  if (name) q.push('n=' + encodeURIComponent(String(name)))
  if (node) q.push('i=' + encodeURIComponent(String(node)))
  // v：只用来让每次生成的载荷互不相同（二维码因此每次都会重画）。
  //    时间戳（36 进制，短一点）+ 自增计数：同一个毫秒内连续调用也不重复。
  pairSeq += 1
  q.push('v=' + Date.now().toString(36) + '-' + pairSeq)
  return 'dsh-console://pair?' + q.join('&')
}

export async function qrDataUrl(text, opts = {}) {
  try {
    const mod = await import('qrcode')
    return await mod.toDataURL(text, {
      margin: 1,
      width: opts.width || 360,
      errorCorrectionLevel: 'M',
      color: { dark: opts.dark || '#0a1220', light: opts.light || '#ffffff' }
    })
  } catch (e) {
    return null
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function pickBase(o, info) {
  const ports = Array.isArray(info && info.ports) ? info.ports : []
  if (ports.length) return String(ports[0])
  const urls = lanUrls(realPort(o))
  return urls.length ? urls[0] : ''
}

/* ============================================================
   主服务
   ============================================================ */
export function startLanServer(o) {
  const log = o.log || (() => {})
  let server = null
  let boundPort = 0

  // ---- 6 位配对码：用户不想抄 48 位长串时的替代路径 ----
  let pairCode = ''
  let pairExp = 0
  // 最近一次手机活动的时刻（带对访问码的请求 / 配对成功）。
  // 0 = 从来没连过。给面板的「手机已连接/未连接」状态灯用。
  let phoneLastSeen = 0

  function ensurePairCode() {
    const t = Date.now()
    if (!pairCode || t > pairExp) {
      pairCode = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
      pairExp = t + PAIR_TTL
      if (typeof o.onPairCode === 'function') o.onPairCode(pairCode, pairExp)
    }
    return pairCode
  }
  function currentPairCode() {
    if (!pairCode || Date.now() > pairExp) return ''
    return pairCode
  }
  function setPairCode(v) { pairCode = v || ''; pairExp = 0 }

  function safeInfo() {
    const urls = lanUrls(realPort(o))
    try {
      const info = o.getInfo() || {}
      return {
        name: info.name || '',
        nodeId: info.nodeId || '',
        host: info.host || os.hostname(),
        dshOk: !!info.dshOk,
        dshError: info.dshError || '',
        version: info.version || '',
        ports: urls,
        /* 🔴 批次F · task-25（#62）· 白名单漏字段：插件 apply() 的 getInfo() 一直
           带着 agentPreset / agentPresetAvailable（lib/index.js:1453-1454），
           但这里没放行 —— 客户端拿到的 /info 里这两个键根本不存在，
           节点管理页那行只读展示永远显示「未知（需电脑端 ≥0.4.3）」。
           只读展示字段，缺省给空串 / false，不影响任何鉴权与能力判定。 */
        agentPreset: info.agentPreset || '',
        agentPresetAvailable: !!info.agentPresetAvailable,
        /* 🔴 第128节 · 公网入口下发（手机 App 断网后切公网的候选地址）。
           只增字段，不动 ports 语义；隧道没就绪时是空数组。 */
        publicUrls: publicUrlsNow()
      }
    } catch (e) {
      // getInfo 抛错时同理：两个字段也要在，否则客户端读 undefined 会显示“未知”
      return { name: '', nodeId: '', host: os.hostname(), dshOk: false, ports: urls,
        agentPreset: '', agentPresetAvailable: false, publicUrls: publicUrlsNow() }
    }
  }

  /* 🔴 第 122 节 · task-2（#21-D）· 隧道状态 + 两条链路灯（面板 /info 与 panelData 共用）。
     tunnelStatus 由插件下发（index.js 的 lan.setTunnel(tunnelStatus)）；单测 / 老插件没有
     ⇒ blankTunnel()，**绝不能因此抛错**（test/selftest.mjs 直接调 panelData()）。 */
  /* 🔴 第170节 · Bug A（假绿）：这两颗灯以前是**粘滞布尔**，置 true 之后永不复位 ——
     本机任何一次 127.0.0.1 的请求（面板探活 / 宿主内部请求 / 本机浏览器）都能把
     「局域网直连」永久点亮，手机早就断开了面板还显绿（用户 2026-10-13 截图实锤，
     并且与侧栏那颗按 phoneOnline 算的灯自相矛盾）。
     现在只记「最近一次真的从这条链进来」的时刻，读取时按 LOCAL_LINK_TTL 判活。
     ⚠️ 两条链各记各的（不再互相清零）：公网手机与局域网手机可以同时在线，
     互相清零反而会让「真连着」的那条链被另一条的活动抹掉。 */
  let localLinkAt = 0
  let remoteLinkAt = 0
  /** 按 TTL 折算两条链路灯（panelData 与 /info 共用，保证同口径）。 */
  function linkState(nowMs) {
    const now = Number(nowMs) || Date.now()
    const fresh = (t) => t > 0 && (now - t) < LOCAL_LINK_TTL
    return { localLink: fresh(localLinkAt), remoteLink: fresh(remoteLinkAt) }
  }
  function tunnelNow() {
    try {
      const t = typeof o.tunnelStatus === 'function' ? o.tunnelStatus() : null
      const base = blankTunnel()
      if (!t || typeof t !== 'object') return base
      const phase = ['disabled', 'starting', 'connected', 'reconnecting', 'error'].indexOf(String(t.phase)) >= 0
        ? String(t.phase) : 'disabled'
      return {
        enabled: t.enabled === true,
        ready: t.ready === true,
        phase: phase,
        lastError: typeof t.lastError === 'string' ? t.lastError : '',
        serverAddr: typeof t.serverAddr === 'string' ? t.serverAddr : '',
        remotePort: Number(t.remotePort) || 0,
        since: Number(t.since) || 0,
        /* 🔴 第128节 · 公网入口：tunnel.mjs 已规范化（http(s) 开头、去尾斜杠、不合格为空串），
           这里原样透传；老插件给的 undefined 一律落空串。 */
        publicUrl: typeof t.publicUrl === 'string' ? t.publicUrl : ''
      }
    } catch (e) { return blankTunnel() }
  }

  /**
   * 🔴 第128节 · 公网入口列表（/info 的新字段，**只增不改**）。
   * 语义只此一条：enabled===true && ready===true && phase==='connected' && publicUrl 非空
   *   ⇒ [publicUrl]；其余（没配 / 没就绪 / 重连中 / 出错）一律 []。
   * ⚠️ 绝不碰 ports 的语义：ports[0] 是配对二维码的局域网 base，改成公网会让手机在家也绕公网。
   */
  function publicUrlsNow() {
    const t = tunnelNow()
    if (t.enabled !== true || t.ready !== true || t.phase !== 'connected') return []
    return (typeof t.publicUrl === 'string' && t.publicUrl !== '') ? [t.publicUrl] : []
  }

  /**
   * 🔴 第135节 · task-5（#A3 数据面）· 这台电脑当前的云端身份三件套。
   * 数据源＝cloud-link.mjs 的 snapshot()（bound{uid,name,avatar} 与 shortId）：
   *   cloudUid 华为账号 openId（bound.uid）⇒ **账号级**身份，只用于显示/兜底，
   *            **绝不参与去重**：同账号下的两台手机（手机+平板）会撞车，拿它判重
   *            就等于把两台不同手机并成一台（撞任务红线）。设备级去重键只认
   *             手机自报的 deviceUid；
   *   pubId    公网短 ID（= shortId）⇒ 面板显示「脱敏公网 id」；
   *   account  账号名（bound.name）⇒ 面板显示这是谁的手机。
   * ⚠️ 三条铁律：①绝不读、更不下发 nodeId（那是插件对云的凭据）；
   *   ②取不到就返回 null，调用方按「身份未知」处理，**绝不编造 uid**
   *   （编一个出来会把两台不同手机并成一台，比多显示一台更糟）；
   *   ③snapshot 抛错一律吞掉（云端挂了不许拖垮名单）。
   */
  function identityOf() {
    const c = cloudMod()
    if (!c || typeof c.snapshot !== 'function') return null
    try {
      const s = c.snapshot()
      if (!s || typeof s !== 'object') return null
      const b = (s.bound && typeof s.bound === 'object') ? s.bound : null
      const cloudUid = String((b && b.uid) || '').trim().slice(0, 120)
      const account = String((b && b.name) || '').trim().slice(0, 80)
      const pubId = String(s.shortId || s.pubId || '').trim().slice(0, 120)
      if (cloudUid === '' && account === '' && pubId === '') return null
      return { cloudUid, pubId, account, nickName: account }
    } catch (e) { return null }
  }

  /**
   * 🔴 task-5 · 把身份来源**后挂**到设备登记表上（index.js 那边一行都不用改）。
   * 传函数而不是快照：重新绑账号 / 换公网 id 之后必须立刻生效。
   * 老 store 没有 setIdentity ⇒ 静默跳过，行为与老版逐字一致。
   */
  function bindStoreIdentity() {
    try {
      const store = o.mp && o.mp.store
      if (store && typeof store.setIdentity === 'function') store.setIdentity(identityOf)
    } catch (e) { /* 挂不上就按「身份未知」跑，名单照常出 */ }
  }

  function identTxt(v, max) {
    const s = String(v == null ? '' : v).trim()
    return s === '' ? '' : s.slice(0, max)
  }

  /**
   * 🔴 task-5 · 名单每行**只补空位**：设备自己上报的身份优先（store 记的 uid），
   * 缺了才用云端绑定补（账号 uid / 账号名 / 公网短 ID）。缺什么就不加什么键 ——
   * 老插件 / 没绑云的机器上，键根本不存在，面板照旧（不会显示成空括号）。
   * ⚠️ 分两个键、别混：uid = 设备级（手机自报的 deviceUid，判重用的就是它）；
   *    cloudUid = 账号级（bound.uid，同一个账号下多台手机同值 ⇒ 只显示、不判重）。
   */
  function withIdentity(row) {
    const id = identityOf()
    const out = Object.assign({}, row)
    const uid = identTxt(row && row.uid, 120)
    const cloudUid = identTxt(row && row.cloudUid, 120) || identTxt(id && id.cloudUid, 120)
    const pubId = identTxt(row && (row.pubId || row.shortId), 120) || identTxt(id && (id.pubId || id.shortId), 120)
    const account = identTxt(row && (row.account || row.nickName), 80) || identTxt(id && (id.account || id.name), 80)
    if (uid !== '') out.uid = uid
    if (cloudUid !== '') out.cloudUid = cloudUid
    if (pubId !== '') out.pubId = pubId
    if (account !== '') out.account = account
    return out
  }

  /**
   * 🔴 批次 H · task-6（#A3）· 已配对设备名单（只读快照）。
   * o.mp.store 由插件下发（index.js 的 lan.setMp）；老插件没有 store 或 list 就回空名单，
   * 面板显示「暂无已配对设备」而不是崩。
   * 🔴 第135节 · task-5：先 bindStoreIdentity() 再 list()，然后逐行补身份空位。
   *   list() 的白名单已含 uid/pubId/account（**绝不含 secret**）——
   *   同 uid 的多张 secret 在 store 里已经并成一条，这里不会重复出人。
   */
  function deviceRoster() {
    try {
      const store = o.mp && o.mp.store
      if (!store || typeof store.list !== 'function') return []
      bindStoreIdentity()
      const list = store.list()
      if (!Array.isArray(list)) return []
      /* ⚠️ 必须返回**新对象**：withIdentity 不就地改 store 的快照，免得副作用回灌登记表。 */
      return list.map(withIdentity)
    } catch (e) { return [] }
  }

  /**
   * 🔴 批次 H · task-8（#A3 前半）· 名单 + 计数一次算好，两个通道共用同一口径。
   * panelData()（宿主面板 /api/dsh-console/state）与 LAN GET /info（手机端直连
   * 8899 走的就是这条）都必须给出一模一样的 devices / deviceCount / onlineCount，
   * 免得两边数字对不上。list() 自身只回白名单字段（绝不含 secret），异常一律吞成空名单。
   */
  function rosterCounts() {
    const devices = deviceRoster()
    return {
      devices: devices,
      deviceCount: devices.length,
      onlineCount: devices.filter((d) => d.online).length
    }
  }

  /* ============================================================
     🔴 第131节 · task-1 · 云链路（公网短 ID + VIP + 兑换）
     ── 分工 ──
     云链路本体在 cloud-link.mjs（对云说话 + 60s 心跳 + 内存缓存），这里只做三件事：
       ① cloudView()  把缓存摘成面板/App 要看的只读形状（拿不到就 null）
       ② GET  /cloud/status  读缓存（不联网）
       ③ POST /cloud/bind、/cloud/redeem  转发给云链路，再把结果原样给 App
     ── 铁律 ──
       · 云链路整个是可选的：o.cloud 不在（老插件 / 没配）时全部按「云端不可用」处理 ——
         /info 的 cloud 给 null，三条路由给 503，**绝不许因此 500**。
       · nodeId **绝不下发**：App 只认 shortId（公网短 ID），nodeId 是插件对云的凭据。
       · cloud-link 的方法都承诺不抛；这里再包一层 try/catch 兜底。
     ============================================================ */
  function cloudMod() {
    const c = o.cloud
    return c && typeof c === 'object' ? c : null
  }

  /** 云端报错文案归一化：非字符串 / 空一律给「云端不可用」。 */
  function cloudErr(e) {
    const s = typeof e === 'string' ? e.trim() : ''
    return s || '云端不可用'
  }

  /** 云端数字归一化：非有限数 / 负数一律 0，别把 NaN 漏进响应。 */
  function cloudNum(v) {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }

  /**
   * App / 面板要看的云端字段。拿不到（没 o.cloud / snapshot 抛错）返回 null ——
   * 调用方不许因为 null 崩。
   */
  function cloudView() {
    const c = cloudMod()
    if (!c || typeof c.snapshot !== 'function') return null
    try {
      const s = c.snapshot()
      if (!s || typeof s !== 'object') return null
      return {
        shortId: typeof s.shortId === 'string' ? s.shortId : '',
        vipExpireMs: Number(s.vipExpireMs) || 0,
        online: s.online === true
      }
    } catch (e) { return null }
  }

  /**
   * 🔴 第134节 · task-6 · 这台节点现在「云端可服务」吗（CLOUD_GATED 闸的判据）。
   * 语义只认一条：o.cloud.snapshot().vipExpireMs 是**有限数字且 > Date.now()**。
   *   - o.cloud 不存在 / snapshot 不是函数 ⇒ 返回 false，**但调用方必须先判 !o.cloud 放行**
   *     （fail-open 铁律写在闸门那里，本函数只管「VIP 是否有效」这一件事，别把两件事混进来）；
   *   - snapshot() 抛异常、返回非对象、vipExpireMs 非数字（NaN/undefined/0）⇒ false。
   * ⚠️ 不看 online：断网时 snapshot 会给 offline:true 但**保留上次落盘的 vipExpireMs**，
   *    VIP 没过期就该照常能用（用户原话「不靠服务器白名单，靠我这台机器有没有 VIP」）。
   */
  function isCloudLive() {
    const c = cloudMod()
    if (!c || typeof c.snapshot !== 'function') return false
    try {
      const s = c.snapshot()
      if (!s || typeof s !== 'object') return false
      const exp = Number(s.vipExpireMs)
      return Number.isFinite(exp) && exp > Date.now()
    } catch (e) { return false }
  }

  /**
   * 🔴 第135节 · task-5（#A3 数据面）· 「公网访问服务是否已开通」那颗三态灯的判据源。
   * 渲染层（lib/client.js:655 起 LinksRow）**不拿 tunnel / remoteLink 猜服务状态** ——
   * 云在线只有宿主看得见（cloud-link 的 snapshot 在宿主手里），所以由这里把证据合成
   * 一个布尔再下发：
   *   true  = 云端快照里 vipExpireMs 未过期（已开通服务）；
   *   false = 本节点确实配了云链路（o.cloud 在场）但 VIP 已过期 / 未开通 ⇒ 渲染层亮黄灯；
   *   undefined = 没配云链路（老插件 / 本机没上云）⇒ **不下发这个键**，
   *               渲染层走既有老两态（不判黄），绝不把「没上云」误报成「未开通服务」。
   * 判据只认 isCloudLive()（内部全吞异常、只看到期时间，不看 online），本函数不抛。
   */
  function linkSubscribed() {
    /* 🔴 第139节 · 用户 m00001 第3条把三态钉成：
       「公网服务器能连接上但未开通服务 ⇒ 黄灯+黄字；没连上 ⇒ 未连接；开通服务且连接了 ⇒ 已连接」。
       ⇒ 本函数从「只看 VIP 到期」升级成**两条件合成**（只有这里看得见 cloud 快照）：
         · 没配云链路（老插件 / 没上云）        ⇒ undefined（键不下发，渲染层走老两态，不误报黄）；
         · 快照 online === true（服务器连得上）:
             - vipExpireMs 未过期 ⇒ true  ⇒ 绿「已连接」；
             - 否则               ⇒ false ⇒ 黄「未开通服务」；
         · 快照 online !== true（服务器没连上） ⇒ undefined ⇒ 灰「未连接」。
       ⚠️ isCloudLive() 仍是 CLOUD_GATED 闸的判据（那边只管「VIP 有没有效」，
          断网时靠落盘的 vipExpireMs 继续放行）—— 这里不改它，只把它当一个条件用。
       ⚠️ 老语义（在线与否都给 false）会让「服务器连不上」也亮黄，与本条用户口径不符。 */
    if (!cloudMod()) return undefined
    let online = false
    try {
      const s = cloudMod().snapshot()
      online = !!s && s.online === true
    } catch (e) { online = false }
    if (!online) return undefined
    return isCloudLive()
  }

  /** GET /cloud/status 的响应体（字段沿用 Lead 冻结的本地路由合同）。 */
  function cloudStatusBody() {
    const c = cloudMod()
    const v = cloudView()
    if (!v) return { ok: false, error: '云端不可用' }
    let bound = null
    try {
      const b = c.snapshot() && c.snapshot().bound
      bound = b && typeof b === 'object'
        ? { uid: String(b.uid || ''), name: String(b.name || ''), avatar: String(b.avatar || ''),
            ms: Number(b.ms) || 0 }
        : null
    } catch (e) { bound = null }
    return {
      ok: true,
      shortId: v.shortId,
      /* pubId = 云端下发的公网短 ID（与 shortId 同值，Lead 2026-10-12 定稿）；
         它**不是**插件的 nodeId —— nodeId 不进任何响应。 */
      pubId: v.shortId,
      vipExpireMs: v.vipExpireMs,
      online: v.online,
      bound
    }
  }

  /**
   * 🔴 批次 H · task-6（#A3）· 顺手记一次「这台设备在场」。
   * 配合 phoneLastSeen：那个是全局单灯（老语义不动），这个是**逐设备**的。
   * 只认 mp_device Cookie；没配对 / 没装 mp 时静默跳过（不 throw、不刷日志）。
   */
  function noteDevice(req) {
    try {
      /* 🔴 第 122 节 · task-2（#21-D）· 两条链路灯挂在这同一批调用点（/info 等四处都调
         noteDevice）。局部变量 + 回调上报各有用途：前者给同一进程内 panelData() 用
         （面板与 /info 必须是同一份值），后者让插件记到设备登记表上。
         🔴 第125节 · task-7 起 remoteLink 不再恒 false：带转发头（Caddy 反代 / 公网隧道）就置
         true；带转发头时 localLink 必须为 false（socket 上的对端是反代自己）。 */
      let ip = ''
      try { ip = req && req.socket ? String(req.socket.remoteAddress || '') : '' } catch (e2) { ip = '' }
      /* 🔴 第125节 · task-7（改动 2+3）：先认转发头 —— 有转发头（Caddy / 公网隧道）
         就说明这一发是从公网那头翻进来的，socket 上的 127.0.0.1 是反代自己，
         不能再判成「局域网直连」（公网连上却亮本地灯 = 假绿）；
         同时 remoteLink 也要跟着亮（以前恒 false，真从公网连上两颗灯都不亮）。 */
      /* 🔴 第170节 · Bug A：改成记时间戳（原本是直接赋布尔，永不复位）。 */
      const linkAt = Date.now()
      const remoteNow = isRemoteLink(req)
      if (remoteNow) remoteLinkAt = linkAt
      /* 🔴 第171节 · Bug A（主修点）：判据从 isLanAddress 换成 isPeerDeviceAddress ——
         回环（127.x / ::1：面板自检 / 宿主内部请求 / 本机浏览器）不再点灯；
         真机从私网段连上来仍是 true（红线），第170节的 TTL 衰减逻辑一个字没动。 */
      else if (isPeerDeviceAddress(ip)) localLinkAt = linkAt
      if (typeof o.onRequestLink === 'function') o.onRequestLink(req)
    } catch (e) {}
    try {
      const secret = cookieValue(req.headers.cookie)
      if (secret === '') return
      const store = o.mp && o.mp.store
      /* 🔴 第135节 · task-5：把云端身份（uid/账号名/公网短 ID）一并带给登记表 ——
         手机自报的 deviceUid 优先，这里只是兜底。拿不到云身份时 identityOf() 返回 null，
         touch(secret, null) 与老版 touch(secret) 行为一致。 */
      if (store && typeof store.touch === 'function') store.touch(secret, identityOf())
    } catch (e) {}
  }

  /** 面板要显示的全部数据（宿主半边 → 客户端半边走 RPC，浏览器配对页也用它） */
  async function panelData(withQr) {
    const info = safeInfo()
    const token = o.getToken()
    const base = pickBase(o, info)
    const code = ensurePairCode()
    /* 🔴 第125节 · task-7（方案 C）：phoneOnline 与在线名单共用同一份快照 + 同一次 now。
       以前只认全局单灯 phoneLastSeen（2 分钟 TTL）：手机切后台被系统冻结、或只走
       /mp/* RPC（不刷 phoneLastSeen）时，明明连着，侧栏那颗点还是灰的。 */
    const now = Date.now()
    const roster = rosterCounts()
    const phoneFresh = phoneLastSeen > 0 && (now - phoneLastSeen) < PHONE_TTL
    /* 逐设备兜底：10 分钟内有过活动（lastSeen）就算在线，与 onlineCount 同口径。
       🔴 铁律：只认 lastSeen 的**时间**口径，绝不读 d.online 字段 ——
       device-roster.spec.mjs 的 fakeStore 里 online 是写死的 true/false、
       lastSeen 是 2000/800（1970 毫秒），读 d.online 会让「还没人连过 ⇒ 灰」那条断言当场挂。 */
    const deviceFresh = roster.devices.some(
      (d) => (now - (Number(d.lastSeen) || 0)) < DEVICE_ONLINE_TTL
    )
    const out = {
      ok: true,
      name: info.name || info.host,
      host: info.host,
      dshOk: info.dshOk,
      dshError: info.dshError,
      port: realPort(o),
      base: base,
      token: token,
      code: code,
      codeLeftMs: Math.max(0, pairExp - Date.now()),
      ports: info.ports,
      phoneLastSeen: phoneLastSeen,
      phoneOnline: phoneFresh || deviceFresh,
      payload: pairPayload({ base, token, name: info.name || info.host, node: info.nodeId })
    }
    /* 🔴 第130节 · Web 控制台已关闭：webUrl 键**保留但恒为空串**（''），
       不删键 —— 客户端与既有单测按「键存在」读它，删键会破坏键集合断言。
       之所以不再拼地址（原来是 webConsoleUrl(realPort(o))）：/web 与 /pet 现在
       无条件 403，下发地址只会给用户一个死链。 */
    out.webUrl = ''
    /* 🔴 批次 H · task-6（#A3）· 多设备在线名单（面板显示「哪台在线、什么机型」）。
       旧字段 phoneLastSeen / phoneOnline 语义**一个字没改**（老客户端与既有单测都读它），
       这里只是**新增** devices —— 老插件没有 store.list() ⇒ 空名单 + 计数 0，不报错。 */
    out.devices = roster.devices
    out.deviceCount = roster.deviceCount
    out.onlineCount = roster.onlineCount
    /* 🔴 第 122 节 · task-2（#21-D）· 隧道状态 + 两条链路灯（T-4 / T-5）。
       tunnel 字段固定 8 个（enabled/ready/phase/lastError/serverAddr/remotePort/since/publicUrl），
       **绝不出现 authToken**；localLink=这台手机真的走局域网/本机直连进来的，
       remoteLink=走公网反代/隧道进来的（第125节 · task-7 起按转发头实算，不再恒 false）。
       🔴 第128节：publicUrls（仅隧道 ready 时 [publicUrl]，否则 []）与 /info 同口径 —— 同一函数。 */
    out.tunnel = tunnelNow()
    out.publicUrls = publicUrlsNow()
    /* 🔴 第170节 · Bug A：与 /info 同口径、同一次 now（linkState 内部用传进来的 now）。 */
    const link = linkState(now)
    out.localLink = link.localLink
    out.remoteLink = link.remoteLink
    /* 🔴 第135节 · task-5 · 公网卡三态（绿 / 黄 / 灰）的「服务是否已开通」判据。
       只在本节点真的配了云链路时下发（布尔）；没配云链路 ⇒ 键不存在，
       老客户端读到的还是 undefined，走的仍是老两态 —— 键集合只增不减、语义不变。 */
    const sub = linkSubscribed()
    if (typeof sub === 'boolean') out.linkSubscribed = sub
    if (withQr) {
      out.qrDataUrl = await qrDataUrl(out.payload, { width: 360 })
      /* 🔴 第130节 · 不再生成 out.webQrDataUrl：Web 控制台页已关闭，
         给一张指向死链的二维码纯属白跑一次 qrcode 编码。 */
    }
    return out
  }

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    // ⚠️ 2026-10-04：面板从「大肥鱼」改名成「DSH控制台」，路由前缀同步换了名字。
    //    但手机小程序里 wx.storage 存的 base 还是老地址（改名前写进去的），
    //    老包重新编译前一直在打 /dafeiyu/* —— 全部 404，表现为「插件显示已连接，小程序连不上」。
    //    这里把老前缀一并认掉，改名不用逼用户重新配对。
    const p = url.pathname.replace(/^\/(?:dsh-console|dafeiyu|dsh-dafeiyu-panel)/, '') || '/'

    // ---- /mp/*：鸿蒙客户端（0.5.0）。必须在 tokenOf 之前，因为那条路用
    //      mp_device Cookie 鉴权，不是访问码；也必须在任何 404 之前。
    //      为什么只能在这里早返回而不能另挂监听器：Node 的多个 'request'
    //      监听器依次调用且互不等待，RPC 要先读完 body，等异步时本 handler
    //      早已写完响应。实测期望 401 拿到的是 404。
    if (o.mp && typeof o.mp.branch === 'function') {
      /* 🔴 批次 H · task-6 · 必须吃**剥过前缀**的 p（见上面 :337）。
         手机端 base 是 http://ip:8899/dsh-console，RPC 打的是
         /dsh-console/mp/api/mobile.pending；这里若传未剥的 url.pathname，
         mp-routes.mjs:34 的 isMp()（PREFIX='/mp'）不匹配 ⇒ branch 返回 false
         ⇒ 落到下面 :426 的访问码闸 ⇒ 401「访问码不对」，App 的 HTTP 轮询
         （提问/审批下发）永远拉不到。WS 侧已剥（mp-ws-live.mjs:208），只漏了这里。 */
      const pathname = p
      try {
        if (await o.mp.branch(req, res, pathname)) return
      } catch (e) {
        log('[mp] 分支出错: ' + ((e && e.message) || e))
        try { sendJson(res, 500, { ok: false, error: 'mp 内部错误' }) } catch (x) { /* 忽略 */ }
        return
      }
    }

    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return }

    /* 🔴 第130节 · 插件侧安全硬化（闸 A）· 公网来源拒绝「配对与取码」免鉴权页。
       ── 两道闸的分工，别记混：──
       第一道：服务器 Caddy 的免鉴权路由已经做了 remote_ip 白名单（公网打不进来）；
       第二道：就是这里 —— 插件自身不再无条件相信「能连上 8899 的就是自己人」。
       为什么插件里还要再拦一次：Caddy 的 remote_ip 是能被人改配置/加一条路由放开的；
       而 8899 一旦被公网直连（端口映射 / 防火墙放行 / 内网穿透），请求根本不过 Caddy，
       第一道闸等于不存在。这一道闸是「请求已经到达插件」时的兜底，不依赖任何前置组件。
       ── 位置铁律（别挪）──
       必须在上面 o.mp.branch 那段**之后**：手机走公网的 /mp/api/* 由 branch 处理并
       已经 return，本闸不能提前把它们拦掉；也必须只拦 PUB_BLOCKED 里那几个免鉴权页，
       /info /sessions /attachment /cmd /mp-cookie 等带访问码的路由**一个都不碰**。
       ── 判定 ──
       isRemoteLink(req) = forwardedFor(req) !== ''，只看 X-Forwarded-For / X-Real-IP。
       本机与局域网直连（手机连同一个 WiFi）都不带这两个头 ⇒ 不受影响。 */
    if (isRemoteLink(req) && PUB_BLOCKED.has(p)) {
      return sendJson(res, 403, { ok: false, error: '配对与取码仅限局域网内使用' })
    }

    /* 🔴 第134节 · task-6（闸 C）· 公网来源 + 业务路由 ⇒ 必须有有效 VIP。
       ── 为什么这里要拦 ──
       Caddy 的 @lanOnly（remote_ip 白名单）只管那几个免鉴权页；/info /sessions
       /attachment /cmd /mp-cookie 这些**带访问码的业务路由没有前置闸**，公网只要
       拿到访问码就能直连（2026-10-12 实测 https://gaoshou25.cn/dsh-console/info?token= → 200）。
       以前的办法是「服务器上给自己电脑单独开一份白名单」—— 那个概念已被**取消**，
       改成「这台节点的 VIP 有没有过期」（云端 cloud.py:278 的 allow = exp > ts）。
       ── 边界（三条，缺一不可）──
       ① 局域网 / 回环直连（isRemoteLink 为假）一律不受影响 —— 在家连 WiFi 永远能用；
       ② 🔴 fail-open：o.cloud 为 null（没接云链路 / 云端模块初始化失败）时**放行**。
          宁可暂时不拦，也绝不能在云端故障时把用户彻底锁死（这是铁律，别改成 fail-closed）；
       ③ 开关 DSH_CLOUD_GATE：值为 off / 0 / false 时整条闸门失效（用户自救后门）。
       ── 位置 ──
       紧跟在闸 A 之后、路由分发之前；/mp/api/* 在更上面的 o.mp.branch 就 return 了，
       本闸碰不到它（CLOUD_GATED 里也没有 /mp/api/*）。 */
    const gateOff = ['off', '0', 'false'].indexOf(
      String((process.env && process.env.DSH_CLOUD_GATE) || '').trim().toLowerCase()
    ) >= 0
    if (!gateOff && o.cloud && isRemoteLink(req) && CLOUD_GATED.has(p) && !isCloudLive()) {
      return sendJson(res, 403, {
        ok: false,
        error: '公网服务未开通或已过期，请在 App 设置页用兑换码续期'
      })
    }

    // ---- 配对页：浏览器直接打开，免 token ----
    if (p === '/' || p === '/pair') {
      const d = await panelData(true)
      return sendHtml(res, pageHtml(d))
    }

    /* ---- Web 控制台：第130节起**彻底关闭** ----
       原来这里 sendHtml(res, webHtml()) 免 token 直接吐整个浏览器控制台；
       现在无条件 403（内网 / 回环也一样），不再有例外分支。
       ⚠️ 保留 p === '/web' 这个判断而不是删掉整个块：删了会掉进下面
       tokenOf 那道 401「访问码不对」，语义变成「有码就能开」，那就没关干净。 */
    if (p === '/web') {
      return sendJson(res, 403, { ok: false, error: 'Web 控制台已关闭' })
    }

    /* ---- 立绘图片：第130节起同样**彻底关闭** ----
       /pet 只是 Web 控制台首页的素材，控制台关了它没有消费方；
       继续免 token 放着等于白留一个未鉴权的文件读取面（o.petLightPath / petDarkPath）。 */
    if (p === '/pet') {
      return sendJson(res, 403, { ok: false, error: 'Web 控制台已关闭' })
    }

    // ---- 面板数据：DSH 面板自己用（宿主进程内调，不走 HTTP）----
    // 留这条是为了浏览器调试方便

    // ---- 6 位码换访问码：错码不给过，用过即作废 ----
    if (p === '/claim' && req.method === 'POST') {
      const body = await readBody(req)
      const code = String(body.code || '').trim()
      // 配对码排障日志：用户报「码用不了」时先看这里——
      // 没有这行 = 请求根本没到电脑（IP/白名单/端口问题）；
      // 有这行且 mismatch = 码错/过期/已被核销。
      log('[claim] 收到配对码请求 ' + req.socket.remoteAddress +
          ' 输入=' + (code ? code.slice(0, 2) + '****' : '(空)') +
          ' 当前有效码=' + (currentPairCode() ? '存在(剩' + Math.max(0, Math.round((pairExp - Date.now()) / 1000)) + 's)' : '无(空或已过期)'))
      if (!/^\d{6}$/.test(code)) {
        log('[claim] ✗ 不是 6 位数字')
        return sendJson(res, 400, { ok: false, error: '配对码是 6 位数字' })
      }
      if (code !== currentPairCode()) {
        log('[claim] ✗ 码不对或已过期（用户输入前两位 ' + code.slice(0, 2) + '**）')
        return sendJson(res, 403, { ok: false, error: '配对码不对或已过期' })
      }
      setPairCode('')                            // 核销
      phoneLastSeen = Date.now()                 // 配对成功 = 手机确实在场
      log('[claim] ✓ 配对成功，码已核销')
      const d = await panelData(false)
      return sendJson(res, 200, {
        ok: true, token: d.token, base: d.base, name: d.name,
        note: '配对成功。这个码已作废。'
      })
    }

    // ---- 二维码 PNG ----
    if (p === '/qr') {
      const dataUrl = await qrDataUrl((await panelData(false)).payload, { width: 360 })
      if (!dataUrl) return sendJson(res, 500, { ok: false, error: '二维码生成失败' })
      const buf = Buffer.from(String(dataUrl).split(',')[1] || '', 'base64')
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      })
      return res.end(buf)
    }

    // ---- 换一张新码（面板的「重新生成」按钮）----
    if (p === '/newcode') {
      setPairCode('')
      const d = await panelData(true)
      return sendJson(res, 200, { ok: true, code: d.code, payload: d.payload, qrDataUrl: d.qrDataUrl })
    }

    // ---- 以下都要访问码 ----
    if (tokenOf(req, url) !== o.getToken()) {
      return sendJson(res, 401, { ok: false, error: '访问码不对' })
    }
    // ⚠️ 状态灯只在「真的认识这个路由」之后才记一笔。
    //    以前是验完码就记，导致手机拿老地址打过来全是 404，
    //    面板照样显示「手机已连接」—— 绿灯是假的，专坑排查（2026-10-04 实锤）。
    // 走到这里说明前缀已剥掉，但还不知道是哪条路由，所以先不记。

    try {
      if (p === '/info') {
        phoneLastSeen = Date.now()   // 真的答上了，才算手机在场
        noteDevice(req)              // #A3：逐设备在场记录（面板名单用）
        /* 🔴 批次 H · task-8（#A3 前半）· 手机端要显示「手机端连接电脑」名单。
           LanClient.ets 直连的是 LAN 服务器（默认 8899）这条 /info，不是宿主的
           /api/dsh-console/state —— 所以本通道也得下发 devices / deviceCount /
           onlineCount，口径与 panelData() 完全一致（同一个 rosterCounts()）。
           安全面不变：devices 来自 store.list() 的白名单快照（deviceId/model/name/
           pairedAt/lastSeen/online，第135节 · task-5 起追加 uid/pubId/account 三个身份字段），
           token 只在 o.getToken() 里、**不进本响应**；secret 同样一个字节都不下发。
           老插件没有 store.list() ⇒ 空数组 + 0，不报错、不 500。
           ⚠️ Object.assign 右侧同名键会覆盖左侧，故设备字段必须写在 safeInfo() 之后。 */
        const roster = rosterCounts()
        /* 🔴 第135节 · task-5 · 与 panelData() 同口径的「公网服务已开通」判据。
           本节点没配云链路 ⇒ 空对象 ⇒ 键不存在（老客户端读 undefined，行为不变）。 */
        const subFlag = linkSubscribed()
        const linkExtra = typeof subFlag === 'boolean' ? { linkSubscribed: subFlag } : {}
        /* 🔴 第 122 节 · task-2（#21-D）· 与 panelData() 完全同口径：手机端直连 8899 走的是这条，
           也必须有 tunnel / localLink / remoteLink，否则面板亮灯 ← /info 说没连，两边打架。 */
        return sendJson(res, 200, Object.assign({ ok: true }, safeInfo(), {
          devices: roster.devices,
          deviceCount: roster.deviceCount,
          onlineCount: roster.onlineCount,
          tunnel: tunnelNow(),
          /* 🔴 第128节 · 公网入口列表（手机离开 WiFi 后切公网的候选地址）。
             ⚠️ 只增这一个字段：ports 仍是局域网地址（配对二维码 base），一个字没动。 */
          publicUrls: publicUrlsNow(),
          /* 🔴 第170节 · Bug A：与 panelData 同口径（同一个 linkState）。 */
          ...linkState(),
          /* 🔴 第131节 · task-1 · 云链路摘要（公网短 ID / VIP 到期 / 在线）。
             老插件 / 没配 cloud / snapshot 抛错 ⇒ null，字段仍在键在，
             面板按 null 显示「未上云」即可，**绝不因为云端挂了而 500**。
             注意这里只给 shortId（= pubId），nodeId 不进任何响应。 */
          cloud: cloudView()
        }, linkExtra))
      }
      /* ============================================================
         🔴 第131节 · task-1 · 云链路三条路由（都站运行在访问码那道闸之后）
         ── 契约（Lead 冻结）──
           GET  /cloud/status  -> 200 { ok:true, shortId, pubId, vipExpireMs, online,
                                        bound:{uid,name,avatar,ms}|null }
           POST /cloud/bind    body { uid, name, avatar } -> 200 { ok:true, shortId, vipExpireMs }
           POST /cloud/redeem  body { code }             -> 200 { ok:true, addedDays, vipExpireMs, shortId }
                                                          失败也是一样 200 { ok:false, error }
         ── 为什么永不 500 ──
           云端挂了、断网、没配 cloud，都只是「云链路暂时不可用」，属于正常状态：
           面板/App 要能照常显示本地功能，绝不能被一条云路由拽死。
           所以这里只可能出现 200（正常/业务失败）与 503（本插件就没有云链路）。
         ── 为什么 nodeId 不出现在任何响应里 ──
           那是插件对云的凭据；对外只认 shortId（pubId 同值）。
         ============================================================ */
      if (p === '/cloud/status' && req.method === 'GET') {
        phoneLastSeen = Date.now()   // 打云状态说明面板/App 真的在场
        noteDevice(req)
        const c = cloudMod()
        if (!c || typeof c.snapshot !== 'function') {
          return sendJson(res, 503, { ok: false, error: '云端不可用' })
        }
        return sendJson(res, 200, cloudStatusBody())
      }
      if (p === '/cloud/bind' && req.method === 'POST') {
        const c = cloudMod()
        if (!c || typeof c.bind !== 'function') {
          return sendJson(res, 503, { ok: false, error: '云端不可用' })
        }
        phoneLastSeen = Date.now()
        noteDevice(req)
        /* body 上限 64KB：绑定信息就是 uid/昵称/头像 URL，头像若是 dataURL 也够。
           解析失败（客户端断开/非法 JSON）当作空对象，交给云侧判「信息不完整」。 */
        let body = {}
        try { body = await readBody(req, 64 * 1024) || {} } catch (e) { body = {} }
        let out = null
        try {
          out = await c.bind({ uid: body.uid, name: body.name, avatar: body.avatar })
        } catch (e) { out = null }
        if (!out || typeof out !== 'object' || out.ok !== true) {
          return sendJson(res, 200, { ok: false, error: cloudErr(out && out.error) })
        }
        return sendJson(res, 200, {
          ok: true,
          shortId: typeof out.shortId === 'string' ? out.shortId : '',
          vipExpireMs: cloudNum(out.vipExpireMs)
        })
      }
      if (p === '/cloud/redeem' && req.method === 'POST') {
        const c = cloudMod()
        if (!c || typeof c.redeem !== 'function') {
          return sendJson(res, 503, { ok: false, error: '云端不可用' })
        }
        phoneLastSeen = Date.now()
        noteDevice(req)
        let body = {}
        try { body = await readBody(req, 16 * 1024) || {} } catch (e) { body = {} }
        const code = typeof body.code === 'string' ? body.code.trim() : ''
        let out = null
        try { out = await c.redeem(code) } catch (e) { out = null }
        if (!out || typeof out !== 'object' || out.ok !== true) {
          /* 失败也回 HTTP 200：兑换码不对是业务结果不是服务器故障，
             手机端照 error 文案提示即可。 */
          return sendJson(res, 200, { ok: false, error: cloudErr(out && out.error) })
        }
        return sendJson(res, 200, {
          ok: true,
          addedDays: cloudNum(out.addedDays),
          vipExpireMs: cloudNum(out.vipExpireMs),
          shortId: typeof out.shortId === 'string' ? out.shortId : ''
        })
      }
      /* 🔴 0.4.3 · 已配对设备免输码换 mp_device Cookie（真打字机的最后一块拼图）。
       * /mp/pair/accept 吃的是面板 6 位一次性码，长期拿着手机连的是 64 位 token，
       * 两者不是一个东西 —— 之前手机要开实时流就得再输一次码，体验断裂。
       * 现在走到这里说明 token 已验过（上面 401 那道闸），用当前面板码
       * 代走一遍 exchange 签发 Cookie。安全面不变：码 15 分钟自过期。
       * 若面板码恰好过期（>15min 没人开面板），返回 409 让手机端提示
       * 打开一次 DSH 面板再连 —— 比输码好，但仍是已知限制。 */
      if (p === '/mp-cookie') {
        phoneLastSeen = Date.now()
        noteDevice(req)              // #A3：换 Cookie 也是「这台设备在场」
        const mpx = o.mp || {}
        /* 🔴 0.4.4 · 优先免码签发（issueDevice）。上面那道 401 已经把长期 token
         * 验过了，6 位面板码再卡一道是多余的 —— 而且它 15 分钟就过期，
         * 会让「DSH 重启后手机自愈重连」在面板没开的时候必然 409。
         * 旧插件没有 issueDevice 时退回原行为（issueForCode + 当前面板码）。 */
        /* 🔴 第170节 · Bug B（主修点）：这条通路以前**只把 6 位面板码递给 issueForCode**，
           手机在 query 上自报的 deviceUid / deviceModel / deviceName 被整条链路吃掉 ⇒
           mint() 拿不到 uid ⇒ 同一台手机每次免码重连都新开一行（用户实测 1 台真机攒 15 行）。
           这里与 /mp/pair/accept 走同一个 aboutOf（App 侧 LanClient.ets:3798-3801 的
           GET /mp-cookie 只带 token + deviceUid，故 model/name 靠 UA 兜底）。 */
        const about = aboutOf(req, null)
        let cookie = ''
        if (typeof mpx.issueDevice === 'function') {
          cookie = mpx.issueDevice(about)
        } else if (typeof mpx.issueForCode === 'function') {
          cookie = mpx.issueForCode(currentPairCode(), about)
        } else {
          return sendJson(res, 501, { ok: false, error: 'mp 未启用' })
        }
        if (!cookie) { return sendJson(res, 409, { ok: false, error: '签发失败，请重启 DSH 后重试' }) }
        return sendJson(res, 200, { ok: true, cookie })
      }
      if (p === '/sessions') {
        phoneLastSeen = Date.now()
        noteDevice(req)              // #A3：同上
        const list = await o.listSessions()
        return sendJson(res, 200, { ok: true, count: list.length, sessions: list })
      }
      /* 🔴 第 100 节 · 会话图片字节（task-22）。
       *   GET /dsh-console/attachment?id=<imageId>
       *   - 鉴权同上：走到这里已经过了 x-dsh-console-token / x-dafeiyu-token 那道闸
       *     （tokenOf 认这两个头，也认 ?token=）；没带/带错一律 401，与其它路由一致。
       *   - id 是宿主附件 id（sha256:<64hex>），插件侧登记表按它取原始字节。
       *   - 失败一律 404 { ok:false, error:'no-such-attachment' }（手机端据此画占位，
       *     不弹错误），包括：没带 id / 没见过这个 id / 宿主读不出来。
       *   - 成功回原始字节 + 正确 Content-Type（登记表里存的就是宿主给的 mediaType：
       *     image/png | image/jpeg | image/webp | image/gif）。
       *   图片是内容寻址的（id 即 sha256），内容永不变化 ⇒ 可长缓存；
       *   仍标 private，别让中间代理随便存。 */
      if (p === '/attachment' && req.method === 'GET') {
        const id = String(url.searchParams.get('id') || '').trim()
        if (!id) return sendJson(res, 404, { ok: false, error: 'no-such-attachment' })
        phoneLastSeen = Date.now()
        noteDevice(req)              // #A3：同上
        let got = null
        try {
          got = typeof o.attachmentOf === 'function' ? await o.attachmentOf(id) : null
        } catch (e) {
          log('[attachment] 读附件出错 ' + id + ': ' + ((e && e.message) || e))
          got = null
        }
        if (!got || !got.data) return sendJson(res, 404, { ok: false, error: 'no-such-attachment' })
        const buf = Buffer.isBuffer(got.data) ? got.data : Buffer.from(got.data)
        if (!buf.length) return sendJson(res, 404, { ok: false, error: 'no-such-attachment' })
        res.writeHead(200, {
          'Content-Type': got.mime || 'application/octet-stream',
          'Content-Length': buf.length,
          'Cache-Control': 'private, max-age=86400, immutable',
          'Access-Control-Allow-Origin': '*'
        })
        return res.end(buf)
      }
      if (p === '/cmd' && req.method === 'POST') {
        // 24MB：手机图片 base64 后 1.4~4MB/张，多张一起传也够
        const body = await readBody(req, 24e6)
        const op = String(body.op || '')
        if (!op) return sendJson(res, 400, { ok: false, error: '缺少 op' })
        return sendJson(res, 200, { ok: true, result: await o.runCommand(op, body.payload || {}) })
      }
      return sendJson(res, 404, { ok: false, error: '未知路径 /dsh-console' + p })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) })
    }
  }

  return {
    start() {
      return new Promise((resolve) => {
        const basePort = Number(o.port) || 8899
        let tries = 0
        const attempt = (port) => {
          tries += 1
          server = http.createServer((req, res) => {
            handler(req, res).catch(() => {
              try { sendJson(res, 500, { ok: false, error: '内部错误' }) } catch (e) { /* 忽略 */ }
            })
          })
          // WebSocket upgrade 必须单独监听：node:http 不会把 upgrade 请求
          // 交给 'request'。鸿蒙客户端连 /mp/api/ws/mux 与 /mp/api/ws/host。
          if (o.mp && typeof o.mp.onUpgrade === 'function') {
            server.on('upgrade', o.mp.onUpgrade)
          }
          server.on('error', (e) => {
            try { server.close() } catch (x) { /* 忽略 */ }
            server = null
            if (e && e.code === 'EADDRINUSE' && tries < MAX_TRIES) {
              // 小程序输 6 位码那条路把 8899 写死了（dsh-console/utils/lan.js:209），
              // 顺延到 8900 会让「自动扫局域网找电脑」直接扫不到。
              // 所以默认不静默顺延，只有明确要求时才让。
              if (!o.allowShift) {
                log('⚠ 端口 ' + port + ' 被占用。')
                log('  小程序只认 8899，请关掉占用它的程序（多半是旧的 dsh-console 实例）再重启 DSH。')
                log('  确实要换端口：给插件配置加 "port": 8900，并让小程序那边同步改。')
                resolve(null)
                return
              }
              log('  端口 ' + port + ' 被占用，换一个…')
              setTimeout(() => attempt(port + 1), 120)
              return
            }
            log('⚠ 局域网服务起不来：' + ((e && e.message) || e))
            resolve(null)
          })
          server.listen(port, '0.0.0.0', () => {
            const addr = server.address()
            boundPort = (addr && addr.port) || port
            boundPortRef.value = boundPort     // ★ 共享给模块级函数
            const urls = lanUrls(boundPort)
            const code = ensurePairCode()
            log('  ── 扫码连接已就绪 ──')
            if (!urls.length) log('  ⚠ 没找到局域网 IP。确认电脑连着 WiFi/网线。')
            log('  配对页：' + (urls[0] || '?') + '/pair')
            log('  配对码：' + code)
            if (boundPort !== basePort) log('  （端口自动换成了 ' + boundPort + '）')
            if (o.mp && typeof o.mp.onUpgrade === 'function') {
              log('  鸿蒙客户端：' + (urls[0] || '?') + '/mp  （配对码换 Cookie 后可用）')
            }
            resolve({ port: boundPort, urls, code })
          })
        }
        attempt(basePort)
      })
    },
    stop() {
      if (server) { try { server.close() } catch (e) { /* 忽略 */ } }
      server = null
      boundPortRef.value = 0
    },
    get port() { return boundPort },
    get urls() { return lanUrls(boundPort) },
    getPairCode() { return ensurePairCode() },
    peekPairCode() { return currentPairCode() },
    getPhoneLastSeen() { return phoneLastSeen },
    /**
     * 挂上 /mp/* 支持（鸿蒙客户端）。之所以是后挂的：配对码封在这个模块里，
     * 而 mp 那边要用同一个码换 Cookie，构造顺序必须是 lan 先、mp 后。
     */
    setMp(mp) { o.mp = mp || null },
    /* 🔴 第 122 节 · task-2（#21-D）· 插件把 tunnel.mjs 的 tunnelStatus() 交进来。
       之所以是「传函数」而不是「传快照」：frpc 的 phase 会在没有请求来的时候自己变
       （登录成功/掉线重连），面板下次来读时必须拿到当下的值，不能被冻在启动那一刻。 */
    setTunnel(fn) { o.tunnelStatus = typeof fn === 'function' ? fn : null },
    panelData
  }
}

/* ============================================================
   浏览器配对页
   ============================================================ */
function pageHtml(d) {
  const rows = (d.ports || []).map((u) => '<li>' + esc(u) + '</li>').join('')
  const qrBlock = d.qrDataUrl
    ? '<div class="qr"><img src="' + d.qrDataUrl + '" alt="扫码连接" /></div>'
    : '<div class="warn">二维码没生成出来（缺 qrcode 依赖）。用下面的 6 位码也行。</div>'
  /* 🔴 第130节 · Web 控制台地址块**不再渲染**。
     原来这里按 d.webUrl 拼一块「用手机浏览器打开 / 扫码开 /web」的卡片；
     控制台已彻底关闭（/web 与 /pet 无条件 403），再显示地址和二维码就是给死链。
     连变量一起删掉，只留这段注释说明为什么没有 webBlock（免得后面有人以为漏了）。 */
  const left = Math.max(0, Math.round((d.codeLeftMs || 0) / 60000))
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH控制台 · 扫码连接</title>
<style>
 body{margin:0;background:#0a1220;color:#e6eefb;padding:26px 16px;
      font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
      display:flex;justify-content:center}
 .card{width:100%;max-width:460px;background:#111d2e;border:1px solid #22344d;
       border-radius:20px;padding:26px;text-align:center}
 h1{font-size:20px;margin:0 0 4px}
 .sub{color:#8fa6c4;font-size:13px;margin-bottom:20px}
 .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:8px;background:${d.dshOk ? '#3ddc97' : '#ff6b6b'}}
 .qr img{width:280px;height:280px;max-width:100%;background:#fff;border-radius:16px;padding:12px;box-sizing:border-box}
 .k{color:#8fa6c4;font-size:13px;margin:20px 0 4px}
 .code{font-size:44px;font-weight:700;letter-spacing:12px;color:#8fc2ff;
       font-family:ui-monospace,Menlo,Consolas,monospace;margin:6px 0}
 .tip{color:#8fc2ff;font-size:14px;margin:8px 0}
 .warn{color:#ffd166;font-size:13px}
 .meta{margin-top:20px;padding-top:16px;border-top:1px solid #22344d;
       color:#5d7391;font-size:12px;text-align:left;line-height:1.9}
 ul{padding-left:18px;margin:6px 0;color:#8fa6c4;font-size:12px;text-align:left}
 code{background:#16253a;padding:2px 6px;border-radius:4px;color:#8fc2ff;word-break:break-all}
 .sec{margin-top:22px;padding-top:20px;border-top:1px solid #22344d}
 .sec-t{font-size:14px;font-weight:600;margin-bottom:10px}
 .wide{display:block;padding:8px 10px;font-size:13px}
</style></head><body><div class="card">
 <h1><span class="dot"></span>${esc(d.name || d.host)}</h1>
 <div class="sub">DSH ${d.dshOk ? '正常' : '读不到'} · ${esc(d.host)}</div>
 <div class="k" style="margin-top:4px">微信小程序：扫这个码</div>
 ${qrBlock}
 <div class="tip">用手机小程序「电脑节点」里的<b>扫一扫</b>扫这个码</div>
 <div class="k">或者在小程序里输这 6 位码</div>
 <div class="code">${esc(d.code || '')}</div>
 <div class="tip" style="color:#5d7391;font-size:12px">${left} 分钟内有效 · 用掉即作废</div>
 <div class="meta">
   小程序用的局域网地址：<br>${rows ? '<ul>' + rows + '</ul>' : '（没找到局域网 IP）'}
   访问码（一般用不到）：<br><code>${esc(d.token)}</code>
 </div>
</div></body></html>`
}

/* ============================================================
   立绘图片：Web 控制台首页用
   从小程序项目 images 目录读 pet.png / pet-dark.png
   路径可配（o.petLightPath / o.petDarkPath），默认指向小程序 images 目录
   ⚠️ 2026-10-04 小程序项目搬到 D 盘后，这里加了候选列表轮询 ——
      只写死一条路径的话，以后再搬一次家立绘就静默变透明图。
   图片读不到时返回 1x1 透明 PNG（不报错，前端不挂）
   ============================================================ */

// 小程序项目 images 目录的候选位置（按优先级，第一个能读到文件的胜出）
const PET_DIR_CANDIDATES = [
  'D:/WeChatProjects/dsh-console-miniprogram/images',                    // 现址（D 盘）
  'C:/Users/Administrator/Documents/WeChatProjects/dsh-console/images'  // 旧址，留着兜底
]

function petPath(fileName) {
  for (const dir of PET_DIR_CANDIDATES) {
    const p = dir + '/' + fileName
    try { if (fs.existsSync(p)) return p } catch (e) { /* 忽略，继续试下一个 */ }
  }
  return PET_DIR_CANDIDATES[0] + '/' + fileName   // 全都没有 → 返回首选，前端有透明图兜底
}

function sendPet(res, theme, o) {
  const configured = theme === 'light'
    ? (o && o.petLightPath)
    : (o && o.petDarkPath)
  const file = configured || petPath(theme === 'light' ? 'pet.png' : 'pet-dark.png')
  try {
    const buf = fs.readFileSync(file)
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(buf)
  } catch (e) {
    // 图片不存在，返回 1x1 透明 PNG
    const transparent = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': transparent.length,
      'Cache-Control': 'no-store'
    })
    res.end(transparent)
  }
}
