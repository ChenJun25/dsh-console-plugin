/**
 * DSH控制台面板 —— 隧道（frpc）半边。
 *
 * 🔴 第 122 节 · task-2（#21-D）· 把 frpc 收进插件。
 * 用户原话（m00001）：「插件自己拉起隧道、面板显示隧道状态，但你这一版不做多用户、不做计费。」
 * 另一半（m00001 第 4 条）：「局域网直连亮=手机真的从局域网连上；远程访问这版默认未连接，只留 UI 和接口。」
 *
 * 这一版只服务**用户本机**，进程管理全部收在本文件里（index.js 只在启动时调一次 startTunnel、
 * 卸载时调一次 stopTunnel，别的地方不许再 spawn frpc）：
 *
 *   ① 配置读 ~/.dsh/dsh-console-tunnel.json（含 authToken，只在用户自己机器上，绝不进仓库/日志）。
 *   ② **配置文件不存在 ⇒ enabled:false ⇒ 整条功能静默关闭**：不 spawn、不报错、不刷屏。
 *      这就是「不接真服务器 / 别人机器永远不连」的技术保证。
 *   ③ 拉起前先独占 remotePort：禁用并停掉开机自启计划任务 dsh-frpc（禁掉不是删），
 *      否则两个 frpc 抢 remotePort=8899，隧道时断时续。
 *   ④ 状态对象 tunnelStatus() 固定 8 个字段（🔴 第128节起多一个 publicUrl），**绝不出现 authToken**。
 *   ⑤ 🔴 第215节 · 修法3：frpc 默认路径 = ~/.dsh/frp 下的托管路径，缺失时**自动从云端下载**
 *      （frpc-bootstrap.mjs + 服务端 /frpc/manifest.json）。下载失败把原因写进 lastError 显形，绝不静默。
 *      用户手放的 frpc（含老路径，通过 startTunnel({frpcPath}) 指定）永远优先，绝不覆盖、绝不联网。
 *
 * 四个已经踩过的坑（每条都有对应代码，别删注释）：
 *   坑 2 frpc 0.62 把配置当 JSON 解析：文件带 BOM 就崩（日志报 error unmarshaling JSON:
 *        ... cannot unmarshal string into Go value of type v1.ClientConfig）⇒ 写配置**必须传 Buffer**，
 *        绝不能用 PowerShell Set-Content -Encoding UTF8。见 writeToml()。
 *   坑 3 插件自测会被误伤：测试里 apply(ctx, { port: 0 }) 会真跑启动流程 ⇒ localPort===0 /
 *        env DSH_TUNNEL=0 / node --test 子进程 一律短路。见 startTunnel()。
 *   坑 4 frpc 的输出里若混进 token，落盘/进 lastError 前一律抹成 ***。见 redact()。
 *   坑 6 宿主退出 ≠ 子进程退出：detached:false + 日志落同一个 fd + 显式 kill，绝不 detached。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { frpcTargetPath, ensureFrpc } from './frpc-bootstrap.mjs'

/* ---------------- 常量 ---------------- */

/** 用户机上的隧道配置（含 authToken，只在用户自己机器上）。 */
export const TUNNEL_CONFIG_PATH = path.join(os.homedir(), ".dsh", "dsh-console-tunnel.json")
const GEN_TOML_PATH = path.join(os.homedir(), ".dsh", "dsh-console-frpc.toml")
const LOG_PATH = path.join(os.homedir(), ".dsh", "dsh-console-tunnel.log")
/**
 * 🔴 G58-A · §A4：云端 register 下发的隧道参数自动文件（cloud-link.mjs 落盘、tunnel.mjs 读取）。
 * 与手写配置分开的**唯一理由**：云端值随时会变（短号/域名/locations），插件启动时整份覆盖它；
 * 绝不能把云端值写进用户手写的 TUNNEL_CONFIG_PATH。合并规则见 readTunnelConfig()：自动文件优先。
 */
