/**
 * DSH控制台面板 —— DSH 插件宿主半边
 *
 * 干两件事：
 *
 *   ① 直接读 DSH —— 通过 ctx 拿 sessionController，自己列会话、自己发指令。
 *      不碰 19387，也就不需要装别人的微信桥插件。
 *
 *   ② 起一个局域网服务 —— 手机 App 扫二维码或输 6 位码就能连上。
 *
 * 面板本身（那个二维码卡片）在客户端半边 lib/client.js 里。
 * 两半边怎么说话，用的是 DSH 自己的 connection.fetch 路由：
 * 宿主这半边注册 /api/dsh-console/* ，客户端那半边用浏览器 fetch() 读。
 * 和 dsh-startup-control 用的是同一套路子，已实证跑通。
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { startLanServer } from './lan-server.mjs'
/* 🔴 第 122 节 · task-2（#21-D）· 把 frpc 收进插件：进程管理全在 tunnel.mjs 里，
   这里只负责「插件启动时拉一次、卸载时停一次」，别在别处再 spawn frpc。 */
import { startTunnel, stopTunnel, tunnelStatus } from './tunnel.mjs'
import { attachMp } from './mp-support.mjs'
import { stripAcp } from './mp-contract.mjs'
import { createAttachmentRegistry } from './attachments.mjs'
/* 🔴 第 134 节 · 云链路（公网短 ID + 体验码兑换）：网络与落盘全在 cloud-link.mjs，
   这里只负责「启动时建一次、把句柄交给 lan-server」。它所有路径都不抛，
   外面再套一层 try/catch —— 云端挂了绝不能让插件起不来。 */
import { createCloudLink } from './cloud-link.mjs'
/* 🔴 第209节 · task-1「检测升级」引擎：npm 版号检测 + 一键升级/rpm 子进程全在
   dsh-console-cloud.mjs 里，本文件只做转发（runCommand 的 update* 五个 op）。 */
import { createCloudPlugin } from './dsh-console-cloud.mjs'


/* ============================================================
 * 🔴 第 111 节 · task-4 / #73 插件半（协议壳：附件描述 + 系统注入）。
 *
 * 病灶（真机截图 + 离线素材双证）：插件下发的 prompt/prompts/工具详情里混着
 * DSH 发给模型的**描述块**，手机端气泡把它当用户输入画出来：
 *   ① 附件描述（DSH asar 的 formatImageReadOutput 模板，实测样本 app.asar:1025826）：
 *      <path>…\_shots-baseline\real_base.jpeg</path>
 *      <type>image</type>
 *      <content>
 *      image/jpeg image, 1320x2848 px, 213235 bytes
 *      </content>
 *   ② <system-reminder>…</system-reminder>（工作区 AGENTS.md / skill 清单）。
 * 二者都不是 ACP 标记（stripAcp 盖不住），也不是 INJECT_RES 前缀能命中的。
 *
 * 口径与客户端 Session.ets:4853 的 stripShell **逐条一致**（同边界、同兜底），
 * 免得同一份脏串在两端被两套规则裁出两种结果：
 *   ① 三兄弟 path+type+content 必须紧邻（之间只允许空白）才剥；正文里孤立的
 *      <type> 后面没有 </content> 配对，一律不动。
 *   ② 只有 <content> 一块时，块内必须含 `image/` 或 ` px,`（附件描述固定特征）。
 *   ③ <system-reminder> 先剥闭合完整的整块，再兜「未闭合开标签到串尾」。
 * 全部标签都是**未转义 ASCII 尖括号**（已核实不是 &#34; / &lt; 转义）。
 * 幂等、零成本：不含 '<' 的串第一行就返回。
 *
 * 位置：**模块顶层**（不是 apply 内）—— stripAcpInTurns 是 export 的模块级函数
 *   （见文件末），它也要用这套规则；做成 apply 内局部函数会让「全文通道」
 *   整条抛 stripShellText is not defined 并静默退回 120 字概要（已实测踩到）。
 * ============================================================ */
const SHELL_RE_PATH_TC = /<path>[\s\S]*?<\/path>\s*<type>[\s\S]*?<\/type>\s*<content>[\s\S]*?(<\/content>|$)/g
const SHELL_RE_PATH_T = /<path>[\s\S]*?<\/path>\s*<type>[\s\S]*?<\/type>/g
const SHELL_RE_CONTENT = /<content>\s*[\s\S]*?(image\/| px,)[\s\S]*?<\/content>/g
const SHELL_RE_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const SHELL_RE_REMINDER_OPEN = /<system-reminder>[\s\S]*$/g

function stripShellText(s) {
  const t = String(s || '')
  if (t.indexOf('<') < 0) return t
  return t
    .replace(SHELL_RE_PATH_TC, '')
    .replace(SHELL_RE_PATH_T, '')
    .replace(SHELL_RE_CONTENT, '')
    .replace(SHELL_RE_REMINDER, '')
    .replace(SHELL_RE_REMINDER_OPEN, '')
}

/* 🔴 第 112 节 · task-6 补丁：title 被 stripShellText 整块剥成空串时的兜底。
 * 根因（projcache 实锤 sessions/3afe8d90-…）：子会话 title 本身就是整条
 * <system-reminder> 注入块，剥壳后 = ''；26 条空标题**全部** origin=subagent，
 * 且 26/26 都带 subagent.label（零缺失）。
 * subagent 投影两种形状都兼容：
 *   wire（session.list items[].projections.values.subagent）
 *     = { mode:'continuable'|'one-shot', label, seq }
 *   projcache 落盘 = { identity:{ mode, label, seq } }
 * label 必须是 string 且 trim 后非空才算数；任何其它形状一律回空串
 * （客户端 Index.ets:1966/2117 已有 String(s.title || '未命名会话')，
 *   插件侧不写死文案，避免两端漂移）。 */
function subagentLabelOf(v) {
  try {
    const sa = v && v.subagent
    if (!sa || typeof sa !== 'object') return ''
    const cands = [sa.label, sa.identity && sa.identity.label]
    for (const c of cands) {
      if (typeof c === 'string' && c.trim()) return c.trim()
    }
    return ''
  } catch (e) { return '' }
}

/** title 统一出口：先剥协议壳，空则兜子智能体标签，仍空回空串。 */
function withTitleFallback(raw, v) {
  const t = stripShellText(String(raw || ''))
  if (t) return t
  return subagentLabelOf(v)
}

export const name = 'dsh-console'

/**
 * 服务声明。
 * - connection：Host 的 Connection 服务持有认证过的 Fetch 路由表，
 *   没有它面板就没数据（参考 dsh-startup-control/lib/host.js:40）。
 * - sessionController：读会话、发消息。
 */
export const inject = ['connection', 'sessionController']

/** 面板数据路由。客户端半边用 fetch() 读它。 */
export const STATE_PATH = '/api/dsh-console/state'
/** 「换一张新配对码」路由。 */
export const NEWCODE_PATH = '/api/dsh-console/newcode'
/** 会话列表路由。 */
export const SESSIONS_PATH = '/api/dsh-console/sessions'
/** 「发一条消息到某个会话」路由。 */
export const CMD_PATH = '/api/dsh-console/cmd'

// 版本号动态读 package.json，不再硬编码 —— 0.2.0→0.2.1 时忘了改这里，
// 日志和面板显示的版本就撒谎了（2026-10-03 04:2x 发现）。
const PLUGIN_VERSION = (() => {
  try {
    // import.meta.url = 本文件位置（<插件根>/lib/index.js），package.json 在上一级。
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '?'
  } catch (_) {
    return 'unknown'
  }
})()

/* ============================================================
 * 🔴 第202节 · task-21：/info 下发 npm 上的最新版号（latestVersion）。
 *
 * 手机 App 靠它判断「插件可更新」。两条硬约束：
 *   ① 绝不阻塞请求路径 —— refreshLatestVersion() 只发不 await（fire-and-forget），
 *      /info 有值就给缓存值，没值就给空串（下一轮 TTL 到期后才有号）。
 *   ② 网络失败绝不冒泡 —— registry 挂了 / 超时 / 非 200 / JSON 不对，一律静默，
 *      保留上一次的号；latestAt 照样更新（按 TTL 退避，不猛打 registry）。
 *
 * 测试缝（单测专用，只读 env，值非法就落回生产默认）：
 *   DSH_CONSOLE_NPM_LATEST_URL 覆盖请求地址；DSH_CONSOLE_NPM_TTL_MS 覆盖 TTL。
 *   单测环境下没显式给 URL ⇒ 直接跳过网络（否则每个跑 apply() 的 spec 都会真打
 *   registry，拖慢整套用例、还依赖外网）。
 * ============================================================ */
