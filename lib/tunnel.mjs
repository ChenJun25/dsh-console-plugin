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
 *   ④ 状态对象 tunnelStatus() 固定 7 个字段，**绝不出现 authToken**。
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

/* ---------------- 常量 ---------------- */

/** 用户机上的隧道配置（含 authToken，只在用户自己机器上）。 */
export const TUNNEL_CONFIG_PATH = path.join(os.homedir(), ".dsh", "dsh-console-tunnel.json")
const GEN_TOML_PATH = path.join(os.homedir(), ".dsh", "dsh-console-frpc.toml")
const LOG_PATH = path.join(os.homedir(), ".dsh", "dsh-console-tunnel.log")
const DEFAULT_FRPC = process.platform === 'win32' ? 'C:\\Program Files\\dsh-frp\\frpc.exe' : 'frpc'

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
    since: 0
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

/** 由 JSON 配置生成 frpc 的 toml 文本（字段结构照 C:\Program Files\dsh-frp\frpc.toml）。 */
function tomlText(c) {
  const q = (v) => '"' + String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
  return [
    "# DSH控制台 · 插件自动生成，每次启动覆盖，请勿手改（改 ~/.dsh/dsh-console-tunnel.json）。",
    "serverAddr = " + q(c.serverAddr),
    "serverPort = " + Number(c.serverPort),
    'auth.method = "token"',
    "auth.token = " + q(c.authToken),
    "",
    "[[proxies]]",
    "name = " + q(c.proxyName),
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    "localPort = " + Number(c.localPort),
    "remotePort = " + Number(c.remotePort),
    ""
  ].join("\n")
}

/**
 * 写 frpc 配置。★坑 2：必须传 Buffer。
 * 传字符串时若哪天上游给它带上 BOM，frpc 0.62 会把它当 JSON 解析并直接崩：
 *   error unmarshaling JSON: ... cannot unmarshal string into Go value of type v1.ClientConfig
 * 也绝不能用 PowerShell 的 Set-Content -Encoding UTF8（Windows PowerShell 5 会写 BOM）。
 */
function writeToml(c) {
  const buf = Buffer.from(tomlText(c), "utf8")
  fs.writeFileSync(GEN_TOML_PATH, buf, { mode: 0o600 })
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

/** 有没有配隧道 + 状态快照。字段固定 7 个（T-4），**绝不出现 authToken**。 */
export function tunnelStatus() {
  return {
    enabled: state.enabled === true,
    ready: state.ready === true,
    phase: PHASES.indexOf(state.phase) >= 0 ? state.phase : "disabled",
    lastError: typeof state.lastError === "string" ? state.lastError : "",
    serverAddr: typeof state.serverAddr === "string" ? state.serverAddr : "",
    remotePort: Number(state.remotePort) || 0,
    since: Number(state.since) || 0
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
  const localPortHint = Number(o.localPort) || 0

  /* ★坑 3：自测短路。device-roster.spec.mjs:360 / preset-info.spec.mjs:326 这些会真跑 apply()，
     不短路的话单测会真的去 spawn frpc，把 remotePort=8899 抢了、还留下残留进程。
     localPort===0（单测传的） / DSH_TUNNEL=0 / node --test 的子进程 一律不拉。 */
  if (localPortHint === 0 || inTestEnv()) {
    state = blankState()
    log("[tunnel] 自测/关闭环境（localPort=" + localPortHint + "）⇒ 不拉起 frpc")
    return tunnelStatus()
  }

  const read = readConfig(cfgPath)
  if (read.exists !== true) {
    /* ★这一条就是「别人机器 / 没配服务器」的默认结局：整条功能静默关闭。 */
    state = blankState()
    log("[tunnel] 没有配置文件 " + cfgPath + " ⇒ 隧道功能关闭")
    return tunnelStatus()
  }
  if (read.ok !== true) {
    state = blankState()
    state.enabled = true
    setPhase("error")
    state.lastError = "隧道配置文件读不了或不是合法 JSON：" + redact(read.error || "")
    state.since = Date.now()
    log("[tunnel] " + state.lastError)
    return tunnelStatus()
  }

  const cfg = read.cfg
  if (cfg.enabled !== true) {
    state = blankState()
    state.serverAddr = String(cfg.serverAddr || "")
    state.remotePort = Number(cfg.remotePort) || 0
    log("[tunnel] 配置里 enabled 不是 true ⇒ 隧道功能关闭")
    return tunnelStatus()
  }

  const c = {
    serverAddr: String(cfg.serverAddr || "").trim(),
    serverPort: Number(cfg.serverPort) || 0,
    authToken: String(cfg.authToken || ""),
    localPort: Number(cfg.localPort) || localPortHint || 8899,
    remotePort: Number(cfg.remotePort) || 0,
    proxyName: String(cfg.proxyName || "dsh-console").trim() || "dsh-console"
  }
  secret = c.authToken
  const bad = []
  if (c.serverAddr === "") bad.push("serverAddr")
  if (!(c.serverPort > 0 && c.serverPort < 65536)) bad.push("serverPort")
  if (c.authToken === "") bad.push("authToken")
  if (!(c.localPort > 0 && c.localPort < 65536)) bad.push("localPort")
  if (!(c.remotePort > 0 && c.remotePort < 65536)) bad.push("remotePort")

  state = {
    enabled: true,
    ready: false,
    phase: "starting",
    lastError: "",
    serverAddr: c.serverAddr,
    remotePort: c.remotePort,
    since: Date.now()
  }
  if (bad.length) {
    setPhase("error", { lastError: "隧道配置缺字段/非法：" + bad.join("、") })
    log("[tunnel] " + state.lastError)
    return tunnelStatus()
  }
  if (!fs.existsSync(rt.frpcPath)) {
    setPhase("error", { lastError: "找不到 frpc：" + rt.frpcPath })
    log("[tunnel] " + state.lastError)
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

/** 插件卸载 / 宿主退出时调一次：停重试、杀子进程、关日志 fd、状态回 disabled。 */
export function stopTunnel() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  killChild()
  closeLog()
  everConnected = false
  retryCount = 0
  state = blankState()
  return tunnelStatus()
}