export const TUNNEL_AUTO_PATH = path.join(os.homedir(), ".dsh", "dsh-console-tunnel.auto.json")
/**
 * 🔴 第215节 · 修法3：默认 frpc 路径不再是**开发机写死**的 'C:\\Program Files\\dsh-frp\\frpc.exe'
 * （别人机器上根本没这个文件 ⇒ 隧道静默失败，用户 m01977 报的「装了最新插件+开了会员仍连不上公网」就是这个）。
 * 现在一律取 ~/.dsh/frp 下的托管路径，缺失时由 frpc-bootstrap.mjs 从云端下载（服务端托管 /frpc/*）。
 * rt.frpcPath 仍可被 startTunnel({frpcPath}) 覆盖（单测/排查用），行为零回归。
 */
const DEFAULT_FRPC = frpcTargetPath() || (process.platform === 'win32' ? 'frpc.exe' : 'frpc')

/** phase 固定 5 值（T-4）。disabled/starting/connected/reconnecting/error，别加别的。 */
const PHASES = ['disabled', 'starting', 'connected', 'reconnecting', 'error']
const RETRY_MS = 5000
const RETRY_MAX_MS = 30000

/* ---------------- 内部状态 ---------------- */

function blankState() {
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

let state = blankState()
let child = null
let childGen = 0
let logFd = null
let retryTimer = null
let retryCount = 0
let everConnected = false
let exitHookInstalled = false
let secret = ""   // 只在本进程内存里，用来把 frpc 输出里的 token 抹掉（坑 4）
let rt = { log: () => {}, frpcPath: DEFAULT_FRPC, configPath: TUNNEL_CONFIG_PATH, logPath: LOG_PATH }
/** 🔴 第215节：frpc 缺失时走异步下载，落地前必须确认这轮 startTunnel 还「当班」（防下载途中被 stop/重启）。 */
let startGen = 0

function errText(e) { return String((e && e.message) || e || "") }

/** frpc 即使输出到管道也会带 ANSI 颜色码（\u001b[0m\u001b[1;34m 之类），落盘前剥掉。 */
function stripAnsi(text) {
  return String(text == null ? "" : text).replace(/\u001b\[[0-9;]*m/g, "")
}

/**
 * ★坑 3（完整版）· 现在是不是「单测环境」。
 * 只判 localPort===0 是不够的：lib/test/preset-info.spec.mjs:326 用的是
 * `apply(ctx, { port: 19301 + (liveSeq++ * 2), allowShiftPort: true })` —— **真实端口**，
 * 它会真的走完启动流程。若用户机上恰好配了 enabled:true（本机验收时就是），
 * 那个单测就会真的去 spawn frpc、抢 remotePort=8899、还留个残留进程。
 * 所以除了 port===0，再按运行形态兜一层：
 *   - DSH_TUNNEL=0 显式关（也给用户/排查用）；
 *   - NODE_TEST_CONTEXT / execArgv 带 --test（node --test 入口）；
 *   - 入口文件是 *.spec.mjs 或落在 test/ 目录下（直接 node lib/test/xxx.spec.mjs）。
 * 生产宿主启动时 argv[1] 是 DSH 自己的入口，都命中不了，不影响真功能。
 */
function inTestEnv() {
  if (process.env.DSH_TUNNEL === '0') return true
  if (process.env.NODE_TEST_CONTEXT) return true
  try {
    if ((process.execArgv || []).some((a) => String(a).indexOf('--test') >= 0)) return true
  } catch (e) { /* 忽略 */ }
  const entry = String(process.argv[1] || '')
  if (/\.spec\.mjs$/i.test(entry)) return true
  if (/[\\/](?:test|tests)[\\/]/i.test(entry)) return true
  return false
}

/** 把 token 从任何要落盘/要进状态对象的文本里抹掉（坑 4）。 */
function redact(text) {
  let s = String(text == null ? "" : text)
  if (secret && secret.length >= 6) s = s.split(secret).join("***")
  return s
}

function setPhase(phase, patch) {
  const next = PHASES.indexOf(phase) >= 0 ? phase : "disabled"
  if (state.phase !== next) {
    state.phase = next
    state.since = Date.now()
  }
  if (patch) Object.assign(state, patch)
}

/* ---------------- 配置 ---------------- */

/**
 * 读配置。三种结果分得很清楚（别合成一个 null，否则「文件不存在」和「文件坏了」分不开）：
 *   { exists:false }            → 静默关闭（正常情况：别人机器上永远走这条）
 *   { exists:true, ok:false }   → 文件在但读不了/不是合法 JSON ⇒ phase:error 让面板显形
 *   { exists:true, ok:true, cfg }
 */
function readConfig(p) {
  let raw = null
  try {
    raw = fs.readFileSync(p, "utf8")
  } catch (e) {
    if (e && e.code === "ENOENT") return { exists: false }
    return { exists: true, ok: false, error: errText(e) }
  }
  try {
    // 手写文件可能带 BOM；配置是 JSON，容错剥一下（我们写出去的 frpc 配置不带 BOM）。
    const j = JSON.parse(String(raw).replace(/^\uFEFF/, ""))
    if (!j || typeof j !== "object" || Array.isArray(j)) return { exists: true, ok: false, error: "内容不是 JSON 对象" }
    return { exists: true, ok: true, cfg: j }
  } catch (e) {
    return { exists: true, ok: false, error: errText(e) }
  }
}

/**
 * 🔴 第 128 节 · 公网入口（publicUrl）规范化。
 * 语义：只接受 http:// 或 https:// 开头；先 String(x||'').trim()，再去掉尾部所有斜杠；
 *      不合格一律回空串。**绝不抛异常、绝不把隧道打成 error phase** ——
 *      配置里写错一个可选字段，不该让整条隧道停产。
 * 文件不存在 / enabled !== true 时，调用方给 state 的就是空串。
 */
function normalizePublicUrl(x) {
  const s = String(x == null ? "" : x).trim()
  if (!/^https?:\/\//i.test(s)) return ""
  return s.replace(/\/+$/, "")
}

/**
 * 由 JSON 配置生成 frpc 的 toml 文本（字段结构照 C:\Program Files\dsh-frp\frpc.toml）。
 * 🔴 G58-A · §A4：按 c.type 分流 ——
 *   type='http'（公网短号入口）：写 customDomains + locations，**绝不写 remotePort**
 *     （http 代理由 frps 的 vhostHTTPPort:8080 按 customDomains/locations 分派到本机 frpc）；
 *   其他（缺省 / 'tcp'）：维持老格式 type='tcp' + remotePort，老手写配置零回归。
 * 导出只为单测能直接断言生成文本（写盘那步另有真文件断言）。
 */
export function tomlText(c) {
  const q = (v) => '"' + String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
  const isHttp = String((c && c.type) || "").trim().toLowerCase() === "http"
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter((x) => x !== "") : [])
  const lines = [
    "# DSH控制台 · 插件自动生成，每次启动覆盖，请勿手改（改 ~/.dsh/dsh-console-tunnel.json）。",
    "serverAddr = " + q(c.serverAddr),
    "serverPort = " + Number(c.serverPort),
    'auth.method = "token"',
    "auth.token = " + q(c.authToken),
    "",
    "[[proxies]]",
    "name = " + q(c.proxyName),
    "type = " + q(isHttp ? "http" : "tcp"),
    'localIP = "127.0.0.1"',
    "localPort = " + Number(c.localPort)
  ]
  if (isHttp) {
    lines.push("customDomains = " + JSON.stringify(list(c.customDomains)))
    lines.push("locations = " + JSON.stringify(list(c.locations)))
  } else {
    lines.push("remotePort = " + Number(c.remotePort))
  }
  lines.push("")
  return lines.join("\n")
}

/**
 * 🔴 G58-A · §A4：两层配置合并（纯函数，只读文件、绝不动 state）。
 *   手写文件 cfgPath  → 连接参数（serverAddr/serverPort/authToken/enabled），用户自己维护；
 *   自动文件 autoPath → 云端 register 下发（name/type/customDomains/locations/publicUrl，
 *                       以及云端一并下发的 serverAddr/serverPort/authToken）；
 *   **自动文件优先**（云端是权威），手写文件兜底；自动文件的任何值绝不写回手写文件。
 * 返回 { cfgPath, autoPath, manual, auto, merged, manualRead, autoRead, exists, manualBroken, autoBroken }
 *   exists=false ⇒ 两处都没有（＝没配隧道）⇒ 调用方沿用老行为静默关闭。
 */
export function readTunnelConfig(cfgPath = TUNNEL_CONFIG_PATH, autoPath = TUNNEL_AUTO_PATH) {
  const manualRead = readConfig(cfgPath)
  const autoRead = readConfig(autoPath)
  const manual = manualRead.exists === true && manualRead.ok === true ? manualRead.cfg : null
  const auto = autoRead.exists === true && autoRead.ok === true ? autoRead.cfg : null
  /* ⚠️ merged 只在**至少一份解析成功**时才是对象；两份都坏 ⇒ null。
     调用方（startTunnel）靠 null 区分「文件在但读不了」（⇒ error phase，让面板显形）
     与「enabled 不是 true」（⇒ 老语义静默关闭）。 */
  const merged = (manual || auto) ? Object.assign({}, manual || {}) : null
  if (merged && auto) {
    for (const k of Object.keys(auto)) {
      if (auto[k] !== undefined && auto[k] !== null) merged[k] = auto[k]
    }
  }
  return {
    cfgPath,
    autoPath,
    manual,
    auto,
    merged,
    manualRead,
    autoRead,
    /* exists = **盘上有文件**（不管解析成败）：老语义里「文件在但坏」要打 error，
       不能跟「两处都没有 ⇒ 静默关闭」混成一件事。 */
    exists: manualRead.exists === true || autoRead.exists === true,
    manualBroken: manualRead.exists === true && manualRead.ok !== true,
    autoBroken: autoRead.exists === true && autoRead.ok !== true
  }
}

/** [仅供单测] startTunnel 里 :468 + :491-493 的代理名分流，抽成纯导出以便直接断言。
 *  http ⇒ 云端 name（"dsh-<短号>"，frps 全局唯一，防同机多机互踢）优先；
 *  tcp  ⇒ 手写 proxyName 优先（老配置零回归）；都空兜底 "dsh-console"。
 *  生产代码路径不走这里（startTunnel 内联同一份逻辑），改一处必须同步另一处。 */
export function pickProxyName(cfg) {
  const c = cfg || {}
  const t = String(c.type || "").trim().toLowerCase() === "http" ? "http" : "tcp"
  const picked = t === "http" ? (c.name || c.proxyName) : (c.proxyName || c.name)
  return String(picked || "dsh-console").trim() || "dsh-console"
}

/**
 * 写 frpc 配置。★坑 2：必须传 Buffer。
 * 传字符串时若哪天上游给它带上 BOM，frpc 0.62 会把它当 JSON 解析并直接崩：
 *   error unmarshaling JSON: ... cannot unmarshal string into Go value of type v1.ClientConfig
 * 也绝不能用 PowerShell 的 Set-Content -Encoding UTF8（Windows PowerShell 5 会写 BOM）。
 */
export function writeToml(c, tomlPath = GEN_TOML_PATH) {
  const buf = Buffer.from(tomlText(c), "utf8")
  fs.writeFileSync(tomlPath, buf, { mode: 0o600 })
}

/* ---------------- 进程 ---------------- */

function closeLog() {
  if (logFd !== null) { try { fs.closeSync(logFd) } catch (e) { /* 忽略 */ } logFd = null }
}

/** 只杀子进程 + 换代（让旧子进程的事件回调全部失效），不动 state。 */
function killChild() {
  const c = child
  child = null
  childGen += 1
  if (c) { try { c.kill() } catch (e) { /* 已经死了 */ } }
}

/** 宿主退出时把子进程一起带走（坑 6：宿主退出 ≠ 子进程退出，别留孤儿占着 8899）。 */
function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  try {
    process.on("exit", () => {
      const c = child
      child = null
      childGen += 1
      if (c) { try { c.kill() } catch (e) { /* 忽略 */ } }
      closeLog()
    })
  } catch (e) { /* 忽略 */ }
}

/**
 * 独占 remotePort：禁用（不是删）开机自启计划任务 dsh-frpc，并停掉它当前的实例。
 * 失败不致命（没管理员权限/没有这个任务都很正常）——只记一句日志，隧道照拉，
 * 真抢端口的话 frpc 自己会在日志里报 start proxy error，面板显示 error。
 */
function ensureExclusiveTask() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve("")
    /* ⚠️ 回显必须是纯 ASCII：powershell.exe 默认用 CP936 输出，Node 按 utf8 解码
       会变成一串乱码（实测 '[tunnel] ���…'）。中文消息在 Node 侧拼。 */
    const cmd = "$ErrorActionPreference='SilentlyContinue';" +
      "Disable-ScheduledTask -TaskName 'dsh-frpc' | Out-Null;" +
      "Stop-ScheduledTask -TaskName 'dsh-frpc';" +
      "'dsh-frpc task disabled and stopped'"
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd],
      { timeout: 20000, windowsHide: true },
      (e, stdout) => {
        if (e) return resolve("禁计划任务没成功（" + redact(errText(e)) + "），仍继续拉起 frpc")
        const said = String(stdout || "").trim()
        resolve(said ? "已禁用并停掉开机自启计划任务 dsh-frpc（独占 remotePort）" : "")
      })
  })
}