let latestVersion = ''
let latestAt = 0
const LATEST_TTL_MS = 10 * 60 * 1000
const LATEST_URL = 'https://registry.npmjs.org/dsh-console-plugin/latest'
export function refreshLatestVersion() {
  const ttlRaw = Number(process.env.DSH_CONSOLE_NPM_TTL_MS)
  const ttl = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : LATEST_TTL_MS
  if (Date.now() - latestAt < ttl) return
  latestAt = Date.now()
  const inTest = !!(process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test')
  const url = process.env.DSH_CONSOLE_NPM_LATEST_URL || (inTest ? '' : LATEST_URL)
  if (!url) return
  fetch(url, { signal: AbortSignal.timeout(5000) })
    .then((r) => (r && r.ok ? r.json() : null))
    .then((j) => {
      const v = j && typeof j.version === 'string' ? j.version.trim() : ''
      if (v) latestVersion = v
    })
    .catch(() => { /* 静默：拿不到就保留旧值，绝不影响 /info */ })
}

/** 只读快照（给单测看缓存，不给 HTTP 层用）。 */
export function latestVersionNow() { return latestVersion }

export function apply(ctx, config = {}) {
  // ⚠️ ctx.logger 常常是 undefined，console.log 又被 DSH 吞掉 ——
  //    所以自己往文件里写，不然出问题时什么都看不到。
  //    （别家插件也是这么干的：~/.dsh/startup-control.log 等一堆）
  const LOG_FILE = (() => {
    try {
      const home = os.homedir()
      const dir = path.join(home, '.dsh')
      fs.mkdirSync(dir, { recursive: true })
      return path.join(dir, 'dsh-console.log')
    } catch (e) {
      return ''
    }
  })()
  const logger = (ctx && ctx.logger) || null
  const say = (level, msg) => {
    const line = '[' + new Date().toISOString() + '] [' + level + '] [DSH] ' + msg
    if (LOG_FILE) {
      try { fs.appendFileSync(LOG_FILE, line + '\n') } catch (e) { /* 忽略 */ }
    }
    try {
      if (logger && typeof logger[level] === 'function') logger[level](line)
      else console.log(line)
    } catch (e) { /* 忽略 */ }
  }
  const log = (m) => say('info', m)
  log('==== 插件加载 ==== version=' + PLUGIN_VERSION + ' config=' + JSON.stringify({
    port: config.port, allowShiftPort: config.allowShiftPort, name: config.name
  }))

  /* 🔴 0.4.3 · agent-preset-registry 探测（用户要做「当前预设只读展示」）。
   * profile 配置里实锤有这个服务（default: standard, selectedDefault: minimal），
   * 但它的方法面在 app.asar 里读不到 —— 照 sessionController 的老办法，
   * 运行时把服务对象的 keys / 常用取值方法探一遍打进日志，下次重启后看日志定接口。
   * 探测结果同时缓存到 presetProbe，/info 顺手带上，前端先展示拿得到的部分。 */
  let presetProbe = { available: false, current: '', probed: false }
  /** 🔴 0.4.3 · 懒探测：apply() 时 preset 服务可能还没注册（首启实测 ctx.get 返回空），
   *  改成每次 getInfo 时尝试，成功即缓存 —— 手机刷新节点详情页就带出预设。 */
  function probePreset() {
    if (presetProbe.probed) return
    try {
      /* ⚠️ 服务名纠正（asar 实锤）：@deepseek-ai/dsh-agent-preset-registry 的类构造是
         super(ctx,'agentPresets')，旧名 'agent-preset-registry' 只是 profile 里的老写法，
         永远拿不到服务对象。两个都试，新的优先。 */
      const reg = ctx && typeof ctx.get === 'function'
        ? (ctx.get('agentPresets') || ctx.get('agent-preset-registry'))
        : null
      if (!reg) return
      presetProbe.probed = true
      presetProbe.available = true
      const keys = Object.keys(reg)
      log('[preset-probe] service keys=' + JSON.stringify(keys))
      /* 🔴 批次F · task-25：老写法只认 reg.current / selected / selectedDefault 三个属性，
         而 asar 实锤 AgentPresetRegistry 实例上根本没有这些键（keys 实测 =
         ctx,name,typertRemote,config,owner,definitions,generations,bindings,switches），
         真正的全局默认在 `config.selectedDefault`（volatile settings 字段）+ `defaultId`
         getter（`return this.config.selectedDefault.get() ?? this.config.default`）里 ⇒
         统一交给 presetCurrentId() 读，探测日志才不会再恒打 current=""。 */
      const v = presetCurrentId(reg)
      presetProbe.current = v
      log('[preset-probe] current=' + JSON.stringify(v).slice(0, 100))
    } catch (e) {
      log('[preset-probe] failed: ' + ((e && e.message) || e))
    }
  }

  /* 🔴 第 110 节 · task-17：**实时**读当前预设，不走 presetProbe.probed 缓存。
   * 根因：probePreset() 第一次成功后 probed=true 永久短路，/info 的 agentPreset
   * 永远是首探那一刻的值 —— 实测 selectPreset（空 sid，改全局默认）之后
   * presetCatalog.current 已经是 minimal，/info 仍然吐 ptc。
   * 口径：与 runCommand('presetCatalog') 的 current 完全同源（同一个
   * presetCurrentId(reg) 直出），所以两边永远不会打架。
   * 服务拿不到 ⇒ 返回 '' 且 available=false（向后兼容：老前端照旧显示未知）。 */
  function readPresetNow() {
    probePreset()                    // 保留首探日志（只有第一次真的打）
    const reg = agentPresetsService()
    if (!reg) {
      presetProbe.available = false
      presetProbe.current = ''
      return ''
    }
    presetProbe.available = true
    let v = ''
    try { v = presetCurrentId(reg) } catch (e) { v = '' }
    presetProbe.current = v
    return v
  }

  // 节点名：配置 > 环境变量 > 电脑名
  const nodeName = String(config.name || process.env.DSH_CONSOLE_NAME || os.hostname() || '我的电脑')

  // 访问码：32 字节随机（64 位十六进制）。
  // ⚠️ 2026-10-03 升级：从「存内存、重启就换」改成「持久化到磁盘」——
  //    这是参考 dsh-wechat-remote 的 gate-state.js 学来的（它把 LAN 令牌
  //    原子写入节点存储，重启不变，手机存一次就永久免配对秒连）。
  //    我们以前每次重启 DSH 都换新 token，手机里存的旧 token 作废，
  //    用户就得重新扫码/输码 —— 现在落盘后一次配对终身受用。
  //    存放位置：~/.dsh/dsh-console-token.json（和日志文件同目录，
  //    不放 profile node_modules 里，避免插件重装时被连坐删掉）。
  //    破损/读不了就重新生成新的（退回旧行为，重新配对一次即可）。
  const tokenFile = path.join(os.homedir(), '.dsh', 'dsh-console-token.json')
  let token = ''
  try {
    if (fs.existsSync(tokenFile)) {
      const parsed = JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
      if (parsed && typeof parsed.token === 'string' && parsed.token.length >= 32) {
        token = parsed.token
        log('访问码已从磁盘载入（重启不变，手机免重新配对）')
      }
    }
  } catch (e) {
    // 读坏了不硬撑：备份原文件后走重新生成，行为退回旧版。
    try { fs.renameSync(tokenFile, tokenFile + '.corrupt-' + Date.now()) } catch (_) { /* 备不成就算了 */ }
    log('访问码文件读不了（' + (e && e.message ? e.message : e) + '），重新生成 —— 手机需要重新配对一次')
  }
  if (!token) {
    token = String(config.token || process.env.DSH_CONSOLE_TOKEN || randomHex(32))
    try {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true })
      fs.writeFileSync(tokenFile, JSON.stringify({ token }, null, 2), { mode: 0o600 })
      log('访问码已持久化到 ' + tokenFile)
    } catch (e) {
      // 写不了盘就退回内存模式：token 仍可用，只是重启会变（旧行为）。
      log('访问码写盘失败（' + (e && e.message ? e.message : e) + '），退回内存模式 —— 重启后需要重新配对')
    }
  }

  // ---- 会话读取器 ----
  // ⚠️ 同样用 ctx.get('sessionController')，不要 ctx.sessionController。
  const ctl = ctx && typeof ctx.get === 'function' ? ctx.get('sessionController') : null
  // 归档/删除走这里（workspace.archiveSession / workspace.delete 的宿主服务）
  const reg = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null
  let dshOk = !!ctl
  let dshError = ctl ? '' : 'sessionController 不可用'

  // 一次性能力探针：把 sessionController 的方法面打进日志 ——
  // 「全文对话(history)/换模型(selectModel)」这类新功能先看这里有没有货，
  // 宿主实际版本才是权威，别对着 node_modules 猜签名（0.3.0 加）。
  try {
    const names = new Set()
    let o = ctl
    while (o && o !== Object.prototype) {
      for (const n of Object.getOwnPropertyNames(o)) names.add(n)
      o = Object.getPrototypeOf(o)
    }
    log('[probe] sessionController 方法面: ' +
      [...names].filter((n) => n !== 'constructor').sort().join(', '))
  } catch (e) {
    log('[probe] 失败: ' + ((e && e.message) || e))
  }

  // 逐条注册，把每条的结果（成功/失败原因）都记下来。
  // 之前四条全包在 ctx.effect 里，一旦 register 抛错就整条被吞掉，
  // 结果是面板 404 而日志一个字都没有。
  const pending = []

  // ---- 实时生成状态（0.3.2）：订阅宿主 session/event 事件总线 ----
  // 手机端「正在回复」要像 DSH 桌面一样实时打字 —— 轮询 history 只能看到
  // 落盘的完成态消息（assistant/message），生成中的过程全在 assistant/chunk
  // 增量事件里，它们不会立刻出现在 history 轮里。
  // 所以直接挂 cordis 事件总线，进程内攒 live 缓存，detail 返回时带上。
  // 回调签名实证（dsh-session/lib/index.js:1462）：callbackArgs = [session, event]
  // event = { type, seq, time(epoch ms), data }
  // chunk 载荷实证（dsh-llm types.d.ts StreamChunk + dsh-session chunk-rows）：
  //   assistant/chunk → data:{ turn, step, chunk:{type:'text-delta'|'reasoning-delta',text} | {type:'block-end',block} }
  /* sessionId → { think, text, thinks:[], steps:[], tools:[], lastAt }
     0.4.10 · thinks/steps 是「步骤流」：thinks 存每步思考全文，steps 按
     发生顺序记 {k:'t'|'o', i, s}（t=thinks 下标，o=tools 下标，s=step 号）。
     客户端照 steps 顺序画「✳ 思考 / 🗎 读取 · 路径」行，就是 DSH 面板同款。 */
  const live = new Map()
  const LIVE_TEXT_CAP = 300000   // 防极端长回复把内存吃爆

  /* 🔴 第 100 节 · 会话图片（task-22）。
   *
   * 手机端气泡要显示图片，但它只拿得到元数据（{id,name,mime,bytes}），字节
   * 回头走 LAN 的 /dsh-console/attachment?id=… 拉。登记表在这边：
   *   宿主图片块 = { type:'image', attachment: ImageAttachmentRef }，
   *   ImageAttachmentRef.attachmentId 形如 "sha256:<64位hex>"（宿主 asar 实锤：
   *   ID_PATTERN = /^sha256:([a-f0-9]{64})$/），本身即内容寻址的稳定标识，
   *   直接当下载 key —— **不把本地绝对路径下发给手机**。
   *   读字节一律走宿主自己的 attachments 服务（readImage 会校验 sha256 与字节数，
   *   坏文件抛 ATTACHMENT_CORRUPT/NOT_FOUND），绝不自拼 DSH_HOME 路径。 */
  const attachments = createAttachmentRegistry({
    store: () => (typeof ctx.get === 'function' ? ctx.get('attachments') : null),
    log: log
  })

  /** 一个 content 块数组里所有图片块的宿主引用（顺序即出现顺序，可含重复）。 */
  function imageRefsOf(content) {
    if (!Array.isArray(content)) return []
    const out = []
    for (const b of content) {
      if (b && b.type === 'image' && b.attachment) out.push(b.attachment)
    }
    return out
  }

  /* 🔴 第 186 节 · task-B：助手**正文里写的**本地图片路径。
   *  用户 m00875：回复正文里的 `![x](D:/a.png)` 手机端看不到图。根因 —— 宿主
   *  只给「真的被当成附件」的 image 块，模型把路径写进正文时没有任何块可登记。
   *  这里按路径读盘、按内容算 sha256 登记，id 与宿主同形（sha256:<64hex>），
   *  手机端既有取图管线一个字都不用改。
   *  ⚠️ 三道闸：扩展名白名单 + 绝对路径 + 普通文件且 ≤8MB；读失败一律静默跳过
   *     （绝不抛、绝不 500）。**路径绝不下发**，出去的只有内容寻址的 id。 */
  const LOCAL_IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?|ico)$/i
  /* 同一张白名单，但**不锚定**串尾 —— 只用来做「这段正文里到底有没有图片扩展名」
     的快速排除（markdown 写法里扩展名后面还跟着 ')'，锚尾版本判不出来）。 */
  const LOCAL_IMG_EXT_ANY_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?|ico)/i
  /** 同一轮最多登记几张本地图（防一段正文列一百个路径把登记表与 payload 撑爆）。 */
  const LOCAL_IMG_PER_TURN = 20
  /** 单张本地图大小上限：超过按「不是图片」跳过（不读进内存）。 */
  const LOCAL_IMG_MAX_BYTES = 8 * 1024 * 1024

  /**
   * 正文里的一个目标串（markdown 链接目标 / 裸路径）→ 可读的本地绝对路径；
   * 不合格返回 ''（调用方静默跳过）。正反斜杠都认、可选 file:// 前缀去掉。
   */
  function localImagePathOf(dest) {
    let s = String(dest || '').trim()
    if (!s) return ''
    /* markdown 目标允许 <path> 包一层；#锚点 / ?查询 切掉。 */
    if (s.charAt(0) === '<' && s.charAt(s.length - 1) === '>') s = s.slice(1, -1).trim()
    s = s.split('#')[0].split('?')[0].trim()
    /* markdown 的标题段：`a.png "标题"` / `a.png 'x'` ⇒ 只取路径那截。
       注意只在引号紧跟空白时切，否则带空格的合法路径会被截断。 */
    const cut = /^(\S+)\s+["'(]/.exec(s)
    if (cut) s = cut[1]
    if (/^file:\/\//i.test(s)) s = s.replace(/^file:\/\//i, '')
    if (!LOCAL_IMG_EXT_RE.test(s)) return ''
    /* 只认绝对路径：相对路径的基准是宿主进程的 cwd（不可知）⇒ 一律不猜。 */
    if (!path.isAbsolute(s)) return ''
    return s.replace(/\//g, path.sep)
  }

  /**
   * 从一段正文里按**出现顺序**抽出本地图片的登记 id。
   * 写法① markdown 图片 ![alt](dest)；写法② 整行 trim 后就是一条裸本地路径。
   * @param text  一段正文（空串直接返回）
   * @param limit 本轮还能登记几张（<=0 直接返回空）
   */
  function localImageIdsOf(text, limit) {
    const out = []
    if (!text || limit <= 0) return out
    const s = String(text)
    /* 一眼排除：正文里连个图片扩展名都没有 —— 绝大多数轮走到这里就返回，不读盘。 */
    if (!LOCAL_IMG_EXT_ANY_RE.test(s)) return out
    const dests = []
    const reMd = /!\[[^\]]*\]\(\s*([^)]+?)\s*\)/g
    let m = reMd.exec(s)
    while (m) { dests.push(m[1]); m = reMd.exec(s) }
    for (const line of s.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      if (t.charAt(0) === '!' || t.indexOf('](') >= 0) continue   // markdown 已收（或整段是引用）
      dests.push(t)
    }
    for (const dest of dests) {
      if (out.length >= limit) break
      const fp = localImagePathOf(dest)
      if (!fp) continue
      let id = ''
      try {
        const st = fs.statSync(fp)
        if (!st.isFile() || st.size <= 0 || st.size > LOCAL_IMG_MAX_BYTES) continue
        id = attachments.registerLocalBytes(fs.readFileSync(fp), { name: path.basename(fp) })
      } catch (e) { continue }        // 读失败 / 文件不在 —— 静默跳过
      if (id && out.indexOf(id) < 0) out.push(id)
    }
    return out
  }

  /** 0.4.10 · 从 assistant/message.data.stream 里取本条事件的思考全文 */
  function streamReasoning(ev) {
    const st = ev && ev.data && ev.data.stream
    if (!Array.isArray(st)) return ''
    let s = ''
    for (const item of st) {
      if (!item || typeof item !== 'object') continue
      if (item.type === 'reasoning-chunks' && Array.isArray(item.texts)) s += item.texts.join('')
      else if (item.type === 'chunk' && item.chunk && item.chunk.type === 'block-end') {
        const b = item.chunk.block
        if (b && b.type === 'reasoning' && typeof b.text === 'string' && !s) s = b.text
      }
    }
    /* ACP 标记可能整段落在思考里（宿主把 <acp …>m00181</acp> 当正文），
       思考折叠块不过客户端 cleanMd，必须在这里剥掉。 */
    return stripAcp(s)
  }

  /** 0.4.10 · live 工具卡裁剪：tools 从头部丢，同步把 steps 里的工具序号左移 */
  function trimLiveTools(L) {
    if (!L || !Array.isArray(L.tools)) return
    if (L.tools.length <= LIVE_TOOLS_KEEP) return
    const drop = L.tools.length - LIVE_TOOLS_KEEP
    L.tools = L.tools.slice(drop)
    const out = []
    for (const s of (L.steps || [])) {
      if (!s || s.k !== 'o') { out.push(s); continue }
      const ni = (Number(s.i) || 0) - drop
      if (ni >= 0) out.push({ k: 'o', i: ni, s: Number(s.s) || 0 })
    }
    L.steps = out
  }

  /* 🔴 第 186 节 · task-A：live 子调用序列 acts。
   *
   * 【为什么】用户 m01047：手机端「生成中」卡标题永远停在「正在运行代码」。
   * 根因 —— RUN_CODE 是**父调用**，真正在动的是它内部派发的子调用
   * （read / grep / bash / subagent…），这些只出现在宿主的
   *   tool/ptc-dispatch-start（子调用开始，带 name + arguments）
   *   tool/ptc-dispatch      （子调用结果，带 content / isError）
   * 两类事件里（实证：dsh-client-ui-chat 的 childCall/childResult，data 形状
   * { rootCallId, parentCallId, subCallId, name, arguments, content?, isError? }）。
   * 插件原来只收 tool/call（run_code 本身）⇒ 名字永远是 run_code、detail 永远
   * 是那段 code，标题自然不动。acts 是**并列**的新字段，不动 tools/steps 语义。
   */

  /** 往 L.acts 末尾追加一条子调用（按发生顺序）；超 ACTS_KEEP 从头部整条丢。 */
  function pushAct(L, name, args, time, subCallId) {
    if (!L || !name) return
    if (!Array.isArray(L.acts)) L.acts = []
    L.acts.push({
      name: String(name),
      state: 'run',
      /* subCallId 只**对内**用于配对结果事件，readDetail 出口按 {name,state,detail,at}
         冻结形状重排，绝不下发内部 id。 */
      sub: String(subCallId || ''),
      /* 用与工具卡 detail 同款的 briefOf 摘要口径（≤ BRIEF_MAX=72 字）。
         arguments 可能是对象，briefOf 只认字符串 ⇒ 这里统一 stringify。 */
      detail: stripShellText(briefOf(typeof args === 'string' ? args : (() => {
        try { return JSON.stringify(args || '') } catch (e) { return '' }
      })())),
      at: Number(time) || Date.now()
    })
    if (L.acts.length > ACTS_KEEP) L.acts = L.acts.slice(L.acts.length - ACTS_KEEP)
  }

  /** 收到某条子调用的结果（tool/ptc-dispatch）⇒ 把对应 act 的 state 改成 done/err。
   *  配对优先用 subCallId（同一条子调用，最准）；宿主/日志里没给 subCallId 时退回
   *  「最近一条同名且还没结束的」—— 同一父调用里同名子调用是串行派发的，不会歧义。 */
  function markActDone(L, name, isError, subCallId) {
    if (!L || !Array.isArray(L.acts) || !L.acts.length) return
    const sub = String(subCallId || '')
    if (sub) {
      for (let i = L.acts.length - 1; i >= 0; i--) {
        const a = L.acts[i]
        if (a && a.sub && a.sub === sub) { a.state = isError ? 'err' : 'done'; return }
      }
    }
    for (let i = L.acts.length - 1; i >= 0; i--) {
      const a = L.acts[i]
      if (a && a.state === 'run' && String(a.name) === String(name)) {
        a.state = isError ? 'err' : 'done'
        return
      }
    }
  }

  /** 兜底：本轮结束时仍挂 run 的子调用标 done（父调用早已返回，不可能还在跑）。 */
  function settleActs(L) {
    if (!L || !Array.isArray(L.acts)) return
    for (const a of L.acts) if (a && a.state === 'run') a.state = 'done'
  }

  let liveDiagOnce = false       // 首个事件打一条诊断日志，确认总线真的在响
  const onSessionEvent = (session, ev) => {
    try {
      if (!session || !ev || typeof ev !== 'object') return
      // 官方插件（dsh-agent-presets）同款用法：session.id 直接可取；header.id 兜底
      const sid = session.id || (session.header && session.header.id)
      if (!sid) return
      if (!liveDiagOnce) {
        liveDiagOnce = true
        log('[live] 收到首个 session/event: type=' + ev.type + ' session=' + String(sid).slice(0, 8) + '…（总线确认在响）')
      }
      if (ev.type === 'turn/start') {
        /* 🩸 第 134 节 · 问题4：startedMs = 本轮开始的毫秒戳，随 live 一起下发，
           手机端拿它算真实用时（不再退化成「进页面那一刻」）。 */
        /* 🔴 第 167 节 · T1：images 只放**用户**发的图，助手图另走 aimages。
           同一数组被客户端「用户气泡」和「助手卡」各画一次 ⇒ 用户看到图重复。 */
        /* 第 186 节 · task-A：acts 与 tools 并列（子调用序列），开轮即空。 */
        live.set(sid, { think: '', text: '', thinks: [], steps: [], tools: [], acts: [], images: [], aimages: [], startedMs: evMs(ev), lastAt: Number(ev.time) || Date.now() })
        return
      }
      if (ev.type === 'turn/end') { live.delete(sid); return }
      // 0.3.3：没赶上 turn/start 也建档 —— 孤儿 chunk 照样显示（旧版直接丢，
      // 用户看到的就是"一直没回复完"）
      const L0 = live.get(sid)
      const L = L0 || (() => { const n = { think: '', text: '', thinks: [], steps: [], tools: [], acts: [], images: [], aimages: [], startedMs: evMs(ev), lastAt: 0 }; live.set(sid, n); return n })()
      if (!Array.isArray(L.acts)) L.acts = []   // 老宿主/老缓存补键（第 186 节 · task-A）
      if (ev.type === 'assistant/message') {
        // ⚠️ 0.3.3 关键修正：工具循环里 assistant/message 会中途落盘，
        // 已落盘的部分 history 轮里就有了 —— live 只留之后的增量，
        // 不然手机端"已落盘的半截 + live 全量"重复显示
        L.text = ''
        L.think = ''
        /* 0.4.10 · 步骤流：本条 assistant/message = 一个 step。
           已落盘的部分由 history 负责画，live 只画「当前这一步」，
           所以 steps/thinks 一起清空重建 —— 与 text/think 同一语义。 */
        L.thinks = []
        L.steps = []
        L.images = []
        L.aimages = []   // 第 167 节 T1：助手图与用户图分家（同 text/think 一样，live 只留这一步的）
        /* 第 186 节 · task-A：acts 与本条 assistant/message 同步清空（父调用已落盘，
           子调用序列跟着这一步走）。 */
        L.acts = []
        /* 0.4.8：该 step 已落盘，清掉旧增量后再吸收本条 stream
           （宿主不发 assistant/chunk，增量只在 assistant/message 里） */
        absorbStream(L, ev)
        const rz = streamReasoning(ev)
        if (rz) {
          L.thinks.push(clip(rz, THINK_STEP_MAX))
          L.steps.push({ k: 't', i: 0, s: Number((ev.data || {}).step) || 0 })
        }
        /* 第 100 节 · 生成中也可能带图（ACP 助手图片下行）：登记到本轮 live 档。
           只登记，不下发 ref —— 下发的形状由 readDetail 统一转成冻结形状。 */
        const mImg = ev.data && ev.data.message
        for (const ref of imageRefsOf(mImg && mImg.content)) {
          const iid = attachments.register(ref)
          // 第 167 节 T1：assistant/message 登记的图 ⇒ aimages（原来进 images，被当用户图重画一遍）
          if (iid && (!L.aimages || L.aimages.indexOf(iid) < 0)) { if (!L.aimages) L.aimages = []; L.aimages.push(iid) }
        }
        /* 🔴 第 186 节 · task-B：正文里的本地图片路径（\`![x](D:/a.png)\`）——
           与上面宿主 image 块同一目标数组 aimages，App 的助手卡图片行直接能画。
           只认已存在、白名单扩展名、≤8MB 的绝对路径；读失败静默跳过。 */
        for (const lid of localImageIdsOf(L.text, LOCAL_IMG_PER_TURN)) {
          if (L.aimages.indexOf(lid) < 0) L.aimages.push(lid)
        }
        L.lastAt = Number(ev.time) || Date.now()
        return
      }
      if (ev.type === 'assistant/chunk') {
        const c = ev.data && ev.data.chunk
        if (!c) return
        if (c.type === 'text-delta') L.text += c.text || ''
        else if (c.type === 'reasoning-delta') L.think += c.text || ''
        // block-end 的 tool-call 块不再 push —— 同一个工具 tool/call 事件还会来，
        // 两处都收会出重复卡片（旧版只收名字看不出，收详情后就穿帮了）
        if (L.text.length > LIVE_TEXT_CAP) L.text = L.text.slice(-100000)
        if (L.think.length > LIVE_TEXT_CAP) L.think = L.think.slice(-100000)
        L.lastAt = Number(ev.time) || Date.now()
      } else if (ev.type === 'tool/call') {
        const d = ev.data || {}
        let args = d.arguments
        if (typeof args !== 'string') { try { args = JSON.stringify(d.arguments || d.input || '') } catch (e) { args = '' } }
        L.tools.push({
          name: String(d.name || d.tool || '工具'), state: 'run',
          /* 第 111 节 · task-4 / #79：live（生成中卡）详情**不带**「已截断」字面量。
             原来这里是 clipText ⇒ 末尾挂 '…（已截断 N 字）'，正是用户点开生成中
             工具卡看到的「会页面生成中咋会显示已截断」。live 走 clip（只留 '…'），
             历史全文通道 fold/buildTrace 保持 clipText 不动（payload.spec ③ 钉住）。 */
          detail: stripShellText(clip(args, TOOL_DETAIL_MAX)), result: '',
          brief: briefOf(args)
        })
        L.steps.push({ k: 'o', i: L.tools.length - 1, s: Number(d.step) || 0 })
        trimLiveTools(L)
        L.lastAt = Number(ev.time) || Date.now()
      } else if (ev.type === 'tool/result') {
        const d = ev.data || {}
        const m = d.message
        const errInBlocks = Array.isArray(m && m.content) &&
          m.content.some((b) => b && b.type === 'tool-result' && b.isError)
        const last = L.tools && L.tools.length ? L.tools[L.tools.length - 1] : null
        if (last && last.state === 'run') {
          last.state = (d.isError || errInBlocks) ? 'err' : 'done'
          // 第 111 节：live 结果去标记（壳已由 contentText 剥掉，详见上）
          last.result = clip(contentText(m && m.content), TOOL_DETAIL_MAX)
        }
        L.lastAt = Number(ev.time) || Date.now()
      } else if (ev.type === 'tool/ptc-dispatch-start') {
        /* 🔴 第 186 节 · task-A：run_code 内部的**子调用开始**（read / grep / bash /
           subagent…）。data 形状实证（dsh-client-ui-chat）：
           { rootCallId, parentCallId, subCallId, name, arguments }。
           父调用那条 tool/call 照旧进 tools（老宿主没有这两类事件时行为不变）。 */
        const d = ev.data || {}
        pushAct(L, d.name || d.tool, d.arguments !== undefined ? d.arguments : d.input, ev.time, d.subCallId)
        L.lastAt = Number(ev.time) || Date.now()
      } else if (ev.type === 'tool/ptc-dispatch') {
        /* 同一条子调用的结果（tool/ptc-dispatch-start 的收尾），把对应 act 标 done/err。
           data: { …, subCallId, name, arguments, content?, isError?, error? } */
        const d = ev.data || {}
        markActDone(L, d.name || d.tool, d.isError === true || !!d.error, d.subCallId)
        L.lastAt = Number(ev.time) || Date.now()
      }
    } catch (e) { /* 单条事件处理失败绝不能影响宿主 */ }
  }
  try {
    if (typeof ctx.on === 'function') {
      const d = ctx.on('session/event', onSessionEvent)
      if (typeof d === 'function') pending.push(d)
      log('已挂 session/event 事件总线（实时生成状态可用）')
    } else {
      log('ctx.on 不可用 —— 实时生成状态退回轮询模式')
    }
  } catch (e) {
    log('挂 session/event 失败（实时状态不可用）: ' + ((e && e.message) || e))
  }

  function readSessions() {
    if (!ctl || typeof ctl.list !== 'function') {
      return Promise.reject(new Error('拿不到会话列表（sessionController 不可用）'))
    }
    return Promise.resolve(ctl.list({}, AbortSignal.timeout(15000))).then((r) =>
      norm(r && r.items ? r.items : r, archiveProjection()))
  }

  /* 🔴 第 113 节 · task-5（用户需求5 插件侧）：把宿主 durable 归档集投影进 /cmd。
   *
   * 为什么不能让宿主直接给：sessionController.list 的 listFields 只返 3 键
   *   {parentSessionId?, origin?, cwd?}（@deepseek-ai/dsh-api-session-controller
   *   list.js，asar 实锤），全库 includeArchived / archivedAt / isArchived 0 命中；
   *   归档真值只在 workspaceRegistry 上（:261 已拿到 reg）：
   *     get archivedSessionIds() { return this.requireState().archivedSessionIds }
   *     get pinnedSessionIds()   { return this.requireState().pinnedSessionIds }
   *   —— 注释原文「The registry-global archive set: sessions hidden from every
   *      grouping surface.」所以插件侧不需要 workspace.follow / 任何新白名单，
   *      直接读这两个 getter 即可（与置顶 :1957 hostPins() 同源同形）。
   *
   * 契约字段名（客户端 task-6 按此读取，不许改）：
   *   norm() 每条会话多出
   *     archived: boolean —— 宿主归档集**可用**时才有这个键；不可用=键不出现
   *                          （客户端按 false 处理，不许当「未归档」以外的含义）
   *     pinned:   boolean —— 同上，宿主置顶集可用时才有
   *   op 'archiveSet' → { ok:true, archived:[sid...], pinned:[sid...], source:'host' }
   *
   * 形状处理：宿主同版本上实为数组（archivedSessionIds getter），但为了将来
   *   换成 Set/Map 也不炸，这里两种都收（Array → 逐个 String；有 .has() → 
   *   列表里的 id 逐个试）。读不到（reg 不可用 / getter 抛错）⇒ 返回 null，
   *   调用方**什么都不加键**，绝不凭空报「已归档」。
   * 顺序/过期：getter 是**当次读**（requireState），所以每次 readSessions /
   *   archiveSet 都是新值，没有缓存与失效问题。 */
  function hostArchivedIds() {
    try {
      if (!reg) return null
      const raw = reg.archivedSessionIds
      if (Array.isArray(raw)) return raw.map((x) => String(x)).filter(Boolean)
      if (raw && typeof raw.has === 'function' && raw.size >= 0) return Array.from(raw, (x) => String(x)).filter(Boolean)
      return null
    } catch (e) {
      return null
    }
  }

  /** 宿主的置顶集原始形状（与 hostPins 同源；hostPins 给的是数组或 null）。 */
  function hostPinnedMembers() {
    const list = hostPins()
    if (list === null) {
      try {
        if (!reg) return null
        const raw = reg.pinnedSessionIds
        if (raw && typeof raw.has === 'function') return Array.from(raw, (x) => String(x))
      } catch (e) { /* 下面统一返回 null */ }
      return null
    }
    return list
  }

  /** 归档/置顶投影（norm 的第三参；宿主不可用时两个都返 null）。 */
  function archiveProjection() {
    return { archived: hostArchivedIds(), pinned: hostPinnedMembers() }
  }

  /** 键名已冻结：客户端只认 archived / pinned（task-6）。 */
  function withArchiveFlags(one, proj) {
    if (!one || !proj) return one
    if (Array.isArray(proj.archived)) one.archived = proj.archived.indexOf(String(one.id)) >= 0
    if (Array.isArray(proj.pinned)) one.pinned = proj.pinned.indexOf(String(one.id)) >= 0
    return one
  }

  /* 🔴 第 113 节 · task-5：归档刚成功时，宿主 workspaceRegistry 的 setState 是
   * 异步落的（archive 的 Promise resolve 不代表状态已可读）。手机端归档后会
   * **立刻**重拉 /cmd op=sessions，如果那时投影还没跟上，列表里那条就还是
   * archived:false ⇒ 用户看到「归档了但没消失」。
   *
   * 处理：归档成功后**主动等一小段**（先 120ms，再最多 3 次 × 60ms 轮询），
   * 直到 sid 真的出现在宿主的归档集里为止，之后返回的会话列表就是新的。
   * 等不到（老版本没有 archivedSessionIds / 宿主迟迟不落）⇒ **不报错、不抛**，
   * 只写一行日志，归档本身仍然算成功（真值不依赖这里）。 */
  const CTL_ARCHIVE_SETTLE_MS = envInt('DSH_MP_ARCHIVE_SETTLE_MS', 120)
  function sleepMs(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms) })
  }
  async function archiveSync(sid, want) {
    const id = String(sid || '')
    const expect = want !== false      // true=等它进归档集，false=等它出归档集
    if (!id) return false
    try {
      if (!reg) return false
      for (let attempt = 0; attempt <= 3; attempt++) {
        await sleepMs(attempt === 0 ? CTL_ARCHIVE_SETTLE_MS : 60)
        const set = hostArchivedIds()
        if (Array.isArray(set)) {
          if ((set.indexOf(id) >= 0) === expect) return true
        } else {
          // 宿主连归档集都读不到：等下去也没意义
          return false
        }
      }
      log('archiveSync 超时：' + id + (expect ? ' 未' : ' 仍') + '出现在宿主归档集（操作本身已成功）')
      return false
    } catch (e) {
      try { log('archiveSync 异常（忽略）：' + ((e && e.message) || String(e))) } catch (e2) { /* 忽略 */ }
      return false
    }
  }

  /**
   * 🔴 第 98 节 · sessionId 存在性查询（供 selectPreset 回退路留痕）。
   *
   * sessionExists 是给 selectPreset 的「拿不到 Agent」那条回退路做留痕用的：
   * 那条路会写 settings 的 selectedDefault（**全局默认预设**）。
   * 返回 true=存在 / false=确认不存在 / null=列表不可用。
   *
   * ⚠️ 口径变更（批次F · task-25）：本函数原来还是**拦路闸** —— 不存在/不可用
   *    一律 throw，导致「换默认预设」这件与具体会话无关的事被打成 HTTP 500。
   *    现在只写一条 [select-preset] 日志（见 selectPreset 里那段），不再抛；
   *    相应地，拿不存在的 sid 也能改全局默认 —— 这是产品口径下的已知取舍。
   *    函数签名与返回语义一个字没改，仍可能被别处复用。
   */
  function sessionExists(sid) {
    return readSessions().then(
      (items) => items.some((s) => s && s.id === sid),
      () => null
    )
  }
  /**
   * 🔴 批次F · task-33 · subagent 会话的 **durable parent address**。
   *
   * 宿主契约（只读 app.asar 实锤，三处；路径都是 asar 内的相对路径）：
   *   ① 类型声明 `SessionAddress` ——
   *      dsh/node_modules/@deepseek-ai/dsh-client-ui-commands/lib/client.js:305 逐字：
   *      `export type SessionAddress = { readonly kind:'session'; readonly sessionId: SessionId }
   *        | { readonly kind:'subagent'; readonly parentSessionId: SessionId;
   *            readonly childSessionId: SessionId; readonly mode:'one-shot'|'continuable'|'unknown' }`
   *   ② page 入参 schema（typert 声明） ——
   *      dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js:1420 附近：address 就是这个
   *      union，另有 throughSeq / beforeSeq? / maxMessages? / turnWindow?。
   *   ③ 校验处 validateAddress ——
   *      dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js:10287-10305（调用点在 :10239）：
   *        `if (address.kind === 'session') {
   *           if (header.origin === 'subagent') throw new RemoteError('session/agent-busy',
   *             'subagent Sessions require their durable parent address', { reason: 'use subagent delivery for this child session' })
   *           return }`
   *      ⇒ 子会话**必须**用 kind:'subagent' 的地址，用 kind:'session' 一定被拒。
   *      紧随其后还会校验 header.parentSession 与 address.parentSessionId 相等、
   *      `projections.values.subagent` 描述符存在且 `identity.seq >= inheritedEventCount`、
   *      `address.mode` 为 'unknown' 或与 identity.mode 相同。
   *
   * parent 从哪取：`ctl.list()` 的每一行就带 —— 实测（POST /cmd op=sessions，33 条）子会话行有
   *   `parentSessionId: 'session-fc020bbc-35ec-4902-8f4d-c3e75e052608'`、`origin: 'subagent'`
   *   （主会话没有这两个键）。宿主自己也这么认亲：
   *   dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js:5780 `flattenLineage(summaries)`
   *   就是按 `s.parentSessionId` 建父子表。
   *
   * mode 一律给 'unknown'：宿主只在 mode !== 'unknown' 时才比对 identity.mode，
   * 给 unknown 即「不声明」，既不必猜 one-shot/continuable，也不会因此被拒。
   *
   * @returns Promise<null | {kind:'subagent',parentSessionId:string,childSessionId:string,mode:'unknown'}>
   *          非子会话 / 列表不可用 → null（调用方保持原行为）。
   */
  function subagentAddressOf(sid) {
    return readSessions().then((items) => {
      const self = (items || []).find((s) => s && s.id === sid)
      const parent = self && self.parentSessionId ? String(self.parentSessionId) : ''
      if (!parent) return null
      return { kind: 'subagent', parentSessionId: parent, childSessionId: sid, mode: 'unknown' }
    }, () => null)
  }

  /* 🔴 第 100 节 · 真删残留二次清理（问题清单 #34/#44，根因由 task-14 只读定位）。
   *
   * 现象：手机端删了会话，电脑端「已删会话」还会以某种形式残留。
   * 根因（task-14 只读对账 47 个已删 id）：插件删掉
   * storages/session_projcache/<...>/<id>.json 之后，宿主投影缓存仍在
   * 4~13ms 后被异步重新写回** —— 投影缓存残留 14/47；sessions 列表与
   * scope 目录都是 0/47，说明只有投影缓存这一条路漏。
   *
   * 做法（三要求都满足）：
   *   ① 不阻塞 —— 第一遍清理照旧，响应立刻返回；补刀全在 unref 的 setTimeout
   *      里（unref 不挡宿主退出）。第一次 600ms 覆盖实测 4~13ms 的重写窗口
   *      并留足余量，第二次 2000ms 防宿主再晚一轮写回。
   *   ② 幂等 —— 同一 id 重复删先清掉上一轮定时器再排新的，不会堆积；
   *      清理动作本身什么都没删到也返回 []，不抛。
   *   ③ 精确匹配 —— 清理只认 <scope>/<sid>/ 目录与 <sid>.json 文件，
   *      文件名逐字相等（大小写敏感、扩展名一致），不碰别的会话。
   */
  // 路径在**调用时**才解析：sessionPersistence 可能晚于 apply 注册（且删除时
  // 读到的才是真值）。延迟沿用生产默认（600ms / 2000ms，见 createDeleteSweeper）。
  const sweeper = createDeleteSweeper({
    sessionsRoot: () => {
      const home = path.join(os.homedir(), '.dsh')
      let root = home + path.sep + 'sessions'
      try {
        const persistence = ctx && typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : null
        if (persistence && typeof persistence.root === 'string' && persistence.root) {
          root = path.resolve(persistence.root)
        }
      } catch (e) { /* 用默认路径 */ }
      return root
    },
    storagesRoot: () => path.join(os.homedir(), '.dsh', 'storages'),
    log: log
  })

  /** 单个会话的实时忙闲（liveFromLog 的 busy 位；查不到返回 undefined，绝不伪造 false）。 */
  function liveBusyOf(sid) {
    try {
      if (!sid) return undefined
      const lv = liveFromLog(String(sid))
      return lv && typeof lv.busy === 'boolean' ? lv.busy : undefined
    } catch (e) { return undefined }
  }

  /** 成员 id → 实时忙闲。成员 id 与宿主会话 id 一一对应，实测是**不带前缀的原样 id**；
      同时按 'session-' + id 兜一种形态（会话列表里 id 确实带 session- 前缀）。 */
  function busyForMemberId(id) {
    const raw = String(id || '')
    if (!raw) return undefined
    const hit = liveBusyOf(raw)
    if (hit !== undefined) return hit
    if (raw.indexOf('session-') === 0) return undefined
    return liveBusyOf('session-' + raw)
  }

  /* 🔴 批次 H · task-6（#A7）· 团队投影归一化。
     宿主 agentTeam 的 wire view 逐字（asar@49897316 / 49895831 实锤）：
       { members: [{ id, name, role: 'lead'|'teammate', phase, error? }],
         tasks:   [{ id, revision, subject, description, status, blockedBy[],
                     writeScopes[], ownerName?, ready, writeScopeWarnings[] }],
         failure? }
     三条铁律：
       ① **逐字段强转**，绝不整体透传宿主对象（多一个字段就是多一条未知数据面）；
       ② 有上限（成员 50 / 任务 200 / 长文本 500 码点），手机端不被拖垮；
       ③ 形状不认识就回 null —— 客户端据此显示「暂无团队」而不是红屏。
     普通会话没有 agentTeam，恒为 null。 */
  function normTeam(raw) {
    try {
      if (!raw || typeof raw !== 'object') return null
      const cut = (x, n) => String(x === undefined || x === null ? '' : x).slice(0, n)
      const arr = (x, n) => (Array.isArray(x) ? x.slice(0, n) : [])
      const members = arr(raw.members, 50).map((m) => {
        const one = {
          id: cut(m && m.id, 120),
          name: cut(m && m.name, 80),
          role: (m && m.role) === 'lead' ? 'lead' : 'teammate',
          phase: cut(m && m.phase, 40)
        }
        /* 🔴 第 115 节 · task-1：成员实时运行态（修「手机端恒显示进行中」）。
           宿主 agentTeam 的 phase 是**持久**字段：成员建好之后长期停在 'active'
           （实测同一批成员在宿主会话列表里 running=false，phase 仍全 active），
           手机端只读 phase ⇒ 恒「进行中」。真值在会话的 busy 位上，且与桌面面板
           用的同一判据（index.js:1715 base.running = !!(lvLog && lvLog.busy)）。
           查得到 ⇒ running 布尔；查不到（会话不在 store / 无日志） ⇒ **不写这个键**，
           客户端据此回退 phase 文案 —— 绝不凭空报「未运行」。 */
        const busy = busyForMemberId(one.id)
        if (busy !== undefined) one.running = busy
        if (m && m.error !== undefined && m.error !== null) one.error = cut(m.error, 200)
        return one
      }).filter((m) => m.id)
      const tasks = arr(raw.tasks, 200).map((t) => {
        const one = {
          id: cut(t && t.id, 120),
          revision: Number((t && t.revision) || 0) || 0,
          subject: cut(t && t.subject, 200),
          description: cut(t && t.description, 500),
          status: cut(t && t.status, 40),
          blockedBy: arr(t && t.blockedBy, 50).map((x) => cut(x, 120)),
          writeScopes: arr(t && t.writeScopes, 50).map((x) => cut(x, 200)),
          ready: !!(t && t.ready),
          writeScopeWarnings: arr(t && t.writeScopeWarnings, 50).map((x) => cut(x, 200))
        }
        if (t && t.ownerName !== undefined && t.ownerName !== null) one.ownerName = cut(t.ownerName, 80)
        return one
      }).filter((t) => t.id)
      const out = { members: members, tasks: tasks }
      if (raw.failure !== undefined && raw.failure !== null) out.failure = cut(raw.failure, 300)
      return out
    } catch (e) { return null }
  }

  /* 🔴 第 113 节 · task-5：norm 多了可选第二参（归档/置顶投影，见
     archiveProjection()）。**默认 undefined ⇒ 行为与改动前逐字一致** —— 其它
     12 处调用（:1721 listSessions / :1825 preset / :2141 …）不打标记，不受影响。
     只有 readSessions()（会话列表通路）显式传，客户端 task-6 才拿得到 archived。 */
  function norm(items, proj) {
    return (items || []).map((s) => ({
      id: String(s.sessionId || s.id || ''),
      /* 🔴 批次 H · task-6（#A6 顺带）：标题也要剥协议壳。
         子智能体会话的 title 直接就是 DSH 注入的 <system-reminder> 原文
         （36 个会话里 21 个长这样），原样透传 ⇒ 抽屉/二级页显示一整段注入文本。
         与 prompt / response 走同一条 stripShellText 出口（幂等，不误杀普通标题）。 */
      title: withTitleFallback((s.projections && s.projections.values && s.projections.values.title) || s.title, s.projections && s.projections.values),
      cwd: String(s.cwd || ''),
      /* 🔴 第 97 节 · 抽屉「智能体」栏的数据前提：宿主 listFields(header)
       * （@deepseek-ai/dsh-api-session-controller list.js，asar 实锤）已经产出
       * parentSessionId（header.parentSession）与 origin（header.origin），
       * 插件侧只要**原样透传**即可 —— 不透传客户端就拿不到子会话血缘，
       * 子智能体永远收不起来。二者都是 optional，缺字段时保持 undefined。 */
      parentSessionId: s.parentSessionId === undefined ? undefined : String(s.parentSessionId),
      origin: s.origin === undefined ? undefined : String(s.origin),
      updatedAt: Number(s.updatedAt) || 0,
      running: !!s.running,
      // 当前模型（0.4.0）：宿主 list 投影里就有 modelSelection.lastUsed/next
      // （provider+model+reasoningEffort），手机端显示「当前模型」直接用，
      // 不用单独请求。lastUsed=本轮用的，next=下一条消息生效的。
      model: (() => {
        try {
          const ms = s.projections && s.projections.values && s.projections.values.modelSelection
          const cur = (ms && (ms.next || ms.lastUsed)) || null
          if (!cur || !cur.provider || !cur.model) return null
          return { provider: String(cur.provider), model: String(cur.model),
            reasoningEffort: cur.reasoningEffort ? String(cur.reasoningEffort) : '' }
        } catch (e) { return null }
      })(),
      /* 🔴 批次 H · task-6（#A7）：团队投影（agentTeam）—— 与 title / modelSelection
         同一条 s.projections.values 通道，插件原来只取后两者 ⇒ 手机端零团队数据。 */
      team: normTeam(s.projections && s.projections.values && s.projections.values.agentTeam)
    })).map((one) => withArchiveFlags(one, proj)).filter((s) => s.id)
  }

  /* 🔴 第 97 节 · ACP 元数据剥离。
   * 真机截图实锤：助手气泡里直接显示 <acp tokens="7" type="text">m00181</acp>
   * （宿主把 ACP 标记当正文塞进了 content 块）。客户端 Session.ets 的 cleanMd
   * 有一份兜底，但只覆盖历史正文 / 流式正文 —— 思考折叠块、实时帧、插件
   * 落盘的 detail 都不过它，所以插件侧也要各有一条。
   * 第 98 节起实现搬到 mp-contract.mjs 的 stripAcp（index.js / mp-ws-live.mjs
   * 共用同一份，避免两处算法漂移），本文件从顶部 import 引入。 */

  /**
   * content 块 → 纯文本（string 直接用；块数组取所有 text 块拼接）。
   * 与 send op 的 content:[{type:'text',text}] 同一套块协议。
   * 返回值类型与语义不变，只是多剥了一层 ACP 标记。
   */
  function contentText(content) {
    if (!content) return ''
    if (typeof content === 'string') return stripShellText(stripAcp(content))
    if (Array.isArray(content)) {
      return stripShellText(stripAcp(content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text)
        .map((b) => b.text)
        .join('\n')))
    }
    return ''
  }


  /**
   * history RPC 的事件解包（0.3.4 实锤修复）：
   * historyEntrySchema（dsh-host-apiproxy L539）= { event: SessionEvent, view?: ToolEventView }
   * —— events 数组每项是包裹对象，不是裸事件！0.3.0~0.3.3 直接读 ev.type
   * 全是 undefined → 折出 0 轮 → 静默退回 120 字概要（全文/轨迹/统计全假死）。
   */
  function unwrapEvent(ev) {
    return (ev && typeof ev === 'object' && ev.event && typeof ev.event === 'object') ? ev.event : ev
  }

  /** history / page 返回的宽容形状提取：
   *   {events} / {value:{events}} / {history:{events}} / 直接数组 /
   *   🔴 0.4.6 新增 {records:[{type:'event', event}]} —— ctl.page() 的返回形状 */
  function extractEvents(h) {
    if (!h) return []
    if (Array.isArray(h)) return h
    if (Array.isArray(h.events)) return h.events
    if (h.value && Array.isArray(h.value.events)) return h.value.events
    if (h.history && Array.isArray(h.history.events)) return h.history.events
    if (Array.isArray(h.records)) return h.records
    return []
  }

  /* ============================================================
   * 第 186 节 · task-C：会话级任务清单（todo/write）→ detail 顶层 todos
   * ------------------------------------------------------------
   * 用户 m01310：把电脑端 DSH 那张「任务」列表（标题 + N 已完成 · N 进行中 ·
   * N 待处理 + 每行状态圆点）也搬到手机端会话页，做成可折叠卡片。
   *
   * 数据源（实锤）：会话日志里的事件
   *   { type: 'todo/write', seq, time, data: { todos: [ { content, status } ] } }
   * 语义是**覆盖式全量**（每一次写就是当前完整清单）⇒ 取**最后一条**即可。
   * 桌面端同源：宿主 dsh-tool-todo 注册 key 为 todos 的单元，state 直接来自该事件
   * （asar 内 /dsh/node_modules/@deepseek-ai/dsh-tool-todo/lib/index.js:81-85）。
   *
   * 下发口径：只留 { content, status } 两键；content 过 stripShellText（与其它
   * 正文同口径，注入块剥壳后变空的项直接丢）；status 只认三态，其它值一律归
   * pending；**绝不下发路径/时间等宿主字段**。
   * ============================================================ */
  const TODO_STATUS = { completed: 'completed', in_progress: 'in_progress', pending: 'pending' }

  /** todo 列表归一：非法项丢弃，形状冻结成 { content, status }（键次序稳定）。 */
  function normalizeTodos(list) {
    const out = []
    for (const it of (Array.isArray(list) ? list : [])) {
      if (!it || typeof it !== 'object') continue
      const content = stripShellText(String(it.content == null ? '' : it.content))
      if (!content.trim()) continue                 // 空串 / 剥壳后为空的项不要
      out.push({ content: content, status: TODO_STATUS[String(it.status)] || 'pending' })
    }
    return out
  }

  /**
   * 从事件流里取最后一条 todo/write 的清单（没有就是 []）。
   * 事件来源与 foldHistoryToTurns 共用同一份 events，不额外读盘、不加网络调用。
   */
  function projectTodos(events) {
    let last = null
    for (const raw of (events || [])) {
      const ev = unwrapEvent(raw)
      if (!ev || typeof ev !== 'object') continue
      /* 🔴 第 188 节 · task-3 ②：镜像桌面 DSH 的「turn/start 清空」语义。
         桌面投影 dsh-tool-todo 的源码原话：「cleared by the next turn/start
         (turn/end keeps the finished checklist visible)」—— 手机端原来从不镜像，
         于是上一轮的任务卡会**永久驻留**（用户 m00001①：「电脑都显示任务完成卡片
         已经消失了，手机上卡片还显示在输入框上没消失」）。
         ⇒ 见到 turn/start 就把当前清单清空；同一轮里随后的 todo/write 照旧覆盖式生效。 */
      if (ev.type === 'turn/start') { last = []; continue }
      if (ev.type !== 'todo/write') continue
      const d = ev.data || {}
      /* 只认数组形状：宿主若改成增量/分片，这里宁可保留上一条完整清单，
         也不把半截数据当全量下发（覆盖式语义下，半截 = 错清单）。 */
      if (Array.isArray(d.todos)) last = d.todos
    }
    return last ? normalizeTodos(last) : []
  }

  /* ============================================================
   * 第 191 节 · 用户 m00001：详情页两张「后补卡」（每轮 turn 上的可选字段）
   * ------------------------------------------------------------
   * App 端 Session.ets:7541 / :7578 每一轮从 detail 的原始 JSON 里捞两个字段：
   *   changes = { turn, files:[{path,added,deleted}], total, added, deleted } | null
   *   files   = [ { path, description, seq, index } ] | null
   * 它们是**后补**的（只有新插件才下发）—— 老客户端读到 undefined 无感，
   * 新客户端读到就多画「本次改动」卡与「交付文件」卡（Session.ets:7117 排在编辑卡前）。
   *
   * 🔴 两个字段的数据源**不是同一份**，这点必须分清楚：
   *   changes：宿主进程内的 workspaceChanges 服务（每个 turn 一份改动快照）。
   *            老宿主可能**没有这个服务** ⇒ 判空 + try/catch，拿不到就是 null。
   *   files  ：会话日志里的事件 deliverables/presented（present() 出来的交付物）。
   *            日志不保证与 page/history 的窗口重叠 ⇒ 另外扫一遍 sess.log。
   *
   * 🔴 两条都绝不许抛错：readDetail 抛错会让整条 detail 变 HTTP 500（手机端整页红字），
   *    而这两张卡只是锦上添花 —— 「拿不到就 null」是硬要求。
   * ============================================================ */

  /** 宿主 workspaceChanges 服务（老宿主没有 / ctx.get 抛错 ⇒ null）。 */
  function changesService() {
    try {
      const svc = ctx.get('workspaceChanges')
      return (svc && typeof svc.summary === 'function') ? svc : null
    } catch (e) { return null }
  }

  /**
   * 某一轮的改动摘要；取不到（没有服务 / summary 抛错 / 返回空）一律 null。
   * changeSeq = collectChangeSeqs 捞到的「这一轮的 workspace/changes 事件 seq」
   * （轮末那条，第 198 节修）；缺失/为 0 ⇒ 退回 turn.seq（老行为）。
   * 下发键**白名单**照抄宿主自己的 HTTP 出口 handleChangesSummary：只透传
   * { turn, files, total, added, deleted } —— **不带 cwd / snapshot**（宿主内部字段，
   * 手机端用不上，别把电脑上的绝对路径扩面下发）。
   */
  function changesFor(svc, sid, turn, changeSeq) {
    if (!svc) return null
    try {
      /* 🩸 第 198 节：宿主把摘要挂在 workspace/changes **这条事件自己的** seq 上，
         而 turn.seq 只是该轮**起点**事件的序号 ⇒ 必须优先用 changeSeq
         （collectChangeSeqs 从日志捞出来的那条）。捞不到才退回 turn.seq ——
         老宿主没有这条事件时行为逐字不变（原来就是拿 turn.seq 去查，查不到 = null）。 */
      const seq = Number(changeSeq) > 0 ? Number(changeSeq) : (Number(turn && turn.seq) || 0)
      const tn = Number(turn && turn.turn) || 0
      const s = svc.summary(sid, seq)
      if (!s || typeof s !== 'object') return null
      const files = []
      for (const f of (Array.isArray(s.files) ? s.files : [])) {
        if (!f || typeof f !== 'object') continue
        const path = String(f.path == null ? '' : f.path)
        if (path === '') continue                     // 空路径的文件行没有意义
        const row = { path: path, added: Number(f.added) || 0, deleted: Number(f.deleted) || 0 }
        // 宿主 schema 里这两个是 true 字面量（可选）；不是 true 就整个键不下发
        if (f.binary === true) row.binary = true
        if (f.oversized === true) row.oversized = true
        files.push(row)
      }
      return {
        // 宿主给的轮号优先；它没给就退回「这一轮自己的轮号」（绝不留 0）
        turn: Number(s.turn) || tn,
        files: files,
        total: Number(s.total) || 0,
        added: Number(s.added) || 0,
        deleted: Number(s.deleted) || 0
      }
    } catch (e) { return null }
  }

  /**
   * 扫会话日志收集「交付文件」事件 → Map<seq, [{path,description,seq,index}]>。
   *
   * 事件形状（宿主 present 工具落盘）：{ type:'deliverables/presented', seq, time,
   * data:{ files:[{ path, description }] } }；判据照抄宿主 isPresentedFile ——
   * **path 必须是非空字符串**才算（其它项直接丢），description 允许缺省。
   *
   * 🔴 读法照抄 liveFromLog(:1968)：ctx.get('sessions') → sess.log（裸事件数组，
   *    逐条 unwrapEvent 宽容解包）。区别只有一处：这里**不按 sid 取 session** ——
   *    detail 的 sid 可能是子会话地址（带 -sub 后缀），sessions.get 只认主会话 id，
   *    拿它当键只会得到 null。所以取「日志最长的那本」= 当前活跃会话的权威日志
   *    （同一进程里同时活着的会话不止一个，但手机端看的就是当前这本）。
   * 任何异常（老宿主没有 sessions 服务）⇒ 空 Map，调用方给 null。
   */
  /* 会话日志取用（collectDeliveryFiles / collectChangeSeqs 共用）：
     ctx.get('sessions') → sess.log（裸事件数组）。
     🔴 区别只有一处：这里**不按 sid 取 session** —— detail 的 sid 可能是子会话地址
     （带 -sub 后缀），sessions.get 只认主会话 id，拿它当键只会得到 null。所以回退取
     「日志最长的那本」= 当前活跃会话的权威日志（活着的会话可能不止一个，但手机端看的
     就是当前这本）。forEach / list 两种形状都容忍。没有 sessions 服务 ⇒ null。 */
  function sessionLogOf(sid) {
    try {
      const store = (() => { try { return ctx.get('sessions') } catch (e) { return null } })()
      if (!store) return null
      /* 主路径照抄 liveFromLog：sessions.get(sid)。 */
      if (typeof store.get === 'function') {
        try {
          const s = store.get(sid)
          if (s && Array.isArray(s.log) && s.log.length) return s.log
        } catch (e) { /* 取不到走下面的回退 */ }
      }
      let best = null
      const consider = (s) => {
        if (s && Array.isArray(s.log) && s.log.length && (!best || s.log.length > best.length)) best = s.log
      }
      try {
        if (typeof store.forEach === 'function') store.forEach(consider)
        else if (typeof store.list === 'function') {
          const arr = store.list()
          for (const s of (Array.isArray(arr) ? arr : [])) consider(s)
        }
      } catch (e) { /* 扫描失败 ⇒ 当没有日志 */ }
      return best
    } catch (e) { return null }
  }

  /**
   * 扫会话日志收集 workspace/changes 事件 → [{seq, turn}]（按 seq 升序）。
   *
   * 🩸 第 198 节 · 用户 m02086 第 2 条「已编辑 N 个文件」卡不显示的真因：
   *   宿主 recorder 在**轮末**才 append 这条事件，并把摘要挂在
   *   records.set(event.seq, …) —— 键是这条事件**自己的** seq（asar @68268993 /
   *   @68319539：const event = this.session.append('workspace/changes', {turn});
   *   this.records.set(event.seq, { summary: … })）。而轮对象上的 seq 是**轮首**
   *   事件的序号（:1540-1541 newSegment / :1576 turnFor 只在首次填）⇒ 拿 turn.seq
   *   查 summary 必然 undefined（records.get 落空），于是每轮 changes 恒 null、
   *   手机端永远没有那张卡。修法 = 先从日志里把「哪条 seq 属于哪一轮」捞出来。
   *
   * 判据照抄宿主日志侧校验 isChangesEvent（asar @20785848）：
   *   isRecord(data) && Number.isSafeInteger(data.turn) && data.turn >= 1。
   * 任何异常 ⇒ 空数组（调用方退回老行为，绝不许把 detail 打成 500）。
   */
  function collectChangeSeqs(sid) {
    const out = []
    try {
      const log = sessionLogOf(sid)
      for (const raw of (log || [])) {
        const ev = unwrapEvent(raw)
        if (!ev || typeof ev !== 'object' || ev.type !== 'workspace/changes') continue
        const d = ev.data || {}
        const turn = Number(d.turn)
        if (!Number.isSafeInteger(turn) || turn < 1) continue
        const seq = Number(ev.seq) || 0
        if (seq <= 0) continue
        out.push({ seq: seq, turn: turn })
      }
      out.sort((a, b) => a.seq - b.seq)
    } catch (e) { /* 日志读不到 ⇒ 空数组 */ }
    return out
  }

  function collectDeliveryFiles(sid) {
    const bySeq = new Map()
    try {
      const log = sessionLogOf(sid)
      if (!log) return bySeq
      for (const raw of (log || [])) {
        const ev = unwrapEvent(raw)
        if (!ev || typeof ev !== 'object' || ev.type !== 'deliverables/presented') continue
        const d = ev.data || {}
        if (!Array.isArray(d.files) || !d.files.length) continue
        const seq = Number(ev.seq) || 0
        if (seq <= 0) continue                        // 没有 seq 归不了轮，宁可不画
        const list = bySeq.get(seq) || []
        for (const it of d.files) {
          if (!it || typeof it !== 'object') continue
          const path = String(it.path == null ? '' : it.path).trim()
          if (path === '') continue
          list.push({
            path: path,
            description: String(it.description == null ? '' : it.description),
            seq: seq,
            /* index = 这条文件在本轮交付清单里的位置（0 起，离散）—— App 侧用它
               排稳定序，绝不能用时间戳之类的连续量当 key（ArkUI 铁律）。 */
            index: list.length
          })
        }
        if (list.length) bySeq.set(seq, list)
      }
    } catch (e) { /* 日志读不到 ⇒ 空 Map */ }
    return bySeq
  }

  /**
   * 给轮次就地挂第 191 节的两个字段（**键一定在**，没数据就是 null，
   * 绝不让 undefined 漏给 App —— 契约写的是「或 null」）。
   *
   * @param turns   本次要下发的轮数组（刚折出来的新对象，不共享缓存，可就地改）
   * @param deliver collectDeliveryFiles() 的结果；传 null = 本次不取交付卡
   *                （概要投影那条路只挂 changes，省一次日志扫描）
   * @param sid     会话 id（workspaceChanges.summary 的入参）
   */
  function attachDetailCards(turns, deliver, sid, changeSeqs) {
    if (!Array.isArray(turns) || !turns.length) return turns
    /* 🔴 服务只取一次：ctx.get 走宿主容器，逐轮调用等于每轮多一次容器查询。 */
    const svc = changesService()
    const seqs = Array.isArray(changeSeqs) ? changeSeqs : []
    /* 🩸 第 198 节：把每条 workspace/changes 事件按 seq 区间归到「它落在哪一轮」——
       规则与交付文件同一套（轮上的 seq 是该轮起点事件序号 ⇒ 最大的 seq <= 事件 seq
       的那一轮）。**故意不用 data.turn**：forkSegment 切过段后插件会把轮号稠密重编号
       （:1973-1977），宿主的 turn 号与插件轮号会错位；seq 是日志原始序号，不受重编号影响。 */
    const seqOf = new Map()
    for (const c of seqs) {
      let target = null
      let best = -1
      for (const t of turns) {
        const ts = Number(t && t.seq) || 0
        if (ts > c.seq) continue
        if (ts >= best) { best = ts; target = t }
      }
      if (target) {
        const prev = seqOf.get(target)
        if (!prev || c.seq > prev) seqOf.set(target, c.seq)   // 一轮有多条（轮内多次记录）⇒ 取最后一条
      }
    }
    for (const t of turns) {
      if (!t || typeof t !== 'object') continue
      t.changes = changesFor(svc, sid, t, seqOf.get(t))
      if (!t.files) t.files = null
    }
    if (!deliver || typeof deliver.get !== 'function') return turns
    /* 归属：按 seq 区间算「事件发生在哪一轮」。轮上的 seq 是该轮**起点**事件的序号，
       所以「最大的 seq <= 事件 seq」那一轮就是它发生的轮（区间归属，不是精确相等）。 */
    for (const [q, list] of deliver) {
      let target = null
      let best = -1
      for (const t of turns) {
        const ts = Number(t && t.seq) || 0
        if (ts > q) continue
        if (ts >= best) { best = ts; target = t }
      }
      if (!target) continue
      const into = target.files || []
      for (const f of list) {
        into.push({ path: f.path, description: f.description, seq: f.seq, index: into.length })
      }
      target.files = into
    }
    return turns
  }

  /**
   * history 事件 → 对话轮。折算规则照抄 DSH 官方 deriveEventMessage
   * （@deepseek-ai/dsh-session/lib/index.js:278，0.3.0 考证）：
   *   user/message      → event.data 就是消息
   *   assistant/message  → event.data.message（content 空则无消息）
   *   tool/result        → event.data.message（内部过程，聊天界面跳过）
   * 连续 assistant 消息并进同一轮回复；user 开新轮。
   * 0.3.1：assistant content 里的 reasoning 块（官方 ContentBlockMap：
   * { type:'reasoning', text }）收进 cur.think —— 手机端「已思考」折叠块。
   */
  /** DSH 把系统注入（~/.dsh/AGENTS.md / skill 清单）包成 <system-reminder>
   *  伪装成一条 user/message —— 它不是用户提问（用户 m11202 实锤：第 3 轮
   *  把整份「# 小助理 · 通用人设」当蓝气泡画出来了）。
   *  0.4.6 离线素材实测（_sess_log.jsonl 14730 事件）：user/message 共 160 条，
   *  其中**只有 58 条是用户真的说的**；另外 102 条是 DSH 注入的伪用户消息，
   *  合计 18.5 万字（占 prompt 总量 161199 字里的 83%）。光滤 <system-reminder>
   *  只去掉 14 条，剩下 88 条照样画成蓝气泡 —— 所以下面按「注入前缀」整类过滤。 */
  const INJECT_RES = [
    /^\s*<system-reminder>/,                         // 工作区 AGENTS.md / skill 清单
    /^\s*Time sampled while preparing turn /,        // 每轮时间采样（73 条）
    /^\s*Current runtime context\./,                 // 运行环境快照（7 条）
    /^\s*This is an automatically generated checkpoint /, // 压缩检查点全文（6 条 11 万字）
    /^\s*\[model changed:/,                         // 换模型提示（2 条）
    // 0.4.7 补漏（第 80 节实测 _sess_log.jsonl 16934 事件）：上一版只滤 5 类，
    // 全新日志里还有 4 类注入同样伪装成 user/message 被画成蓝气泡，共 16 条：
    /^\s*Background subagent /,                      // 后台子智能体收尾通知（7 条）
    /^\s*Team message team-message-/,                // 队友消息（5 条）
    /^\s*Agent [0-9a-fA-F-]{8,} sent a message:/,    // 子体回报（1 条）
    /^\s*background job /                            // 后台任务完成通知（3 条）
  ]
  function isInjectedUserText(text) {
    for (const re of INJECT_RES) { if (re.test(text)) return true }
    return false
  }
  /* 🔴 第 124 节 · task-1 / #42：user/message 自带宿主归因 data.source，
   * 比文本前缀可靠得多，专治「注入/合成文本被画成用户气泡」。
   * 🩸 第 134 节 · 泄露修复（推翻旧结论，务必看清）：
   *   旧注释曾断言 kind='ptc-mode' = 「用户发的图，必须放行」—— **错的**。
   *   ptc-mode 是宿主 PTC（run_code）工具结果把「模型刚看过的图片」回灌进会话时
   *   造的合成 user/message：asar 原文
   *     additionalContexts.push(createUserMessage({ content: retained,
   *       source: { kind: 'ptc-mode' } }))   // dsh-tools 的 tools/ptc-dispatch-log
   *   条件是 exec.parent!==undefined && !isError && hasImages && 内容里还没图。
   *   ⇒ 于是「我跑程序自己抓的截图 / read_image 看过的图」会伪装成用户提问。
   *   本机取证（session-4c63e4bb… 全量逐帧解压 5651 事件）：
   *     带 image 块的 user/message 66 条 = ptc-mode 59 条（全是 _s132.jpeg / h1.jpeg /
   *     p1.jpeg / n1…n10.jpeg 这类我自己跑出来的截图）+ kind='user' 且带 rpcId 7 条
   *     （用户从桌面真发的图）；assistant/message 带图 0 条。
   *   ⇒ ptc-mode 的 image 块正是「会话页把内部截图漏出来」的本体，必须滤掉。
   * 归因口径（本文件唯一判据）：
   *   kind='user' 带 rpcId ....... 用户真的说的（含真发的图）—— 一条都不能滤
   *   kind='user' 不带 rpcId ..... 子会话委派 prompt（合成）—— #42 本体
   *   kind='ptc-mode' ............ 宿主 PTC 工具产物回灌（含内部截图）—— 滤
   *   其余 kind .................. 宿主注入（时间采样 / 队友消息 / 指令 / 技能清单…）—— 滤
   * ⚠️ 滤 ptc-mode 会连它的 text 一起丢；但它的 text 只是附件描述壳
   *   （stripShellText 后为空），不是用户提的问题，丢了不心疼。
   * ⚠️ 未知 kind 一律不判注入（保守：宁漏勿误伤），仍交给下面的 INJECT_RES 前缀兜底。 */
  const INJECT_SOURCE_KINDS = new Set([
    'team-message', 'time-context', 'runtime-context', 'agent-instructions',
    'skill-catalog', 'checkpoint', 'model-selection', 'subagent-settled',
    'agent-message', 'tool-jobs', 'repeat-tool-reminder', 'background-job',
    'ptc-mode'   // 🩸 第 134 节：宿主 PTC 工具产物回灌（内部截图泄露本体）
  ])
  /** user/message.data.source → kind（兼容老日志「无 source」与「source 是字符串」两种形状）。 */
  function sourceKindOf(data) {
    const s = data && data.source
    if (!s) return ''
    if (typeof s === 'string') return s
    return typeof s.kind === 'string' ? s.kind : ''
  }
  /** 宿主归因判定：这条 user/message 是不是注入。判不出来就返回 false（不误伤）。 */
  function isInjectedUserData(data) {
    const k = sourceKindOf(data)
    if (!k) return false
    if (INJECT_SOURCE_KINDS.has(k)) return true
    /* kind='user' 但没有 rpcId = 宿主替子智能体合成的 prompt，不是用户点的发送。
     * 实测零重叠：真发言 149/149 全带 rpcId，委派 prompt 56/56 全不带。
     * source 不是对象（拿不到 rpcId）时不判 —— 避免误伤真实发言。 */
    if (k === 'user') {
      const s = data && data.source
      if (!s || typeof s !== 'object') return false
      return !s.rpcId
    }
    return false
  }
  /* 🔴 第 100 节 · payload 瘦身上限（task-35 / 问题清单 #48）。
   *
   * 全部可被环境变量覆盖（插件加载时读一次，重启生效）。为什么要能调：
   * payload 体积与手机端渲染能力、局域网快慢都有关，写死等于调不动。
   *
   * ⚠️ 关于 maxMessages: 600 的更正（实测，别照抄任务书那个数）：
   *   任务书写「maxMessages: 600 ⇒ 32 轮」。**实测不成立** —— 宿主 paginate
   *   的 maxMessages 数的是 user/message + assistant/message **条数**
   *   （asar@16195456: MESSAGE_TYPES = new Set(['user/message','assistant/message'])），
   *   而本机最大那个会话（session-7f37d36e，41 轮 / 4332 条 message）
   *   平均每轮 105.7 条 message，最后 32 轮合计 3202 条：
   *     maxMessages=600  → 窗口 4404 事件 / 6 轮 / 114KB   ← 只覆盖 6 轮，手机往前翻就空
   *     maxMessages=3000 → 窗口 19843 事件 / 28 轮 / 533KB
   *     maxMessages=3200 → 窗口 20889 事件 / 30 轮 / 584KB（截断前）
   *   本文件里 0.4.7 的注释（:1110-1116「600→6 轮」）也是同一结论。
   *   ⇒ 要「轮数 ≥ 30」就必须 maxMessages ≈ 3200；600 与「32 轮」互斥。
   *   所以默认取 3200（满足验收②轮数≥30），再靠下面几项收紧把体积压到 ≤500KB。
   *   真要省流量可把 DSH_MP_MAX_MESSAGES 调小，代价就是往前翻的轮数变少。
   */
  const MAX_MESSAGES = envInt('DSH_MP_MAX_MESSAGES', 3200)
  /** 思考过程截断上限（方案 A 值 = 2500）。一轮 think 原样透传会把 payload 撑爆。 */
  const THINK_MAX = envInt('DSH_MP_THINK_MAX', 2500)
  /** 0.4.10 · 步骤流：每轮「思考」步骤共用的文字总预算。
   *  一轮可能有几十个 step，每步都塞全文会让 detail 体积翻倍 —— 用户要的是
   *  「知道每步在干什么」，前若干步的思考全文足够，超预算的步骤只留一行。
   *  0.4.11 · 第 98 节：4000 → 1200。第 100 节（task-35）：1200 → 700 ——
   *  【实测依据】32 轮窗口里 steps[] 合计 86KB（体积第二大头，仅次于 tools[]）。
   *  THINK_STEP_MAX 是 700，所以 700 的预算仍能让**单步**思考全文落地；
   *  只有一轮里连续多个长步骤时才从第 2 步起转成「只留步骤行 + 截断标记」。
   *  真机会话实测：1200→485KB / 900→485KB / 800→481KB / 700→476KB（均 32 轮），
   *  取 700 是为了让「更重的合成压力样本」也稳在 500KB 以内（留余量）。 */
  const THINK_STEPS_TOTAL = envInt('DSH_MP_THINK_STEPS_TOTAL', 3000)
  /** 0.4.10 · 单个「思考」步骤的截断上限 */
  const THINK_STEP_MAX = envInt('DSH_MP_THINK_STEP_MAX', 700)
  /** 🔴 第 188 节 · task-3 ③：**第一步之后**每个思考步骤的文字上限。
   *  【为什么】用户 m00778：「生成中的面板为什么思考只有一条？而且没刷新？」
   *  真根因：总预算原来是 700，而单步上限也是 700 ⇒ 一轮里**第一步就把预算吃光**，
   *  后面每个 k:'t' 步骤连 thinks 条目都进不去（App 的 buildFlowItems 只认非空文本）
   *  ⇒ 手机端一轮只剩 1 条思考，且那条不再变 ⇒ 看着「不刷新」。
   *  改法：总预算 700 → 2100（第一步仍可放 700 全文），后续步改用 220 的小上限，
   *  保证**每一步都留得下文字**；每轮体积仍 ≤ ~2.1KB（32 轮约 +45KB）。 */
  const THINK_TAIL_STEP_MAX = envInt('DSH_MP_THINK_TAIL_STEP_MAX', 150)
  /** 0.4.10 · live 阶段保留的工具卡张数。步骤行按**序号**引用 tools[]，
   *  从头部裁剪时必须同步把 steps 里的 i 左移，否则步骤指到错卡。 */
  const LIVE_TOOLS_KEEP = envInt('DSH_MP_LIVE_TOOLS_KEEP', 30)
  /** 🔴 第 186 节 · task-A：live 子调用序列（acts）保留条数。父调用 run_code
   *  底下真正在动的是 read / grep / bash / subagent…，手机端「生成中」卡的
   *  标题就靠它（用户 m01047：标题永远停在「正在运行代码」）。
   *  与 tools 一样从头部丢 —— acts 是自成一体的记录，丢就整条走，不留悬空引用。 */
  const ACTS_KEEP = envInt('DSH_MP_LIVE_ACTS_KEEP', 60)
  /** 工具卡参数预览 / 工具结果截断上限（字段名沿用 TOOL_DETAIL_MAX）。
   *  0.4.6 时 detail 是 160、result 是 400，0.4.7 统一到同一上限。
   *  🔴 第 112 节 · 用户 m00879（逐字）：「还有怎么还在截断啊？不要截断。」
   *     现象：run_code 工具卡显示「（已截断 513 字）」/「（已截断 11 字）」。
   *     160 对 run_code 的代码/输出太短，等于每张卡都挂标记。
   *  160 → 600 的依据（本机实测：用 payload.spec 的 32 轮标定素材逐档量 payload
   *  字节数，脚本 lib/test/_tmp_measure.mjs）：
   *    LIMIT 160 → 478KB / 240 → 493KB / 320 → 508KB / 400 → 523KB / 600 → 525KB
   *  ⇒ 600 已到饱和（素材正文本身只有 403 字），相对 160 只多 47KB（+10%），
   *    离「3020 张卡全正文 2.06MB / 手机端 5s 超时」那条红线差 4 倍。
   *  真正兜住体积的不是这个上限，而是「每轮只有最后 TOOL_KEEP_FULL 张卡走全文」。
   *  第 113 节（task-5）起更老的卡不再删键，改成 OLD_DETAIL_MAX 字预览 + 跨轮
   *  OLD_TOOL_BUDGET 字节预算（见下面那组常量）—— 所以放宽这里仍不会线性放大 payload。
   *  ⚠️ 别设成 1e9：上限是「极端长输出」的最后一道闸，去掉它等于让某一次
   *     超大 tool/result 单卡拖垮整包。标记（clipTag）必须保留，见测试护栏。 */
  const TOOL_DETAIL_MAX = envInt('DSH_MP_TOOL_DETAIL_MAX', 600)
  /** 0.4.10 · 步骤行短摘要限长。brief 只在最新 BRIEF_KEEP 张上保留，
   *  72 字是「看得懂又不撑爆」的平衡点。brief 是**摘要**不是正文，不挂截断标记。 */
  const BRIEF_MAX = envInt('DSH_MP_BRIEF_MAX', 72)
  /** 每轮最多给多少张卡留 brief（从**最新**往前数）。
   *  实测本会话单轮最高 554 张卡 ⇒ 不设上限的话 72 字 × 554 会让回包再涨
   *  一百多 KB，把手机端 5000ms 超时逼爆（用户 m15302「经常读会话失败」）。
   *  0.4.11 · 第 100 节：20 → 4（实测 32 轮：brief 从 34KB 降到约 17KB）。
   *  brief 是**摘要**不是正文（72 字/条，只画在步骤行上），砍它不影响
   *  「思考/正文/工具结果」这些用户真正要看的内容 —— 优先砍它而不是砍 think。 */
  const BRIEF_KEEP = envInt('DSH_MP_BRIEF_KEEP', 4)
  /** 每轮保留**全文** detail/result 的工具卡张数（0.4.6）。
   *  第 113 节 · task-5 起：更老的卡**不再删键**（旧做法见 0.4.6 注释：
   *  3020 张卡全带正文实测 2.06MB 超 5s 超时线 → 改成删键 → 老卡点开全空，
   *  用户需求9 就是这么来的）。现在改成留 OLD_DETAIL_MAX 字预览。
   *  0.4.11 · 第 100 节：3 → 2（实测 32 轮省 15KB）。 */
  const TOOL_KEEP_FULL = envInt('DSH_MP_TOOL_KEEP_FULL', 2)
  /** 第 113 节 · task-5（用户需求9）：**老卡**的 detail/result 预览上限（码点）。
   *  旧行为是老卡直接 delete detail/result 键 ⇒ 手机端点开老步骤全空
   *  （用户：「过程流里只有最下面一个能展开」）。现在改成：最后 TOOL_KEEP_FULL
   *  张留全文（TOOL_DETAIL_MAX=600），更老的卡留 OLD_DETAIL_MAX 字预览，
   *  且一律带「已截断 N 字」标记（不静默丢内容）。
   *  真机标定（session-7f37d36e 43MB 日志，3493 张卡 / 31 轮窗口；脚本见报告）：
   *    detail 上限 40 → 全包 1053KB ｜ 120 → 1496KB ｜ 200 → 1800KB
   *    （固定开销 337KB，与上限无关；每张老卡约 3 字节/字 + 键名开销）
   *  ⇒ 默认取 120：看得出这一步干了什么，又比 200 省 300KB。 */
  const OLD_DETAIL_MAX = envInt('DSH_MP_OLD_TOOL_DETAIL_MAX', 120)
  /** 第 113 节 · task-5：**老卡**的 brief 预览上限（码点）。brief 是步骤行摘要
   *  （不挂截断标记，见 briefOf），旧行为是老卡 delete brief 键 → 步骤行只剩动词。
   *  现在改成截短（默认 32 ≈ 原 72 字摘要的前 32 字），键永远在。 */
  const OLD_BRIEF_MAX = envInt('DSH_MP_OLD_TOOL_BRIEF_MAX', 32)
  /** 第 113 节 · task-5：老卡预览的**字节预算**（跨轮累计，UTF-8 字节）。
   *  为什么还要预算：上限是「每张卡」的，卡一多就会线性叠回去 —— 实测 43MB
   *  真机日志 3493 张卡、上限 200 时全包 1800KB，已经贴着历史「2.06MB / 手机
   *  5s 超时」那条红线。预算从**最新一轮往前**记账：越新的轮越优先拿满
   *  OLD_DETAIL_MAX，预算见底后的更老卡退到 OLD_TOOL_MIN（**仍然有内容**，
   *  绝不 delete 键）。新会话（卡少）根本碰不到预算，不受影响。
   *  默认 600KB：真机标定下全包约 1.0MB（红线 2.06MB 的一半）。 */
  const OLD_TOOL_BUDGET = envInt('DSH_MP_OLD_TOOL_BUDGET_KB', 600) * 1024
  /** 第 113 节 · task-5：预算见底后老卡预览的**下限**（码点）。
   *  16 字 + 「已截断 N 字」标记 = 用户在手机上至少能看出「这步在干什么」；
   *  下限的作用是让极端长会话（几万张卡）也有体积上界，而不是把键删掉。 */
  const OLD_TOOL_MIN = envInt('DSH_MP_OLD_TOOL_MIN', 16)
  /** UTF-8 字节数（预算记账用；TextEncoder 是 Node 全局，无需 import）。 */
  function byteLen(s) {
    const t = String(s || '')
    if (!t) return 0
    try { return new TextEncoder().encode(t).length } catch (e) { return t.length * 3 }
  }
  /** 轨迹「每轮」保留条数（0.4.6）。原来只写了一个全局 TRACE_MAX=200，
   *  但离线素材实测轨迹总共 8611 条（3.4MB），全局留 200 条 = 只覆盖最后
   *  2 轮（turn 27..28）—— 手机端「轨迹」tab 往前翻就空了。改成按轮配额后
   *  28 轮全覆盖，实测 216 条 / 98KB。
   *  0.4.11 · 第 100 节：4 → 2 条/轮（每轮只留首条 + 最近 1 条；实测 32 轮省 31KB）。
   *  ⚠️ 轨迹是「时间线摘要」：每轮被省略的条数会以一条显式标记补回（见 buildTrace）。 */
  const TRACE_PER_TURN = envInt('DSH_MP_TRACE_PER_TURN', 2)
  /** 轨迹单条正文的截断上限（原写死 600）。轨迹是**时间线摘要**视图，
   *  单条留 240 字足够看清「这步做了什么」，超出的带「已截断 N 字」标记。 */
  const TRACE_TEXT_MAX = envInt('DSH_MP_TRACE_TEXT_MAX', 240)
  /** 轨迹全局硬上限（方案 A 值 = 200，保险丝；按轮配额下 30×2=60 条够用）。
   *  被这道保险丝砍掉的条数会以一条显式标记补回（见 buildTrace）。 */
  const TRACE_MAX = envInt('DSH_MP_TRACE_MAX', 200)

  /** 第 101 节 · task-4（问题清单 #56）：失败消息长度上限。
   *  429 的 failure.message 里带着 provider 原始 JSON，整段透传会把 payload 撑大；
   *  300 码点足够看清「谁的什么错误」。 */
  const FAILURE_MSG_MAX = envInt('DSH_MP_FAILURE_MSG_MAX', 300)
  /** 把失败事件的原始形状折成统一结构（字段名见报告：turns[].failure）。
   *  src 可能是 llm/retry.data.failure、turn/end.data.reason.error，
   *  或 assistant/attempt stream 里 finish.reason.failure —— 三者都是
   *  { message, type, code }。 */
  function failureOf(src, extra) {
    const f = (src && typeof src === 'object') ? src : {}
    const o = {
      ok: false,        // 该轮最终是否成功（重试后成功会被 turn/end 改成 true）
      fatal: false,     // 该轮是否以错误收尾（turn/end reason.kind === 'error'）
      retrying: false,  // 当前是否正处于重试中
      recovered: false, // 失败过但重试后恢复
      retry: 0,         // 已重试次数（最后一次 llm/retry 的 data.retry）
      maxRetries: 0,    // 重试上限（data.maxRetries）
      code: '',         // 失败码，如 RATE_LIMIT
      type: '',         // 失败类型，如 soft_rate
      message: '',      // 人类可读失败消息（clip 到 FAILURE_MSG_MAX）
      time: ''          // HH:MM
    }
    if (f.code) o.code = String(f.code)
    if (f.type) o.type = String(f.type)
    if (f.message) o.message = clip(String(f.message), FAILURE_MSG_MAX, '')
    /* 有些 failure 只给 message 里一段 provider 原始 JSON（实测样本：
       message = '429: {"message":"…soft_rate…","type":"soft_rate","code":"soft_rate"}'，
       外层只有 code=RATE_LIMIT、没有 type）。这里补一次内层提取，
       让客户端两个字段都有值可显示。仅当外层缺值时才填，不覆盖已有字段。 */
    if (!o.type || !o.code) {
      const mt = /"type"\s*:\s*"([^"]{1,40})"/.exec(o.message)
      const mc = /"code"\s*:\s*"([^"]{1,40})"/.exec(o.message)
      if (!o.type && mt) o.type = mt[1]
      if (!o.code && mc) o.code = mc[1]
    }
    if (extra) {
      for (const k of Object.keys(extra)) {
        const v = extra[k]
        if (v !== undefined && v !== null && v !== '') o[k] = v
      }
    }
    return o
  }
  function foldHistoryToTurns(events) {
    const turns = []
    const byNo = new Map()
    // 真实轮号游标（0.4.6 · J 项）：user/message 不带 data.turn，用「最近见到的
    // 轮号」归位；turn/start 权威，其余带 data.turn 的事件（assistant/step/tool）
    // 也能校正。旧实现用 turns.length+1 → 22 条 user/message 全在 turn 1，
    // 结果真实 1..28 被折成 1..10。
    let lastTurn = 0
    /* 🔴 第 187 节 · task-A：PTC 子调用事件（tool/ptc-dispatch-start / tool/ptc-dispatch）
       **没有 data.step 字段**（实测键 = rootCallId/parentCallId/subCallId/name/arguments）。
       但子调用卡的 steps 必须落回它所属的那一步，否则 App 端 buildFlowItems 会把
       工具卡排到思考后面去。这里维护一个「最近一次见到的 step 号」游标：
       主循环里任何带 data.step 的事件（tool/call、assistant/message 等）都会刷新它，
       子调用卡就用它归位；一次都没见到就退化成 0（与父卡口径一致）。 */
    let lastStep = 0
    /* 第 187 节 · task-A：subCallId → 已 push 的子调用卡，供 tool/ptc-dispatch
       精确配对（同一条子调用只 push 一张卡）。 */
    const ptcAt = new Map()
    /* 🩸 第 187 节 · task-A（配对防坑）：子调用卡也进 cur.tools，于是父 tool/call
       的收尾 tool/result 到达时，数组末位已经是某张**子卡**（可能仍 run，也可能已
       done）。原实现只看 cur.tools[len-1] ⇒ 父卡的 state 会永远停在 'run'。
       这里记下「哪些卡是子卡」，tool/result 只回填最近的**非子卡** run 卡。
       用 Set 而不是往卡上加标记字段 ⇒ 下发的卡片形状逐字节不变。 */
    const ptcCards = new Set()
    /* 0.4.10 · 每个「思考」步骤的文字预算（跨该轮所有 step 共享），
       防止几十个 step 各带全文把 detail 撑爆。 */
    const thinkLeft = new Map()
    /* 🔴 第 189 节 · task-B（用户 m01563 / m01725「新一轮的回复要单独成卡」）：
       DSH 的「一轮」= 宿主 turn/start→turn/end，而**用户可以在同一轮里继续追问**
       （steer：agent/inbox/spliced 插话），宿主把它们全折进同一个 turn。结果手机端
       「新一轮的提问 + 回复」和上一张已完成的回复卡挤在同一张卡里（turnBlock 先画
       提问再画回复 ⇒ 用户看到「新消息显示在已完成回复上面」），而且这一轮的 response
       早有正文 ⇒ App 的 showLiveCard() 被 response 守卫挡掉，生成中卡没了、退化成
       平铺过程流的兜底分支（m01544「思考和代码跑到卡片外」）。修法 = **按用户消息切
       分视觉轮**：当前段已经有助手正文时，再来一条用户提问就另开一段，后续
       assistant / tool / turn-end 都落到新段。切分只发生在「已有正文之后」，所以
       turn-prompt-images.spec ① 那种「一轮里连着两条提问、之后才有回复」仍同卡。 */
    let segmented = false
    /* 视觉轮号：**真实 DSH 轮号优先保留**（单段日志与老行为逐字一致 ——
       failure-acp.spec 钉着 turns.find(t => t.turn === 3)）；fork 出来的段没有真轮号，
       取「当前最大号 + 1」保证唯一。 */
    const usedNos = new Set()
    let maxNo = 0
    const allocNo = (want) => {
      let n = Number(want) || 0
      if (n < 1 || usedNos.has(n)) n = maxNo + 1
      usedNos.add(n)
      if (n > maxNo) maxNo = n
      return n
    }
    const newSegment = (want, seq, ev) => {
      const t = { turn: allocNo(want), seq: Number(seq) || 0, startedMs: evMs(ev), endedMs: 0, maxTokens: false, prompt: '', prompts: [], pimgs: [], response: '', think: '', thinks: [], steps: [], tools: [], images: [], aimages: [], time: '' }
      turns.push(t)
      return t
    }
    /* 同一 DSH 轮里的「下一次追问」另起一段：号取 maxNo+1，并把 byNo 的这个轮号
       指向新段（同轮后续的 assistant/tool/result/turn-end 都靠 byNo 归位）。 */
    const forkSegment = (ev, seq) => {
      segmented = true
      const t = newSegment(0, seq, ev)
      const key = lastTurn > 0 ? lastTurn : Number(t.turn) || 0
      byNo.set(key, t)
      return t
    }
    const turnFor = (no, seq, ev) => {
      let n = Number(no) || 0
      if (n < 1) n = lastTurn
      if (n < 1) n = maxNo + 1
      let t = byNo.get(n)
      if (!t) {
        /* 🩸 第 134 节 · 问题4：startedMs = **该轮第一条进入本条流水线的事件**的
           毫秒戳（正常就是用户提问那条 user/message，与电脑端点发送同一时刻）。
           轮对象是懒建的 ⇒ 谁先碰它谁盖戳，后到的同轮事件不覆盖。 */
        /* 第 167 节 T1：images=用户图 / aimages=助手图，两个数组分开下发（形状一致）。 */
        /* 🔴 第 185 节 · task-2（数据通路）新增两个轮级事实，随每轮一起下发：
            · maxTokens（布尔）—— 这一轮结束时宿主报的 reason.kind === 'max-tokens'
              （至少一个 step 撞到输出 token 上限）；懒建时先给 false。
            · endedMs（数字）—— 该轮 turn/end 的毫秒戳，与 startedMs 同口径（evMs）
              ⇒ App 拿 startedMs→endedMs 直接算「已完成，用时 X」；没走到 turn/end 就是 0。 */
        /* 🔴 第 185 节 · task-6（逐条提问的图片归属）：pimgs 与 prompts **同序同长** ——
           pimgs[i] 是第 i 条提问自己的图片 id 串。轮级 images 仍保留（老客户端/助手卡/
           live 都在用），只是前端改成优先按 pimgs[pi] 取图，这样同一轮里「纯文字的那条
           提问」不会再顶上一张图（用户 m00329 反复报的那个问题）。 */
        t = newSegment(n, seq, ev)
        byNo.set(n, t)
      } else {
        if (!t.seq && Number(seq)) t.seq = Number(seq)
        if (!t.startedMs) { const m = evMs(ev); if (m) t.startedMs = m }
      }
      return t
    }
    for (const raw of (events || [])) {
      const ev = unwrapEvent(raw)
      if (!ev || typeof ev !== 'object') continue
      const d = ev.data || {}
      const dTurn = Number(d.turn) || 0
      if (dTurn > 0) lastTurn = dTurn
      // 第 187 节 · task-A：step 游标（PTC 子调用事件自己不带 step，靠它归位）
      const dStep = Number(d.step) || 0
      if (dStep > 0) lastStep = dStep
      // 0.4.2：工具调用/结果收进当前轮 cur.tools（手机端对话流的可折叠工具卡，
      // DSH 同款）—— 之前直接跳过，只有轨迹 tab 能看到
      /* 第 101 节 · task-4（#56）：**真实的失败是结构化事件**，不是正文里的中文。
         桌面那行「已重试模型请求（5/5）· 9s」/「本轮运行失败」是宿主 locale 文案，
         不进会话事件；旧实现也不解析下面这三类事件 ⇒ 手机端「报错了会话页没提示」
         （用户 #56 后半句）。这里折成 turns[].failure 结构化透传，客户端照它画错误卡。
         实测样本：session-0ca1541a-677c-4967-b5a2-6cd39fb75ada turn 3 step 167，
         连续 5 次 llm/retry（code=RATE_LIMIT / type=soft_rate），随后 turn/end error。 */
      if (ev.type === 'llm/retry' || ev.type === 'llm/retry-started') {
        const cur = turnFor(dTurn, ev.seq, ev)
        const prev = cur.failure || null
        const nRetry = Number(d.retry) || 0
        const nMax = Number(d.maxRetries) || (prev ? prev.maxRetries : 0) || 0
        const fail = ev.type === 'llm/retry' ? d.failure : null
        const o = prev ? Object.assign({}, prev) : failureOf(fail)
        if (nRetry > (Number(o.retry) || 0)) o.retry = nRetry
        if (nMax > (Number(o.maxRetries) || 0)) o.maxRetries = nMax
        o.ok = false
        o.retrying = true
        if (fail) {
          if (fail.code) o.code = String(fail.code)
          if (fail.type) o.type = String(fail.type)
          if (fail.message) o.message = clip(String(fail.message), FAILURE_MSG_MAX, '')
        }
        if (!o.message) o.message = '模型请求失败'
        if (!o.time) o.time = evTime(ev)
        cur.failure = o
        if (!cur.time) cur.time = evTime(ev)
        continue
      }
      if (ev.type === 'assistant/attempt') {
        /* stream 末尾 chunk.type === 'finish' 且 reason.kind === 'error' 时，
           failure 与 llm/retry 里的是同一份（{message,type,code}）。
           有些日志只从这里能拿到失败原因，所以也收一份。 */
        const st = Array.isArray(d.stream) ? d.stream : []
        let fr = null
        for (const seg of st) {
          const c = seg && seg.chunk
          if (c && c.type === 'finish' && c.reason && c.reason.kind === 'error') {
            fr = c.reason.failure || c.reason.error || {}
          }
        }
        if (fr) {
          const cur = turnFor(dTurn, ev.seq, ev)
          const o = cur.failure ? Object.assign({}, cur.failure) : failureOf(fr)
          if (fr.code) o.code = String(fr.code)
          if (fr.type) o.type = String(fr.type)
          if (fr.message) o.message = clip(String(fr.message), FAILURE_MSG_MAX, '')
          if (!o.message) o.message = '模型请求失败'
          o.ok = false
          o.retrying = true
          if (!o.time) o.time = evTime(ev)
          cur.failure = o
        }
        continue
      }
      if (ev.type === 'turn/end') {
        /* reason.kind === 'error' ⇒ 这一轮真的失败了（重试耗尽 / 登录失效 / 取消）。
           没走到这里的话，前面的 failure 只是「过程中重试过」，最终成功。 */
        const cur = byNo.get(dTurn) || byNo.get(lastTurn) || null
        const rs = d.reason || {}
        if (cur) {
          /* 🔴 第 185 节 · task-2（数据通路）。两件事都只写这一处：
             ① endedMs —— 本轮结束的毫秒戳，与 startedMs 同口径（同一个 evMs）。
                turnFor 懒建时给 0，走到 turn/end 才被盖成真值 ⇒ App 侧读 0 就知道
                「这轮没结束（或宿主没给时间）」，不会把 0 当 1970 年算用时。
             ② maxTokens —— 判据是宿主 TurnEndReasonMap 白名单里的
                'max-tokens'（completed | blocked | max-tokens | interrupted，原文注释
                "At least one step reached its output-token ceiling, even if a plugin
                 continued the turn."）：撞了输出上限但插件续了轮，用户看不到「失败」，
                只有这个字段能说明「被截断了」。它是**一次性事实**，命中就置 true，
                之后任何分支都不再改回 false（含下面 error 那条）。
             ⚠️ 顺序按任务书固定：写在 kind === 'error' 判定**之前**（两者互斥，
                rs.kind 只会取一个值，位置只是把「先判截断、再判失败」钉死）。 */
          cur.endedMs = evMs(ev)
          if (rs && rs.kind === 'max-tokens') cur.maxTokens = true
          if (rs && rs.kind === 'error') {
            const prev = cur.failure || null
            const o = failureOf(rs.error || {}, {
              fatal: true, retrying: false,
              retry: prev ? prev.retry : 0, maxRetries: prev ? prev.maxRetries : 0
            })
            if (prev) {
              if (!o.code && prev.code) o.code = prev.code
              if (!o.type && prev.type) o.type = prev.type
            }
            if (!o.message) o.message = '本轮运行失败'
            if (!o.time) o.time = evTime(ev)
            cur.failure = o
          } else if (cur.failure) {
            const o = Object.assign({}, cur.failure)
            o.retrying = false
            o.ok = true
            if ((Number(o.retry) || 0) > 0) o.recovered = true
            cur.failure = o
          }
        }
        continue
      }
      if (ev.type === 'tool/call') {
        let args = d.arguments
        if (typeof args !== 'string') { try { args = JSON.stringify(d.arguments || d.input || '') } catch (e) { args = '' } }
        const cur = turnFor(dTurn, ev.seq, ev)
        // state 先给 'run'：后面紧跟的 tool/result 靠 state==='run' 找到它回填
        // 结果与终态（done/err）；call→result 是串行交替的，取最后一个 run 即正确配对
        cur.tools.push({
          name: String(d.name || d.tool || '工具'), state: 'run',
          // 第 111 节 · task-4/#73：保留「已截断」标记（payload.spec ③ 钉住），
          // 只先剥附件描述壳，避免工具参数里的 <path>/<content> 串进展开态
          detail: stripShellText(clipText(args, TOOL_DETAIL_MAX)), result: '',
          brief: briefOf(args)
        })
        cur.steps.push({ k: 'o', i: cur.tools.length - 1, s: Number(d.step) || 0 })
        if (Number(d.step) > 0) lastStep = Number(d.step)
        if (!cur.time) cur.time = evTime(ev)
        continue
      }
      if (ev.type === 'tool/ptc-dispatch-start') {
        /* 🔴 第 187 节 · task-A：run_code 里的**子调用开始**折进历史轮 —— 手机端
           折叠栏原本只有「思考 + 代码」两行（用户 m01797/m01830：
           「别只显示思考和代码了，本来折叠栏打开就是要看步骤的啊」）。
           这两类事件**不带 turn / step**（实测键只有 rootCallId / parentCallId /
           subCallId / name / arguments），所以轮号用 lastTurn、步骤号用 lastStep
           游标归位；子调用夹在父 tool/call 与 tool/result 之间 ⇒ 游标指向父卡那一步，
           顺序天然正确。子调用卡与父卡进**同一个 cur.tools 数组** ⇒ 自动吃
           1594 行起的跨轮字节预算 + BRIEF_KEEP/TOOL_KEEP_FULL 裁剪（体积红线）。
           老宿主没有这两类事件时，本分支永不命中，历史轮逐字不变。 */
        const args = d.arguments !== undefined ? d.arguments : d.input
        let s = args
        if (typeof s !== 'string') { try { s = JSON.stringify(args === undefined ? '' : args) } catch (e) { s = '' } }
        const cur = turnFor(dTurn, ev.seq, ev)
        cur.tools.push({
          name: String(d.name || d.tool || '工具'), state: 'run',
          detail: stripShellText(clipText(s, TOOL_DETAIL_MAX)), result: '',
          brief: briefOf(s)
        })
        cur.steps.push({ k: 'o', i: cur.tools.length - 1, s: lastStep })
        const myCard = cur.tools[cur.tools.length - 1]
        ptcCards.add(myCard)
        if (d.subCallId) ptcAt.set(String(d.subCallId), myCard)
        if (!cur.time) cur.time = evTime(ev)
        continue
      }
      if (ev.type === 'tool/ptc-dispatch') {
        /* 同一条子调用的收尾：**按 subCallId 精确配对**（子调用可能同名并发），
           配不上再退回「最近一条同名且仍 run」的兜底；命中就回填 done/err +
           结果正文，命不中就当独立一步补一张卡（宁多勿漏）。 */
        const args = d.arguments !== undefined ? d.arguments : d.input
        let s = args
        if (typeof s !== 'string') { try { s = JSON.stringify(args === undefined ? '' : args) } catch (e) { s = '' } }
        const isErr = d.isError === true || !!d.error
        const cur = turnFor(dTurn, ev.seq, ev)
        let card = d.subCallId ? ptcAt.get(String(d.subCallId)) : null
        if (!card) {
          const nm = String(d.name || d.tool || '工具')
          for (let i = cur.tools.length - 1; i >= 0; i--) {
            const c = cur.tools[i]
            if (c && c.state === 'run' && c.name === nm) { card = c; break }
          }
        }
        if (!card) {
          card = { name: String(d.name || d.tool || '工具'), state: 'run',
            detail: stripShellText(clipText(s, TOOL_DETAIL_MAX)), result: '', brief: briefOf(s) }
          cur.tools.push(card)
          ptcCards.add(card)
          cur.steps.push({ k: 'o', i: cur.tools.length - 1, s: lastStep })
        }
        card.state = isErr ? 'err' : 'done'
        card.result = clipText(contentText(d.content), TOOL_DETAIL_MAX)
        if (!cur.time) cur.time = evTime(ev)
        continue
      }
      if (ev.type === 'tool/result') {
        const m = d.message
        const errInBlocks = Array.isArray(m && m.content) &&
          m.content.some((b) => b && b.type === 'tool-result' && b.isError)
        const cur = byNo.get(dTurn) || byNo.get(lastTurn) || null
        /* 🔴 第211节 · task-2：外层守卫原本还要求 cur.tools.length 非零 —— 但 steer 切段后
           新段可能**一张工具卡都没有**（result 落在新段），那样连下面的跨段回填都进不来，
           上一段的 run 父卡永远挂着。放开成「有 tools 数组即可」（下一行原样判断长度）。 */
        if (cur && cur.tools) {
          // 第 187 节 · task-A：跳过子调用卡，往前找最近的**父卡**（state==='run' 且
          // 不是 ptc 子卡）；一个都没找到再退回数组末位（老日志无子卡时行为不变）。
          let last = null
          for (let i = cur.tools.length - 1; i >= 0; i--) {
            const c = cur.tools[i]
            if (c && c.state === 'run' && !ptcCards.has(c)) { last = c; break }
          }
          if (!last) {
            const tail = cur.tools[cur.tools.length - 1]
            if (tail && tail.state === 'run') last = tail
          }
          /* 🔴 第211节 · task-2：steer 可能在**工具还在跑**时切段（上一行的 forkSegment），
             于是 call 登记在旧段、result 落到新段 ⇒ byNo 指向新段、旧段的父卡永远挂着
             'run'（手机端折叠栏一直显示「运行中」）。在紧邻的上一个视觉轮里再找一次
             同一条 run 父卡，配上就回填结果与终态；找不到才维持旧行为（什么都不动）。 */
          if (!last && cur.tools && cur.tools.length === 0) {
            const ci = turns.indexOf(cur)
            const prev = ci > 0 ? turns[ci - 1] : null
            if (prev && Array.isArray(prev.tools)) {
              for (let i = prev.tools.length - 1; i >= 0; i--) {
                const cc = prev.tools[i]
                if (cc && cc.state === 'run' && !ptcCards.has(cc)) { last = cc; break }
              }
            }
          }
          if (last) {
            last.state = (d.isError || errInBlocks) ? 'err' : 'done'
            // 第 100 节：工具结果统一到 TOOL_DETAIL_MAX（原写死 400），按码点切 + 带标记
            last.result = clipText(contentText(m && m.content), TOOL_DETAIL_MAX)
          }
        }
        continue
      }
      let msg = null
      let isUser = false
      if (ev.type === 'user/message') { msg = d; isUser = true }
      else if (ev.type === 'assistant/message') msg = d.message
      // agent/inbox/spliced 也走这里：它没有 data.content（内容在 data.inserted[]），
      // contentText(undefined)='' → 被下面 !text && !think 跳过，不会重复成一轮。
      if (!msg) continue
      const text = contentText(msg && msg.content)
      // 【G】DSH 注入的伪用户消息（<system-reminder> / 时间采样 / 运行环境快照 /
      // 压缩检查点 / 换模型提示）不是用户提问：不当 prompt、也不新开轮
      /* 🔴 第 124 节 · task-1 / #42：先按宿主归因 data.source 判（可靠），
         再按文本前缀兜底。只靠前缀时，子会话那条「委派 prompt」没有任何已知
         前缀、剥壳后又是光秃秃的任务正文 → 被画成用户气泡（#42 本体）。 */
      if (isUser && (isInjectedUserData(msg) || isInjectedUserText(text))) continue
      // 思考过程（reasoning 块）先收，和正文分开走
      let think = ''
      if (!isUser && Array.isArray(msg && msg.content)) {
        /* 思考块不过客户端 cleanMd（Session.ets 只覆盖历史正文/流式正文），
           宿主塞进来的 ACP 标记要在这里剥干净再下发。 */
        think = stripAcp(msg.content
          .filter((b) => b && b.type === 'reasoning' && typeof b.text === 'string' && b.text)
          .map((b) => b.text)
          .join('\n\n'))
      }
      /* 图片块不进 contentText（只拼 text），单独登记 —— 与文本同一轮归属。
         登记必须在 !text && !think 的 continue 之前：一张只有图的提问轮
         （text 为空、think 为空）否则整轮被丢掉，气泡里就没图了。 */
      const imgRefs = imageRefsOf(msg && msg.content)
      if (!text && !think && !imgRefs.length) continue
      let cur = turnFor(dTurn, ev.seq, ev)
      /* 🔴 第 189 节 · task-B：同一条 DSH 轮里，**已经出过助手正文**之后又来一条用户
         提问 ⇒ 那是「同一轮里的下一次追问 / steer」，必须另起一张卡（见上面 forkSegment
         注释）。只认「已有正文」—— 首条提问与紧跟其后的第二条（还没任何回复）仍同卡，
         turn-prompt-images.spec ① 钉着这个行为。 */
      /* 🔴🔴 第211节 · task-2（G55 §2-D · 插件半）· 触发条件收窄修正：
         旧判据只认 `cur.response`（当前段已有**助手正文**），实测太窄 —— 真实 agent 一轮里
         先跑几十条 reasoning + tool/call 才出正文（assistant/message 的 text 长度为 0、
         只有 reasoning / tool-call 块），用户在这中间 steer 时 cur.response 还是空串
         ⇒ 不切段 ⇒ 追问和上一段的回复挤在同一张卡里；而 App 的 turnBlock 先 ForEach
         画**全部提问**、之后才画助手正文 ⇒ 用户 m1404/m2000 看到的
         「我发出去的新消息在你回复之上」。
         离线全量回放（~/.dsh/sessions 下 session-98fbbeec，8316 事件）：
         「同一 DSH 轮里已有助手活动之后又来的真 user/message」共 63 处，其中
         cur.response 非空的**只有 1 处**，另外 62 处前面只有 reasoning(think) / tool/call
         ⇒ 旧判据漏掉 62/63（session-c9b21044 25 处全漏）。
         ⇒ 放宽成「当前段已有**任意助手活动**」：正文 / 思考 / 步骤 / 工具 / 失败卡。
         ⚠️ 只放宽「已有活动」这一维，**没动**「正文前连问不切」这条红线：
         turn-prompt-images.spec ① 的两条连问中间没有任何助手事件，仍然同卡。 */
      if (isUser && (cur.response || cur.think || (cur.steps && cur.steps.length) ||
        (cur.tools && cur.tools.length) || cur.failure)) cur = forkSegment(ev, ev.seq)
      // 【A】发送时间：轮内第一条事件的时间（用户提问优先），手机端 TurnItem.time
      if (!cur.time) cur.time = evTime(ev)
      /* 🔴 第 167 节 · T1：按事件来源分流 —— isUser ⇒ 用户数组，assistant ⇒ 助手数组。
         原来两个来源都进 cur.images，客户端在用户气泡和助手卡各渲染一次 ⇒ 图重复。 */
      const imgBucket = isUser ? cur.images : cur.aimages
      /* 🔴 第 185 节 · task-6：myImgIds = **本条** user/message 自己登记出的 id（原顺序）。
         与轮级 bucket 的区别：bucket 是整轮的、要去重；myImgIds 只属于这一条提问，
         下面与 prompts.push 严格同序同长地进 pimgs（没图就是空数组，下标绝不能错位）。
         ⚠️ register 只在这里调一次（id 复用登记表，别再 register 一遍）。 */
      const myImgIds = []
      for (const ref of imgRefs) {
        const iid = attachments.register(ref)
        if (!iid) continue
        if (myImgIds.indexOf(iid) < 0) myImgIds.push(iid)
        if (imgBucket.indexOf(iid) < 0) imgBucket.push(iid)
      }
      /* 0.4.10 · 步骤流：这一步的思考作为「思考」步骤按顺序插进 steps。
         文字用该轮共享预算（THINK_STEPS_TOTAL），超了只留步骤行不留正文。 */
      if (!isUser && think) {
        if (!thinkLeft.has(cur.turn)) thinkLeft.set(cur.turn, THINK_STEPS_TOTAL)
        const left = thinkLeft.get(cur.turn)
        if (left > 0) {
          /* 第 100 节：这一段被预算砍掉的部分要看得见（按码点切 + 「已截断 N 字」）。
             预算记账用**实际消耗的码点数**，不能算上标记本身（否则越记越亏）。 */
          /* 🔴 第 188 节 · task-3 ③：第一步给足 THINK_STEP_MAX，之后每步给个小上限，
             让一轮里每一步都留得下思考文字（旧实现第一步就吃光 700 预算，
             后面的 k:'t' 步骤整条消失 ⇒ 手机端只剩 1 条思考）。 */
          const cap = Math.min(cur.thinks.length === 0 ? THINK_STEP_MAX : THINK_TAIL_STEP_MAX, left)
          const seg = clipText(think, cap)
          thinkLeft.set(cur.turn, left - Math.min(Array.from(think).length, cap))
          cur.thinks.push(seg)
          cur.steps.push({ k: 't', i: cur.thinks.length - 1, s: Number(d.step) || 0 })
        }
      }
      if (isUser) {
        /* 🔴 0.4.10 · 用户 m15254「还有两次会话怎么在一个气泡里？」
         *  user/message 不带 data.turn，只能靠 lastTurn 归位 —— 同一轮里连着
         *  两条 user/message 时旧实现用 \n\n 拼进同一个 prompt，手机端就把
         *  两条提问画进同一个蓝气泡。DSH 面板是两条独立气泡。
         *  prompt 保留拼接（旧字段兼容），另加 prompts[]，客户端一条一泡。 */
        /* 🔴 第 185 节 · task-6：pimgs 与 prompts **同一次 push**（同序同长是硬约束）——
           两条 user/message 时：第一条带图 ⇒ pimgs[0]=[图]，第二条纯文字 ⇒ pimgs[1]=[]。
           客户端 Session.ets ForEach(prompts) 里按下标取 pimgs[pi]，不再用轮级 images。 */
        cur.prompts.push(text)
        cur.pimgs.push(myImgIds)
        cur.prompt = cur.prompt ? cur.prompt + '\n\n' + text : text
      } else {
        if (think) cur.think = cur.think ? cur.think + '\n\n' + think : think
        if (text) cur.response = cur.response ? cur.response + '\n\n' + text : text
        /* 🔴 第 186 节 · task-B：这段助手正文里的本地图片路径也登记进**该轮的**
           aimages（与上面宿主 image 块的助手图同一数组，累在既有 id 之后）。
           只登记不改正文 —— markdown 片段原样留着，文本净化是 App 侧的活。 */
        for (const lid of localImageIdsOf(text, LOCAL_IMG_PER_TURN)) {
          if (cur.aimages.indexOf(lid) < 0) cur.aimages.push(lid)
        }
      }
    }
    for (const t of turns) {
      // 图片：登记表 id → 冻结形状 [{id,name,mime,bytes}]（客户端 task-24/25 按此渲染）
      t.images = (t.images || []).map((id) => attachments.infoOf(id)).filter(Boolean)
      // 第 167 节 T1：aimages 与 images 同一冻结形状（客户端助手卡按它画图）
      t.aimages = (t.aimages || []).map((id) => attachments.infoOf(id)).filter(Boolean)
      /* 🔴 第 185 节 · task-6：pimgs 逐项冻结成与 images **完全一致**的形状
         （[{id,name,mime,bytes}]，infoOf 拿不到的 id 同 images 一样被 filter 掉）。 */
      t.pimgs = (t.pimgs || []).map((ids) => (Array.isArray(ids) ? ids : [])
        .map((id) => attachments.infoOf(id)).filter(Boolean))
      // 第 100 节：按码点切 + 带「已截断 N 字」标记（task-35 要求①②）
      if (t.think) t.think = clipText(t.think, THINK_MAX)
    }
    /* 【I】payload 瘦身（0.4.6）· 第 113 节 task-5 改：工具卡是体积大头，
     *  老做法（每轮只留最后 TOOL_KEEP_FULL 张，其余卡 delete detail/result/
     *  brief）把老卡展开掏空了 —— 用户需求9「只有最下面一个能展开」。
     *  新做法 = **留键 + 短预览**，任何一张卡都不再 delete 三个键：
     *    · 最后 TOOL_KEEP_FULL 张：detail/result 全文（TOOL_DETAIL_MAX=600）
     *    · 更老的卡：detail/result 截到 OLD_DETAIL_MAX、brief 截到 OLD_BRIEF_MAX
     *  客户端 LanClient.ets 的 String(tl.detail || '') 从此不会再兜出空串；
     *  截断处一律用 clipText/clip 带标记，不静默丢内容（第 100 节要求）。
     *
     *  预算记账：单卡上限是「每张」的，3493 张卡叠起来实测 1496KB（上限 120）。
     *  所以这里再叠一道跨轮预算 OLD_TOOL_BUDGET，**从最新一轮往前**遍历
     *  （用户最可能展开的是最近几步；老卡优先退到 OLD_TOOL_MIN，仍带正文）。
     *  记账口径 = UTF-8 字节、算截断后的实际值（标记本身也占字节）。
     *  上限 = min(OLD_DETAIL_MAX, max(OLD_TOOL_MIN, left/3))，3 是 CJK 码点
     *  的字节上界 ⇒ 预算永不超支。预算见底后老卡固定 OLD_TOOL_MIN 字
     *  （**键仍在、不为空**；这是需求9「每张都能展开」的底线，不做 delete）。
     *  真机实测（session-7f37d36e / 43MB / 3493 卡 / 31 轮）：
     *    无预算 120/32 → 1496KB ｜ 旧删键逻辑 → 495KB（但 3431 张展开全空）
     *    本预算 600KB 下 → 约 1.2MB，红线是历史 2.06MB / 手机 5s 超时。 */
    let left = OLD_TOOL_BUDGET
    for (let ti = turns.length - 1; ti >= 0; ti--) {
      const tl = turns[ti].tools || []
      for (let i = tl.length - 1; i >= 0; i--) {
        const fromTail = tl.length - 1 - i
        const c = tl[i]
        if (!c || typeof c !== 'object') continue
        const capOf = (max) => (left > 0
          ? Math.min(max, Math.max(OLD_TOOL_MIN, Math.floor(left / 3)))
          : OLD_TOOL_MIN)
        if (fromTail >= TOOL_KEEP_FULL) {
          if (typeof c.detail === 'string' && c.detail) {
            const before = c.detail
            c.detail = clipText(before, capOf(OLD_DETAIL_MAX))
            left -= Math.min(byteLen(before), byteLen(c.detail))
          }
          if (typeof c.result === 'string' && c.result) {
            const before = c.result
            c.result = clipText(before, capOf(OLD_DETAIL_MAX))
            left -= Math.min(byteLen(before), byteLen(c.result))
          }
        }
        /* 第 94 节 b · brief 也限量：留最新 BRIEF_KEEP 张全文，更老的截短。
           单轮实测最高 554 张卡 ⇒ 不限量会把手机端 5000ms 超时逼爆。 */
        if (fromTail >= BRIEF_KEEP && typeof c.brief === 'string' && c.brief) {
          const before = c.brief
          c.brief = clip(before, capOf(OLD_BRIEF_MAX))
          left -= Math.min(byteLen(before), byteLen(c.brief))
        }
      }
    }
    /* 0.4.10 · 步骤流兜底：没有 steps 的轮（老日志 / 纯思考轮）也补一条，
       客户端只写一套渲染逻辑；prompts 为空时用 prompt 兜。 */
    for (const t of turns) {
      if (!Array.isArray(t.prompts) || !t.prompts.length) t.prompts = t.prompt ? [t.prompt] : []
      /* 🔴 第 185 节 · task-6：**不变式**「prompts.length === pimgs.length」在这里兜底。
         老日志 / 只走轮级 prompt 的轮（turnOutline 概要、人工构造）没有 pimgs 或长度
         对不上 ⇒ 补齐成等长的空数组，客户端按下标取 pimgs[pi] 永不 undefined。 */
      if (!Array.isArray(t.pimgs)) t.pimgs = []
      if (t.pimgs.length > t.prompts.length) t.pimgs.length = t.prompts.length
      while (t.pimgs.length < t.prompts.length) t.pimgs.push([])
      if (!Array.isArray(t.steps)) t.steps = []
      if ((!Array.isArray(t.thinks) || !t.thinks.length) && t.think) {
        t.thinks = [clip(t.think, THINK_STEP_MAX)]
        t.steps.push({ k: 't', i: 0, s: 0 })
      }
    }
    /* 第 101 节 · task-4：失败标记不能凭空造出一轮 —— 只有 failure、别的什么都没有
       的轮（宿主先报 llm/retry 又被取消/换轮）删掉，免得手机端画一个空蓝气泡。 */
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]
      if (!t.failure) continue
      const hasBody = (t.prompt && t.prompt.length) || (t.response && t.response.length) ||
        (t.think && t.think.length) || (t.tools && t.tools.length) ||
        (t.images && t.images.length) || (t.aimages && t.aimages.length) ||
        (t.steps && t.steps.length)
      if (!hasBody) { byNo.delete(t.turn); turns.splice(i, 1) }
    }
    /* 🔴 第 189 节 · task-B：切过段 ⇒ 轮号已被 fork 打乱（fork 段拿的是「+1 号」，
       真轮号可能被让位挪走），统一重排成稠密的 1..N（顺序 = turns[] 创建顺序 =
       事件时间顺序）。App 的 ForEach key 是 String(t.turn)，重号会撞 key；稠密化后
       轮号也与 App 乐观插入的 lastTurn+1 对齐，reconcilePending 更容易对上。
       没切过段的日志仍按轮号排序，逐字不变。 */
    if (segmented) {
      for (let i = 0; i < turns.length; i++) turns[i].turn = i + 1
    } else {
      turns.sort((a, b) => a.turn - b.turn)
    }
    return turns
  }

  /**
   * 事件时间 → epoch 毫秒（拿不到就 0）。
   * 🩸 第 134 节 · 问题4：手机端「用时」起点 bug 的数据源 —— 任务在电脑发起、
   *   手机后进会话时，App 只能拿「进页面那一刻」当起点（Session.ets liveStartOf(n)
   *   的兜底分支），于是手机永远比电脑少算。插件侧从这一节起在每轮下发
   *   `startedMs`（该轮首事件的毫秒戳，与 evTime 同源、同一时间基准），
   *   App 用它就能算出真实用时。故意不复用 evTime：那个只返回 HH:MM，
   *   被多处时间文案用着，改返回值会连带把它们全打坏。
   */
  function evMs(ev) {
    const raw = ev && (ev.ts || ev.time || ev.createdAt || ev.timestamp)
    if (!raw) return 0
    try {
      const n = typeof raw === 'number'
        ? (raw > 1e12 ? raw : raw * 1000)
        : new Date(raw).getTime()
      return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
    } catch (e) { return 0 }
  }

  /** 事件时间 → HH:MM（拿不到就空串，前端不显示时间）。 */
  function evTime(ev) {
    const raw = ev && (ev.ts || ev.time || ev.createdAt || ev.timestamp)
    if (!raw) return ''
    try {
      const d = new Date(typeof raw === 'number' ? (raw > 1e12 ? raw : raw * 1000) : raw)
      if (isNaN(d.getTime())) return ''
      const p = (n) => (n < 10 ? '0' + n : '' + n)
      return p(d.getHours()) + ':' + p(d.getMinutes())
    } catch (e) { return '' }
  }

  /**
   * 长文本截尾（轨迹卡片预览用）。
   *
   * 🔴 第 100 节 · task-35 要求②：**必须按码点切**。原来的 `t.slice(0, n)` 是按
   *   UTF-16 code unit 切 —— 汉字本身是单 code unit 没事，但 emoji / 生僻字
   *   （代理对，如 𝕏、🧠、𠮷）正好跨在边界上时会被切成半个，前后各留一个孤立
   *   代理码元 ⇒ 手机端显示成乱码方块（本项目已踩过乱码）。
   *   改用 Array.from（按码点迭代）后，s.length 也不再等于「字数」，所以统一用
   *   码点数组的长度判断。
   *
   * @param s 任意值（非字符串会被 String() 包一层）
   * @param n 上限，**按码点计**
   * @param mark 截断标记；省略用默认 '…'，显式传 '' 表示不要标记
   */
  function clip(s, n, mark) {
    const t = String(s || '')
    const cps = Array.from(t)
    if (cps.length <= n) return t
    const tag = mark === undefined ? '…' : String(mark)
    return cps.slice(0, n).join('') + tag
  }

  /**
   * 带「截掉多少」的截断标记（task-35 要求①：不许静默丢内容）。
   * 轨迹/思考/工具详情这些**正文**位置的截断都用它，让用户知道后面还有。
   * 返回 '' 表示没截断（调用方据此判断要不要加尾巴）。
   */
  function clipTag(cutChars) {
    return cutChars > 0 ? '…（已截断 ' + cutChars + ' 字）' : ''
  }

  /**
   * 正文截断：按码点切 + 带「已截断 N 字」标记。
   * @param s 原文；@param n 码点上限；返回值可能比 n 长（标记本身占位）。
   */
  function clipText(s, n) {
    const t = String(s || '')
    const cps = Array.from(t)
    if (cps.length <= n) return t
    return cps.slice(0, n).join('') + clipTag(cps.length - n)
  }

  /**
   * 0.4.10 · 工具卡「短摘要」：从调用参数里抽最有用的一条值。
   *
   * 为什么单独一个字段、而不是复用 detail：
   *   【I】payload 瘦身会把除最后 TOOL_KEEP_FULL 张以外的 detail/result
   *   截短（旧版本是直接删键，治手机端 detail 5000ms 超时；第 113 节 task-5
   *   起改成留键 + 预览）。而手机端步骤流每一步都要显示「做了什么」，删键
   *   后就只剩光秃秃的动词。brief 是最短的那档摘要，**保留 BRIEF_KEEP 张原文、
   *   更老的截到 OLD_BRIEF_MAX（永不删键）**，既保住「知道每一步在干什么」，
   *   又不会把 payload 撑回原样。
   *
   * 优先级：路径 > 命令 > 模式 > 查询 > 原串（前几个在 DSH 里出现频率最高）。
   */
  function briefOf(args) {
    if (typeof args !== 'string' || !args) return ''
    const keys = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'content']
    let o = null
    try { o = JSON.parse(args) } catch (e) { o = null }
    if (o && typeof o === 'object') {
      for (const k of keys) {
        const v = o[k]
        if (typeof v === 'string' && v) return clip(v.replace(/\s+/g, ' ').trim(), BRIEF_MAX)
      }
    }
    return clip(args.replace(/\s+/g, ' ').trim(), BRIEF_MAX)
  }

  /* 🔴 0.4.8 · 实时流真根因修复。
     宿主事件普查（2026-10-07，_sess_log.jsonl 55 类）：
       assistant/chunk   = 0 次    ← 宿主从不发这个事件
       assistant/message = 2764
       text-chunks       = 384 / reasoning-chunks = 2324 / tool-call-chunks = 3315
     老代码 onSessionEvent / liveFromLog / mp-ws-live 三处都只认
     assistant/chunk ⇒ live 永远为空、WS 一帧都推不出，手机端就是
     「一直没动」。

     真实增量入口是 assistant/message.data.stream（合并事件数组）：
       {type:"text-chunks",      texts:[...]}   逐字增量批，join("") 即本批全文
       {type:"reasoning-chunks", texts:[...]}   同上（思考）
       {type:"chunk", chunk:{type:"block-end", block:{type,text}}}  整段全文兜底
     实证（384 text-chunks / 2324 reasoning-chunks 全量拼接 = 最终全文，逐字相等）。
     工具卡不从 stream 收 —— 同一批 tool/call 事件也到，两处都收会出重复卡。 */
  function absorbStream(L, ev) {
    if (!L || !ev) return false
    const st = ev.data && ev.data.stream
    if (!Array.isArray(st) || !st.length) return false
    let got = false
    for (let i = 0; i < st.length; i++) {
      const item = st[i]
      if (!item || typeof item !== "object") continue
      const it = item.type
      if (it === "text-chunks" || it === "reasoning-chunks") {
        const arr = item.texts
        if (!Array.isArray(arr) || !arr.length) continue
        /* ⚠️ 这里剥的是「本批文本」，跨批被切开的 <acp …> 标签剥不干净；
           残留由客户端 Session.ets 的 cleanMd 兜底（同一份算法）。 */
        const s = stripAcp(arr.join(""))
        if (!s) continue
        if (it === "text-chunks") L.text += s
        else L.think += s
        got = true
      } else if (it === "chunk" && item.chunk && item.chunk.type === "block-end") {
        const b = item.chunk.block
        if (!b || typeof b.text !== "string" || !b.text) continue
        /* block-end 给的是整段全文；text-chunks 已累积过就不再加，避免翻倍 */
        if (b.type === "text" && !L.text) { L.text = stripAcp(b.text); got = true }
        else if (b.type === "reasoning" && !L.think) { L.think = stripAcp(b.text); got = true }
      }
    }
    if (got) {
      if (L.text.length > LIVE_TEXT_CAP) L.text = L.text.slice(-100000)
      if (L.think.length > LIVE_TEXT_CAP) L.think = L.think.slice(-100000)
      L.lastAt = Number(ev.time) || Date.now()
    }
    return got
  }

  /**
   * live 兜底（0.3.3）：不看事件总线，直接扫 Session.log 尾部 ——
   * sessions store 进程内直读（delete 算法实证过的路径），数据源就是权威日志。
   * 窗口判定（从尾部往回）：
   *   先遇 turn/end         → 最近一轮已结束，无进行中内容
   *   先遇 assistant/message → 该条已落盘（history 有了），只聚合它之后的增量
   *   先遇 turn/start / user/message → 整轮都还没落盘，从头聚合
   */
  function liveFromLog(sid) {
    try {
      const store = (() => { try { return ctx.get('sessions') } catch (e) { return null } })()
      const sess = store && typeof store.get === 'function' ? store.get(sid) : null
      if (!sess || !Array.isArray(sess.log) || !sess.log.length) return null
      const log = sess.log
      /* 0.4.8：窗口判定同时给出 busy（这一轮到底还在不在跑）。
         原来 turn/end 直接 return null ⇒ 手机端会退回事件总线缓存，
         那边的内容已经落盘了 → 重复显示。现在统一以 log 为准。 */
      let start = -1
      let busy = false
      for (let i = log.length - 1; i >= 0; i--) {
        const t = unwrapEvent(log[i])   // 宽容解包：Session.log 是裸事件，但防形状漂移
        const tt = t && t.type
        if (tt === 'turn/end') { busy = false; start = log.length; break }
        if (tt === 'turn/start' || tt === 'user/message') { start = i; busy = true; break }
      }
      if (start < 0) return null
      if (start >= log.length) return { think: '', text: '', tools: [], acts: [], todos: [], images: [], aimages: [], lastAt: 0, busy: false }
      const L = { think: '', text: '', thinks: [], steps: [], tools: [], acts: [], todos: [], images: [], aimages: [], startedMs: 0, lastAt: 0 }
      /* 🔴 第211节 · task-2（G55 §2-D）：窗口**起点事件的 seq**。readDetail 用它判断
         「live 窗口和折出来的末轮视觉轮是不是同一段」（见 maskLiveSegment）。
         纯内部字段，**不进 base.live 的下发形状**，老客户端读不到也不受影响。 */
      L.seq = Number((unwrapEvent(log[start]) || {}).seq) || 0
      for (let i = start; i < log.length; i++) {
        const ev = unwrapEvent(log[i])
        if (!ev || typeof ev !== 'object') continue
        /* 🩸 第 134 节 · 问题4：窗口内**首个带时间的事件**盖本轮起点（通常是
           turn/start 或 user/message）。只在为空时写一次 ⇒ 得到的就是轮首。 */
        if (!L.startedMs) L.startedMs = evMs(ev)
        /* 0.4.8：宿主只发 assistant/message，增量藏在 data.stream 里 */
        if (ev.type === 'assistant/message') {
          absorbStream(L, ev)
          const rz = streamReasoning(ev)
          if (rz) {
            L.thinks.push(clip(rz, THINK_STEP_MAX))
            L.steps.push({ k: 't', i: L.thinks.length - 1, s: Number((ev.data || {}).step) || 0 })
          }
          const mImg = ev.data && ev.data.message
          // 第 167 节 T1：从日志回放时，assistant/message 的图也只进 aimages
          for (const ref of imageRefsOf(mImg && mImg.content)) {
            const iid = attachments.register(ref)
            if (iid && L.aimages.indexOf(iid) < 0) L.aimages.push(iid)
          }
          L.lastAt = Number(ev.time) || L.lastAt
          continue
        }
        if (ev.type === 'assistant/chunk') {
          const c = ev.data && ev.data.chunk
          if (!c) continue
          if (c.type === 'text-delta') L.text += stripAcp(c.text || '')
          else if (c.type === 'reasoning-delta') L.think += stripAcp(c.text || '')
          // block-end 不收（同 onSessionEvent：tool/call 事件统一负责，避免重复卡）
          L.lastAt = Number(ev.time) || L.lastAt
        } else if (ev.type === 'tool/call') {
          const d = ev.data || {}
          let args = d.arguments
          if (typeof args !== 'string') { try { args = JSON.stringify(d.arguments || d.input || '') } catch (e) { args = '' } }
          L.tools.push({
            name: String(d.name || d.tool || '工具'), state: 'run',
            // 第 111 节 · task-4/#79：liveFromLog 回放同样去「已截断」
            detail: stripShellText(clip(args, TOOL_DETAIL_MAX)), result: '',
            brief: briefOf(args)
          })
          L.steps.push({ k: 'o', i: L.tools.length - 1, s: Number(d.step) || 0 })
          trimLiveTools(L)
          L.lastAt = Number(ev.time) || L.lastAt
        } else if (ev.type === 'tool/ptc-dispatch-start') {
          /* 🔴 第 186 节 · task-A：Session.log 尾部回放同样收子调用（实测每步 1~4 条，
             与 tool/call 在同一份日志里）。 */
          const d = ev.data || {}
          pushAct(L, d.name || d.tool, d.arguments !== undefined ? d.arguments : d.input, ev.time, d.subCallId)
          L.lastAt = Number(ev.time) || L.lastAt
        } else if (ev.type === 'tool/ptc-dispatch') {
          const d = ev.data || {}
          markActDone(L, d.name || d.tool, d.isError === true || !!d.error, d.subCallId)
          L.lastAt = Number(ev.time) || L.lastAt
        } else if (ev.type === 'todo/write') {
          /* 第 186 节 · task-C：日志窗口里也记最后一条清单（覆盖式全量）。
             这只是 detail 顶层 todos 的活性兜底 —— 主要来源仍是全文通道的 events。 */
          const d = ev.data || {}
          if (Array.isArray(d.todos)) L.todos = normalizeTodos(d.todos)
          L.lastAt = Number(ev.time) || L.lastAt
        } else if (ev.type === 'tool/result') {
          const d = ev.data || {}
          const m = d.message
          const errInBlocks = Array.isArray(m && m.content) &&
            m.content.some((b) => b && b.type === 'tool-result' && b.isError)
          const last = L.tools && L.tools.length ? L.tools[L.tools.length - 1] : null
          if (last && last.state === 'run') {
            last.state = (d.isError || errInBlocks) ? 'err' : 'done'
            // 第 111 节 · task-4/#79：同上，live 结果不带截断标记
            last.result = clip(contentText(m && m.content), TOOL_DETAIL_MAX)
          }
          L.lastAt = Number(ev.time) || L.lastAt
        }
      }
      trimLiveTools(L)
      /* 第 186 节 · task-A：日志窗口回放完，还挂 run 的子调用都是收尾缺失 ⇒ 标 done
         （窗口已结束，父调用早返回了；不能让手机端永久显示「运行中」）。 */
      settleActs(L)
      L.busy = busy
      return L
    } catch (e) { return null }
  }

  /* 🔴 第211节 · task-2（G55 §2-D · 插件半）· 消掉「同一屏两张生成中卡」的最后一条通路：
     turns 与 live 读的是**同一份 Session.log**。用户在本轮里 steer 之后，被切出来的新视觉轮
     （foldHistoryToTurns 的 forkSegment）与 liveFromLog 的窗口起于**同一条事件** ⇒ 同一段内容
     既进了 turns 末轮、又原样下发成 base.live。App 侧（Session.ets）：
       · showLiveCard() 有 response 守卫（:4031）⇒ 主路径改画「已完成本轮」；
       · liveCardFallback()（:4060）在「末轮有正文」时仍然为真 ⇒ 页面底部再画一张兜底
         live 卡 = 用户截图里上下两张卡（同一段正文重复两遍）。
     判据（三条**同时**成立才屏蔽；缺一条都不屏蔽 —— 宁可多下一份 live，也不许丢信息）：
       ① 段身份一致：lc.startedMs === t.startedMs（同一条事件起头；seq 相等为辅助判据）；
       ② 末轮已折进过程内容（tools/steps 非空）⇒ 「已完成」折叠栏有东西可看；
       ③ live 正文已被末轮 response 覆盖（含等）⇒ 屏蔽后一个字都不丢。
     ⚠️ 屏蔽 = **不下发 base.live**（键完全不出现）：App 那条兜底只看 live 这个键在不在，
        只把内容清空没用。
     ⚠️ running 不动：轮询该继续还继续，真正结束（turn/end）后由 liveFromLog 自己收敛。
     ⚠️ live 没有 seq（老宿主 / 事件总线缓存通道）时本条恒不触发 —— 老行为逐字不变。 */
  function liveFoldedInLastTurn(lc, turns) {
    if (!lc || !Array.isArray(turns) || !turns.length) return false
    const t = turns[turns.length - 1]
    if (!t) return false
    const seq = Number(lc.seq) || 0
    const sm = Number(lc.startedMs) || 0
    if (!sm) return false
    /* 段身份：**毫秒戳相等**为主判据，seq 相等为辅助（两条都是同一本日志里的唯一身份）。
       为什么不只认 seq：真日志实测（session-98fbbeec idx1410）live 窗口起点是第 1404 条
       steer 消息，而折出的 fork 段 seq=1403 —— 同一条 steer 在日志里落了两条相邻事件、
       毫秒戳完全相同，只比 seq 会漏判 ⇒ 双卡照旧。 */
    const sameStart = (sm === (Number(t.startedMs) || 0)) || (!!seq && seq === (Number(t.seq) || 0))
    if (!sameStart) return false
    const tools = Array.isArray(t.tools) ? t.tools.length : 0
    const steps = Array.isArray(t.steps) ? t.steps.length : 0
    if (!tools && !steps) return false
    const lt = String(lc.text || '')
    if (lt && String(t.response || '').indexOf(lt) < 0) return false
    return true
  }

  /**
   * history 事件 → 轨迹时间线（0.3.1）。
   * 手机端「轨迹」标签：按发生顺序列工具调用/工具结果/助手/用户/上下文注入卡片。
   * 只挑用户能看懂的事件；chunk/header 等流式细节跳过。
   */
  function buildTrace(events) {
    const out = []
    // 真实轮号（0.4.6 · J 项）：优先事件的 data.turn，缺省沿用上一个已知轮号；
    // 旧实现用自增 turnNo —— 轨迹卡上的「第 N 轮」与实际轮次对不上。
    let turnNo = 0
    let lastTurn = 0
    for (const raw of (events || [])) {
      const ev = unwrapEvent(raw)
      if (!ev || typeof ev !== 'object') continue
      const t = String(ev.type || '')
      const seq = Number(ev.seq) || 0
      const time = evTime(ev)
      const d = ev.data || {}
      const dTurn = Number(d.turn) || 0
      if (dTurn > 0) lastTurn = dTurn
      if (t === 'turn/start') turnNo = dTurn || turnNo
      else turnNo = dTurn || lastTurn || turnNo
      if (t === 'user/message') {
        const text = contentText(d.content)
        // 【G】注入的伪用户消息（<system-reminder> 等）不进轨迹，避免手机端也画出来
        // 第 124 节 · task-1：同 foldHistoryToTurns，先看 data.source 再看前缀
        if (isInjectedUserData(d) || isInjectedUserText(text)) continue
        out.push({ kind: 'user', turn: turnNo, seq, time, text: clipText(text, TRACE_TEXT_MAX) })
      } else if (t === 'assistant/message') {
        const m = d.message
        out.push({ kind: 'assistant', turn: turnNo, seq, time,
          text: clipText(contentText(m && m.content), TRACE_TEXT_MAX) })
      } else if (t === 'tool/call') {
        let args = d.arguments
        if (typeof args !== 'string') { try { args = JSON.stringify(d.arguments || d.input || '') } catch (e) { args = '' } }
        out.push({ kind: 'tool-call', turn: turnNo, seq, time,
          tool: String(d.name || d.tool || '工具'), text: clipText(stripShellText(args), TRACE_TEXT_MAX) })
      } else if (t === 'tool/result') {
        const m = d.message
        const errInBlocks = Array.isArray(m && m.content) &&
          m.content.some((b) => b && b.type === 'tool-result' && b.isError)
        out.push({ kind: 'tool-result', turn: turnNo, seq, time,
          tool: String(d.name || d.tool || ''),
          status: (d.isError || errInBlocks) ? '出错' : '已完成',
          text: clipText(contentText(m && m.content), TRACE_TEXT_MAX) })
      } else if (t === 'request/context') {
        let brief = ''
        if (typeof d.summary === 'string') brief = d.summary
        else if (typeof d.text === 'string') brief = d.text
        else { try { brief = JSON.stringify(d) } catch (e) { brief = '' } }
        // 第 100 节 · task-36：d.summary/d.text 是宿主原始文本（没过 contentText），
        // 同一类 ACP 漏点，一并剥掉。
        out.push({ kind: 'context', turn: turnNo, seq, time, text: clipText(stripAcp(brief), TRACE_TEXT_MAX) })
      }
    }
    /* 【I】payload 瘦身（0.4.6）：先按「每轮」留最后 TRACE_PER_TURN 条，再套
     *  全局 TRACE_MAX 保险丝。**不能只在循环里砍尾部** —— 实测总轨迹 8611 条，
     *  全局留 200 条时只剩 turn 27..28，手机端轨迹页往前翻全空。
     *  按轮配额后 28 轮全覆盖（实测 216 条 / 98KB）。 */
    /* 🔴 第 100 节 · task-35 要求①：截断不许静默。
       轨迹是按轮裁剪的（每轮只留 TRACE_PER_TURN 条）。被丢掉的条数按轮记下来，
       给每一轮补一条 kind:'note' 的显式标记（手机端画一行「本轮另有 N 条过程
       已省略」）。没有这一步，用户会以为这一轮就干了这么点事。
       每一轮**至多**一条 note，写在该轮最后一条之后。 */
    const byTurn = new Map()
    for (const e of out) {
      let arr = byTurn.get(e.turn)
      if (!arr) { arr = []; byTurn.set(e.turn, arr) }
      arr.push(e)
    }
    const kept = []
    for (const k of [...byTurn.keys()].sort((a, b) => a - b)) {
      const arr = byTurn.get(k)
      if (arr.length <= TRACE_PER_TURN) { kept.push(...arr); continue }
      // 每轮留「开头 1 条 + 末尾 (TRACE_PER_TURN-1) 条」：开头那条通常是这一轮
      // 的用户提问，纯尾部截断会把提问丢掉，轨迹看起来全是工具调用。
      const head = arr.slice(0, Math.min(1, TRACE_PER_TURN))
      const tail = arr.slice(-Math.max(1, TRACE_PER_TURN - head.length))
      kept.push(...head, ...tail)
      const dropped = arr.length - head.length - tail.length
      if (dropped > 0) {
        kept.push({ kind: 'note', turn: k, seq: 0, time: '',
          text: '本轮另有 ' + dropped + ' 条过程已省略' })
      }
    }
    if (kept.length > TRACE_MAX) {
      const cut = kept.length - TRACE_MAX
      const tail = kept.slice(-TRACE_MAX)
      // 保险丝砍掉的（跨轮）也留一条显式标记在最前面，别静默
      return [{ kind: 'note', turn: (tail[0] && tail[0].turn) || 0, seq: 0, time: '',
        text: '轨迹较早的 ' + cut + ' 条已省略' }].concat(tail)
    }
    return kept
  }

  /**
   * 读单个会话详情 —— 进程内直接调 projections（不走 19387 桥）。
   *
   * 走桥 vs 进程内的实测差别：
   *   走桥：list 硬截断 2000 字符；page 要 AbortSignal 而桥不补 → 读不了
   *   进程内：无截断、signal 是真的（连 page 都能用）
   *
   * 签名：projections(request, signal) —— 第二参是 AbortSignal，不是 paths！
   *   → ctl.projections({sessionId}, AbortSignal.timeout(20000))
   *
   * 🔴 第 96 节 · 冷会话 100%「读会话失败」的真根因（实机 + asar 双证）：
   *   这里原来传的是 `[]`（空数组）—— 上面注释自己写着「signal 是真的」，
   *   代码却塞了个数组当 signal。宿主 JsonlSessionPersistence.open|stat 的
   *   第一行就是 `options?.signal?.throwIfAborted()`；`?.` 只保护 null/undefined，
   *   不保护「属性存在但不是函数」，于是 `[].throwIfAborted()` 抛
   *   TypeError: options.signal.throwIfAborted is not a function，被宿主
   *   projections() 包成 gateway/internal + "Session projection read failed"
   *   ⇒ HTTP 500 ⇒ 手机端整页红字「读会话失败」。
   *   为什么偏偏只有当前会话能读：live 会话走 ctx.sessions 内存注册表、
   *   根本不碰 persistence/signal；其余冷会话全部走 stat/open 而炸。
   *
   * ⚠️ turnOutline 是概要投影：真机实测 30 轮会话最长 response 仅 120 字
   *    （2026-10-03 curl 实锤）——手机上"对面的话只显示一半"就是它切的。
   *    0.3.0 起：宿主有 history 就用完整事件折全文轮，概要只做统计和兜底。
   */
  function readDetail(sid) {
    if (!ctl || typeof ctl.projections !== 'function') {
      return Promise.reject(new Error('这个 DSH 版本没有 sessionController.projections'))
    }
    return Promise.resolve(ctl.projections({ sessionId: sid }, AbortSignal.timeout(20000))).then((raw) => {
      const v = (raw && raw.values) || {}
      const st = v.sessionStats || {}
      const tk = v.tokenUsage || {}
      const cp = v.contextPressure || {}
      const cached = Number(tk.cacheReadTokens) || 0
      const uncached = Number(tk.uncachedInputTokens) || 0
      /* 🔴 第 25 节 · turnOutline 里可能混进 prompt 为空的条目
       * （DSH 侧投影偶尔把「只有 assistant 输出、没有用户输入」的一轮也塞进来，
       *   或投影时机不对拿到半条记录）。原来直接 String(t.prompt || '') 透传，
       *   手机端拿到空串后无条件渲染用户气泡 → **画出一个纯 padding 的空蓝框**
       *   （用户图4 实锤：第 2 轮那个空白蓝气泡就是这个）。
       * → 这里直接把 prompt/response 双空、且无 tools/think 的条目剔掉，
       *   保证 outline 里的每一轮都有实际内容。 */
      /* 🔴 第 100 节 · task-36：这里原来**没过 stripAcp** —— 全文分支的 contentText
         与 foldHistoryToTurns 的 think 都剥了，只有这条概要投影路径漏了。
         实测（会话 dfc0a791…，detail 仅 2579B/6 轮 ⇒ 走的正是这条回退分支）：
           turn 6 seq 4195 response 开头 = '<acp tokens="86" type="text">m01440</acp> Root cause …'
           turn 7 seq 4387 response 开头 = '<acp tokens="836" type="text">m01619</acp> 两项任务 …'
         turnOutline 是宿主投影，里面的 prompt/response 是**原始日志文本**，
         没经过 contentText ⇒ ACP 标记会原样进气泡。stripAcp 对不含 '<acp' 的串
         原样返回，热路径零额外开销。 */
      const turns = (v.turnOutline || [])
        .map((t) => {
          const p = stripShellText(stripAcp(String(t.prompt || '')))
          const r = stripShellText(stripAcp(String(t.response || '')))
          /* 🔴 第 111 节 · task-4 / #73 插件半：概要投影是唯一不过注入过滤的下发口。
             history 全文通道在 foldHistoryToTurns(:885) 与 buildTrace(:1227) 里都过
             isInjectedUserText，只有这条投影直接透传宿主原文 ⇒ DSH 塞给模型的
             <system-reminder>（工作区 AGENTS.md）与附件描述块
             （<path>…</path>/<type>image</type>/<content>… px, … bytes</content>）
             会原样进子会话蓝气泡（真机截图 + 离线素材双证，取证脚本 _t4/live73.mjs）。
             stripShellText 与客户端 Session.ets:4853 stripShell 逐条同口径；
             命中注入前缀的整条 prompt 置空（不删轮，保住 response/统计/图片位），
             客户端 turnPrompts(:4115) 会把空串 trim 掉 ⇒ 不再画空蓝框。 */
          return {
            turn: Number(t.turn) || 0,
            seq: Number(t.seq) || 0,
            /* 🩸 第 134 节 · 问题4：概要投影也带毫秒起点（宿主投影给了就用，
               没给就 0 —— App 侧读到 0 会自然退到旧兜底，不会算错）。 */
            startedMs: Number(t.startedMs) || 0,
            /* 🔴 第 185 节 · task-2：宿主 turnOutline 的 schema 里**只有**
               turn/seq/prompt/response —— 没有 reason，也没有结束时间。所以这条
               通道给**稳定占位**（不是「漏了」）：键一定在，客户端一套取键逻辑通吃，
               不必为两条通道分两套。语义：0 = 本通道不提供结束时间；
               false = 本通道不提供截断信息（App 该按「不知道」处理，别当「没截断」）。 */
            endedMs: 0,
            maxTokens: false,
            prompt: (isInjectedUserData(t) || isInjectedUserText(p)) ? '' : p,
            response: r,
            /* 概要投影没有图片块（图只在 history 事件里），这里给空数组占位，
               客户端不用为「有没有这个字段」分两套逻辑。 */
            images: [],
            // 第 167 节 T1：同 images 一样给空数组占位（概要投影本就没有图片块）
            aimages: [],
            /* 🔴 第 185 节 · task-6：概要投影的 prompts 是**单条**（客户端会退化成
               [prompt] 一个气泡），所以 pimgs 给 [] —— 客户端按同一条兜底逻辑把它
               当成「这一条没图」，不会画出错位的气泡。键一定在（稳定形状）。 */
            pimgs: []
          }
        })
        .filter((t) => t.prompt.length > 0 || t.response.length > 0 ||
          t.images.length > 0 || t.aimages.length > 0)
      const base = {
        ok: true,
        sessionId: sid,
        title: withTitleFallback(v.title, v),
        /* 🔴 批次 H · task-6（#A7）：详情页也要带团队投影（同一个 v.agentTeam）。 */
        team: normTeam(v.agentTeam),
        asOfSeq: Number(raw && raw.asOfSeq) || 0,
        running: false,
        turns: turns,
        turnCount: turns.length,
        /* 第 186 节 · task-C：会话级任务清单。**键一定在**（与 endedMs/maxTokens/pimgs
           同风格的稳定占位）—— App 侧一套取键逻辑通吃，取不到事件的回退分支也一样是 []。
           真值在下面的全文通道里从 events 投影（projectTodos），这里只是缺省。 */
        todos: [],
        stats: {
          turns: Number(st.turns) || turns.length,
          steps: Number(st.steps) || 0,
          llmMs: Number(st.llmMs) || 0,
          toolMs: Number(st.toolMs) || 0
        },
        token: {
          input: uncached,
          output: Number(tk.outputTokens) || 0,
          cacheRead: cached,
          hitRate: (cached + uncached) > 0 ? Math.round(cached * 100 / (cached + uncached)) : 0
        },
        context: {
          used: Number(cp.pressureTokens) || 0,
          window: Number(cp.contextWindow) || 0,
          percent: cp.contextWindow
            ? Math.round((Number(cp.pressureTokens) || 0) * 1000 / cp.contextWindow) / 10
            : 0
        }
      }
      // 实时生成状态（0.3.2/0.3.3）：这一轮还在跑的内容。
      // 优先直扫权威 Session.log（不依赖事件总线），订阅缓存做兜底
      const lvLog = liveFromLog(sid)
      let lv = lvLog || live.get(sid) || null
      /* 🔴 0.4.9 · 事件总线缓存会陈留：实测 {text:0, think:0, tools:1} 能挂
         几十分钟不变（日志窗口那边这一轮早就结束了）。原来的后果：
         手机端 liveGenerating() 恒 true ⇒ 一直显示空白「生成中」卡，
         把已经从 history 落盘的正文整个挡住；running 判据也跟着忙转不停。
         规则：liveFromLog（权威日志窗口）永远可信；事件总线缓存只有在
         确实带着正文或思考时才采信。 */
      /* 第 186 节 · task-A：acts（子调用序列）也算「有内容」，与 tools 同级 ——
         否则只收到 dispatch、正文还没落盘时 acts 会被这条陈留防护整个吃掉。 */
      if (lv && !lvLog && !lv.text && !lv.think && !(lv.acts || []).length) lv = null
      /* 🔴 0.4.8：running 以前写死 false（@676），手机端拿不到「在生成」
         标志，只能猜 → 轮询被提前掐断。现在按 log 尾部窗口写真值，
         再用「末轮有 prompt 没 response」兜底。 */
      base.running = !!(lvLog && lvLog.busy)
      if (!base.running && turns.length) {
        const lastT = turns[turns.length - 1]
        if (String(lastT.prompt).length > 0 && String(lastT.response).trim().length === 0) {
          base.running = true
        }
      }
      /* 第 186 节 · task-C（live 通路，可选但做了）：日志窗口里若已经写过 todo/write，
         它就是最新的清单。只当**兜底**用 —— 全文通道折到事件流时以那边为准（那边是
         整段会话的权威末条，窗口可能只截了最近一轮）。App 不读 live.todos，这里只喂
         detail 顶层同一个 todos 字段，保证「拿不到 events」时也不至于空着。 */
      base.todos = (lvLog && Array.isArray(lvLog.todos)) ? lvLog.todos : []
      /* 第 186 节 · task-A：acts 也算「这一轮有活动」，否则纯子调用窗口（正文还没
         落盘）会让 act 序列整个下发不出去。 */
      if (lv && (lv.text || lv.think || lv.tools.length || (lv.acts || []).length)) {
        /* 0.4.10 · 步骤流：tools 全给（已在 trimLiveTools 里限到 LIVE_TOOLS_KEEP），
           steps/thinks 一起下发 —— 手机端「生成中」卡照 steps 顺序画
           「✳ 思考 / 🗎 读取 · 路径」行，而不是只糊一串工具卡。 */
        base.live = {
          /* 第 111 节 · task-4/#73：live 出口再兜一道壳剥离（tools 的 detail/result
             已在装配点剥过，这里覆盖 think/text/thinks 等其余正文位；幂等）。 */
          think: stripShellText(lv.think || ''),
          text: stripShellText(lv.text || ''),
          thinks: (lv.thinks || []).map((s) => stripShellText(s)),
          steps: lv.steps || [],
          tools: (lv.tools || []).map((tl) => (tl && (tl.detail || tl.result)
            ? Object.assign({}, tl, {
                detail: stripShellText(tl.detail || ''),
                result: stripShellText(tl.result || '')
              })
            : tl)),
          /* 🩸 第 134 节 · 问题4：本轮起点毫秒戳（App Session.ets liveStartOf 用它，
             取代「进页面那一刻」的兜底）。旧客户端多收一个数不吃亏。 */
          startedMs: Number(lv.startedMs) || 0,
          toolCount: (lv.tools || []).length,
          /* 第 100 节 · 生成中的图片，形状与 turn.images 完全一致
             （客户端 task-24/25 共用一套渲染）。 */
          images: (lv.images || []).map((id) => attachments.infoOf(id)).filter(Boolean),
          /* 第 167 节 T1：生成中的助手图走 aimages，客户端在「生成中」卡里画，
             与用户气泡的 images 不再共用同一个数组。 */
          aimages: (lv.aimages || []).map((id) => attachments.infoOf(id)).filter(Boolean),
          /* 🔴 第 186 节 · task-A：子调用序列（手机端「生成中」卡的标题就用它 ——
             用户 m01047 的「永远停在正在运行代码」）。形状原样 { name, state, detail, at }，
             detail 与 tools 同款过一道 stripShellText；live 没这个字段（老宿主）⇒ []。 */
          acts: (lv.acts || []).map((a) => ({
            name: String((a && a.name) || ''),
            state: String((a && a.state) || 'done'),
            detail: stripShellText((a && a.detail) || ''),
            at: Number(a && a.at) || 0
          }))
        }
      }
      // 全文升级（0.3.0）：宿主能拿到完整事件流就折完整对话轮（全文）；
      // 拿不到或调用失败 → 退回 turnOutline 概要（每轮 ~120 字预览）
      // 0.3.1：顺带从同一份 events 产出轨迹时间线（trace）
      //
      // 🔴 0.4.6 · 手机端「回复只显示一部分 + 省略号、过程步骤和思考全没了」的真根因：
      //   0.3.0~0.4.5 这里判的是 `typeof ctl.history === 'function'`，但
      //   @deepseek-ai/dsh-api-session-controller 里 `history` 是**实例字段**
      //   （`this.history = new SessionHistoryController(...)`，不是 @Remote 方法），
      //   所以这个条件**恒为 false** —— 「取全文」分支从来没进过，
      //   每次都静默走下面 `return Object.assign({}, base, { trace: [] })`，
      //   手机上拿到的永远是 120 字概要投影。连 :637 的退回日志都没机会打。
      //
      //   现存可用的取数入口是 `ctl.page(request, signal)`（宿主内部转发给
      //   `this.history.page(...)`），返回 `{ records, hasMore }`，
      //   records 每项 `{ type:'event', event }` —— 正是 :311 `unwrapEvent`
      //   要的形状，下游 foldHistoryToTurns / buildTrace **一行都不用改**。
      //   请求体必须带 `address`（validatePageRequest 校验），
      //   throughSeq 用 projections 给的 asOfSeq（= 日志末条 seq）；
      //   传 -1 会得到空页，不能用。
      //   0.4.7 · I 项复定标（第 80 节 _sim80.js 按 paginate 语义实测，当时代码
      //   里写的是 600）：maxMessages 计的是 user/message + assistant/message 条数，
      //   不是轮数。素材 2946 条 message / 32 轮实测：
      //     600→6 轮 43KB ｜ 1000→10 轮 82KB ｜ 1400→15 轮 114KB
      //     2000→25 轮 182KB ｜ 2400→31 轮 219KB ｜ 3000→32 轮全量 260KB
      //   ⇒ 600 只回 6 轮（手机端往前翻就空），提到 3000 才全量；260KB 加轨迹约
      //   370KB，仍在手机端 5s 超时线内（改前 3020 张卡全带正文是 2064KB）。
      const throughSeq = Number(raw && raw.asOfSeq) || 0
      /* 第 100 节 · task-35：上限提到模块级 MAX_MESSAGES（env 可覆盖，默认 3200）。
         别再写回 600 —— 实测那只有 6~7 轮（见 MAX_MESSAGES 处的实测表）。 */
      const PAGE_MAX_MESSAGES = MAX_MESSAGES
      const canPage = ctl && typeof ctl.page === 'function'
      const canHistory = ctl && typeof ctl.history === 'function'
      /* 🔴 第 109 节 · task-33 · 子智能体会话的全文通道。
         原来这里写死 `address:{kind:'session',sessionId:sid}` —— 命中宿主
         validateAddress 的第一条分支：header.origin === 'subagent' 时直接抛
         `session/agent-busy`「subagent Sessions require their durable parent address」
         （dsh-client-ui-chat/lib/client.js:10288-10289，逐字见 subagentAddressOf 的注释）。
         后果是**子智能体会话永远退回 turnOutline 概要投影**（每轮只有 120 字预览、images 恒空）——
         task-8 的助手侧图片、task-21 的 failure 卡片在子会话上因此都不可达。
         现在按宿主契约换成 kind:'subagent' 的 durable parent address；
         非子会话（subagentAddressOf 给 null）保持原来的 kind:'session' 一字不变。
         parent 取不到时宁可照旧走 kind:'session' 让宿主照原样拒绝、退回概要，
         也不编一个假 parent —— 假 parent 只会换来 subagent/unauthorized。
         另外**故意不做** throughSeq 兜底重试：宿主 paginate（dsh-client-ui-chat/lib/client.js:10313）
         是 `const end = SessionLogOffset(Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1))`，
         throughSeq:-1 ⇒ end=0 ⇒ 必得空页；重试只会把「折出 0 轮」换成「0 条事件」，
         落点仍是同一份概要 —— 加了也白加，徒增一条没人测的分支。 */
      if (canPage || canHistory) {
        let usedSubAddress = false   // 仅供退回日志区分「子会话地址仍被拒」
        return Promise.resolve()
          .then(() => subagentAddressOf(sid))
          .then((subAddr) => {
            usedSubAddress = !!subAddr
            if (canPage) {
              const address = subAddr || { kind: 'session', sessionId: sid }
              return ctl.page({
                address: address,
                throughSeq: throughSeq,
                maxMessages: PAGE_MAX_MESSAGES
              }, AbortSignal.timeout(20000))
            }
            return ctl.history({ sessionId: sid, maxMessages: PAGE_MAX_MESSAGES }, AbortSignal.timeout(20000))
          })
          .then((h) => {
            // 0.3.4：page/history 返回形状宽容提取（{records} / {events} / {value:{events}} / 数组）
            const events = extractEvents(h)
            const fullTurns = stripAcpInTurns(foldHistoryToTurns(events))
            /* 第 186 节 · task-C：todos 与全文轮同一份 events（不额外读盘/请求）。
               即便一条轮都没折出来（下面两条 return），todos 也照样带上 ——
               「有任务清单但正文没落盘」是真实存在的组合。 */
            const todos = projectTodos(events)
            /* 第 191 节 · 用户 m00001：交付文件卡（presented）来自**会话日志**，
               与上面这份 page/history 事件窗口不是同一份 —— 单独扫一遍。只在确有
               presented 事件时才产出数据，没有就是空 Map（下面挂卡时给 null）。 */
            const deliver = collectDeliveryFiles(sid)
            /* 🩸 第 198 节：宿主把改动摘要挂在**轮末**那条 workspace/changes 事件自己的
               seq 上（不是轮首 seq），所以先从同一本会话日志里把这张对照表捞出来，
               再交给 attachDetailCards 按 seq 区间归轮。扫不到就是空数组 ⇒ 退回老行为。 */
            const changeSeqs = collectChangeSeqs(sid)
            if (fullTurns.length) {
              const out = Object.assign({}, base, {
                /* 第 191 节：就地给每轮挂 changes / files（fullTurns 是刚折出来的新对象，
                   不共享缓存）。attachDetailCards 内部全程 try/catch，拿不到就是 null。 */
                turns: attachDetailCards(fullTurns, deliver, sid, changeSeqs),
                turnCount: fullTurns.length,
                // 事件窗口里没有 todo/write 时，别把 live 窗口兜到的那条盖掉
                todos: todos.length ? todos : base.todos,
                trace: buildTrace(events),
                full: true
              })
              /* 🔴 第211节 · task-2：live 窗口与末轮是同一段（见 liveFoldedInLastTurn 注释）
                 ⇒ 不下发 base.live，App 的兜底 live 卡（liveCardFallback）随之关闭，
                 同一屏只剩 turnBlock 里那一张「已完成本轮」卡。 */
              if (liveFoldedInLastTurn(lvLog, fullTurns)) delete out.live
              return out
            }
            // 0.3.4 诊断：events 非空但折出 0 轮 —— 打形状日志便于真机对账
            if (events.length) {
              const first = unwrapEvent(events[0])
              log('[detail] history ' + events.length + ' 条事件折出 0 轮' +
                '（首事件 type=' + ((first && first.type) || 'undefined') +
                ' keys=' + Object.keys(events[0] || {}).join(',') + '）')
            } else {
              log('[detail] 全文通道返回 0 条事件（' + (canPage ? 'page' : 'history') +
                ' throughSeq=' + throughSeq + ' keys=' +
                Object.keys(h || {}).join(',') + '）')
            }
            return Object.assign({}, base, {
              /* 第 191 节：一条轮都没折出来时也把两张卡的键补上（值 null），
                 App 侧一套取键逻辑通吃。 */
              turns: attachDetailCards(base.turns, deliver, sid, changeSeqs),
              todos: todos.length ? todos : base.todos,
              trace: []
            })
          })
          .catch((e) => {
            log('[detail] history 退回概要' + (usedSubAddress ? '（子会话地址）' : '') + ': ' + ((e && e.message) || e))
            // 第 186 节 · task-C：拿不到事件流 ⇒ todos 由 base 兜成 []（键仍在）
            /* 第 191 节：事件流拿不到 ⇒ 交付卡无从谈起（files=null）；
               changes 是宿主服务，与事件流无关，照样挂一次。 */
            return Object.assign({}, base, {
              turns: attachDetailCards(base.turns, null, sid, collectChangeSeqs(sid)),
              trace: []
            })
          })
      }
      // 第 186 节 · task-C：没有 page/history 能力（老宿主）⇒ base.todos = [] 兜住
      // 第 191 节：同上，changes 照挂（没有 workspaceChanges 服务就是 null），
      // 交付卡 files 保持 null（这条通道没有事件流）。
      return Object.assign({}, base, {
        turns: attachDetailCards(base.turns, null, sid, collectChangeSeqs(sid)),
        trace: []
      })
    }).catch((e) => {
      /* 🔴 第 96 节 · 降级安全网：projections 再抖也不能让整个 detail 变 500
         （500 在手机端 = 整页红字「读会话失败」，用户直接没东西看）。
         退回「只有骨架 + 空轮次」，手机端至少能挂住页面。 */
      log('[detail] projections 失败，退回空骨架: ' + ((e && e.message) || e))
      return {
        ok: true, sessionId: sid, title: '', asOfSeq: 0, running: false,
        turns: [], turnCount: 0, degraded: true,
        stats: { turns: 0, steps: 0, llmMs: 0, toolMs: 0 },
        token: { input: 0, output: 0, cacheRead: 0, hitRate: 0 },
        context: { used: 0, window: 0, percent: 0 },
        trace: [], error: String((e && e.message) || e)
      }
    })
  }

  /** 停止会话 —— 进程内直接调 */
  function cancelSession(sid) {
    if (!ctl || typeof ctl.cancel !== 'function') {
      return Promise.reject(new Error('这个 DSH 版本没有 sessionController.cancel'))
    }
    return Promise.resolve(ctl.cancel({ sessionId: sid })).then((r) => {
      let raw = r
      if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch (e) { raw = null } }
      return { ok: !!(raw && raw.accepted), accepted: !!(raw && raw.accepted) }
    })
  }

  // ---- 云链路（第 134 节）----
  /* 公网短 ID / VIP 到期 / 体验码兑换。storePath 走默认 ~/.dsh/dsh-console-cloud.json
     （模块内自建目录、生成并持久化 nodeId）。config.cloud 是面板配置里的可选项，
     没有就不传 —— createCloudLink 自己带默认基址 https://gaoshou25.cn/api/cloud。 */
  /* 🔴 第215节 · 修法3 缺口补丁：新用户**首次**启动时 ~/.dsh/dsh-console-tunnel.auto.json 还不存在
     （它是 register 之后才写出来的），下面那次 startTunnel 于是一直走到 tunnel.mjs 「没有配置文件 ⇒ 关闭」，
     之后本次 register 就算把文件写好了，也没有任何人再拉起 frpc ⇒ 用户必须重启一次宿主才有公网。
     这两个小函数把「拉起隧道」收成一个可重复调用的入口：
       · ensureTunnel()：只在隧道当前**没起来**（disabled / error）时才重新 startTunnel()，
         已连上/正在连的一律原样返回 —— 绝不打断一条好着的隧道；
       · bootTunnel() ：真正的那一次 startTunnel（全文件只此一处 spawn 入口，符合 tunnel.mjs 头部契约）。
     下面的 createCloudLink 通过 onTunnel 钩子接上它（自动文件内容变化时才回调，见 cloud-link.mjs）。 */
  const bootTunnel = () => {
    try {
      const st = startTunnel({ localPort: Number(config.port) || 8899, log: log })
      log('[tunnel] 启动快照 ' + JSON.stringify(st))
      return st
    } catch (e) {
      log('[tunnel] 拉起失败（不影响其它功能）：' + ((e && e.message) || e))
      return null
    }
  }
  const ensureTunnel = () => {
    try {
      const st = tunnelStatus()
      if (st && st.phase && st.phase !== 'disabled' && st.phase !== 'error') return st
    } catch (e) { /* 读不到状态就当没起来，继续走 bootTunnel */ }
    return bootTunnel()
  }

  let cloudLink = null
  try {
    cloudLink = createCloudLink({ log: log, config: (config && config.cloud) || {}, onTunnel: ensureTunnel })
    log('[cloud] 云链路已就绪 nodeId=' + String(cloudLink && cloudLink.nodeId || '').slice(0, 8) + '…')
  } catch (e) {
    cloudLink = null
    log('[cloud] 初始化失败（不影响其它功能）：' + ((e && e.message) || e))
  }

  /* 🔴 第209节 · task-1：面板「检测升级」引擎（网络 + 子进程全在 dsh-console-cloud.mjs）。
     放 apply() 作用域里，日志走同一个 log()；lan 的 getInfo() 也读它的快照。
     官方 dsh-market 更新 API 对本插件无效（link 装法 source=linked / latestVersion=null），
     所以版本号自己问 npm registry。 */
  const cloudPlugin = createCloudPlugin({
    logger: log,
    version: PLUGIN_VERSION,
    metaUrl: import.meta.url,
    /* 面板点「检测更新」后，把 index.js 的模块级缓存一起对齐 ——
       /info 与 /state 两条通路读同一份号，不会一个说有新版、一个说没有。 */
    onLatest: (v) => { latestVersion = v; latestAt = Date.now() }
  })

  // ---- 局域网服务 ----
  const lan = startLanServer({
    port: Number(config.port) || 8899,
    // 默认锁死 8899：6 位码那条路把端口写死了，
    // 顺延会让手机「自动扫局域网找电脑」直接失败。
    // 真要换端口得显式打开，并让手机端同步改。
    allowShift: config.allowShiftPort === true,
    getToken: () => token,
    /* 🔴 面板「检测升级」卡（第210节）：只给宿主面板那条路由
       （/api/dsh-console/state）用的升级快照。
       **绝不进 /info** —— /info 是公网可读的，插件根绝对路径、任务日志
       这类本地信息只许走带访问码的面板通路。 */
    getUpdateState: () => cloudPlugin.updateState(),
    getInfo: () => {
      /* 🔴 第 110 节 · task-17：原来这里只调 probePreset() 吃一次性缓存
         （presetProbe.probed），用户切完预设 /info 永远返旧值。改成每次现读。 */
      const presetNow = readPresetNow()
      /* 🔴 第202节 · task-21：只发不 await —— registry 慢或挂掉都不许拖住 /info。 */
      refreshLatestVersion()
      return {
        name: nodeName,
        nodeId: 'dsh-console',
        host: os.hostname(),
        dshOk: dshOk,
        dshError: dshError,
        version: PLUGIN_VERSION,
        /* 🔴 第202节 · task-21：npm 上 dsh-console-plugin 的最新版号；
           没拿到就是空串（App 落「未知」），绝不让网络失败影响 /info。 */
        latestVersion: latestVersion,
        /* 🔴 第209节 · task-1：面板「一键升级」要的额外状态 —— 本插件是否装在
           源码目录（link 装法）、插件根绝对路径、当时写日志的「已在线上跑着」的号。
           全是只读展示字段，跟鉴权无关；老客户端读不到这些键也不报错。 */
        /* ⚠️ 只放「无敏感信息」的两个布尔/枚举：/info 是公网可读的（带访问码），
           插件根目录绝对路径、升级任务详情这类只走宿主面板 /state，绝不进 /info。 */
        installKind: (cloudPlugin && typeof cloudPlugin.installKind === 'function') ? cloudPlugin.installKind() : '',
        installDev: !!(cloudPlugin && typeof cloudPlugin.installDev === 'function' && cloudPlugin.installDev()),
        /* 🔴 0.4.3 · 当前 Agent 预设（只读展示用；探测失败给空串，前端显示未知） */
        agentPreset: presetNow,
        agentPresetAvailable: presetProbe.available
      }
    },
    listSessions: () => readSessions(),
    runCommand: (op, payload) => runCommand(op, payload),
    /* 第 100 节 · 图片字节（task-22）：手机端要的是原图，走这条 LAN 通道拉。
       只认登记表里有的 id（= 宿主 ImageAttachmentRef.attachmentId，形如
       sha256:<64hex>），字节由宿主 attachments 服务读 —— 插件不自拼磁盘路径。
       拿不到就返回 null，由 lan-server 翻成 404 no-such-attachment。 */
    attachmentOf: async (id) => {
      const info = attachments.infoOf(id)
      if (!info) return null
      const data = await attachments.readImageOf(id)
      if (!data || !data.length) return null
      return { mime: info.mime || '', name: info.name || '', data: data, bytes: data.length }
    },
    // 鸿蒙客户端的 /mp/*（0.5.0）。构造在下面 —— 它要读 lan 的配对码，
    // 而 lan 的 options 又要把它传下去，所以这里先留一个待填的引用。
    mp: null,
    /* 🔴 第 134 节：/cloud/status /cloud/bind /cloud/redeem 与 /info.cloud 的数据源。
       为 null 时 lan-server 一律降级（三路由 503、/info.cloud=null），绝不 500。 */
    cloud: cloudLink,
    log: log
  })

  /* 🔴 第 122 节 · task-2（#21-D）· 插件自己拉起隧道（frpc），面板显示隧道状态。
     用户原话（m00001）：「插件自己拉起隧道、面板显示隧道状态，但你这一版不做多用户、不做计费。」
     行为边界（tunnel.mjs 里实现，这里只管接线）：
       - ~/.dsh/dsh-console-tunnel.json 不存在 ⇒ 整条功能静默关闭（别人机器上永远走这条）；
       - 配了 enabled:true 才拉起，且拉起前先禁掉开机自启计划任务 dsh-frpc 独占 remotePort；
       - 测试环境（config.port===0 / DSH_TUNNEL=0 / node --test）自动短路，绝不 spawn。
     传的是**函数**不是快照：frpc 的 phase 在没有请求来的时候自己会变。
     启动顺序放在 lan 之后（面板要读它），且不 await、不影响插件启动耗时。 */
  try { lan.setTunnel(tunnelStatus) } catch (e) { /* 老版本 lan-server 没有 setTunnel，忽略 */ }
  try { bootTunnel() } catch (e) { /* bootTunnel 自己已兜错，这里只防御它不存在的老宿主 */ }

  // ---- 鸿蒙客户端的 /mp/* 支持（0.5.0）----
  // 配对复用面板那 6 位码：同一个码换 mp_device Cookie，不给用户第二个码
  // （两个码并存必然记错）。未配对 401，配了不认识则 403 forbidden ——
  // 客户端靠这个 code 区分「插件版本过旧」和「本设备没配对」。
  //
  // 必须在 lan 之后构造：它要 peekPairCode()，而那个码封在 lan-server 里。
  const mp = attachMp(ctx, {
    log,
    config: config.mp || {},
    isPairCode: (code) => code === lan.peekPairCode(),
    /* 🔴 第191节 · 用户 m00174：手机连上 WS 打字机后就不再打 HTTP 探活了 ——
       两条链路灯既没人续期、App 被划掉后也没人熄灯（要干等 2 分钟 TTL）。
       把 WS 的生命周期（连接/心跳/断开）转给 lan-server：它在场就续期，
       这一链上再没有活跃流就立刻熄灯。 */
    onStream: (req, mode) => lan.noteStreamLink(req, mode)
  })
  lan.setMp({
    branch: mp.branch,
    /* 🔴 0.4.3 · 实时流 WS upgrade（真打字机服务端）。之前传 null ——
       lan-server 的 upgrade 监听形同虚设，WS 建立不起来。 */
    onUpgrade: (typeof mp.onUpgrade === 'function') ? mp.onUpgrade : null,
    /* 🔴 0.4.3 · 已配对设备免输码换 Cookie（见 lan-server /mp-cookie） */
    /* 🔴 第170节 · Bug B：把 about（手机自报的 model/name/uid）**穿透这一层**。
       以前这里的闭包只吃 code，lan-server 即使解析出身份也会被吃掉 ⇒ 台数虚高。 */
    issueForCode: (code, about) => (typeof mp.issueForCode === 'function' ? mp.issueForCode(code, about) : ''),
    /* 🔴 0.4.4 · 免码签发（不看 15 分钟面板码）—— 手机自愈重连用，见 mp-support.issueDevice */
    /* 🔴 第170节 · Bug B（主修点）：同上，about 必须透传，issueDevice 才拿得到 uid。 */
    issueDevice: (about) => (typeof mp.issueDevice === 'function' ? mp.issueDevice(about) : ''),
    /* 🔴 批次 H · task-6（#A3）：已配对设备登记表（机型 / 最近活动）。
       panelData 靠它下发「多设备在线名单」；lan-server 只读 list()，
       写只有 accept 与 gate 两条路。表里绝不含 secret（见 createDeviceStore.list）。 */
    store: mp.store
  })

  /**
   * 面板能下的几条指令。
   *
   * ⚠️ 发消息走 sessionController.prompt()，不是 send() —— sessionController
   *    没有 send 方法，prompt 是它唯一的消息入口：
   *      prompt(request: SessionPromptRequest, signal): Promise<SessionPromptValue>
   *    SessionPromptRequest { requestId, sessionId, mode: 'queue'|'steer', content: [{type:'text',text}] }
   */
  /* 🔴 第 97 节 · Agent 预设服务取用（presetCatalog / selectPreset 共用）。
   * asar 实锤：@deepseek-ai/dsh-agent-preset-registry 的类构造是
   *   super(ctx, 'agentPresets')
   * 所以服务名是 'agentPresets'；profile 里的 'agent-preset-registry' 只是
   * settings 命名空间名，作为老名字兜底。服务可能懒注册 → 每次现取，取不到 null。
   * 方法面（asar:288561-288844 / 289533-289551）：
   *   list() → [{id,name?,description?,order?,broken?}]
   *   remoteExportList() → {presets:[{...row, isDefault}]}   ← @Remote('list')
   *   select(agent: Agent, presetId: string) → committed id（scope 是 agent，wire 'agentId'）
   *   readDocument(id) → {agentPreset,content,name?,description?}  ← @Remote('read')
   */
  function agentPresetsService() {
    try {
      if (!ctx || typeof ctx.get !== 'function') return null
      return ctx.get('agentPresets') || ctx.get('agent-preset-registry') || null
    } catch (e) { return null }
  }

  /** settings 命名空间 'agent-preset-registry' 的 selectedDefault（官方前端同路）。 */
  function presetSettingsValue() {
    try {
      const s = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : null
      if (!s) return null
      if (typeof s.namespace === 'function') return s.namespace('agent-preset-registry')
      if (s['agent-preset-registry'] !== undefined) return s['agent-preset-registry']
      return null
    } catch (e) { return null }
  }

  /**
   * 当前生效预设 id。取值顺序（都能拿不到就一路往下退）：
   *   ① 老服务属性 current / selected / selectedDefault（历史写法，通常都不存在）
   *   ② svc.defaultId —— asar 实锤 getter：`config.selectedDefault.get() ?? config.default`
   *   ③ svc.config.selectedDefault（volatile settings 字段，有 .get() 就调）
   *   ④ svc.config.default
   *   ⑤ settings 命名空间 'agent-preset-registry' 的 selectedDefault
   * 全部失败回空串（客户端看到「未知」而不是崩）。
   * 🔴 批次F · task-25 ③：加 ②③④ —— 实测 [preset-probe] 恒打 current=""，
   *    根因就是老写法只找服务上的 current/selected/selectedDefault，一个都不在。
   */
  function presetCurrentId(svc) {
    const norm = (raw) => {
      if (raw == null) return ''
      if (typeof raw === 'function') return ''            // 别把方法名 String 成正文
      if (typeof raw === 'string') return raw
      if (typeof raw === 'number') return String(raw)
      if (typeof raw === 'object') return String(raw.id ?? raw.name ?? '')
      return ''
    }
    try {
      const raw = svc ? (svc.current ?? svc.selected) : null
      const v = norm(raw)
      if (v) return v
    } catch (e) { /* 继续往下试 */ }
    try {
      const v = norm(svc ? svc.defaultId : null)          // asar: get defaultId()
      if (v) return v
    } catch (e) { /* 继续往下试 */ }
    try {
      const cfg = svc ? svc.config : null
      if (cfg) {
        const f = cfg.selectedDefault
        const v = norm(f && typeof f.get === 'function' ? f.get() : f)
        if (v) return v
        const d = norm(cfg.default)
        if (d) return d
      }
    } catch (e) { /* 继续往下试 */ }
    try {
      const ns = presetSettingsValue()
      const v = norm(ns ? ns.selectedDefault : null)
      if (v) return v
    } catch (e) { /* 忽略 */ }
    return ''
  }

  /** locale 值归一：string 直接用，{en,zh,…} 优先 zh/cn 再 en 再第一个非空。 */
  function pickLocale(v) {
    if (v == null) return ''
    if (typeof v === 'string') return v
    if (typeof v !== 'object') return String(v)
    const order = ['zh', 'zh-cn', 'zh-CN', 'zh_CN', 'cn', 'en']
    for (const k of order) {
      const x = v[k]
      if (typeof x === 'string' && x) return x
    }
    for (const k of Object.keys(v)) {
      const x = v[k]
      if (typeof x === 'string' && x) return x
    }
    return ''
  }

  /** 宿主预设行 → 面板冻结形状 {id,name,description,isDefault,broken}。 */
  function presetRows(raw, currentId) {
    const rows = Array.isArray(raw) ? raw
      : (raw && Array.isArray(raw.presets)) ? raw.presets
      : (raw && Array.isArray(raw.items)) ? raw.items : []
    return rows.filter((r) => r && (r.id || r.name)).map((r) => {
      const id = String(r.id ?? '')
      return {
        id,
        name: String(r.name ?? id),
        description: String(r.description ?? ''),
        isDefault: r.isDefault === undefined ? (currentId !== '' && id === currentId) : !!r.isDefault,
        broken: r.broken === undefined || r.broken === null ? '' : String(r.broken),
      }
    })
  }

  /* 🔴 第 100 节 · 置顶会话持久化（task-28 A 段 / 问题清单 #36）。
   *
   * 现状（task-14 只读排查）：置顶只存在于 /mp/api 通道，而且 mp-support.mjs:418 的
   *   createDispatcher(..., { pins: new Set() }) 是**纯内存 Set** —— 宿主一重启就丢。
   *   /cmd 的 op 名单里根本没有 pin/pins，手机抽屉（走 /cmd）压根没有置顶能力。
   *
   * 正路 = **复用宿主自己的 durable pin**（任务要求第 3 条「优先复用」，已实证）：
   *   asar@66417365  `class WorkspaceRegistry extends Service { constructor(ctx) { super(ctx, "workspaceRegistry"); } }`
   *                   —— 就是本文件 :159 已经拿到的 reg。
   *   asar@66468936  `get pinnedSessionIds() { return this.requireState().pinnedSessionIds }`
   *                   —— 「Session ids in pin order (most recently pinned first)」。
   *   asar@66468936  `pinSession(sessionId) { return this.enqueueOperation(async () => {
   *                     if (this.requireState().pinnedSessionIds.includes(sessionId)) return;
   *                     if (archivedSessionIds.includes(sessionId)) throw new WorkspaceArchivedSessionPinError(sessionId);
   *                     if (!await this.sessionKnown(sessionId)) throw new WorkspaceUnknownSessionError(sessionId, "pin");
   *                     await this.setState({ ...state, pinnedSessionIds: [sessionId, ...state.pinnedSessionIds] }) }) }`
   *                   —— 「Pin one session durably, prepending it to the registry-global pin set」，
   *                     `await this.setState(...)` 就是落盘（storageDomain/workspaceDomainSpec，
   *                     asar@66417365 的 [Service.init] 里 this.global = domain.global）。
   *   asar@17232725  用户面包装：`async pinSession(request) { await ctx.workspaceRegistry.pinSession(request.sessionId); return { pinnedSessionIds: [...ctx.workspaceRegistry.pinnedSessionIds] } }`
   *   语义还正好对上：`pinSession` **幂等**（已置顶直接 return，不重排）、`unpinSession` 对
   *   未置顶的 id **不报错**（注释原文「An id that is not pinned is not an error: the call is idempotent」）、
   *   两侧都要求 session 必须存在（不存在抛 WorkspaceUnknownSessionError）。
   *
   * 兜底 = 插件自己的文件（宿主 pin API 在旧版本可能没有；或 reg 拿不到）。
   *   落点：~/.dsh/dsh-console-pins.json（与 dsh-console-token.json 同目录、同样的
   *   0600 权限、同样的「读坏就重来」策略）。格式：{"pinned":["<sessionId>", ...]}，
   *   数组顺序 = 置顶顺序（最新在前，与宿主 pinnedSessionIds 一致）。
   *   ⚠️ 两条路**不混用**：宿主可用就整条走宿主（手机置顶 = DSH 桌面也置顶，语义统一）；
   *   只有宿主不可用时才落文件，且读也读同一个来源，不会一半在宿主一半在文件。
   */
  const pinFile = path.join(os.homedir(), '.dsh', 'dsh-console-pins.json')

  function readPinFile() {
    try {
      if (!fs.existsSync(pinFile)) return []
      const j = JSON.parse(fs.readFileSync(pinFile, 'utf8'))
      const arr = j && Array.isArray(j.pinned) ? j.pinned : []
      return arr.filter((x) => typeof x === 'string' && x)
    } catch (e) {
      log('[pins] 读 ' + pinFile + ' 失败，当作空置顶: ' + ((e && e.message) || e))
      return []
    }
  }

  function writePinFile(ids) {
    try {
      fs.mkdirSync(path.dirname(pinFile), { recursive: true })
      fs.writeFileSync(pinFile, JSON.stringify({ pinned: ids }, null, 2), { mode: 0o600 })
      return true
    } catch (e) {
      log('[pins] 写 ' + pinFile + ' 失败: ' + ((e && e.message) || e))
      return false
    }
  }

  /** 宿主的置顶集（拿不到返回 null = 这条路不可用，调用方走文件兜底）。 */
  function hostPins() {
    try {
      if (!reg) return null
      const list = reg.pinnedSessionIds
      return Array.isArray(list) ? list.map((x) => String(x)) : null
    } catch (e) {
      return null
    }
  }

  /**
   * 在宿主上置顶/取消置顶。返回置顶数组；宿主这条路不可用返回 null（调用方走文件）。
   * 宿主明确报错（比如会话不存在）就往上抛 —— 静默吞掉会让客户端误显示成功。
   */
  async function pinOnHost(sid, want) {
    if (!reg) return null
    const fn = want ? reg.pinSession : reg.unpinSession
    if (typeof fn !== 'function') return null
    try {
      await fn.call(reg, sid)
    } catch (e) {
      const msg = (e && e.message) || String(e)
      log('[pins] 宿主 ' + (want ? 'pinSession' : 'unpinSession') + '(' + sid + ') 失败: ' + msg)
      throw new Error('置顶失败：' + msg)
    }
    const after = hostPins()
    if (after === null) throw new Error('置顶后读不到宿主的置顶集（workspaceRegistry.pinnedSessionIds 不可用）')
    return after
  }

  /* 🔴 第 113 节 · task-5：取消归档入口（与 :261 reg 同族，但走 workspaceController）。
   * 与宿主 asar 里 @deepseek-ai/dsh-api-workspace-controller 的两个入口对齐：
   *   ① WorkspaceRegistry.unarchiveSession(sessionId) —— durable，requireState 里
   *      archivedSessionIds 过滤掉该 id（asar 实锤，6842xxxx 段）。
   *   ② workspaceController 客户端 unarchiveSession(sessionId) → remote
   *      workspace/unarchiveSession（params object({ sessionId })，result
   *      object({ archivedSessionIds:array(string) })）。
   * 取服务的顺序也是照这个来：sessionController（如果哪天真加了）→
   * workspaceRegistry → workspaceController。都取不到返回 null，调用方抛中文错误。
   * 注意：ctx.get 是**当次调用**才取（服务可能晚于 apply 就绪），别在闭包外存死。 */
  async function unarchiveOnHost(sid) {
    const id = String(sid || '')
    if (!id) throw new Error('缺少 sessionId')
    const tries = []
    if (ctl && typeof ctl.unarchive === 'function') {
      tries.push({ who: 'sessionController.unarchive', fn: () => ctl.unarchive({ sessionId: id }) })
    }
    if (reg && typeof reg.unarchiveSession === 'function') {
      tries.push({ who: 'workspaceRegistry.unarchiveSession', fn: () => reg.unarchiveSession(id) })
    }
    let wc = null
    try { wc = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceController') : null } catch (e) { wc = null }
    if (wc && typeof wc.unarchiveSession === 'function') {
      tries.push({ who: 'workspaceController.unarchiveSession', fn: () => wc.unarchiveSession(id) })
    }
    if (!tries.length) return null
    let lastErr = null
    for (const t of tries) {
      try {
        await t.fn()
        log('unarchive ' + id + ' → ' + t.who)
        return t.who
      } catch (e) {
        lastErr = e
        log('unarchive ' + id + ' 走 ' + t.who + ' 失败: ' + ((e && e.message) || String(e)))
      }
    }
    throw new Error('取消归档失败：' + ((lastErr && lastErr.message) || String(lastErr)))
  }

  /* 🔴 第 117 节 · task-16（⑯）· 工作区改名（用户在手机端改「工作区」名字，要同步到电脑端 DSH）。
   *
   * 依据（出处：文档\第117节-工作区改名同步可行性.md，全部 app.asar 字节级取证）：
   *   · 宿主 durable 记录里 title 与 path 是**两个独立字段**（title 初值 = basename(path)，
   *     之后可单独改）；落盘实锤见 ~/.dsh/storages/workspace.json；
   *   · WorkspaceEntity 有 `get title` / `setTitle(title)`（走 mutate 单次持久化写）；
   *   · RPC 侧 ctx.remote.workspace.rename({workspaceId,title}) → {workspace}，
   *     稳定错误码：gateway/bad-request（title trim 后为空）/
   *               workspace/name-conflict（与**另一个**工作区重名）/ workspace/not-found。
   * ⚠️ 只改 title，**不动 path、不重命名文件夹**（宿主实体 `get path` 没有 setter，
   *   改文件夹名要 delete+create，会丢会话归属 —— 见文档 §5，本 op 不做）。
   * ⚠️ ctx.get 必须**当次调用**才取（服务可能晚于 apply 就绪），别在闭包外存死 —— 同 :2179。
   * ⚠️ 入口顺序照 unarchiveOnHost()（:2180）：workspaceRegistry → workspaceController
   *   依次试；**全不可用时给明确错误、绝不编造成功**。 */
  const WS_RENAME_UNSUPPORTED = '本机插件不支持工作区改名，或需要重启 DSH'
  /** 路径归一化：小写 + 去尾部反斜杠（与客户端 LanClient.ets getWsExtra 同口径）。 */
  function wsNormPath(s) {
    return String(s || '').replace(/[\\/]+$/, '').toLowerCase()
  }
  /** 宿主错误 → 手机端中文错误（三条稳定错误码逐条对齐，其余原样带出原因）。 */
  function wsRenameErr(e) {
    const code = String((e && e.code) || '')
    const msg = String((e && e.message) || e || '')
    const all = code + ' ' + msg
    if (/bad-request|non-blank|blank/i.test(all)) return new Error('新名字不能为空')
    if (/name-conflict|already in use/i.test(all)) return new Error('已存在同名工作区')
    if (/not-found|not found/i.test(all)) return new Error('找不到这个工作区，请刷新列表后重试')
    return new Error('工作区改名失败：' + (msg || code || '未知错误'))
  }

  /**
   * 工作区改名。入参 { path?, workspaceId?, title }：
   *   · 有 workspaceId 最省事（宿主主键）；只给 path 时用 registry.list() 按规范化路径配。
   * 返回 { ok:true, renamed:true, title }；失败抛中文 Error。
   */
  async function wsRenameOnHost(payload) {
    const p = payload || {}
    const pathArg = String(p.path || '').trim()
    const idArg = String(p.workspaceId || '').trim()
    const title = String(p.title || '').trim()
    if (!title) throw new Error('新名字不能为空')
    if (!pathArg && !idArg) throw new Error('缺少工作区路径（path）或 workspaceId')

    let regNow = null
    try { regNow = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null } catch (e) { regNow = null }
    let wc = null
    try { wc = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceController') : null } catch (e) { wc = null }

    const canList = !!(regNow && typeof regNow.list === 'function')
    /** 定位目标工作区实体；拿不到返回 null（不猜、不编造）。 */
    let ws = null
    if (canList) {
      let list = null
      try { list = regNow.list() } catch (e) { list = null }
      if (Array.isArray(list)) {
        if (idArg) ws = list.find((c) => c && String(c.id) === idArg) || null
        if (!ws && pathArg) {
          const want = wsNormPath(pathArg)
          ws = list.find((c) => c && wsNormPath(c.path) === want) || null
        }
      }
    }
    if (!ws && !idArg && regNow && typeof regNow.resolveByPath === 'function') {
      try { ws = await regNow.resolveByPath(pathArg) } catch (e) { ws = null }
    }
    const targetId = ws ? String(ws.id || '') : idArg

    const tries = []
    /* 路 1 · workspaceRegistry 实体（durable 那条）：setTitle 走 mutate。
       这条**没有**重名检查（重名检查在 WorkspaceCommands.rename 里），所以这里自己补一条，
       与宿主同一判据：还有别的 id 用了这个 title 就算冲突。 */
    if (ws && typeof ws.setTitle === 'function') {
      tries.push({
        who: 'workspaceRegistry.setTitle',
        fn: async () => {
          const cur = String(ws.title === undefined ? '' : ws.title)
          if (cur === title) return { title }
          if (canList) {
            let all = null
            try { all = regNow.list() } catch (e) { all = null }
            if (Array.isArray(all) && all.some((c) => c && String(c.id) !== String(ws.id) && String(c.title) === title)) {
              throw new Error('workspace/name-conflict: Workspace name is already in use')
            }
          }
          await ws.setTitle(title)
          return { title }
        },
      })
    }
    /* 路 2 · workspaceController.rename（官方 RPC，自带 trim / 重名 / not-found 三校验）。 */
    if (wc && typeof wc.rename === 'function' && targetId) {
      tries.push({ who: 'workspaceController.rename', fn: () => wc.rename({ workspaceId: targetId, title }) })
    }
    if (!tries.length) {
      if (!canList && !(wc && typeof wc.rename === 'function')) throw new Error(WS_RENAME_UNSUPPORTED)
      if (!targetId) throw new Error('找不到这个工作区，请刷新列表后重试')
      throw new Error(WS_RENAME_UNSUPPORTED)
    }
    let lastErr = null
    for (const t of tries) {
      try {
        await t.fn()
        log('[wsRename] ' + (pathArg || targetId) + ' → ' + title + '（走 ' + t.who + '）')
        return { ok: true, renamed: true, title }
      } catch (e) {
        lastErr = e
        log('[wsRename] 走 ' + t.who + ' 失败: ' + ((e && e.message) || String(e)))
      }
    }
    throw wsRenameErr(lastErr)
  }

  async function runCommand(op, payload) {
    const p = payload || {}
    if (op === 'sessions') return readSessions()
    /* 🔴 第 113 节 · task-5：只读归档集探测（客户端 task-6 显式降级用）。
     * 形状冻结：{ ok:true, archived:[sessionId...], pinned:[sessionId...],
     *             source:'host' | 'unavailable' }
     * 宿主集不可用时两个数组都是**空数组**（不是缺键），source='unavailable' ——
     * 客户端据此区分「本版本没有归档能力」与「一条都没归档」。
     * 归档真值的另一条路仍是 /cmd op='archive'；这里只读，不改任何状态。 */
    if (op === 'archiveSet') {
      const arch = hostArchivedIds()
      const pin = hostPinnedMembers()
      return {
        ok: true,
        archived: Array.isArray(arch) ? arch : [],
        pinned: Array.isArray(pin) ? pin : [],
        source: Array.isArray(arch) ? 'host' : 'unavailable',
      }
    }
    if (op === 'send') {
      if (!ctl || typeof ctl.prompt !== 'function') throw new Error('sessionController.prompt 不可用')
      const text = String(p.text || '').trim()
      if (!text) throw new Error('消息是空的')
      const sessionId = String(p.sessionId || '')
      if (!sessionId) throw new Error('缺少 sessionId')
      /* 🔴 第 25 节 · 忙碌时发送策略实装（用户图1 参考实现）。
       * DSH 原生 SessionPromptRequest.mode 就有 'queue'（排队）| 'steer'（插话），
       * 之前这里**写死 'queue'**，等于手机端没法切插话。
       * 现在按传入的 busyMode 走，取值非法回退 queue（排队）——
       * 跟参考实现「默认排队」的行为一致。 */
      const busyMode = p.busyMode === 'steer' ? 'steer' : 'queue'
      return ctl.prompt({
        requestId: crypto.randomUUID(),
        sessionId,
        mode: busyMode,
        content: [{ type: 'text', text }]
      }, AbortSignal.timeout(20000))
    }
    // 手机发图片（0.3.1）。content 块用 DSH 官方 PromptContentPart 的 image 形态
    // （dsh-host-apiproxy/api/sessions.d.ts:82 考证）：
    //   { type:'image', mediaType:'image/png'|'image/jpeg'|'image/webp'|'image/gif', data: base64, name? }
    //   注释原文：the host promotes image bytes to durable references ——
    //   宿主自己把 base64 转成持久附件引用，panel 不用碰 attachments 服务。
    // 万一这个宿主版本 prompt 只认 text 块 → 退路：ctx.attachments.saveImages
    // 自己转持久引用，再塞 { type:'image', attachment: ref }。
    if (op === 'uploadImage') {
      if (!ctl || typeof ctl.prompt !== 'function') throw new Error('sessionController.prompt 不可用')
      const sessionId = String(p.sessionId || '')
      if (!sessionId) throw new Error('缺少 sessionId')
      const imgs = Array.isArray(p.images) ? p.images : []
      if (!imgs.length) throw new Error('没有收到图片')
      if (imgs.length > 4) throw new Error('一次最多带 4 张图')
      const MEDIA = {
        'image/png': 'image/png',
        'image/jpeg': 'image/jpeg',
        'image/jpg': 'image/jpeg',
        'image/webp': 'image/webp',
        'image/gif': 'image/gif'
      }
      const text = String(p.text || '').trim() || '（来自手机）'
      const content = [{ type: 'text', text }]
      for (const im of imgs) {
        const mt = MEDIA[String((im && im.mediaType) || '').toLowerCase()]
        const data = String((im && im.data) || '')
        if (!mt || !data) throw new Error('图片格式不支持（只收 png/jpg/webp/gif）')
        if (data.length > 14e6) throw new Error('有图片超过大小上限（base64 后 14MB）')
        const nm = String((im && im.name) || '').slice(0, 80)
        content.push(nm ? { type: 'image', mediaType: mt, data, name: nm } : { type: 'image', mediaType: mt, data })
      }
      const sendPrompt = (blocks) => ctl.prompt({
        requestId: crypto.randomUUID(),
        sessionId,
        mode: 'queue',
        content: blocks
      }, AbortSignal.timeout(30000))
      return Promise.resolve().then(() => sendPrompt(content)).catch((e) => {
        // 双保险：base64 块被拒 → 自己走 attachments 服务转持久引用再发一次
        log('[uploadImage] 直发失败（' + ((e && e.message) || e) + '），改走 attachments 服务')
        const store = (() => { try { return ctx.get('attachments') } catch (e2) { return null } })()
        if (!store || typeof store.saveImages !== 'function') throw e
        return store.saveImages(content
          .filter((b) => b.type === 'image')
          .map((b) => ({ data: Buffer.from(b.data, 'base64'), mediaType: b.mediaType, name: b.name })))
          .then((refs) => sendPrompt([
            content[0],
            ...refs.map((r) => ({ type: 'image', attachment: r }))
          ]))
      })
    }
    // 手机发文件（0.3.1，非图片）。prompt content 只有 text/image 两形态，
    // 文件进不去 —— 存到 ~/.dsh/dsh-console-inbox/ 收件箱，然后自动往会话里
    // 发一条文本告知绝对路径，电脑那头的 DSH 后续可以直接拿这个路径干活。
    if (op === 'uploadFile') {
      const sessionId = String(p.sessionId || '')
      if (!sessionId) throw new Error('缺少 sessionId')
      const raw = String(p.data || '')
      if (!raw) throw new Error('没有收到文件内容')
      if (raw.length > 20e6) throw new Error('文件太大（base64 后 20MB 上限）')
      const name = String(p.name || 'file.bin').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'file.bin'
      const dir = path.join(os.homedir(), '.dsh', 'dsh-console-inbox')
      fs.mkdirSync(dir, { recursive: true })
      let out = path.join(dir, name)
      // 同名不覆盖：后缀前加 -2 -3…
      const dot = name.lastIndexOf('.')
      const stem = dot > 0 ? name.slice(0, dot) : name
      const ext = dot > 0 ? name.slice(dot) : ''
      for (let i = 2; fs.existsSync(out); i++) out = path.join(dir, stem + '-' + i + ext)
      fs.writeFileSync(out, Buffer.from(raw, 'base64'))
      log('[uploadFile] 已存 ' + out + '（' + Buffer.from(raw, 'base64').length + ' bytes）')
      let notified = false
      if (ctl && typeof ctl.prompt === 'function') {
        try {
          await ctl.prompt({
            requestId: crypto.randomUUID(),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: '【来自手机】已上传文件到电脑：' + out }]
          }, AbortSignal.timeout(20000))
          notified = true
        } catch (e) {
          log('[uploadFile] 通知会话失败: ' + ((e && e.message) || e))
        }
      }
      return { ok: true, path: out, notified }
    }
    if (op === 'cancel') {
      if (!ctl || typeof ctl.cancel !== 'function') throw new Error('sessionController.cancel 不可用')
      return ctl.cancel({ sessionId: String(p.sessionId || '') })
    }
    // 会话详情（对话轮次 + 统计）—— App「会话详情页」的数据源。
    // 走 readDetail()：进程内直接调 projections，不吃 19387 桥的 2000 字符截断。
    if (op === 'detail') {
      const sid = String(p.sessionId || '')
      if (!sid) throw new Error('缺少 sessionId')
      return readDetail(sid)
    }
    /* 🔴 第191节 · 用户 m00001 · 按 deviceId 移除整台设备（面板「踢掉这台手机」）。
     * 入参 { deviceId }：就是 list() 下发的那串原始 'mp-xxxxxxxx'（**不是** secret、
     * 不是 uid/cloudUid 分组键）。走既有 /cmd 访问码鉴权，不新开路由。
     *
     * 为什么用 mp.store：branch 里那个 store 是**壳**（mp-support.mjs:702-708 只包了
     * exchange/isPaired/revoke/touch），没有 revokeDevice；mp.store 才是
     * createDeviceStore 的原对象。不带 revokeDevice 的旧 store ⇒ 明确回错，不抛。
     *
     * 🔴 这里**绝不 throw**：/cmd 出口（index.js:4009 附近）把任何抛出转成 HTTP 500，
     * 而 App 侧要的是一个能判断的 { ok:false, error }。 */
    if (op === 'deviceRevoke') {
      try {
        const want = String(p.deviceId == null ? '' : p.deviceId).trim()
        if (want === '') return { ok: false, error: 'device-not-found' }
        const store = mp && mp.store
        if (!store || typeof store.revokeDevice !== 'function') {
          return { ok: false, error: 'device-store-unavailable' }
        }
        const removed = Number(store.revokeDevice(want)) || 0
        // 0 = 这台设备早就不在表里（别的入口已删 / 重启后列表清空）⇒ 与空值同口径
        if (removed <= 0) return { ok: false, error: 'device-not-found' }
        return { ok: true, removed: removed }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }
    // 模型目录（0.3.3）：sessionController.modelCatalog 实证在方法面
    // （probe 日志 2026-10-03）。返回 SessionModels：
    //   { current:{provider,model,reasoningEffort?}, routable,
    //     groups:[{id,name,models:[{id,name,description?,reasoning?{efforts,defaultEffort?}}]}],
    //     failures:[{id,name,message}] }
    if (op === 'models') {
      if (!ctl || typeof ctl.modelCatalog !== 'function') {
        throw new Error('sessionController.modelCatalog 不可用（这个 DSH 版本没有模型目录）')
      }
      const sid = String(p.sessionId || '')
      if (!sid) throw new Error('缺少 sessionId')
      const norm = (raw) => {
        let v = raw
        if (typeof v === 'string') { try { v = JSON.parse(v) } catch (e) { v = null } }
        v = v || {}
        // 宽容剥壳：有的宿主把值包在 .value / .catalog 里
        if (v.value && typeof v.value === 'object') v = v.value
        if (v.catalog && typeof v.catalog === 'object') v = v.catalog
        return {
          current: v.current ? {
            provider: String(v.current.provider || ''),
            model: String(v.current.model || ''),
            reasoningEffort: v.current.reasoningEffort ? String(v.current.reasoningEffort) : ''
          } : null,
          routable: v.routable !== false,
          groups: (v.groups || []).map((g) => ({
            id: String(g.id || ''),
            name: String(g.name || g.id || ''),
            models: (g.models || []).map((m) => ({
              id: String(m.id || ''),
              name: String(m.name || m.id || ''),
              description: String(m.description || ''),
              efforts: ((m.reasoning && m.reasoning.efforts) || []).map((e) => ({
                id: String(e.id || ''), name: String(e.name || e.id || '')
              }))
            }))
          })),
          failures: (v.failures || []).map((f) => ({
            id: String(f.id || ''), name: String(f.name || ''), message: String(f.message || '')
          }))
        }
      }
      // 参数形态宽容化：签名没进 node_modules 文档，三种形态逐个试
      const attempts = [
        () => ctl.modelCatalog({ sessionId: sid }, AbortSignal.timeout(15000)),
        () => ctl.modelCatalog({ sessionId: sid }),
        () => ctl.modelCatalog(sid)
      ]
      let lastErr = null
      for (const at of attempts) {
        try { return norm(await at()) } catch (e) { lastErr = e }
      }
      log('[models] modelCatalog 三种调用形态都失败: ' + ((lastErr && lastErr.message) || lastErr))
      throw new Error('模型目录读不了：' + ((lastErr && lastErr.message) || '未知错误'))
    }
    /* ⚠️ 第 100 节 · 这里原本还有一段 0.3.3 的旧 selectModel 分支（return 在
       前面 ⇒ 下面 0.4.0 那段**永远走不到**）。两段都叫 op==='selectModel'，
       旧的那段不归一 selected.reasoningEffort、错误文案也不同，实测让
       test/test-selectmodel.mjs 的两条用例红了（0.3.3 遗留，与本次改动无关）。
       已删除旧段，只留 0.4.0 那段（:1821 起）。 */
    /* 🔴 第 117 节 · task-16（⑯）· 工作区改名（**工作区级**，别与会话级 'rename' 混）。
     * 形状冻结（客户端 task-15 按此实现）：
     *   wsRename → { ok:true, renamed:true, title }；失败抛中文错误（永不回 ok 假成功）。
     * payload：{ path?, workspaceId?, title } —— 有 workspaceId 最准（宿主主键），
     *   只给 path 也能用（按规范化路径在 registry.list() 里配）。
     * ⚠️ 只改显示名（title），**不改文件夹名**（见 wsRenameOnHost 上方注释）。 */
    if (op === 'wsRename') return wsRenameOnHost(p)

    // 重命名会话（签名实测：rename({sessionId, title})，空标题报
    // "session title must contain visible characters"）
    if (op === 'rename') {
      if (!ctl || typeof ctl.rename !== 'function') throw new Error('sessionController.rename 不可用')
      const sid = String(p.sessionId || '')
      const title = String(p.title || '').trim()
      if (!sid) throw new Error('缺少 sessionId')
      if (!title) throw new Error('新名字不能为空')
      return Promise.resolve(ctl.rename({ sessionId: sid, title })).then((r) => {
        let raw = r
        if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch (e) { raw = null } }
        return { ok: true, renamed: true }
      })
    }
    // 分叉会话（签名实测：fork({sessionId}) → 返回 {sessionId: 新id}）
    if (op === 'fork') {
      if (!ctl || typeof ctl.fork !== 'function') throw new Error('sessionController.fork 不可用')
      const sid = String(p.sessionId || '')
      if (!sid) throw new Error('缺少 sessionId')
      return Promise.resolve(ctl.fork({ sessionId: sid })).then((r) => {
        let raw = r
        if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch (e) { raw = null } }
        return { ok: true, newSessionId: String((raw && raw.sessionId) || '') }
      })
    }
    // 新建会话。读 { cwd?, workspaceId? } 形状 ——
    // ⚠️ 历史 bug（真机实锤 2026-10-03）：原来写 ctl.create(...a)，
    //    把对象 spread 进参数表直接炸 "Spread syntax requires ...iterable"，
    //    手机端点「新建会话」必失败。对象就该整传：ctl.create(a)。
    /* 🔴 第 182 节 · 手机端「新建会话」必须落到电脑端**上到下第一个**工作区。
     * 【根因 · 本机实测 2026-10-14】宿主 create 只有给 workspaceId 才登记工作区：
     *   · 传 { cwd } → 只 ensureSession，不 attachSession ⇒ 电脑侧栏落「未分组」；
     *   · 传 {}     → cwd 落宿主 defaultCwd（实测 ~/.dsh/profiles/desktop），同样未分组。
     *   证据：宿主 dsh-api-session-controller/lib/index.js:686-714（给了 workspaceId 才
     *   workspace.attachSession；且 workspaceId 与 cwd 不可同传，同传直接抛 bad-request）。
     * 【「电脑端上到下第一个工作区」的定义】= registry.list()[0]
     *   （dsh-workspace/lib/index.js:452-458：list() 按 durable workspaceIds 顺序返回，
     *     正是桌面侧栏上到下的顺序；resolveByPath() 无顺序保证，取第一栏不能用它）。
     * 【形状】{ cwd?, workspaceId? } →
     *   · 有 workspaceId 且 registry 里查得到 → 传 { workspaceId }（最准）
     *   · 有 cwd → 先按规范化路径反查工作区，命中传 { workspaceId }，未命中退回 { cwd }
     *   · 都没给（手机端首页「新建会话」默认路径）→ 取 list()[0] 的 id 传 { workspaceId }
     *   · 工作区确实拿不到（老宿主 / 一台工作区都没建过）→ 才退化成 {}，绝不编造成功。
     * 回包多带 cwd / workspaceId：宿主 create 只回 sessionId，而手机端要拿真 cwd 做分组
     * 与会话页标题（Session.ets 收 params.cwd），由插件给最准。
     * 【症状对照】修前：电脑上那条新会话显示在「未分组」，手机按 cwd 分组看起来在
     * 「微信小助理」⇒ 两边不一致。修后：attach 进第一栏，两边一致。 */
    if (op === 'create') {
      if (!ctl || typeof ctl.create !== 'function') throw new Error('sessionController.create 不可用')
      const cwdArg = p.cwd ? String(p.cwd) : ''
      const idArg = p.workspaceId ? String(p.workspaceId) : ''

      let regNow = null
      try { regNow = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null } catch (e) { regNow = null }
      let wsList = null
      try { if (regNow && typeof regNow.list === 'function') wsList = regNow.list() } catch (e) { wsList = null }
      if (!Array.isArray(wsList)) wsList = null

      /** 定位目标工作区：id 优先，其次规范化路径相等。找不到返回 null（不猜、不编造）。 */
      let wsHit = null
      if (wsList && wsList.length > 0) {
        if (idArg) wsHit = wsList.find((c) => c && String(c.id) === idArg) || null
        if (!wsHit && cwdArg) {
          const want = wsNormPath(cwdArg)
          wsHit = wsList.find((c) => c && wsNormPath(c.path) === want) || null
        }
        /* 既没显式 id 也没 cwd = 手机端首页「新建会话」的默认路径 ⇒ 用户要的第一栏。 */
        if (!wsHit && !idArg && !cwdArg) wsHit = wsList[0] || null
      }

      /* registry 还没就绪（服务晚于 apply）时按路径异步反查一次。 */
      const asyncLookup = (!wsHit && cwdArg && regNow && typeof regNow.resolveByPath === 'function')
        ? Promise.resolve().then(() => regNow.resolveByPath(cwdArg)).catch(() => null)
        : Promise.resolve(null)

      return asyncLookup.then((awy) => {
        const target = wsHit || awy || null
        const targetId = target && target.id !== undefined ? String(target.id) : ''
        const attempts = []
        if (targetId) attempts.push({ workspaceId: targetId })
        if (cwdArg) attempts.push({ cwd: cwdArg })
        if (attempts.length === 0) attempts.push({})
        return (async () => {
          let lastErr = null
          for (const a of attempts) {
            try { return { req: a, raw: await ctl.create(a) } } catch (e) { lastErr = e }
          }
          throw lastErr || new Error('创建失败')
        })()
      }).then((out) => {
        let raw = out.raw
        if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch (e) { raw = null } }
        const sid = String((raw && (raw.sessionId || raw.id)) || '')
        const wsPath = wsHit && wsHit.path ? String(wsHit.path) : ''
        const wsId = wsHit && wsHit.id !== undefined ? String(wsHit.id) : ''
        log('[create] 传 ' + JSON.stringify(out.req) + ' → sessionId=' + sid + ' cwd=' + (wsPath || cwdArg))
        return { ok: true, sessionId: sid, cwd: wsPath || cwdArg, workspaceId: wsId }
      })
    }
    /* 🔴 第 113 节 · task-5：取消归档。
     * 形状冻结（客户端 task-6 按此实现）：
     *   unarchive → { ok:true, done:'unarchive' }   失败抛中文错误
     * payload：{ sessionId }
     * 入口顺序见 unarchiveOnHost()；宿主侧没有可取消的 id 时宿主自己 resolve
     * （registry 注释：An id that is not archived resolves without writing），
     * 所以「取消归档一个本来就没归档的会话」不算失败，不报错。 */
    if (op === 'unarchive') {
      const sid = String(p.sessionId || '')
      if (!sid) throw new Error('缺少 sessionId')
      const who = await unarchiveOnHost(sid)
      if (who === null) throw new Error('这个 DSH 版本没有可用的取消归档入口')
      await archiveSync(sid, false)
      return { ok: true, done: 'unarchive' }
    }

    // 归档 / 删除。
    //
    // ⚠️ 历史 bug（真机实锤 2026-10-03）：调 workspaceRegistry.delete(sid)
    //    返回 ok 但会话根本没删 —— DSH 官方在 workspace 命名空间里压根
    //    没实现 delete（见 @deepseek-ai/dsh-client-ui-workspace 的
    //    "no Session deletion" 限制），那个调用是空操作。
    //
    // ✅ 真正能删的路子 = dsh-session-delete 插件的算法（桌面已装、已实证），
    //    这里把它移植进来进程内直接干：
    //      1. 收集删除目标（本会话 + subagent 后代）
    //      2. dispose Agent（停循环、摘出 live store）
    //      3. detach 无 Agent 的 live 会话（不然列表里会阴魂不散）
    //      4. 删 $DSH_HOME/sessions/<scope>/<id>/ 目录（每个 scope 都找一遍）
    //      5. 删 storages/session_projcache 里的 <id>.json
    //      6. registry.unpinSession / unarchiveSession 清登记
    //    归档走 ctl.archive（sessionController 上真有）；没有再退 registry。
    if (op === 'archive' || op === 'delete') {
      const sid = String(p.sessionId || '')
      if (!sid) throw new Error('缺少 sessionId')
      if (op === 'archive') {
        // sessionController.archive 是 DSH 官方归档入口（和 DSH 菜单一致）
        if (ctl && typeof ctl.archive === 'function') {
          try {
            await ctl.archive({ sessionId: sid })
            await archiveSync(sid, true)
            return { ok: true, done: 'archive' }
          } catch (e) {
            const msg = (e && e.message) || String(e)
            // 活跃中的会话不能直接归档 → 先停这一轮再试
            if (/active/i.test(msg) && ctl && typeof ctl.cancel === 'function') {
              try { await ctl.cancel({ sessionId: sid }) } catch (e2) { /* 忽略 */ }
              await ctl.archive({ sessionId: sid })
              await archiveSync(sid, true)
              return { ok: true, done: 'archive', cancelledFirst: true }
            }
            throw e
          }
        }
        // 老版本兜底：registry.archiveSession
        if (!reg || typeof reg.archiveSession !== 'function') {
          throw new Error('这个 DSH 版本没有可用的归档入口')
        }
        try {
          await reg.archiveSession(sid)
          await archiveSync(sid, true)
          return { ok: true, done: 'archive' }
        } catch (e) {
          const msg = (e && e.message) || String(e)
          if (/active/i.test(msg) && ctl && typeof ctl.cancel === 'function') {
            try { await ctl.cancel({ sessionId: sid }) } catch (e2) { /* 忽略 */ }
            await reg.archiveSession(sid)
            await archiveSync(sid, true)
            return { ok: true, done: 'archive', cancelledFirst: true }
          }
          throw e
        }
      }

      // ---- delete：完整移植 dsh-session-delete v5 算法 ----
      const get = (svc) => {
        try { return ctx.get(svc) } catch (e) { return undefined }
      }
      const sessions = get('sessions')          // live 会话存储
      const agents = get('agents')              // Agent 注册表
      const query = get('sessionQuery')         // 血缘（subagent 后代）
      const home = path.join(os.homedir(), '.dsh')
      let sessionsRoot = home + path.sep + 'sessions'
      try {
        const persistence = get('sessionPersistence')
        if (persistence && typeof persistence.root === 'string' && persistence.root) {
          sessionsRoot = path.resolve(persistence.root)
        }
      } catch (e) { /* 用默认路径 */ }
      const storagesRoot = home + path.sep + 'storages'

      // ① 删除目标 = 本会话 + subagent 后代
      const targets = [sid]
      if (query && typeof query.traceSession === 'function') {
        try {
          const lineage = await query.traceSession(sid)
          for (const node of (lineage && lineage.descendants) || []) {
            const id = node && node.session && node.session.header && node.session.header.id
            if (typeof id === 'string' && id && targets.indexOf(id) < 0) targets.push(id)
          }
        } catch (e) { /* 读不到血缘就只删自己 */ }
      }

      const isLive = (id) => {
        try { return !!(sessions && typeof sessions.get === 'function' && sessions.get(id) !== undefined) }
        catch (e) { return false }
      }

      // ② dispose Agent（停循环 + 从 live store 摘除）
      const closed = []
      let stillLive = targets.filter(isLive)
      for (const id of stillLive) {
        const agent = (() => {
          try { return agents && typeof agents.get === 'function' ? agents.get(id) : undefined }
          catch (e) { return undefined }
        })()
        if (agent && typeof agent.dispose === 'function') {
          try { await agent.dispose(); closed.push(id) } catch (e) { /* 归入 evict */ }
        }
      }

      // ③ detach 没有 Agent 的 live 会话（不 detach 的话列表阴魂不散）
      const evicted = []
      for (const id of targets.filter(isLive)) {
        try {
          const session = sessions.get(id)
          const entry = typeof sessions.liveEntryFor === 'function'
            ? sessions.liveEntryFor(session)
            : (sessions.store && sessions.store.get && sessions.store.get(id))
          if (entry && typeof entry.detach === 'function') {
            entry.detach()
            if (!isLive(id)) evicted.push(id)
          }
        } catch (e) { /* 尽力而为 */ }
      }

      // ④⑤ 删目录 + 投影缓存
      const directories = []
      const cacheFiles = []
      for (const id of targets) {
        // 第一遍与 ⑦ 的二次补刀共用同一个纯函数 —— 匹配规则（<scope>/<id>/ 目录、
        // <id>.json 逐字相等、投影缓存最多下探 3 层）只写一遍，不会漂移。
        let r = { dirs: [], caches: [] }
        try { r = sweepSessionFilesNow(id, { sessionsRoot: sessionsRoot, storagesRoot: storagesRoot }) }
        catch (e) { /* sessionsRoot 不存在等 */ }
        for (const d of r.dirs) directories.push(d)
        for (const f of r.caches) cacheFiles.push(f)
      }

      // ⑦ 真删残留兜底（第 100 节 / task-21）：宿主投影缓存会在第一遍删掉后的
      //    几毫秒内被异步重新写回（task-14 只读对账：47 个已删 id 里 14 个复活，
      //    sessions 列表与 scope 目录 0/47）。这里**不 sleep、不阻塞响应**，
      //    只给每个目标 id 挂两个 unref 定时器异步补刀。
      let sweepScheduled = 0
      for (const id of targets) { if (sweeper.schedule(id)) sweepScheduled += 1 }

      // ⑥ registry 登记清理（unpin/unarchive；纯簿记，失败不挡）
      if (reg) {
        for (const id of targets) {
          for (const m of ['unpinSession', 'unarchiveSession']) {
            if (typeof reg[m] === 'function') {
              try { await reg[m].call(reg, id) } catch (e) { /* 忽略 */ }
            }
          }
        }
      }

      const leftLive = targets.filter(isLive)
      log('delete session=' + sid + ' targets=' + targets.length +
          ' dirs=' + directories.length + ' cache=' + cacheFiles.length +
          ' 补刀=' + sweepScheduled + '个会话(600ms/2000ms)' +
          ' closedAgent=' + closed.join('|') + ' evicted=' + evicted.join('|') +
          ' liveAfter=' + leftLive.join('|'))
      if (directories.length === 0 && leftLive.length === targets.length && targets.length === 1 && !isLive(sid)) {
        throw new Error('找不到这个会话的存储（可能已删过）')
      }
      return {
        ok: true,
        done: 'delete',
        deleted: targets,
        directories: directories.length,
        cacheRecords: cacheFiles.length,
        /* 第 100 节：已经排上的异步二次补刀会话数（0 表示没排上，客户端可据此判断兜底有没有生效） */
        sweepScheduled: sweepScheduled,
        closedLive: closed,
        evictedLive: evicted,
        stillLive: leftLive
      }
    }
    // ---- 电脑文件系统浏览（0.4.0「添加工作区」用）----
    // 安全边界：只「列目录」和「建目录」，不读/不写/不删任何文件；
    // 走 LAN 访问码保护，和 /sessions /cmd 同一门槛。
    if (op === 'fsDrives') {
      const drives = []
      for (let i = 67; i <= 90; i++) {          // C..Z（跳过 A/B 软驱，避免老驱动器探测卡顿）
        const d = String.fromCharCode(i) + ':\\'
        try { fs.accessSync(d, fs.constants.R_OK); drives.push(d.slice(0, 2)) } catch (e) { /* 没这个盘 */ }
      }
      return { ok: true, drives: drives, home: os.homedir() }
    }
    if (op === 'fsList') {
      const dir = String(p.path || '').trim()
      if (!dir) throw new Error('缺少 path')
      const st = fs.statSync(dir)
      if (!st.isDirectory()) throw new Error('不是文件夹：' + dir)
      const showHidden = p.showHidden === true
      const names = fs.readdirSync(dir).sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN'))
      const dirs = []
      for (const n of names) {
        if (!showHidden && String(n).charAt(0) === '.') continue
        let isDir = false
        try { isDir = fs.statSync(path.join(dir, String(n))).isDirectory() } catch (e) { continue } // 无权限/系统链接跳过
        if (isDir) dirs.push({ name: String(n), path: path.join(dir, String(n)) })
      }
      return { ok: true, path: dir, dirs: dirs, sep: path.sep }
    }
    if (op === 'fsMkdir') {
      const dir = String(p.path || '').trim()
      if (!dir) throw new Error('缺少 path')
      fs.mkdirSync(dir, { recursive: true })
      return { ok: true, path: dir }
    }
    // 桌面信息（工作区面板顶部那个「CJ / explorer」）
    if (op === 'desktop') {
      if (!ctl || typeof ctl.workspaceDesktop !== 'function') {
        throw new Error('sessionController.workspaceDesktop 不可用')
      }
      return Promise.resolve(ctl.workspaceDesktop({})).then((r) => {
        let raw = r
        if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch (e) { raw = null } }
        return {
          ok: true,
          available: !!(raw && raw.available),
          name: String((raw && raw.name) || ''),
          fileManager: String((raw && raw.fileManager) || '')
        }
      })
    }
    // 换模型（0.4.0）。宿主签名（sc-index.js:720 / app.asar:319029 实测）：
    //   selectModel({ sessionId, provider, model, reasoningEffort? })
    //   → { selected: { provider, model, reasoningEffort? } }
    // ⚠️ 必须「扁平形状」——ACP 的 {sessionId,configId,value} 形状会报
    //    "Select an available model before sending a message."（§7.11 踩过）。
    // reasoningEffort 可选：efforts 取 modelCatalog().groups[].models[].reasoning，
    // 例如 deepseek 的 off/low/high/max；不传则由宿主取该模型默认档。
    if (op === 'selectModel') {
      if (!ctl || typeof ctl.selectModel !== 'function') throw new Error('sessionController.selectModel 不可用')
      const sid = String(p.sessionId || '')
      if (!sid) throw new Error('缺少 sessionId')
      const provider = String(p.provider || '').trim()
      const model = String(p.model || '').trim()
      if (!provider || !model) throw new Error('缺少 provider 或 model')
      const args = { sessionId: sid, provider, model }
      const effort = String(p.reasoningEffort || '').trim()
      if (effort) args.reasoningEffort = effort
      return Promise.resolve(ctl.selectModel(args)).then((r) => {
        let raw = r
        if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch (e) { raw = null } }
        const sel = (raw && raw.selected) || null
        return {
          ok: true,
          selected: sel ? {
            provider: String(sel.provider || provider),
            model: String(sel.model || model),
            reasoningEffort: sel.reasoningEffort ? String(sel.reasoningEffort) : ''
          } : { provider, model, reasoningEffort: effort }
        }
      })
    }
    // 模型清单（0.4.0）。modelCatalog() 无参：
    //   { default:{provider,model,reasoningEffort}, routableProviders:[...],
    //     groups:[{ id, name, models:[{ id, name, description?, reasoning?:
    //     { efforts:[{id,name,description}], defaultEffort } }] }] }
    // 手机端「换模型」选择列表的数据源；groups 顺序即展示顺序。
    if (op === 'modelCatalog') {
      if (!ctl || typeof ctl.modelCatalog !== 'function') throw new Error('sessionController.modelCatalog 不可用')
      return Promise.resolve(ctl.modelCatalog()).then((r) => {
        let raw = r
        if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch (e) { raw = null } }
        return {
          ok: true,
          default: raw && raw.default ? {
            provider: String(raw.default.provider || ''),
            model: String(raw.default.model || ''),
            reasoningEffort: raw.default.reasoningEffort ? String(raw.default.reasoningEffort) : ''
          } : null,
          groups: ((raw && raw.groups) || []).map((g) => ({
            id: String((g && g.id) || ''),
            name: String((g && g.name) || ''),
            models: ((g && g.models) || []).map((m) => ({
              id: String((m && m.id) || ''),
              name: String((m && m.name) || ''),
              description: String((m && m.description) || ''),
              efforts: (m && m.reasoning && Array.isArray(m.reasoning.efforts))
                ? m.reasoning.efforts.map((e2) => ({
                    id: String(e2.id || ''),
                    name: String(e2.name || ''),
                    description: String(e2.description || '')
                  }))
                : [],
              defaultEffort: (m && m.reasoning && m.reasoning.defaultEffort)
                ? String(m.reasoning.defaultEffort) : ''
            }))
          }))
        }
      })
    }
    /* ============================================================
       🔴 第 97 节 · 预设目录 / 切换预设 / 插件清单（手机端「节点设置」页）
       清单类 op 一律「失败降级返回空清单」，绝不抛 —— 客户端只认这两种形状。
       ============================================================ */
    // 预设目录（手机端「换预设」选择列表）。
    // 冻结形状：成功 {ok:true,presets:[{id,name,description,isDefault,broken}],current,unavailable:false}
    //           失败 {ok:true,presets:[],current:'',unavailable:true}
    if (op === 'presetCatalog') {
      return Promise.resolve().then(async () => {
        const svc = agentPresetsService()
        if (!svc) {
          log('[preset-catalog] agentPresets 服务不可用（懒注册 / 版本差异），降级为空目录')
          return { ok: true, presets: [], current: '', unavailable: true }
        }
        let raw = null
        if (typeof svc.remoteExportList === 'function') raw = await svc.remoteExportList()
        else if (typeof svc.list === 'function') raw = await svc.list()
        else throw new Error('agentPresets 既没有 remoteExportList 也没有 list')
        const current = presetCurrentId(svc)
        return { ok: true, presets: presetRows(raw, current), current, unavailable: false }
      }).catch((e) => {
        log('[preset-catalog] 读取失败，降级为空目录: ' + ((e && e.message) || e))
        return { ok: true, presets: [], current: '', unavailable: true }
      })
    }

    // 切换预设。入参 {sessionId, presetId}。
    // ⚠️ 宿主 select(agent, presetId) 的 scope 是 agent scope（wire 'agentId'，asar 实锤），
    //    所以先把 sessionId 还原成 Agent（ctx.get('agents').get(sid)），再直调服务 ——
    //    比绕 remote 少一层，且校验语义与官方前端一致：会话已开轮会抛
    //    RemoteError('agent-preset/locked','This session has already started')。
    //    拿不到 Agent 时退回 settings 'agent-preset-registry' 的 selectedDefault
    //    （官方前端 writeDefaultPreset 走的就是这条路）。
    if (op === 'selectPreset') {
      const sid = String(p.sessionId || '').trim()
      const pid = String(p.presetId || '').trim()
      /* 🔴 批次F · task-25（#62）：sid 为空/不存在不再 500。
         官方前端切「默认预设」走的就是 settings 'agent-preset-registry' 的
         selectedDefault（writeDefaultPreset），节点管理页那行本来就是全局语义；
         没开过会话 / 手填了过期 id / 干脆没带 sid 时，整页按钮被打成 500 是错的
         （实测 sessionId='__nonexistent_probe__' → HTTP 500）。
         只有 presetId 还必须是硬性入参 —— 缺它没法确定要切到哪。
         ⚠️ 取舍：原来靠「sid 必须存在」防误改全局默认；现在按产品口径放行，
         代价是拿一个不存在的 sid 也能改全局默认（可接受：改的是本机电脑端自己
         的默认，且返回值里用 scope 标了落点）。 */
      if (!pid) throw new Error('缺少 presetId')
      const svc = agentPresetsService()
      if (!svc) throw new Error('agentPresets 服务不可用')
      const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : null
      const agent = (sid && agents && typeof agents.get === 'function') ? agents.get(sid) : null
      if (agent && typeof svc.select === 'function') {
        try {
          const committed = await svc.select(agent, pid)
          return { ok: true, selected: typeof committed === 'string' && committed ? committed : pid }
        } catch (e) {
          const code = String((e && (e.code || (e.data && e.data.code))) || '')
          const msg = (e && e.message) || String(e)
          if (code === 'agent-preset/locked' || /already started/i.test(msg)) {
            throw new Error('这个会话已经开过轮了，改不了预设（agent-preset/locked）')
          }
          throw e
        }
      }
      /* 🔴 第 98 节 · 走到这里说明拿不到 Agent（sid 为空 / 会话没在本进程开过 /
         id 已不存在）。这条回退改的是**全局默认预设**。
         批次F · task-25：存在性只做「日志留痕」，不再拦路 —— 拦路会把「换默认预设」
         这件本来与具体会话无关的事，变成依赖某条会话还在不在（曾经 throw 500）。 */
      if (sid) {
        const exists = await sessionExists(sid)
        if (exists === false) log('[select-preset] 会话不存在，改全局默认: ' + sid)
        else if (exists === null) log('[select-preset] 会话列表不可用，无法确认存在性，仍改全局默认: ' + sid)
      }
      const ns = presetSettingsValue()
      const sett = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : null
      if (sett && typeof sett.update === 'function') {
        try {
          await sett.update('agent-preset-registry', { selectedDefault: pid }, undefined)
          /* 🔴 第 110 节 · task-17：全局默认刚改完，顺手把探测状态同步成新值。
             不是必须的（readPresetNow 每次现读），但能保证「切完立刻读 /info」
             这条路上连一次 ctx.get 的探测结果都不会落后。响应体一个字不动。 */
          presetProbe.available = true
          presetProbe.current = pid
          /* scope:'global' 是本轮新增的**附加**字段（老字段一个没动）：
             客户端 selectPreset() 只读 ok（LanClient.ets:1417-1418 `reply.ok !== false`），
             多一个字段不会破坏契约；节点管理页想区分「会话级 / 全局默认」时可读它。
             有 Agent 那条路返回的是会话级（上面 :2236，不带 scope）。 */
          return { ok: true, selected: pid, scope: 'global' }
        } catch (e) {
          log('[select-preset] settings 回退失败: ' + ((e && e.message) || e))
        }
      }
      throw new Error('切不了预设：' + (sid ? ('拿不到会话 ' + sid + ' 的 Agent') : '会话未开过、也没有可用的全局设置') + '（' + (ns ? 'settings 回退也失败' : '且 settings 不可用') + '）')
    }

    // 插件清单（手机端「插件」列表）。
    // 宿主服务（asar 实锤）：service 'pluginInventory'，list() 无参 →
    //   {managementAvailable?, entries:[{entryId,moduleName,enabled,fiberPhase,meta?}]}
    // 拿不到服务 → {ok:true,managementAvailable:false,entries:[]}（客户端落空态，不红屏）。
    if (op === 'pluginInventory') {
      return Promise.resolve().then(async () => {
        const svc = ctx && typeof ctx.get === 'function' ? ctx.get('pluginInventory') : null
        if (!svc || typeof svc.list !== 'function') {
          log('[plugin-inventory] 宿主 pluginInventory 服务不可用（懒注册 / 版本差异），降级为空清单')
          return { ok: true, managementAvailable: false, entries: [] }
        }
        const snap = (await svc.list()) || {}
        const packages = ctx && typeof ctx.get === 'function' ? ctx.get('pluginPackages') : null
        const baseUrl = ctx ? ctx.baseUrl : undefined
        const entries = (Array.isArray(snap.entries) ? snap.entries : []).map((en) => {
          const moduleName = String((en && en.moduleName) || '')
          /* meta 优先用宿主快照自带的（宿主 readPluginInventory 已按
             entry.parent.tree.ctx.baseUrl 解析好）；缺失才自己回落，且回落时
             不对 baseUrl 做硬性要求（拿不到就调 metaOf(moduleName) 赌一把，
             失败就算了，title 用 moduleName 兜底，绝不因此让整个 op 失败）。 */
          let meta = en && en.meta ? en.meta : null
          if (!meta && packages && typeof packages.metaOf === 'function' && moduleName) {
            try {
              meta = (baseUrl !== undefined ? packages.metaOf(moduleName, baseUrl) : packages.metaOf(moduleName)) || null
            } catch (e) { meta = null }
          }
          const title = pickLocale(meta && meta.title)
          return {
            name: moduleName,
            moduleName,
            title: title || moduleName,
            description: pickLocale(meta && meta.description),
            enabled: !!(en && en.enabled),
            phase: (en && en.fiberPhase) ? String(en.fiberPhase) : 'unknown',
            error: pickLocale(meta && meta.error),
          }
        })
        return { ok: true, managementAvailable: snap.managementAvailable === true, entries }
      }).catch((e) => {
        log('[plugin-inventory] 读取失败，降级为空清单: ' + ((e && e.message) || e))
        return { ok: true, managementAvailable: false, entries: [] }
      })
    }

    /* ---- 置顶会话（第 100 节 · task-28 A 段 / #36）----
     * 形状冻结（客户端 task-28 B 段按此实现，不许改）：
     *   pins → { ok:true, pinned:[sessionId, ...] }        顺序 = 置顶顺序（最新在前）
     *   pin  → { ok:true, pinned:[sessionId, ...] }        切换后返回**完整**集合
     * 失败一律抛中文错误（/cmd 的 catch 会包成 { ok:false, error:'<中文>' }）。
     * 优先级：宿主 workspaceRegistry 的 durable pin（与 DSH 桌面共用同一份）→ 文件兜底。 */
    if (op === 'pins') {
      const h = hostPins()
      return { ok: true, pinned: h !== null ? h : readPinFile() }
    }
    if (op === 'pin') {
      const sid = String(p.sessionId || '').trim()
      if (!sid) throw new Error('缺少 sessionId')
      const want = p.pinned !== false          // 默认置顶；显式 false 才取消
      /* 会话不存在就拒绝（宿主那侧本来也会抛 WorkspaceUnknownSessionError；
         文件兜底那条路没有这个保护，所以这里统一先查一次，免得把死 id 写进去）。
         sessionExists 返回 true/false/null；null = 列表不可用，不挡（乐观放行）。 */
      const exists = await sessionExists(sid)
      if (exists === false) throw new Error('找不到这个会话：' + sid)
      const host = await pinOnHost(sid, want)   // null = 宿主没这条路
      if (host !== null) return { ok: true, pinned: host }
      const cur = readPinFile()
      const next = want
        ? (cur.indexOf(sid) >= 0 ? cur : [sid].concat(cur))
        : cur.filter((x) => x !== sid)
      writePinFile(next)
      return { ok: true, pinned: next }
    }

    /* ---- 🔴 第 164 节 · 手机端「排队消息」读 / 改（用户 m00237）----
     * 手机端会话页输入条上方要显示 dsh 桌面端那种「N 条排队消息」折叠条：
     * 展开看每条内容 + 编辑 / 删除 / 插队。
     *
     * 两条权威通路（都不新造状态，全部读宿主的真队列）：
     *   · 读：service 'agents' → agent.inbox.nextTurn / .nextStep
     *         （与 dsh-host-apiproxy\lib\index.js:1823-1837 queueItems() **逐字同口径**：
     *           next-turn 全部 = placement 'queued'；
     *           next-step 里 source.kind === 'user' → 'steering'，其余 → 'context'。
     *           官方 README.zh.md:41 明写这是宿主权威瞬态快照、不是对话历史。）
     *         拿不到 agents 服务 / 拿不到 agent（本进程没开过这条会话）时**不抛**：
     *           回 { ok:false, err:'queue-unavailable', items:[] }，客户端落空数组、
     *           整条不画（老插件 / 冷会话下的界面与改动前逐像素一致）。
     *   · 改：ctl.updateQueue({sessionId, itemId, action})，
     *         action 只有三种（宿主 QueueAction 原文，apiproxy index.js:2834-2869）：
     *           { kind:'edit',  content:[{type:'text',text}] }  只收文本块，带图会拒
     *           { kind:'remove' }                              删掉这条排队
     *           { kind:'steer' }                               立刻插进当前轮（=「插队」）
     *         ⚠️ 宿主**没有重排（上移/下移）API**：手机端那颗「上移」按 steer 语义落成
     *            「插队」，这是宿主真支持的唯一「提前」动作，不伪造顺序。
     *         ⚠️ steer 仅在 target==='next-turn' 且 agent.status==='running' 时可用，
     *            否则宿主回 code 'steer-unavailable'；这里原样把 code 带回去，UI 自己提示。
     *
     * 冻结形状（客户端 LanClient.ets queueList/queueUpdate 按此实现，不许改）：
     *   queueList   → { ok:true, items:[{ id, placement, text, preview, editable }] }
     *                 或 { ok:false, err:'queue-unavailable', items:[] }
     *   queueUpdate → { ok:true } / { ok:false, err:'<reason>' }（失败也可能被 /cmd 包成
     *                 { ok:false, error:'<中文>' }，两条客户端都按「不是 ok:true 即失败」处理）
     */
    if (op === 'queueList') {
      const sid = String(p.sessionId || '').trim()
      if (!sid) throw new Error('缺少 sessionId')

      /* 一条 UserMessage → 冻结形状要的三个字段（queueItems 同口径：
         只取 type==='text' 的块，其它块（图/工具结果）忽略；
         editable = 全是文本块且非空 —— 带非文本块的项宿主 edit 会拒 QUEUE_EDIT_NON_TEXT）。 */
      const split = (m) => {
        const blocks = Array.isArray(m && m.content) ? m.content : []
        const parts = []
        let allText = blocks.length > 0
        for (const b of blocks) {
          if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
          else allText = false
        }
        const text = parts.join('\n')
        return {
          text,
          editable: allText && text.length > 0,
          /* 一行预览：换行/连续空白压成单空格再截 80 字（桌面端也是这个信息密度） */
          preview: text.replace(/\s+/g, ' ').trim().slice(0, 80),
        }
      }

      /* ---- a) agents 服务（首选；与宿主权威读路 queuesItems 同一份内存态）---- */
      let agent = null
      try {
        const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : null
        if (agents && typeof agents.get === 'function') agent = agents.get(sid) || null
      } catch (e) { agent = null }
      /* 兜底 a2：探针日志显示 sessionController 方法面里就有 agents（typert 上下文本体），
         形态对了就用；不对直接跳过，绝不猜。 */
      if (!agent && ctl && ctl.agents && typeof ctl.agents.get === 'function') {
        try { agent = ctl.agents.get(sid) || null } catch (e) { agent = null }
      }
      if (agent && agent.inbox) {
        const rows = []
        const nextTurn = Array.isArray(agent.inbox.nextTurn) ? agent.inbox.nextTurn : []
        const nextStep = Array.isArray(agent.inbox.nextStep) ? agent.inbox.nextStep : []
        for (const m of nextTurn) rows.push({ id: String((m && m.id) || ''), placement: 'queued', message: m })
        for (const m of nextStep) {
          const src = (m && m.source) || {}
          rows.push({ id: String((m && m.id) || ''), placement: src.kind === 'user' ? 'steering' : 'context', message: m })
        }
        const items = []
        for (const row of rows) {
          if (!row.id) continue
          const s = split(row.message)
          items.push({ id: row.id, placement: row.placement, text: s.text, preview: s.preview, editable: s.editable })
        }
        return { ok: true, items }
      }

      /* ---- b) projections 兜底：全量遍历 values 找「队列形状」的键，不猜键名 ----
         只认「非空数组 + 每项都是带 id 且带 placement 或 message 的对象」这一种形状；
         一个都没命中就是真没有，照样如实回 queue-unavailable。顺带把键名打进日志，
         下次日志里能直接看到这个宿主版本到底投影了哪些键。 */
      let projKeys = []
      try {
        if (ctl && typeof ctl.projections === 'function') {
          const raw = await ctl.projections({ sessionId: sid }, AbortSignal.timeout(20000))
          const values = (raw && raw.values) || {}
          projKeys = Object.keys(values)
          for (const k of projKeys) {
            const v = values[k]
            if (!Array.isArray(v) || v.length === 0) continue
            const looksLikeQueue = v.every((x) => x && typeof x === 'object' && 'id' in x && ('placement' in x || 'message' in x))
            if (!looksLikeQueue) continue
            const qItems = []
            for (const x of v) {
              const id = String((x && x.id) || '')
              if (!id) continue
              const msg = (x && x.message) || {}
              const s = split(msg)
              const src = (msg && msg.source) || {}
              const placement = String((x && x.placement) || (src.kind === 'user' ? 'steering' : 'context'))
              qItems.push({ id, placement, text: s.text, preview: s.preview, editable: s.editable })
            }
            log('[queue-list] 走 projections 兜底：键 ' + k + ' 命中队列形状，' + qItems.length + ' 条')
            return { ok: true, items: qItems }
          }
        }
      } catch (e) {
        log('[queue-list] projections 兜底失败: ' + ((e && e.message) || e))
      }

      /* ---- c) 两条都不行：如实回空，绝不伪造 ---- */
      log('[queue-list] 会话 ' + sid + ' 拿不到待发队列（本进程没开过它 / agents 与投影都没有队列），'
        + 'projections 键=[' + projKeys.join(',') + ']，回 queue-unavailable')
      return { ok: false, err: 'queue-unavailable', items: [] }
    }

    if (op === 'queueUpdate') {
      const sid = String(p.sessionId || '').trim()
      /* 入参名双读：任务书冻结的 {itemId, action, text} 与客户端 LanClient.ets:4472
         实际发的 {queueItemId, queueAction, text}。两套都认，谁先有值用谁 ——
         客户端不用改，任务书那份写法定死的形状也不破。 */
      const itemId = String(p.itemId || p.queueItemId || '').trim()
      const kind = String(p.action || p.queueAction || '').trim()
      if (!sid) throw new Error('缺少 sessionId')
      if (!itemId) throw new Error('缺少 itemId')
      if (kind !== 'edit' && kind !== 'remove' && kind !== 'steer') {
        throw new Error('action 只支持 edit / remove / steer')
      }
      /* edit 只接受纯文本：无 text 直接业务失败（不抛，客户端按 ok:false 处理）。 */
      const text = typeof p.text === 'string' ? p.text : ''
      if (kind === 'edit' && text === '') return { ok: false, err: 'no-text' }
      if (!ctl || typeof ctl.updateQueue !== 'function') throw new Error('sessionController.updateQueue 不可用')
      const action = kind === 'edit'
        ? { kind: 'edit', content: [{ type: 'text', text }] }
        : { kind }
      let raw = null
      try {
        raw = await ctl.updateQueue({ sessionId: sid, itemId, action })
      } catch (e) {
        /* 宿主抛（RemoteError / steer-unavailable 这类）→ 把 code/reason 原样带回去，
           让手机端能出「这条已经不能插队了」这种准确提示，而不是笼统的失败。 */
        const code = String((e && (e.code || (e.data && e.data.code) || (e.details && e.details.reason))) || '')
          || ((e && e.message) || String(e))
        log('[queue-update] ' + kind + ' ' + itemId + ' 失败: ' + code)
        return { ok: false, err: code }
      }
      let obj = raw
      if (typeof raw === 'string') { try { obj = JSON.parse(raw) } catch (e) { obj = null } }
      if (obj && obj.ok === false) {
        const er = obj.error || {}
        const code = String((er.details && (er.details.reason || er.details.itemId)) || er.code || 'update-failed')
        log('[queue-update] ' + kind + ' ' + itemId + ' 被宿主拒绝: ' + code)
        return { ok: false, err: code }
      }
      return { ok: true }
    }

    /* 🔴 第209节 · task-1：面板「检测升级」四个 op —— 走既有 /cmd 通路，
       **不新增宿主路由**（registerRoutes 的 4 条计数与失败判据一个字都不用改）。
       · updateCheck ：真的去问 npm registry（可 force），几秒内返回，只给面板按钮用；
       · updateState ：纯同步读快照（绝不上网、绝不起子进程），给面板轮询用；
       · updateStart ：起升级任务（后台跑，立刻返回任务视图）；
       · updateCancel / updateRollback：取消（杀子进程） / 回滚到台账里的旧版本。 */
    if (op === 'updateCheck') return await cloudPlugin.refresh(!!p.force)
    if (op === 'updateState') return cloudPlugin.state()
    if (op === 'updateStart') return cloudPlugin.startUpdate(String(p.mode || 'update'))
    if (op === 'updateCancel') return cloudPlugin.cancel()
    if (op === 'updateRollback') return cloudPlugin.startUpdate('rollback')
    throw new Error('这个指令不支持：' + op)
  }

  // 内部 HTTP 调用（走 localhost，免去重复实现）
  async function fetchLocal(pathname) {
    const port = lan.port
    if (!port) return { ok: false, error: '服务还没起来' }
    const r = await fetch('http://127.0.0.1:' + port + pathname)
    return await r.json()
  }

  // ---- 面板的 Fetch 路由：客户端半边靠它拿数据 ----
  function json(status, payload) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    })
  }

  function err(e) {
    return (e && e.message) || String(e)
  }

  function registerOne(conn, route, label) {
    try {
      const dispose = conn.fetch.register(route)
      log('  ✓ ' + label + ' ' + route.path + ' 已注册' +
          (typeof dispose === 'function' ? '' : '（注意：register 没返回清理函数）'))
      if (typeof dispose === 'function') pending.push(dispose)
      return true
    } catch (e) {
      say('warn', '  ✗ ' + label + ' ' + route.path + ' 注册失败: ' + ((e && e.stack) || e))
      return false
    }
  }

  function registerRoutes(conn) {
    if (!conn || !conn.fetch || typeof conn.fetch.register !== 'function') {
      say('warn', '拿不到 connection.fetch —— 面板会显示但没数据')
      say('warn', 'ctx 实际有哪些键: ' + Object.keys(ctx || {}).join(','))
      say('warn', 'ctx.get 存在吗: ' + typeof (ctx && ctx.get))
      say('warn', 'ctx.get("connection") = ' + (ctx && typeof ctx.get === 'function' ? String(ctx.get('connection')) : 'ctx.get 不可用'))
      say('warn', '检查 DSH 版本，Connection 服务是新的才带 fetch 注册表')
      return false
    }
    let count = 0
    log('拿到 connection.fetch，开始注册 ' + STATE_PATH + ' 等 4 条路由')

    // /api/dsh-console/state —— 二维码、6 位码、端口、访问码都在这
    if (registerOne(conn, {
      path: STATE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          // light=1：浏览器端每几秒轮询一次状态灯，别每次都重画二维码
          // （qrDataUrl 生成要跑 canvas，白白烧 CPU，而且码本来就没变）
          let light = false
          try {
            light = new URL(request.url).searchParams.get('light') === '1'
          } catch (e) { /* request 不是标准 Request 就当全量 */ }
          return json(200, await lan.panelData(!light))
        } catch (e) {
          return json(500, { ok: false, error: err(e) })
        }
      }
    }, '面板数据')) count += 1

    // /api/dsh-console/newcode —— 「换一张新码」
    if (registerOne(conn, {
      path: NEWCODE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const r = await fetchLocal('/dsh-console/newcode')
          return json(r.ok === false ? 500 : 200, r)
        } catch (e) {
          return json(500, { ok: false, error: err(e) })
        }
      }
    }, '换新配对码')) count += 1

    // /api/dsh-console/sessions —— 会话列表
    if (registerOne(conn, {
      path: SESSIONS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const list = await readSessions()
          return json(200, { ok: true, count: list.length, sessions: list })
        } catch (e) {
          dshOk = false
          dshError = err(e)
          return json(500, { ok: false, error: dshError })
        }
      }
    }, '会话列表')) count += 1

    // /api/dsh-console/cmd —— 下指令
    if (registerOne(conn, {
      path: CMD_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = {}
        try {
          body = await request.json()
        } catch (e) {
          return json(400, { ok: false, error: '请求体不是 JSON' })
        }
        const op = String(body.op || '')
        if (!op) return json(400, { ok: false, error: '缺少 op' })
        try {
          return json(200, { ok: true, result: await runCommand(op, body.payload || {}) })
        } catch (e) {
          return json(500, { ok: false, error: err(e) })
        }
      }
    }, '下指令')) count += 1

    log(count === 4
      ? '面板数据路由已就绪（4 条）：/api/dsh-console/*'
      : '⚠ 只注册成功 ' + count + '/4 条路由，面板会 404')
    return count === 4
  }

  // ---- 启动 ----
  const started = lan.start().then((r) => {
    if (!r) {
      say('warn', '局域网服务没起来，手机 App 连不上')
      return
    }
    say('info', '配对码 ' + r.code + '（15 分钟内有效）')
  })

  // 探一次会话，确认真的读得到
  readSessions().then(
    (l) => {
      dshOk = true
      dshError = ''
      say('info', '读到 ' + l.length + ' 个会话')
    },
    (e) => {
      dshOk = false
      dshError = err(e)
      say('warn', '读会话失败：' + dshError)
    }
  )

  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      // 第 100 节：停掉还没触发的二次清理定时器（unref 的定时器本身不挡退出，
      // 这里只是别让插件卸载后又去动磁盘）。
      sweeper.clear()
      for (const dispose of pending) { try { dispose() } catch (e) { /* 忽略 */ } }
      try { lan.stop() } catch (e) { /* 忽略 */ }
      /* 🔴 第 122 节 · task-2（#21-D）· 宿主退出 ≠ 子进程退出：插件卸载时必须显式
         停掉 frpc（stopTunnel 内部 kill + 关日志 fd），否则孤儿 frpc 一直占着 remotePort=8899。 */
      try { stopTunnel() } catch (e) { /* 忽略 */ }
    }, 'dsh-console: cleanup')
  }

  // ⚠️ 必须 ctx.get('connection')，不能写 ctx.connection。
  //    connection 是 inject 进来的服务，不是 ctx 上的属性 ——
  //    写 ctx.connection 会拿到 undefined，路由静默不注册，面板就报 404。
  //    范例：dsh-startup-control/lib/host.js:985
  registerRoutes(ctx && typeof ctx.get === 'function' ? ctx.get('connection') : null)

  return started
}

