import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { frpcTargetPath, ensureFrpc } from './frpc-bootstrap.mjs'

export const TUNNEL_CONFIG_PATH = path.join(os.homedir(), ".dsh", "dsh-console-tunnel.json")
const GEN_TOML_PATH = path.join(os.homedir(), ".dsh", "dsh-console-frpc.toml")
const LOG_PATH = path.join(os.homedir(), ".dsh", "dsh-console-tunnel.log")

export const TUNNEL_AUTO_PATH = path.join(os.homedir(), ".dsh", "dsh-console-tunnel.auto.json")

const DEFAULT_FRPC = frpcTargetPath() || (process.platform === 'win32' ? 'frpc.exe' : 'frpc')

const PHASES = ['disabled', 'starting', 'connected', 'reconnecting', 'error']
const RETRY_MS = 5000
const RETRY_MAX_MS = 30000

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
let secret = ""
let rt = { log: () => {}, frpcPath: DEFAULT_FRPC, configPath: TUNNEL_CONFIG_PATH, logPath: LOG_PATH }

let startGen = 0

function errText(e) { return String((e && e.message) || e || "") }

function stripAnsi(text) {
  return String(text == null ? "" : text).replace(/\u001b\[[0-9;]*m/g, "")
}

function inTestEnv() {
  if (process.env.DSH_TUNNEL === '0') return true
  if (process.env.NODE_TEST_CONTEXT) return true
  try {
    if ((process.execArgv || []).some((a) => String(a).indexOf('--test') >= 0)) return true
  } catch (e) {  }
  const entry = String(process.argv[1] || '')
  if (/\.spec\.mjs$/i.test(entry)) return true
  if (/[\\/](?:test|tests)[\\/]/i.test(entry)) return true
  return false
}

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

function readConfig(p) {
  let raw = null
  try {
    raw = fs.readFileSync(p, "utf8")
  } catch (e) {
    if (e && e.code === "ENOENT") return { exists: false }
    return { exists: true, ok: false, error: errText(e) }
  }
  try {

    const j = JSON.parse(String(raw).replace(/^\uFEFF/, ""))
    if (!j || typeof j !== "object" || Array.isArray(j)) return { exists: true, ok: false, error: "内容不是 JSON 对象" }
    return { exists: true, ok: true, cfg: j }
  } catch (e) {
    return { exists: true, ok: false, error: errText(e) }
  }
}

function normalizePublicUrl(x) {
  const s = String(x == null ? "" : x).trim()
  if (!/^https?:\/\//i.test(s)) return ""
  return s.replace(/\/+$/, "")
}

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

export function readTunnelConfig(cfgPath = TUNNEL_CONFIG_PATH, autoPath = TUNNEL_AUTO_PATH) {
  const manualRead = readConfig(cfgPath)
  const autoRead = readConfig(autoPath)
  const manual = manualRead.exists === true && manualRead.ok === true ? manualRead.cfg : null
  const auto = autoRead.exists === true && autoRead.ok === true ? autoRead.cfg : null

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

    exists: manualRead.exists === true || autoRead.exists === true,
    manualBroken: manualRead.exists === true && manualRead.ok !== true,
    autoBroken: autoRead.exists === true && autoRead.ok !== true
  }
}

export function pickProxyName(cfg) {
  const c = cfg || {}
  const t = String(c.type || "").trim().toLowerCase() === "http" ? "http" : "tcp"
  const picked = t === "http" ? (c.name || c.proxyName) : (c.proxyName || c.name)
  return String(picked || "dsh-console").trim() || "dsh-console"
}

export function writeToml(c, tomlPath = GEN_TOML_PATH) {
  const buf = Buffer.from(tomlText(c), "utf8")
  fs.writeFileSync(tomlPath, buf, { mode: 0o600 })
}

function closeLog() {
  if (logFd !== null) { try { fs.closeSync(logFd) } catch (e) {  } logFd = null }
}

function killChild() {
  const c = child
  child = null
  childGen += 1
  if (c) { try { c.kill() } catch (e) {  } }
}

function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  try {
    process.on("exit", () => {
      const c = child
      child = null
      childGen += 1
      if (c) { try { c.kill() } catch (e) {  } }
      closeLog()
    })
  } catch (e) {  }
}

function ensureExclusiveTask() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve("")

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
  if (retryTimer.unref) retryTimer.unref()
}

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
    if (logFd !== null) { try { fs.writeSync(logFd, Buffer.from(text, "utf8")) } catch (e) {  } }
    classify(text)
  }
  if (c.stdout) c.stdout.on("data", onData)
  if (c.stderr) c.stderr.on("data", onData)
  c.on("error", (e) => {
    if (myGen !== childGen) return
    setPhase("error", { lastError: "frpc 进程出错：" + redact(errText(e)) })
  })
  c.on("exit", (code, sig) => {
    if (myGen !== childGen) return
    child = null
    if (state.enabled !== true) return
    const why = "frpc 退出（code=" + code + (sig ? ", signal=" + sig : "") + "）"
    setPhase(everConnected ? "reconnecting" : "error", { lastError: why })
    scheduleRetry()
  })
}

function boot() {
  if (state.enabled !== true) return
  killChild()
  installExitHook()
  setPhase("starting")
  ensureExclusiveTask()
    .then((note) => { if (note) rt.log("[tunnel] " + note); spawnFrpc() })
    .catch((e) => { rt.log("[tunnel] 独占计划任务处理失败（继续拉起）：" + redact(errText(e))); spawnFrpc() })
}

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

export function startTunnel(o = {}) {
  const cfgPath = o.configPath || TUNNEL_CONFIG_PATH
  const log = typeof o.log === "function" ? o.log : () => {}
  rt = { log, frpcPath: o.frpcPath || DEFAULT_FRPC, configPath: cfgPath, logPath: o.logPath || LOG_PATH }
  const myStart = ++startGen
  const localPortHint = Number(o.localPort) || 0

  if (localPortHint === 0 || inTestEnv()) {
    state = blankState()
    log("[tunnel] 自测/关闭环境（localPort=" + localPortHint + "）⇒ 不拉起 frpc")
    return tunnelStatus()
  }

  const read = readTunnelConfig(cfgPath, o.autoPath || TUNNEL_AUTO_PATH)
  const readErr = read.manualBroken ? read.manualRead.error : (read.autoBroken ? read.autoRead.error : "")
  if (read.exists !== true) {

    state = blankState()
    log("[tunnel] 没有配置文件 " + cfgPath + "（也没有云端自动文件 " + read.autoPath + "）⇒ 隧道功能关闭")
    return tunnelStatus()
  }
  if (!read.merged || read.merged.enabled !== true) {

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

    proxyName: pickProxyName(Object.assign({}, cfg, { type: cfgType })),

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

  if (c.type === "http") {
    if (!c.customDomains.length) bad.push("customDomains")
    if (!c.locations.length) bad.push("locations")
  } else if (!(c.remotePort > 0 && c.remotePort < 65536)) bad.push("remotePort")

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

export function stopTunnel() {

  startGen++
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  killChild()
  closeLog()
  everConnected = false
  retryCount = 0
  state = blankState()
  return tunnelStatus()
}