function scheduleRetry() {
  if (retryTimer) return
  const delay = Math.min(RETRY_MS * Math.pow(2, Math.min(retryCount, 3)), RETRY_MAX_MS)
  retryCount += 1
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (state.enabled !== true) return
    boot()
  }, delay)
  if (retryTimer.unref) retryTimer.unref()   // 别挡住宿主退出
}

/** 逐行判状态（frpc 0.62 的日志格式）。 */
function classify(text) {
  const lines = String(text).split(/\r?\n/)
  for (const raw of lines) {
    const line = String(raw).trim()
    if (line === "") continue
    if (/login to server success/i.test(line)) {
      everConnected = true
      retryCount = 0
      setPhase("connected", { lastError: "" })
      rt.log("[tunnel] frpc 已登录服务器")
      continue
    }
    if (/start proxy success/i.test(line)) {
      everConnected = true
      retryCount = 0
      setPhase("connected", { ready: true, lastError: "" })
      rt.log("[tunnel] 隧道已就绪 remotePort=" + state.remotePort)
      continue
    }
    if (/try to connect to server/i.test(line)) {
      if (state.phase !== "connected") setPhase(everConnected ? "reconnecting" : "starting")
      continue
    }
    if (/(login to server failed|connect to server error|cannot connect|start proxy error|i\/o timeout|connection reset|EOF)/i.test(line)) {
      setPhase(everConnected ? "reconnecting" : "error", { lastError: line.slice(0, 300) })
      continue
    }
  }
}