/**
 * 🔴 第 100 节 · 真删残留的**纯删除动作**（task-21）。
 *
 * 只做一件事，不做任何判断：把磁盘上属于 sid 的会话残留删掉。
 * 第一遍删除（runCommand 的 delete 分支）与异步二次补刀都调它，
 * 这样「什么算这个会话的残留」只有一处定义。
 *
 * 精确匹配（任务要求 ③）：
 *   - 目录：<sessionsRoot>/<scope>/<sid>/ —— scope 目录名任意，但会话目录名
 *     必须与 sid **逐字相等**（fs 层大小写敏感，不做不区分大小写的通配）。
 *   - 投影缓存：<storagesRoot>/session_projcache 下最多 3 层里的 <sid>.json —— 文件名必须
 *     恰好是 sid + '.json'（同上逐字），最多下探 3 层（宿主实际就 1~2 层）。
 * 不碰任何其它文件、不做递归模糊匹配。
 *
 * @returns {{dirs: string[], caches: string[]}} 实际删掉的路径（幂等：已不存在就返回空数组，不抛）
 */
export function sweepSessionFilesNow(sid, roots) {
  const out = { dirs: [], caches: [] }
  const id = String(sid || '')
  if (!id) return out
  const sessionsRoot = roots && roots.sessionsRoot
  const storagesRoot = roots && roots.storagesRoot

  if (sessionsRoot) {
    let scopes = []
    try { scopes = fs.readdirSync(sessionsRoot, { withFileTypes: true }) } catch (e) { scopes = [] }
    for (const sc of scopes) {
      if (!sc.isDirectory()) continue
      const dir = path.join(sessionsRoot, sc.name, id)
      try {
        if (fs.statSync(dir).isDirectory()) {
          fs.rmSync(dir, { recursive: true, force: true })
          if (!fs.existsSync(dir)) out.dirs.push(dir)
        }
      } catch (e) { /* 这个 scope 下没有这个会话 */ }
    }
  }

  if (storagesRoot) {
    const cacheRoot = path.join(storagesRoot, 'session_projcache')
    const walk = (dir, depth) => {
      if (depth > 3) return
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
      for (const en of entries) {
        const full = path.join(dir, en.name)
        if (en.isDirectory()) { walk(full, depth + 1); continue }
        if (en.name !== id + '.json') continue
        try {
          fs.rmSync(full, { force: true })
          if (!fs.existsSync(full)) out.caches.push(full)
        } catch (e) { /* 忽略这一个文件 */ }
      }
    }
    walk(cacheRoot, 0)
  }
  return out
}