function spawnFrpc() {
  killChild()
  let fd = null
  try { fd = fs.openSync(rt.logPath, "a") } catch (e) { fd = null }
  logFd = fd
  let c = null
  try {
    /* ★坑 6：detached 必须 false；stdout/stderr 进 pipe 是为了「监听 stdout 判状态」，
       同一份字节再原样写进同一个 fd（等于 stdio 落到日志文件），所以日志与判状态两不误。
       绝不 detached —— 否则宿主退出后 frpc 变孤儿，一直占着 remotePort=8899。 */
    c = spawn(rt.frpcPath, ["-c", GEN_TOML_PATH], {
      detached: false,
      windowsHide: true,
      stdio: fd === null ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"]
    })
  } catch (e) {
    setPhase("error", { lastError: "拉起 frpc 失败：" + redact(errText(e)) })
    closeLog()
    return
  }
  child = c
  childGen += 1
  const myGen = childGen
  const onData = (d) => {
    const text = stripAnsi(redact(d && typeof d.toString === "function" ? d.toString() : String(d || "")))
    if (logFd !== null) { try { fs.writeSync(logFd, Buffer.from(text, "utf8")) } catch (e) { /* 忽略 */ } }
    classify(text)
  }
  if (c.stdout) c.stdout.on("data", onData)
  if (c.stderr) c.stderr.on("data", onData)
  c.on("error", (e) => {
    if (myGen !== childGen) return
    setPhase("error", { lastError: "frpc 进程出错：" + redact(errText(e)) })
  })
  c.on("exit", (code, sig) => {
    if (myGen !== childGen) return          // 已被 stopTunnel / 换代重启接管，别重复动作
    child = null
    if (state.enabled !== true) return
    const why = "frpc 退出（code=" + code + (sig ? ", signal=" + sig : "") + "）"
    setPhase(everConnected ? "reconnecting" : "error", { lastError: why })
    scheduleRetry()
  })
}

/** 异步起飞：先独占 remotePort，再 spawn。startTunnel() 本身不 await，不挡插件启动。 */
function boot() {
  if (state.enabled !== true) return
  killChild()
  installExitHook()
  setPhase("starting")
  ensureExclusiveTask()
    .then((note) => { if (note) rt.log("[tunnel] " + note); spawnFrpc() })
    .catch((e) => { rt.log("[tunnel] 独占计划任务处理失败（继续拉起）：" + redact(errText(e))); spawnFrpc() })
}

/* ---------------- 对外 API ---------------- */

/** 有没有配隧道 + 状态快照。字段固定 8 个（T-4 / 第128节多 publicUrl），**绝不出现 authToken**。 */
export function tunnelStatus() {
  return {
    enabled: state.enabled === true,
    ready: state.ready === true,
    phase: PHASES.indexOf(state.phase) >= 0 ? state.phase : "disabled",
    lastError: typeof state.lastError === "string" ? state.lastError : "",
    serverAddr: typeof state.serverAddr === "string" ? state.serverAddr : "",
    remotePort: Number(state.remotePort) || 0,
    since: Number(state.since) || 0,
    publicUrl: typeof state.publicUrl === "string" ? state.publicUrl : ""
  }
}

/**
 * 插件启动时调一次。返回**同步**状态快照（拉进程是异步的，phase 会从 starting 自己走）。
 * o = { localPort, log, configPath?, frpcPath?, logPath? }（后三个只有单测/排查才传）。
 */