/**
 * 🔴 第 100 节 · 真删残留的**异步二次清理调度器**（task-21）。
 *
 * 为什么需要它：宿主投影缓存会在插件删掉 session_projcache 下的 <id>.json 之后
 * 4~13ms 又写回来（task-14 只读对账，14/47 残留）。所以删完还要过一会儿再补刀。
 *
 * 任务要求逐条对应：
 *   ① 不阻塞 delete 响应 —— 本函数只 setTimeout，不 await、不 sleep。
 *      两次补刀默认 600ms / 2000ms：600ms 覆盖实测 4~13ms 的重写窗口且留余量，
 *      2000ms 防宿主再晚一轮写回。
 *   ② 幂等 —— schedule 同一个 id 会先 clearTimeout 上一轮，不会堆积；补刀回调
 *      自身把已触发的定时器从表里摘掉；什么都没删到也不抛。
 *   ③ 只按 sessionId 精确匹配 —— 真正的删除动作在 sweepSessionFilesNow 里，
 *      目录名/文件名逐字相等，不碰别的会话。
 *
 * 路径用**函数**延迟解析（删除时读到的 sessionPersistence.root 才是当前真值）。
 * setTimer 可注入（单测用假定时器把 2.6s 压成同步触发）。
 */
export function createDeleteSweeper(opts) {
  const o = opts || {}
  const rootOf = (v) => {
    try { return typeof v === 'function' ? String(v() || '') : String(v || '') } catch (e) { return '' }
  }
  const delay1 = Number(o.delayMs) > 0 ? Number(o.delayMs) : 600
  const delay2 = Number(o.delay2Ms) > 0 ? Number(o.delay2Ms) : 2000
  const say = typeof o.log === 'function' ? o.log : () => {}
  const setTimer = typeof o.setTimer === 'function'
    ? o.setTimer
    : (fn, ms) => {
      const t = setTimeout(fn, ms)
      if (t && typeof t.unref === 'function') t.unref()
      return t
    }
  const timers = new Map()   // sid -> 未触发的定时器数组

  function clear() {
    for (const ts of timers.values()) for (const t of ts) { try { clearTimeout(t) } catch (e) { /* 忽略 */ } }
    timers.clear()
  }

  /** 给一个已删会话排两次异步补刀。返回是否排上了。 */
  function schedule(id) {
    const sid = String(id || '')
    if (!sid) return false
    const prev = timers.get(sid)
    if (prev) for (const t of prev) { try { clearTimeout(t) } catch (e) { /* 忽略 */ } }
    const roots = { sessionsRoot: rootOf(o.sessionsRoot), storagesRoot: rootOf(o.storagesRoot) }
    const mine = []
    for (const pair of [[delay1, String(delay1) + 'ms'], [delay2, String(delay2) + 'ms']]) {
      const ms = pair[0]
      const tag = pair[1]
      let handle = null
      handle = setTimer(() => {
        try {
          const gone = sweepSessionFilesNow(sid, roots)
          if (gone.dirs.length + gone.caches.length > 0) {
            say('delete 二次清理(' + tag + ') session=' + sid + ' 又清掉 ' +
                (gone.dirs.length + gone.caches.length) + ' 项: ' + gone.dirs.concat(gone.caches).join(' | '))
          }
        } catch (e) {
          // 补刀失败绝不能影响已经返回给客户端的 ok（只是残留没清干净）
          say('delete 二次清理失败(' + tag + ') session=' + sid + ': ' + ((e && e.message) || e))
        }
        const cur = timers.get(sid)
        if (cur) {
          const i = cur.indexOf(handle)
          if (i >= 0) cur.splice(i, 1)
          if (!cur.length) timers.delete(sid)
        }
      }, ms)
      mine.push(handle)
    }
    timers.set(sid, mine)
    return true
  }

  return { clear: clear, schedule: schedule, get pending() { return timers.size } }
}