export function startTunnel(o = {}) {
  const cfgPath = o.configPath || TUNNEL_CONFIG_PATH
  const log = typeof o.log === "function" ? o.log : () => {}
  rt = { log, frpcPath: o.frpcPath || DEFAULT_FRPC, configPath: cfgPath, logPath: o.logPath || LOG_PATH }
  const myStart = ++startGen
  const localPortHint = Number(o.localPort) || 0

  /* ★坑 3：自测短路。device-roster.spec.mjs:360 / preset-info.spec.mjs:326 这些会真跑 apply()，
     不短路的话单测会真的去 spawn frpc，把 remotePort=8899 抢了、还留下残留进程。
     localPort===0（单测传的） / DSH_TUNNEL=0 / node --test 的子进程 一律不拉。 */
  if (localPortHint === 0 || inTestEnv()) {
    state = blankState()
    log("[tunnel] 自测/关闭环境（localPort=" + localPortHint + "）⇒ 不拉起 frpc")
    return tunnelStatus()
  }

  /* 🔴 G58-A · §A4：两层配置合并 —— 手写文件（用户维护的连接参数）打底，
     云端自动文件（register 下发：短号 → type/customDomains/locations/publicUrl）覆盖其上。
     自动文件在 ⇒ 「装上即自动有隧道」，不再需要用户手写配置文件（原来没有手写文件就整条静默关闭）。 */
  const read = readTunnelConfig(cfgPath, o.autoPath || TUNNEL_AUTO_PATH)
  const readErr = read.manualBroken ? read.manualRead.error : (read.autoBroken ? read.autoRead.error : "")
  if (read.exists !== true) {
    /* ★这一条就是「别人机器 / 没配服务器」的默认结局：整条功能静默关闭。 */
    state = blankState()
    log("[tunnel] 没有配置文件 " + cfgPath + "（也没有云端自动文件 " + read.autoPath + "）⇒ 隧道功能关闭")
    return tunnelStatus()
  }
  if (!read.merged || read.merged.enabled !== true) {
    /* 情况 A：文件在但根本不是合法 JSON（手写/自动都坏）⇒ error 让面板显形；
       情况 B：合法但 enabled !== true ⇒ 沿用老语义：静默关闭，只把已知字段填进 state。 */
    const mk = read.merged || {}
    if (!read.merged) {
      state = blankState()
      state.enabled = true
      setPhase("error")
      state.lastError = "隧道配置文件读不了或不是合法 JSON：" + redact(readErr || "")
      state.since = Date.now()
      log("[tunnel] " + state.lastError)
      return tunnelStatus()
    }
    state = blankState()
    state.serverAddr = String(mk.serverAddr || "")
    state.remotePort = Number(mk.remotePort) || 0
    state.publicUrl = normalizePublicUrl(mk.publicUrl)
    log("[tunnel] 配置里 enabled 不是 true ⇒ 隧道功能关闭")
    return tunnelStatus()
  }

  const cfg = read.merged
  /* 自动文件的 enabled 是插件自己写死的 true；手写文件才是用户的开关，两者都认。 */
  const cfgType = String(cfg.type || "").trim().toLowerCase() === "http" ? "http" : "tcp"
  const cfgDomains = (Array.isArray(cfg.customDomains) ? cfg.customDomains : []).map((x) => String(x).trim()).filter((x) => x !== "")
  const cfgLocations = (Array.isArray(cfg.locations) ? cfg.locations : []).map((x) => String(x).trim()).filter((x) => x !== "")
  if (cfg.enabled !== true) {
    state = blankState()
    state.serverAddr = String(cfg.serverAddr || "")
    state.remotePort = Number(cfg.remotePort) || 0
    state.publicUrl = normalizePublicUrl(cfg.publicUrl)
    log("[tunnel] 配置里 enabled 不是 true ⇒ 隧道功能关闭")
    return tunnelStatus()
  }

  const c = {
    serverAddr: String(cfg.serverAddr || "").trim(),
    serverPort: Number(cfg.serverPort) || 0,
    authToken: String(cfg.authToken || ""),
    localPort: Number(cfg.localPort) || localPortHint || 8899,
    remotePort: Number(cfg.remotePort) || 0,
    /* 🔴 G58-A：云端自动文件里这个字段叫 name（cloud.py tunnel_config_for），手写文件叫 proxyName。
       按类型分流取代理名，避免同一台 frps 上多机 "proxy already exists" 互踢：
       · http（公网短号入口）：必须用云端下发的 name = "dsh-<shortId>"，它天然按短号唯一；
         若沿用老手写文件里的 proxyName="dsh-console"，多台机器会全局撞名互踢 ⇒ 故 http 下 name 优先。
       · tcp（老手写配置）：沿用 proxyName 优先，行为零回归（老配置里可能根本没有 name）。 */
    proxyName: pickProxyName(Object.assign({}, cfg, { type: cfgType })),
    /* G58-A：http 类型（公网短号入口）走 customDomains + locations，**不需要 remotePort**。 */
    type: cfgType,
    customDomains: cfgDomains,
    locations: cfgLocations
  }
  secret = c.authToken
  const bad = []
  if (c.serverAddr === "") bad.push("serverAddr")
  if (!(c.serverPort > 0 && c.serverPort < 65536)) bad.push("serverPort")
  if (c.authToken === "") bad.push("authToken")
  if (!(c.localPort > 0 && c.localPort < 65536)) bad.push("localPort")
  /* 🔴 http 类型豁免 remotePort 校验：它靠 customDomains/locations 分派，没有 remotePort 这个字段。
     tcp 仍是硬要求 —— 老手写配置的校验一个字没松。 */
  if (c.type === "http") {
    if (!c.customDomains.length) bad.push("customDomains")
    if (!c.locations.length) bad.push("locations")
  } else if (!(c.remotePort > 0 && c.remotePort < 65536)) bad.push("remotePort")

  /* 🔴 第 128 节：公网唯一入口（Caddy 443 反代 → 隧道 → 本机 8899）由配置的 publicUrl 下发，
     规范化失败一律空串（不抛、不写 error phase）。 */
  const pubUrl = normalizePublicUrl(cfg.publicUrl)
  state = {
    enabled: true,
    ready: false,
    phase: "starting",
    lastError: "",
    serverAddr: c.serverAddr,
    remotePort: c.remotePort,
    since: Date.now(),
    publicUrl: pubUrl
  }
  if (bad.length) {
    setPhase("error", { lastError: "隧道配置缺字段/非法：" + bad.join("、") })
    log("[tunnel] " + state.lastError)
    return tunnelStatus()
  }
  if (!fs.existsSync(rt.frpcPath)) {
    /* 🔴 第215节 · 修法3：以前这里直接 setPhase("error","找不到 frpc") 收工 —— 对**别人机器**来说
       那是必然结局（老默认路径是开发机专用的），面板还看不到原因、兑换/开通都白搭。
       现在先让 frpc-bootstrap 从云端取一个（下载 + sha256 校验 + 原子落盘），拿到再拉。
       这里**故意先返回 "starting"**：面板不会先闪一下 error 再变回 starting；
       真结论（下载失败 ⇒ error + 原因 / 成功 ⇒ starting 继续）由 ensureThenShell() 落定。 */
    ensureThenShell(c, myStart)
    return tunnelStatus()
  }
  try {
    writeToml(c)
  } catch (e) {
    setPhase("error", { lastError: "写 frpc 配置失败：" + redact(errText(e)) })
    log("[tunnel] " + state.lastError)
    return tunnelStatus()
  }
  everConnected = false
  retryCount = 0
  boot()
  return tunnelStatus()
}

/**
 * 🔴 第215节：frpc 不在 ⇒ 先下载再拉起。全程不抛（ensureFrpc 已把异常收成 {ok:false,reason,error}）。
 * myStart 是这轮 startTunnel 的序号：下载是异步的，若期间宿主退出/重启（stopTunnel 或新的 startTunnel），
 * 结果一律丢弃，绝不在「已经不算数」的这一轮上 boot()。
 */
async function ensureThenShell(c, myStart) {
  const target = rt.frpcPath
  const log = rt.log
  let r = null
  try {
    r = await ensureFrpc({ frpcPath: target, log })
  } catch (e) {
    r = { ok: false, reason: 'io', error: errText(e) }
  }
  if (myStart !== startGen) return
  if (!r || r.ok !== true) {
    setPhase("error", { lastError: "缺少 frpc 且自动下载失败：" + redact((r && r.error) || "未知原因") })
    log("[tunnel] " + state.lastError)
    return
  }
  /* 🔴 第215节：引导可能回一个**别的路径**（用户机器上已有的老位置 frpc，或刚下载到托管目录）。
     必须把它写回 rt.frpcPath —— 否则 writeToml/boot 仍拿着原来那个不存在的路径去 spawn。 */
  if (r.path && r.path !== rt.frpcPath) {
    if (r.legacy === true) log("[tunnel] 用机器上已有的 frpc：" + r.path)
    rt.frpcPath = r.path
  }
  if (r.downloaded === true) log("[tunnel] frpc 已就绪：" + r.path + "（" + Number(r.size || 0) + " 字节）")
  try {
    writeToml(c)
  } catch (e) {
    setPhase("error", { lastError: "写 frpc 配置失败：" + redact(errText(e)) })
    log("[tunnel] " + state.lastError)
    return
  }
  everConnected = false
  retryCount = 0
  boot()
}

/** 插件卸载 / 宿主退出时调一次：停重试、杀子进程、关日志 fd、状态回 disabled。 */
export function stopTunnel() {
  /* 🔴 第215节：+1 作废「正在下载 frpc」的那一轮 —— 否则下载完成后 ensureThenShell 仍会 boot()，
     宿主都退出了却冒出一个孤儿 frpc 占着 remotePort。 */
  startGen++
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  killChild()
  closeLog()
  everConnected = false
  retryCount = 0
  state = blankState()
  return tunnelStatus()
}