/**
 * 读一个整数环境变量，非法/缺失就用默认值（第 100 节 · task-35）。
 *
 * 为什么要能覆盖：payload 体积与手机端渲染都跟运行环境有关（老手机更吃紧、
 * 局域网更慢），把上限写死等于把「调不动」也写死了。这些值只在插件加载时
 * 读一次（重启生效），不做热更新 —— 免得每次 detail 都读一次 env。
 */
/**
 * 🔴 第 100 节 · task-36 · 轮次的**防御性终态清洗**。
 *
 * 为什么要有这一层：ACP 标记进手机气泡有**三条**装配路径，历史上前两条各自
 * 单独修补过（contentText 剥 text 块、foldHistoryToTurns 剥 reasoning 块），
 * 第三条（概要投影 turnOutline 直接透传）就是这么漏掉的。与其每次发现一条补
 * 一条，不如在所有轮次**生产完成的最后**统一再过一道 —— 谁以后再加装配路径，
 * 只要经过这里就自动安全。
 *
 * 覆盖字段：prompt / response（正文）、prompts[]（逐条提问）、think / thinks[]
 * （思考折叠块）。**不动**结构字段（turn/seq/time/tools/steps/images/aimages
 * —— 第 167 节 T1 起 images 与 aimages 都是图片引用登记表的 id 数组，同属结构字段）。
 *
 * 幂等且零成本：stripAcp 内部第一行就是 `t.indexOf('<acp') === -1` 直接返回，
 * 不含标记的串（99.9%）走不到任何分配。
 */
export function stripAcpInTurns(turns) {
  if (!Array.isArray(turns)) return turns
  for (const t of turns) {
    if (!t || typeof t !== 'object') continue
    /* 第 111 节 · task-4 / #73：终态清洗同时剥「协议壳」——ACP 之外还有两类
       宿主原文会漏进气泡：附件描述块（<path>/<type>/<content>）与
       <system-reminder>。与客户端 Session.ets:4853 stripShell 同口径。
       幂等零成本（不含 '<' 直接 return）。 */
    if (typeof t.prompt === 'string') t.prompt = stripShellText(stripAcp(t.prompt))
    if (typeof t.response === 'string') t.response = stripShellText(stripAcp(t.response))
    if (typeof t.think === 'string') t.think = stripShellText(stripAcp(t.think))
    if (Array.isArray(t.prompts)) t.prompts = t.prompts.map((x) => (typeof x === 'string' ? stripAcp(x) : x))
    if (Array.isArray(t.thinks)) t.thinks = t.thinks.map((x) => (typeof x === 'string' ? stripAcp(x) : x))
  }
  return turns
}

function envInt(name, def) {
  try {
    const raw = process.env && process.env[name]
    if (raw === undefined || raw === null || String(raw).trim() === '') return def
    const n = Number(String(raw).trim())
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : def
  } catch (e) {
    return def
  }
}

function randomHex(bytes) {
  // ⚠️ 必须用 node:crypto 的 randomBytes。全局 crypto 是 WebCrypto，
  //    没有 randomBytes / randomInt —— 之前在项目里踩过这个坑。
  return crypto.randomBytes(bytes).toString('hex')
}

export default { name, inject, apply }
