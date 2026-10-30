import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { startLanServer, inboxDir, safeUploadName, uniquePathIn, decodedBase64Bytes } from './lan-server.mjs'

import { startTunnel, stopTunnel, tunnelStatus } from './tunnel.mjs'
import { attachMp } from './mp-support.mjs'
import { stripAcp } from './mp-contract.mjs'
import { createAttachmentRegistry, mimeOfName } from './attachments.mjs'

import { createMemeGallery } from './meme-gallery.mjs'

import { createCloudLink } from './cloud-link.mjs'

import { createWanMeter, makeWanFetch, WAN_DEFAULT_QUOTA_BYTES, WAN_DEFAULT_UPLOAD_MAX_BYTES } from './wan-meter.mjs'

import { createCloudPlugin, registryList, fetchLatestFromSources } from './dsh-console-cloud.mjs'

import { pushStatus, createPushWatcher, createTurnAnnouncer, sendPush, pushReady } from './hw-push.mjs'

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

function withTitleFallback(raw, v) {
  const t = stripShellText(String(raw || ''))
  if (t) return t
  return subagentLabelOf(v)
}

export const name = 'dsh-console'

export const inject = ['connection', 'sessionController', 'tools']

export const STATE_PATH = '/api/dsh-console/state'

export const NEWCODE_PATH = '/api/dsh-console/newcode'

export const SESSIONS_PATH = '/api/dsh-console/sessions'

export const CMD_PATH = '/api/dsh-console/cmd'

export const DESKTOP_WEB_PATH = '/api/dsh-console/desktop-web'

const PLUGIN_VERSION = (() => {
  try {

    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '?'
  } catch (_) {
    return 'unknown'
  }
})()

let latestVersion = ''
let latestAt = 0
const LATEST_TTL_MS = 10 * 60 * 1000

export function refreshLatestVersion() {
  const ttlRaw = Number(process.env.DSH_CONSOLE_NPM_TTL_MS)
  const ttl = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : LATEST_TTL_MS
  if (Date.now() - latestAt < ttl) return
  latestAt = Date.now()
  const inTest = !!(process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test')

  const raw = process.env.DSH_CONSOLE_NPM_LATEST_URL
  const url = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : ''
  if (url) {
    fetch(url, { signal: AbortSignal.timeout(5000) })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((j) => {
        const v = j && typeof j.version === 'string' ? j.version.trim() : ''
        if (v) latestVersion = v
      })
      .catch(() => {  })
    return
  }
  if (inTest) return
  fetchLatestFromSources(registryList({}), { log: () => {} })
    .then((res) => { if (res && res.version) latestVersion = res.version })
    .catch(() => {  })
}

export function latestVersionNow() { return latestVersion }

export const PUSH_TOKEN_PATH = path.join(os.homedir(), '.dsh', 'dsh-console-push.json')

const PUSH_TOKEN_MAX = 10

function readPushTokens() {
  try {
    const obj = JSON.parse(fs.readFileSync(PUSH_TOKEN_PATH, 'utf8'))
    const list = Array.isArray(obj && obj.tokens) ? obj.tokens : []
    return list.filter((t) => t && typeof t.token === 'string' && t.token)
  } catch (e) {
    return []
  }
}

function writePushTokens(tokens) {
  fs.mkdirSync(path.dirname(PUSH_TOKEN_PATH), { recursive: true })

  const tmp = PUSH_TOKEN_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ tokens }, null, 2))
  fs.renameSync(tmp, PUSH_TOKEN_PATH)
}

export function pushRegister(payload) {
  const p = payload || {}
  const token = typeof p.pushToken === 'string' ? p.pushToken.trim() : ''
  if (!token) return { ok: false, error: 'pushToken 为空' }
  const deviceId = typeof p.deviceId === 'string' ? p.deviceId.trim() : ''
  const deviceModel = typeof p.deviceModel === 'string' ? p.deviceModel.trim() : ''

  const tokens = readPushTokens().filter((t) => t.token !== token)
  tokens.push({ token, deviceId, deviceModel, updatedAt: Date.now() })
  tokens.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
  const kept = tokens.slice(0, PUSH_TOKEN_MAX)
  writePushTokens(kept)
  return { ok: true, count: kept.length }
}

export function pushTokenList() {
  const tokens = readPushTokens().map((t) => ({
    tokenTail: String(t.token).slice(-8),
    deviceId: String(t.deviceId || ''),
    deviceModel: String(t.deviceModel || ''),
    updatedAt: Number(t.updatedAt) || 0,
  }))
  return { ok: true, tokens }
}

export function splitPushTokens(list) {
  const real = []
  const emulator = []
  const arr = Array.isArray(list) ? list : []
  for (const t of arr) {
    if (!t) continue
    const token = (t && typeof t === 'object') ? t.token : t
    const s = String(token == null ? '' : token).trim()
    if (!s) continue
    const model = (t && typeof t === 'object') ? String(t.deviceModel || '').trim().toLowerCase() : ''
    const row = { token: s, deviceModel: model, deviceId: (t && typeof t === 'object') ? String(t.deviceId || '') : '' }
    if (model === 'emulator') emulator.push(row)
    else real.push(row)
  }
  return { real, emulator }
}

export function pushTestMessage() {
  try {
    const v = String(process.env.DSH_HW_PUSH_TEST || '').trim().toLowerCase()

    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
    const obj = JSON.parse(fs.readFileSync(PUSH_TOKEN_PATH, 'utf8'))
    if (obj && typeof obj.testMessage === 'boolean') return obj.testMessage
  } catch (e) {  }

  return false
}

export function apply(ctx, config = {}) {

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
      try { fs.appendFileSync(LOG_FILE, line + '\n') } catch (e) {  }
    }
    try {
      if (logger && typeof logger[level] === 'function') logger[level](line)
      else console.log(line)
    } catch (e) {  }
  }
  const log = (m) => say('info', m)
  log('==== 插件加载 ==== version=' + PLUGIN_VERSION + ' config=' + JSON.stringify({
    port: config.port, allowShiftPort: config.allowShiftPort, name: config.name
  }))

  let presetProbe = { available: false, current: '', probed: false }

  function probePreset() {
    if (presetProbe.probed) return
    try {

      const reg = ctx && typeof ctx.get === 'function'
        ? (ctx.get('agentPresets') || ctx.get('agent-preset-registry'))
        : null
      if (!reg) return
      presetProbe.probed = true
      presetProbe.available = true
      const keys = Object.keys(reg)
      log('[preset-probe] service keys=' + JSON.stringify(keys))

      const v = presetCurrentId(reg)
      presetProbe.current = v
      log('[preset-probe] current=' + JSON.stringify(v).slice(0, 100))
    } catch (e) {
      log('[preset-probe] failed: ' + ((e && e.message) || e))
    }
  }

  function readPresetNow() {
    probePreset()
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

  const nodeName = String(config.name || process.env.DSH_CONSOLE_NAME || os.hostname() || '我的电脑')

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

    try { fs.renameSync(tokenFile, tokenFile + '.corrupt-' + Date.now()) } catch (_) {  }
    log('访问码文件读不了（' + (e && e.message ? e.message : e) + '），重新生成 —— 手机需要重新配对一次')
  }
  if (!token) {
    token = String(config.token || process.env.DSH_CONSOLE_TOKEN || randomHex(32))
    try {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true })
      fs.writeFileSync(tokenFile, JSON.stringify({ token }, null, 2), { mode: 0o600 })
      log('访问码已持久化到 ' + tokenFile)
    } catch (e) {

      log('访问码写盘失败（' + (e && e.message ? e.message : e) + '），退回内存模式 —— 重启后需要重新配对')
    }
  }

  const remotePairFile = path.join(os.homedir(), '.dsh', 'dsh-console-remote-pair.json')
  let remotePairState = config.allowRemotePair === true
  try {
    if (fs.existsSync(remotePairFile)) {
      const parsed = JSON.parse(fs.readFileSync(remotePairFile, 'utf8'))
      if (parsed && typeof parsed.on === 'boolean') remotePairState = parsed.on
    }
  } catch (e) {

    try { fs.renameSync(remotePairFile, remotePairFile + '.corrupt-' + Date.now()) } catch (_) {  }
    log('异地配对开关文件读不了（' + ((e && e.message) || e) + '），按默认关闭处理')
  }

  const remotePairOn = () => remotePairState === true

  const setRemotePair = (next) => {
    remotePairState = next === true
    try {
      fs.mkdirSync(path.dirname(remotePairFile), { recursive: true })
      fs.writeFileSync(remotePairFile, JSON.stringify({ on: remotePairState }, null, 2), { mode: 0o600 })
      return true
    } catch (e) {
      log('异地配对开关写盘失败（' + ((e && e.message) || e) + '）：本次生效，重启后回默认')
      return false
    }
  }

  const masterFile = path.join(os.homedir(), '.dsh', 'dsh-console-master.json')
  let masterState = config.allowConnect !== false
  try {
    if (fs.existsSync(masterFile)) {
      const parsed = JSON.parse(fs.readFileSync(masterFile, 'utf8'))
      if (parsed && typeof parsed.on === 'boolean') masterState = parsed.on
    }
  } catch (e) {
    try { fs.renameSync(masterFile, masterFile + '.corrupt-' + Date.now()) } catch (_) {  }
    log('总开关文件读不了（' + ((e && e.message) || e) + '），按默认开启处理')
  }

  const masterOn = () => masterState !== false

  const setMaster = (next) => {
    masterState = next !== false
    try {
      fs.mkdirSync(path.dirname(masterFile), { recursive: true })
      fs.writeFileSync(masterFile, JSON.stringify({ on: masterState }, null, 2), { mode: 0o600 })
      return true
    } catch (e) {
      log('总开关写盘失败（' + ((e && e.message) || e) + '）：本次生效，重启后回默认')
      return false
    }
  }

  const ctl = ctx && typeof ctx.get === 'function' ? ctx.get('sessionController') : null

  const reg = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null
  let dshOk = !!ctl
  let dshError = ctl ? '' : 'sessionController 不可用'

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

  const pending = []

  const live = new Map()
  const LIVE_TEXT_CAP = 300000

  const LAN_TOOL_DETAIL_MAX = envInt('DSH_MP_LAN_TOOL_DETAIL_MAX', 200000)
  const LAN_BRIEF_MAX = envInt('DSH_MP_LAN_BRIEF_MAX', 400)
  const LAN_THINK_STEP_MAX = envInt('DSH_MP_LAN_THINK_STEP_MAX', 1000000)
  const LAN_THINK_STEPS_TOTAL = envInt('DSH_MP_LAN_THINK_STEPS_TOTAL', 4000000)
  const LAN_TRACE_TEXT_MAX = envInt('DSH_MP_LAN_TRACE_TEXT_MAX', 20000)
  const LAN_TRACE_MAX = envInt('DSH_MP_LAN_TRACE_MAX', 20000)
  const LAN_LIVE_TEXT_CAP = envInt('DSH_MP_LAN_LIVE_TEXT_CAP', 4194304)
  const LAN_LIVE_TEXT_KEEP = envInt('DSH_MP_LAN_LIVE_TEXT_KEEP', 2000000)
  const LAN_LIVE_TOOLS_KEEP = envInt('DSH_MP_LAN_LIVE_TOOLS_KEEP', 200)
  const LAN_LIVE_ACTS_KEEP = envInt('DSH_MP_LAN_LIVE_ACTS_KEEP', 400)

  const DETAIL_MAX_BYTES = envInt('DSH_CONSOLE_DETAIL_MAX_BYTES', 0)

  function wantDetailTrace() {
    const v = String((process.env && process.env.DSH_CONSOLE_DETAIL_TRACE) || '').trim().toLowerCase()
    return v === '1' || v === 'true' || v === 'yes' || v === 'on'
  }

  const attachments = createAttachmentRegistry({
    store: () => (typeof ctx.get === 'function' ? ctx.get('attachments') : null),
    log: log
  })

  const memes = createMemeGallery({ log: log })

  function imageRefsOf(content) {
    if (!Array.isArray(content)) return []
    const out = []
    for (const b of content) {
      if (b && b.type === 'image' && b.attachment) out.push(b.attachment)
    }
    return out
  }

  const LOCAL_IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?|ico)$/i

  const LOCAL_IMG_EXT_ANY_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?|ico)/i

  const LOCAL_IMG_PER_TURN = 20

  const LOCAL_IMG_MAX_BYTES = 8 * 1024 * 1024

  function localImagePathOf(dest) {
    let s = String(dest || '').trim()
    if (!s) return ''

    if (s.charAt(0) === '<' && s.charAt(s.length - 1) === '>') s = s.slice(1, -1).trim()
    s = s.split('#')[0].split('?')[0].trim()

    const cut = /^(\S+)\s+["'(]/.exec(s)
    if (cut) s = cut[1]
    if (/^file:\/\//i.test(s)) s = s.replace(/^file:\/\//i, '')
    if (!LOCAL_IMG_EXT_RE.test(s)) return ''

    if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1)

    if (!path.isAbsolute(s)) return ''
    return s.replace(/\//g, path.sep)
  }

  function registerLocalImageDest(dest) {
    const fp = localImagePathOf(dest)
    if (!fp) return ''
    try {
      const st = fs.statSync(fp)
      if (!st.isFile() || st.size <= 0 || st.size > LOCAL_IMG_MAX_BYTES) return ''
      return attachments.registerLocalBytes(fs.readFileSync(fp), { name: path.basename(fp) }) || ''
    } catch (e) { return '' }
  }

  function localImagesOf(text, limit) {
    const raw = String(text == null ? '' : text)
    const res = { ids: [], rmd: raw, changed: false }
    if (!raw || limit <= 0) return res

    const meme = memes.apply(raw, (fp, name) => {
      if (res.ids.length >= limit) return ''
      try {
        const st = fs.statSync(fp)
        if (!st.isFile() || st.size <= 0 || st.size > LOCAL_IMG_MAX_BYTES) return ''
        const id = attachments.registerLocalBytes(fs.readFileSync(fp), { name: name }) || ''
        if (!id) return ''
        if (res.ids.indexOf(id) < 0) res.ids.push(id)
        return id
      } catch (e) { return '' }
    })
    if (meme.changed) { res.rmd = meme.rmd; res.changed = true }
    const base = meme.changed ? meme.rmd : raw

    if (!LOCAL_IMG_EXT_ANY_RE.test(base)) return res
    const ids = res.ids
    const reg = (dest) => {
      if (ids.length >= limit) return ''
      const id = registerLocalImageDest(dest)
      if (!id) return ''
      if (ids.indexOf(id) < 0) ids.push(id)
      return id
    }

    const rmd = base.replace(/!\[([^\]]*)\]\(\s*([^)]+?)\s*\)/g, (whole, alt, dest) => {
      const id = reg(dest)
      return id ? '![' + alt + '](dshimg:' + id + ')' : whole
    })

    const linked = rmd.replace(/(?<!!)\[([^\]\n]*)\]\(\s*([^)\n]+?)\s*\)/g, (whole, text, dest) => {
      if (dest.indexOf('dshimg:') === 0) return whole
      const id = reg(dest)
      return id ? '[' + text + '](dshimg:' + id + ')' : whole
    })

    for (const line of base.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      if (t.charAt(0) === '!' || t.indexOf('](') >= 0) continue
      reg(t)
    }
    res.rmd = linked
    if (linked !== base) res.changed = true
    return res
  }

  function localImageIdsOf(text, limit) {
    return localImagesOf(text, limit).ids
  }

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

    return stripAcp(s)
  }

  function isWanScope(meta) {
    return !!(meta && typeof meta === 'object' && meta.wan === true)
  }

  function capsFor(wan) {
    if (wan) {
      return {
        toolDetail: TOOL_DETAIL_MAX, brief: BRIEF_MAX,
        thinkStep: THINK_STEP_MAX, thinkTail: THINK_TAIL_STEP_MAX,
        thinkMax: THINK_MAX, thinkStepsTotal: THINK_STEPS_TOTAL,
        traceText: TRACE_TEXT_MAX, traceMax: TRACE_MAX,
        liveTextCap: LIVE_TEXT_CAP, liveTextKeep: 100000,
        liveToolsKeep: LIVE_TOOLS_KEEP, liveActsKeep: ACTS_KEEP
      }
    }
    return {
      toolDetail: LAN_TOOL_DETAIL_MAX, brief: LAN_BRIEF_MAX,
      thinkStep: LAN_THINK_STEP_MAX, thinkTail: LAN_THINK_STEP_MAX,
      thinkMax: LAN_THINK_STEP_MAX, thinkStepsTotal: LAN_THINK_STEPS_TOTAL,
      traceText: LAN_TRACE_TEXT_MAX, traceMax: LAN_TRACE_MAX,
      liveTextCap: LAN_LIVE_TEXT_CAP, liveTextKeep: LAN_LIVE_TEXT_KEEP,
      liveToolsKeep: LAN_LIVE_TOOLS_KEEP, liveActsKeep: LAN_LIVE_ACTS_KEEP
    }
  }

  function trimLiveTools(L, wan) {
    if (!L || !Array.isArray(L.tools)) return
    const keep = capsFor(wan === true).liveToolsKeep
    if (L.tools.length <= keep) return
    const drop = L.tools.length - keep
    L.tools = L.tools.slice(drop)
    const out = []
    for (const s of (L.steps || [])) {
      if (!s || s.k !== 'o') { out.push(s); continue }
      const ni = (Number(s.i) || 0) - drop
      if (ni >= 0) out.push({ k: 'o', i: ni, s: Number(s.s) || 0 })
    }
    L.steps = out
  }

  function pushAct(L, name, args, time, subCallId, wan) {
    if (!L || !name) return
    if (!Array.isArray(L.acts)) L.acts = []
    L.acts.push({
      name: String(name),
      state: 'run',

      sub: String(subCallId || ''),

      detail: stripShellText(briefOf(typeof args === 'string' ? args : (() => {
        try { return JSON.stringify(args || '') } catch (e) { return '' }
      })(), wan === true)),
      at: Number(time) || Date.now()
    })
    const actsKeep = capsFor(wan === true).liveActsKeep
    if (L.acts.length > actsKeep) L.acts = L.acts.slice(L.acts.length - actsKeep)
  }

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

  function settleActs(L) {
    if (!L || !Array.isArray(L.acts)) return
    for (const a of L.acts) if (a && a.state === 'run') a.state = 'done'
  }

  const DM_NS = 'agent-default-model'
  let dmPending = null
  let dmTimer = null
  let dmRetry = 0
  let dmBackedUp = false

  function dmPatchCandidates() {
    const out = []
    const envPath = process.env && process.env.DSH_DM_PATCH
    if (envPath) out.push(envPath)

    try {
      const pc = typeof ctx.get === 'function' ? ctx.get('profileContext') : null
      if (pc && typeof pc.patchPath === 'string' && pc.patchPath) out.push(pc.patchPath)
    } catch (e) { }
    try {
      const home = path.join(os.homedir(), '.dsh')
      out.push(path.join(home, 'cordis.patch.yml'))
      const root = path.join(home, 'profiles')
      if (fs.existsSync(root)) {
        for (const name of fs.readdirSync(root)) out.push(path.join(root, name, 'cordis.patch.yml'))
      }
    } catch (e) { }
    return out
  }

  function dmFindPatch() {
    const cands = dmPatchCandidates()
    let best = null
    for (let i = 0; i < cands.length; i++) {
      const p = cands[i]
      try {
        if (!fs.existsSync(p)) continue
        const t = fs.readFileSync(p, 'utf8')
        if (!/^- id:\s*['\"]?agent-default-model['\"]?\s*$/m.test(t)) continue
        if (i === 0) return { path: p, text: t }
        const m = fs.statSync(p).mtimeMs || 0
        if (!best || m > best.m) best = { path: p, text: t, m: m }
      } catch (e) { }
    }
    return best
  }

  function dmRewrite(text, sel) {
    const lines = text.split('\n')
    let start = -1
    for (let i = 0; i < lines.length; i++) {
      if (/^- id:\s*['\"]?agent-default-model['\"]?\s*$/.test(lines[i])) { start = i; break }
    }
    if (start < 0) return null
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) if (/^- id:/.test(lines[i])) { end = i; break }
    let cfg = -1
    for (let i = start + 1; i < end; i++) if (/^ {2}config:\s*$/.test(lines[i])) { cfg = i; break }
    if (cfg < 0) return null
    let cfgEnd = end
    for (let i = cfg + 1; i < end; i++) {
      const l = lines[i]
      if (l.trim() === '') continue
      if (!/^ {4,}\S/.test(l)) { cfgEnd = i; break }
    }
    const want = [['provider', sel.provider], ['model', sel.model]]
    if (sel.reasoningEffort) want.push(['reasoningEffort', String(sel.reasoningEffort)])

    for (const pair of want) {
      if (typeof pair[1] !== 'string' || !pair[1] || /[\r\n]/.test(pair[1])) return null
    }
    const out = lines.slice()
    for (const pair of want) {
      const k = pair[0]
      const v = pair[1]
      if (typeof v !== 'string' || !v) continue
      if (/[\r\n]/.test(v)) continue
      let found = -1
      for (let i = cfg + 1; i < cfgEnd; i++) {
        const m = /^(\s+)([A-Za-z0-9_-]+):\s*(.*)$/.exec(out[i])
        if (m && m[2] === k) { found = i; break }
      }
      const line = '    ' + k + ': ' + v
      if (found >= 0) out[found] = line
      else { out.splice(cfgEnd, 0, line); cfgEnd++ }
    }
    if (!sel.reasoningEffort) {
      for (let i = cfg + 1; i < cfgEnd; i++) {
        if (/^ {4}reasoningEffort:\s*\S/.test(out[i])) { out.splice(i, 1); cfgEnd--; break }
      }
    }
    const next = out.join('\n')
    return next === text ? null : next
  }

  function dmFlush() {
    dmTimer = null
    const sel = dmPending
    if (!sel || !sel.provider || !sel.model) return

    if (live.size > 0 && dmRetry < 400) {
      dmRetry++
      dmTimer = setTimeout(dmFlush, 3000)
      if (typeof dmTimer.unref === 'function') dmTimer.unref()
      return
    }
    const hit = dmFindPatch()
    if (!hit) { log('[默认模型] 没找到含 agent-default-model 的 patch 文件，跳过落盘') ; return }
    let next = null
    try { next = dmRewrite(hit.text, sel) } catch (e) { log('[默认模型] 改写 patch 失败: ' + ((e && e.message) || e)); return }
    if (next === null) return
    try {
      if (!dmBackedUp) {
        dmBackedUp = true
        const bk = hit.path + '.bak-plugin-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
        try { fs.writeFileSync(bk, hit.text, 'utf8') } catch (e) { }
      }
      const tmp = hit.path + '.tmp-plugin-' + process.pid
      fs.writeFileSync(tmp, next, 'utf8')
      fs.renameSync(tmp, hit.path)
      log('[默认模型] 已写回 ' + hit.path + ' → ' + String(sel.provider) + ' / ' + String(sel.model) + (sel.reasoningEffort ? ' / ' + String(sel.reasoningEffort) : ''))
    } catch (e) {
      log('[默认模型] 写 patch 失败: ' + ((e && e.message) || e))
    }
  }

  function dmKick(data) {
    const d = data && typeof data === 'object' ? data : {}
    const provider = typeof d.provider === 'string' ? d.provider : ''
    const model = typeof d.model === 'string' ? d.model : ''
    if (!provider || !model) return
    const effort = typeof d.reasoningEffort === 'string' ? d.reasoningEffort : ''
    dmPending = { provider: provider, model: model, reasoningEffort: effort }
    dmRetry = 0
    if (dmTimer) clearTimeout(dmTimer)
    dmTimer = setTimeout(dmFlush, 800)
    if (typeof dmTimer.unref === 'function') dmTimer.unref()
  }

  let turnAnnouncer = null
  let busHooked = false

  let liveDiagOnce = false
  const onSessionEvent = (session, ev) => {
    try {
      if (!session || !ev || typeof ev !== 'object') return

      const sid = session.id || (session.header && session.header.id)
      if (!sid) return

      const caps = capsFor(false)
      if (!liveDiagOnce) {
        liveDiagOnce = true
        log('[live] 收到首个 session/event: type=' + ev.type + ' session=' + String(sid).slice(0, 8) + '…（总线确认在响）')
      }
      if (ev.type === 'turn/start') {

        if (turnAnnouncer) turnAnnouncer.hold(sid)
        live.set(sid, { think: '', text: '', rmd: '', thinks: [], steps: [], tools: [], acts: [], images: [], aimages: [], startedMs: evMs(ev), lastAt: Number(ev.time) || Date.now() })
        return
      }
      if (ev.type === 'turn/end') {
        live.delete(sid)

        if (turnAnnouncer) { try { turnAnnouncer.ping(sid) } catch (e) { } }
        return
      }
      if (ev.type === 'model/selection') { dmKick(ev.data || {}); return }

      const L0 = live.get(sid)
      const L = L0 || (() => { const n = { think: '', text: '', rmd: '', thinks: [], steps: [], tools: [], acts: [], images: [], aimages: [], startedMs: evMs(ev), lastAt: 0 }; live.set(sid, n); return n })()
      if (!Array.isArray(L.acts)) L.acts = []
      if (ev.type === 'assistant/message') {

        L.text = ''
        L.think = ''

        L.thinks = []
        L.steps = []
        L.images = []
        L.aimages = []

        L.acts = []

        absorbStream(L, ev, { wan: false })
        const rz = streamReasoning(ev)
        if (rz) {
          L.thinks.push(clip(rz, caps.thinkStep))
          L.steps.push({ k: 't', i: 0, s: Number((ev.data || {}).step) || 0 })
        }

        const mImg = ev.data && ev.data.message
        for (const ref of imageRefsOf(mImg && mImg.content)) {
          const iid = attachments.register(ref)

          if (iid && (!L.aimages || L.aimages.indexOf(iid) < 0)) { if (!L.aimages) L.aimages = []; L.aimages.push(iid) }
        }

        const lmd = localImagesOf(L.text, LOCAL_IMG_PER_TURN)
        for (const lid of lmd.ids) {
          if (L.aimages.indexOf(lid) < 0) L.aimages.push(lid)
        }
        L.rmd = lmd.changed ? lmd.rmd : ''
        L.lastAt = Number(ev.time) || Date.now()
        return
      }
      if (ev.type === 'assistant/chunk') {
        const c = ev.data && ev.data.chunk
        if (!c) return
        if (c.type === 'text-delta') L.text += c.text || ''
        else if (c.type === 'reasoning-delta') L.think += c.text || ''

        if (L.text.length > LAN_LIVE_TEXT_CAP) L.text = L.text.slice(-LAN_LIVE_TEXT_KEEP)
        if (L.think.length > LAN_LIVE_TEXT_CAP) L.think = L.think.slice(-LAN_LIVE_TEXT_KEEP)
        L.lastAt = Number(ev.time) || Date.now()
      } else if (ev.type === 'tool/call') {
        const d = ev.data || {}
        let args = d.arguments
        if (typeof args !== 'string') { try { args = JSON.stringify(d.arguments || d.input || '') } catch (e) { args = '' } }
        L.tools.push({
          name: String(d.name || d.tool || '工具'), state: 'run',

          detail: stripShellText(clip(args, caps.toolDetail)), result: '',
          brief: briefOf(args, false)
        })
        L.steps.push({ k: 'o', i: L.tools.length - 1, s: Number(d.step) || 0 })
        trimLiveTools(L, false)
        L.lastAt = Number(ev.time) || Date.now()
      } else if (ev.type === 'tool/result') {
        const d = ev.data || {}
        const m = d.message
        const errInBlocks = Array.isArray(m && m.content) &&
          m.content.some((b) => b && b.type === 'tool-result' && b.isError)
        const last = L.tools && L.tools.length ? L.tools[L.tools.length - 1] : null
        if (last && last.state === 'run') {
          last.state = (d.isError || errInBlocks) ? 'err' : 'done'

          last.result = clip(contentText(m && m.content), caps.toolDetail)
          attachPview(last, d.meta)
        }
        L.lastAt = Number(ev.time) || Date.now()
      } else if (ev.type === 'tool/ptc-dispatch-start') {

        const d = ev.data || {}
        pushAct(L, d.name || d.tool, d.arguments !== undefined ? d.arguments : d.input, ev.time, d.subCallId, false)
        L.lastAt = Number(ev.time) || Date.now()
      } else if (ev.type === 'tool/ptc-dispatch') {

        const d = ev.data || {}
        markActDone(L, d.name || d.tool, d.isError === true || !!d.error, d.subCallId)
        L.lastAt = Number(ev.time) || Date.now()
      }
    } catch (e) {  }
  }
  try {
    if (typeof ctx.on === 'function') {
      const d = ctx.on('session/event', onSessionEvent)
      if (typeof d === 'function') pending.push(d)
      log('已挂 session/event 事件总线（实时生成状态可用）')

      busHooked = true
    } else {
      log('ctx.on 不可用 —— 实时生成状态退回轮询模式')
    }
  } catch (e) {
    log('挂 session/event 失败（实时状态不可用）: ' + ((e && e.message) || e))
  }

  function isEmptySessionRaw(s) {
    if (!s || typeof s !== 'object') return false
    try {
      const values = (s.projections && s.projections.values) || null
      const rawTitle = String((values && values.title) || s.title || '').trim()
      if (rawTitle !== '') return false
      if (s.running) return false
      if (s.parentSessionId !== undefined && s.parentSessionId !== null && String(s.parentSessionId) !== '') return false
      if (s.origin !== undefined && s.origin !== null && String(s.origin) !== '') return false

      try {
        const at = values && values.agentTeam
        if (at && ((Array.isArray(at.members) && at.members.length > 0) ||
                   (Array.isArray(at.tasks) && at.tasks.length > 0))) return false
      } catch (e) {  }

      try {
        const f0 = values && values.titleInput && values.titleInput.first
        const first = (f0 && typeof f0 === 'object') ? String(f0.text || '') : String(f0 || '')
        if (first.trim() !== '') return false
      } catch (e) {  }
      try {
        const ms = values && values.modelSelection
        const cur = (ms && (ms.next || ms.lastUsed)) || null
        if (cur && cur.provider && cur.model) return false
      } catch (e) {  }

      if (s.blank === false) return false
      try {
        const slm = values && values.sessionListMetadata
        if (slm && slm.blank === false) return false
      } catch (e) {  }
      return true
    } catch (e) {
      return false
    }
  }

  const createdAtDiag = { noSvc: false, failed: false }

  const createdAtCache = new Map()

  function applyCreatedAt(items) {
    for (const s of items) {
      if (!s || typeof s !== 'object') continue
      const t = createdAtCache.get(String(s.id || ''))
      if (t) s.createdAt = t
    }
  }

  function withCreatedAt(list) {
    const items = Array.isArray(list) ? list : []
    applyCreatedAt(items)
    let missing = 0
    for (const s of items) {
      if (s && !createdAtCache.has(String(s.id || ''))) missing += 1
    }
    if (missing === 0) return Promise.resolve(items)

    let svc = null
    try {
      svc = ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null
    } catch (e) {
      svc = null
    }
    if (!svc || typeof svc.listSessions !== 'function') {
      if (!createdAtDiag.noSvc) {
        createdAtDiag.noSvc = true
        log('[createdAt] sessionQuery 不可用 —— 创建时间恒为 0（App 侧「本周任务」会退化到自算）')
      }
      return Promise.resolve(items)
    }
    return Promise.resolve()
      .then(() => svc.listSessions(AbortSignal.timeout(15000)))
      .then((records) => {
        for (const rec of (Array.isArray(records) ? records : [])) {
          const h = rec && rec.header
          const id = h && String(h.id || '')
          if (!id) continue
          const t = Number(h.createdAt)

          if (Number.isFinite(t) && t > 0) {

            if (createdAtCache.size > 20000) createdAtCache.clear()
            createdAtCache.set(id, t)
          }
        }
        applyCreatedAt(items)
        return items
      })
      .catch((e) => {
        if (!createdAtDiag.failed) {
          createdAtDiag.failed = true
          log('[createdAt] sessionQuery.listSessions 失败，创建时间缺省 0: ' + ((e && e.message) || e))
        }
        return items
      })
  }

  function readSessions() {
    if (!ctl || typeof ctl.list !== 'function') {
      return Promise.reject(new Error('拿不到会话列表（sessionController 不可用）'))
    }
    return Promise.resolve(ctl.list({}, AbortSignal.timeout(15000)))
      .then((r) => norm(r && r.items ? r.items : r, archiveProjection()))
      .then((list) => withCreatedAt(list))
  }

  const LIST_HIDDEN_ORIGINS = new Set(['subagent'])
  function hiddenOriginOf(s) {
    const o = s && s.origin !== undefined && s.origin !== null ? String(s.origin) : ''
    return o !== '' && LIST_HIDDEN_ORIGINS.has(o)
  }

  function listSessionsForClient() {
    return readSessions().then((list) => {
      const allRaw = Array.isArray(list) ? list : []
      const shells = allRaw.filter((s) => hiddenOriginOf(s))
      const all = allRaw.filter((s) => !hiddenOriginOf(s))
      if (shells.length > 0) {
        log('[sessions] 子智能体会话已隐藏：' + shells.length + ' 条（origin=subagent）' +
          ' / 总 ' + allRaw.length + ' 条')
      }
      const kept = all.filter((s) => !(s && s.__blank === true))

      const dropped = all.filter((s) => s && s.__blank === true)
      if (dropped.length > 0) {
        const names = dropped.slice(0, 5).map((s) => {
          const t = String((s && s.title) || '').trim()
          return String((s && s.id) || '?') + (t ? ' "' + t.slice(0, 24) + '"' : ' (无标题)')
        }).join(', ')
        log('[sessions] 空会话过滤：共 ' + dropped.length + ' 条被隐藏 / 总 ' +
          all.length + ' 条 —— ' + names + (dropped.length > 5 ? ' ...' : ''))
      }
      return kept
    })
  }

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

  function hostPinnedMembers() {
    const list = hostPins()
    if (list === null) {
      try {
        if (!reg) return null
        const raw = reg.pinnedSessionIds
        if (raw && typeof raw.has === 'function') return Array.from(raw, (x) => String(x))
      } catch (e) {  }
      return null
    }
    return list
  }

  function archiveProjection() {
    return { archived: hostArchivedIds(), pinned: hostPinnedMembers() }
  }

  function withArchiveFlags(one, proj) {
    if (!one || !proj) return one
    if (Array.isArray(proj.archived)) one.archived = proj.archived.indexOf(String(one.id)) >= 0
    if (Array.isArray(proj.pinned)) one.pinned = proj.pinned.indexOf(String(one.id)) >= 0
    return one
  }

  const CTL_ARCHIVE_SETTLE_MS = envInt('DSH_MP_ARCHIVE_SETTLE_MS', 120)
  function sleepMs(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms) })
  }
  async function archiveSync(sid, want) {
    const id = String(sid || '')
    const expect = want !== false
    if (!id) return false
    try {
      if (!reg) return false
      for (let attempt = 0; attempt <= 3; attempt++) {
        await sleepMs(attempt === 0 ? CTL_ARCHIVE_SETTLE_MS : 60)
        const set = hostArchivedIds()
        if (Array.isArray(set)) {
          if ((set.indexOf(id) >= 0) === expect) return true
        } else {

          return false
        }
      }
      log('archiveSync 超时：' + id + (expect ? ' 未' : ' 仍') + '出现在宿主归档集（操作本身已成功）')
      return false
    } catch (e) {
      try { log('archiveSync 异常（忽略）：' + ((e && e.message) || String(e))) } catch (e2) {  }
      return false
    }
  }

  function sessionExists(sid) {
    return readSessions().then(
      (items) => items.some((s) => s && s.id === sid),
      () => null
    )
  }

  function subagentAddressOf(sid) {
    return readSessions().then((items) => {
      const self = (items || []).find((s) => s && s.id === sid)

      const origin = self && self.origin ? String(self.origin) : ''
      if (origin !== 'subagent') return null
      const parent = self && self.parentSessionId ? String(self.parentSessionId) : ''
      if (!parent) return null
      return { kind: 'subagent', parentSessionId: parent, childSessionId: sid, mode: 'unknown' }
    }, () => null)
  }

  const sweeper = createDeleteSweeper({
    sessionsRoot: () => {
      const home = path.join(os.homedir(), '.dsh')
      let root = home + path.sep + 'sessions'
      try {
        const persistence = ctx && typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : null
        if (persistence && typeof persistence.root === 'string' && persistence.root) {
          root = path.resolve(persistence.root)
        }
      } catch (e) {  }
      return root
    },
    storagesRoot: () => path.join(os.homedir(), '.dsh', 'storages'),
    log: log
  })

  function liveBusyOf(sid) {
    try {
      if (!sid) return undefined

      const lv = liveFromLog(String(sid), { wan: true })
      return lv && typeof lv.busy === 'boolean' ? lv.busy : undefined
    } catch (e) { return undefined }
  }

  function busyForMemberId(id) {
    const raw = String(id || '')
    if (!raw) return undefined
    const hit = liveBusyOf(raw)
    if (hit !== undefined) return hit
    if (raw.indexOf('session-') === 0) return undefined
    return liveBusyOf('session-' + raw)
  }

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

  let wsDiskLogged = false
  function wsTitlesFromDisk() {
    const m = new Map()
    try {
      const f = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json')
      if (!fs.existsSync(f)) { if (!wsDiskLogged) { wsDiskLogged = true; log('[ws-title] workspace.json 不存在: ' + f) } return null }
      const doc = JSON.parse(fs.readFileSync(f, 'utf8'))
      const ws = doc && doc.tables && doc.tables.workspaces
      if (!ws || typeof ws !== 'object') { if (!wsDiskLogged) { wsDiskLogged = true; log('[ws-title] workspace.json 里没有 tables.workspaces') } return null }
      for (const k of Object.keys(ws)) {
        const c = ws[k]
        if (!c) continue
        const p = wsNormPath(c.path)
        const ti = String(c.title || '').trim()
        if (!p || !ti) continue
        m.set(p, ti)
      }
      if (!wsDiskLogged) { wsDiskLogged = true; log('[ws-title] 磁盘 workspace.json 读到 ' + m.size + ' 条工作区名: ' + JSON.stringify([...m.keys()])) }
      return m.size > 0 ? m : null
    } catch (e) {
      if (!wsDiskLogged) { wsDiskLogged = true; log('[ws-title] 读 workspace.json 失败: ' + ((e && e.message) || e)) }
      return null
    }
  }

  function wsTitleMapNow() {
    let now = null
    try { now = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : reg } catch (e) { now = null }
    if (!now || typeof now.list !== 'function') return wsTitlesFromDisk()
    let list = null
    try { list = now.list() } catch (e) { return wsTitlesFromDisk() }
    if (!Array.isArray(list)) return wsTitlesFromDisk()
    const m = new Map()
    for (const c of list) {
      if (!c) continue
      const p = wsNormPath(c.path)
      const ti = String(c.title || '').trim()
      if (!p || !ti) continue
      m.set(p, ti)
    }
    if (m.size === 0) return wsTitlesFromDisk()
    return m
  }

  function norm(items, proj) {

    const wsTitles = wsTitleMapNow()
    return (items || []).map((s) => ({ raw: s, one: {
      id: String(s.sessionId || s.id || ''),

      title: withTitleFallback((s.projections && s.projections.values && s.projections.values.title) || s.title, s.projections && s.projections.values),
      cwd: String(s.cwd || ''),

      parentSessionId: s.parentSessionId === undefined ? undefined : String(s.parentSessionId),
      origin: s.origin === undefined ? undefined : String(s.origin),
      updatedAt: Number(s.updatedAt) || 0,

      createdAt: Number(s.createdAt) || 0,
      running: !!s.running,

      model: (() => {
        try {
          const ms = s.projections && s.projections.values && s.projections.values.modelSelection
          const cur = (ms && (ms.next || ms.lastUsed)) || null
          if (!cur || !cur.provider || !cur.model) return null
          return { provider: String(cur.provider), model: String(cur.model),
            reasoningEffort: cur.reasoningEffort ? String(cur.reasoningEffort) : '' }
        } catch (e) { return null }
      })(),

      team: normTeam(s.projections && s.projections.values && s.projections.values.agentTeam)
    } })).map(({ raw, one }) => {
      withArchiveFlags(one, proj)

      if (wsTitles) {
        const wt = wsTitles.get(wsNormPath(one.cwd))
        if (wt) one.workspaceTitle = wt
      }

      if (isEmptySessionRaw(raw)) {
        try {
          Object.defineProperty(one, '__blank', { value: true, enumerable: false, configurable: true, writable: true })
        } catch (e) {  }
      }
      return one
    }).filter((s) => s.id)
  }

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

  function unwrapEvent(ev) {
    return (ev && typeof ev === 'object' && ev.event && typeof ev.event === 'object') ? ev.event : ev
  }

  function extractEvents(h) {
    if (!h) return []
    if (Array.isArray(h)) return h
    if (Array.isArray(h.events)) return h.events
    if (h.value && Array.isArray(h.value.events)) return h.value.events
    if (h.history && Array.isArray(h.history.events)) return h.history.events
    if (Array.isArray(h.records)) return h.records
    return []
  }

  const TODO_STATUS = { completed: 'completed', in_progress: 'in_progress', pending: 'pending' }

  function normalizeTodos(list) {
    const out = []
    for (const it of (Array.isArray(list) ? list : [])) {
      if (!it || typeof it !== 'object') continue
      const content = stripShellText(String(it.content == null ? '' : it.content))
      if (!content.trim()) continue
      out.push({ content: content, status: TODO_STATUS[String(it.status)] || 'pending' })
    }
    return out
  }

  function projectTodos(events) {
    let last = null
    for (const raw of (events || [])) {
      const ev = unwrapEvent(raw)
      if (!ev || typeof ev !== 'object') continue

      if (ev.type === 'turn/start') { last = []; continue }
      if (ev.type !== 'todo/write') continue
      const d = ev.data || {}

      if (Array.isArray(d.todos)) last = d.todos
    }
    return last ? normalizeTodos(last) : []
  }

  function changesService() {
    try {
      const svc = ctx.get('workspaceChanges')
      return (svc && typeof svc.summary === 'function') ? svc : null
    } catch (e) { return null }
  }

  function changesFor(svc, sid, turn, changeSeq) {
    if (!svc) return null
    try {

      const seq = Number(changeSeq) > 0 ? Number(changeSeq) : (Number(turn && turn.seq) || 0)
      const tn = Number(turn && turn.turn) || 0
      const s = svc.summary(sid, seq)
      if (!s || typeof s !== 'object') return null
      const files = []
      for (const f of (Array.isArray(s.files) ? s.files : [])) {
        if (!f || typeof f !== 'object') continue
        const path = String(f.path == null ? '' : f.path)
        if (path === '') continue
        const row = { path: path, added: Number(f.added) || 0, deleted: Number(f.deleted) || 0 }

        if (f.binary === true) row.binary = true
        if (f.oversized === true) row.oversized = true
        files.push(row)
      }
      return {

        turn: Number(s.turn) || tn,
        files: files,
        total: Number(s.total) || 0,
        added: Number(s.added) || 0,
        deleted: Number(s.deleted) || 0
      }
    } catch (e) { return null }
  }

  function sessionLogOf(sid) {
    try {
      const store = (() => { try { return ctx.get('sessions') } catch (e) { return null } })()
      if (!store) return null
      if (typeof store.get !== 'function') return null
      const s = store.get(sid)
      if (s && Array.isArray(s.log) && s.log.length) return s.log
      return null
    } catch (e) { return null }
  }

  function logForCards(sid, events) {
    const out = []
    const seen = new Set()
    const push = (raw) => {
      const ev = unwrapEvent(raw)
      if (!ev || typeof ev !== 'object') return
      const key = String(ev.type || '') + '|' + String(Number(ev.seq) || 0)
      if (seen.has(key)) return
      seen.add(key)
      out.push(ev)
    }
    for (const raw of (sessionLogOf(sid) || [])) push(raw)
    for (const raw of (Array.isArray(events) ? events : [])) push(raw)
    return out
  }

  function collectChangeSeqs(sid, logIn) {
    const out = []
    try {
      const log = Array.isArray(logIn) ? logIn : logForCards(sid, null)
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
    } catch (e) {  }
    return out
  }

  function collectDeliveryFiles(sid, logIn) {
    const bySeq = new Map()
    try {
      const log = Array.isArray(logIn) ? logIn : logForCards(sid, null)
      if (!log) return bySeq
      for (const raw of (log || [])) {
        const ev = unwrapEvent(raw)
        if (!ev || typeof ev !== 'object' || ev.type !== 'deliverables/presented') continue
        const d = ev.data || {}
        if (!Array.isArray(d.files) || !d.files.length) continue
        const seq = Number(ev.seq) || 0
        if (seq <= 0) continue
        const list = bySeq.get(seq) || []
        for (const it of d.files) {
          if (!it || typeof it !== 'object') continue
          const path = String(it.path == null ? '' : it.path).trim()
          if (path === '') continue
          list.push({
            path: path,
            description: String(it.description == null ? '' : it.description),
            seq: seq,

            index: list.length
          })
        }
        if (list.length) bySeq.set(seq, list)
      }
    } catch (e) {  }
    return bySeq
  }

  function attachDetailCards(turns, deliver, sid, changeSeqs) {
    if (!Array.isArray(turns) || !turns.length) return turns

    const svc = changesService()
    const seqs = Array.isArray(changeSeqs) ? changeSeqs : []

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
        if (!prev || c.seq > prev) seqOf.set(target, c.seq)
      }
    }
    for (const t of turns) {
      if (!t || typeof t !== 'object') continue
      t.changes = changesFor(svc, sid, t, seqOf.get(t))
      if (!t.files) t.files = null
    }
    if (!deliver || typeof deliver.get !== 'function') return turns

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

  const INJECT_RES = [
    /^\s*<system-reminder>/,
    /^\s*Time sampled while preparing turn /,
    /^\s*Current runtime context\./,
    /^\s*This is an automatically generated checkpoint /,
    /^\s*\[model changed:/,

    /^\s*Background subagent /,
    /^\s*Team message team-message-/,
    /^\s*Agent [0-9a-fA-F-]{8,} sent a message:/,
    /^\s*background job /,
    /^\s*<goal_round[\s>]/
  ]

  function isInjectedUserText(text) {
    const t = String(text || '')
    for (const re of INJECT_RES) { if (re.test(t)) return true }
    if (t.length > 200) {
      const m = t.match(/^\s*<([a-z][a-z0-9_]{2,})[\s>]/)
      if (m) {
        const close = '</' + m[1] + '>'
        if (t.trim().slice(-close.length) === close) return true
      }
    }
    return false
  }

  const INJECT_SOURCE_KINDS = new Set([
    'team-message', 'time-context', 'runtime-context', 'agent-instructions',
    'skill-catalog', 'checkpoint', 'model-selection', 'subagent-settled',
    'agent-message', 'tool-jobs', 'repeat-tool-reminder', 'background-job',
    'ptc-mode'
  ])

  function sourceKindOf(data) {
    const s = data && data.source
    if (!s) return ''
    if (typeof s === 'string') return s
    return typeof s.kind === 'string' ? s.kind : ''
  }

  const REAL_USER_SOURCE_KINDS = new Set(['user', 'user-question-reply'])

  function isInjectedUserData(data) {
    const k = sourceKindOf(data)
    if (!k) return false
    if (INJECT_SOURCE_KINDS.has(k)) return true

    if (k.indexOf('plugin:') === 0) return true

    if (!REAL_USER_SOURCE_KINDS.has(k)) return true

    if (k === 'user') {
      const s = data && data.source
      if (!s || typeof s !== 'object') return false
      return !s.rpcId
    }
    return false
  }

  function goalRoundOf(data) {
    const s = data && data.source
    if (!s || typeof s !== 'object') return 0
    if (typeof s.kind !== 'string' || s.kind !== 'goal') return 0
    const n = Number(s.round)
    return n > 0 && isFinite(n) ? n : 0
  }

  function isGoalRoundUserData(data) {
    const s = data && data.source
    return !!(s && typeof s === 'object' && s.kind === 'goal')
  }

  const MAX_MESSAGES = envInt('DSH_MP_MAX_MESSAGES', 3200)

  const THINK_MAX = envInt('DSH_MP_THINK_MAX', 1000000)

  const THINK_STEPS_TOTAL = envInt('DSH_MP_THINK_STEPS_TOTAL', 1000000)

  const THINK_STEP_MAX = envInt('DSH_MP_THINK_STEP_MAX', 200000)

  const THINK_TAIL_STEP_MAX = envInt('DSH_MP_THINK_TAIL_STEP_MAX', 200000)

  const LIVE_TOOLS_KEEP = envInt('DSH_MP_LIVE_TOOLS_KEEP', 30)

  const ACTS_KEEP = envInt('DSH_MP_LIVE_ACTS_KEEP', 60)

  const TOOL_DETAIL_MAX = envInt('DSH_MP_TOOL_DETAIL_MAX', 2000)

  const BRIEF_MAX = envInt('DSH_MP_BRIEF_MAX', 72)

  const BRIEF_KEEP = envInt('DSH_MP_BRIEF_KEEP', 4)

  const TOOL_KEEP_FULL = envInt('DSH_MP_TOOL_KEEP_FULL', 2)

  const TOOLBODY_KEEP_TURNS = envInt('DSH_MP_TOOLBODY_KEEP_TURNS', 2)

  const OLD_DETAIL_MAX = envInt('DSH_MP_OLD_TOOL_DETAIL_MAX', 400)

  const OLD_BRIEF_MAX = envInt('DSH_MP_OLD_TOOL_BRIEF_MAX', 32)

  const OLD_TOOL_BUDGET = envInt('DSH_MP_OLD_TOOL_BUDGET_KB', 2000) * 1024

  const OLD_TOOL_MIN = envInt('DSH_MP_OLD_TOOL_MIN', 200)

  function byteLen(s) {
    const t = String(s || '')
    if (!t) return 0
    try { return new TextEncoder().encode(t).length } catch (e) { return t.length * 3 }
  }

  const TRACE_PER_TURN = envInt('DSH_MP_TRACE_PER_TURN', 2)

  const TRACE_TEXT_MAX = envInt('DSH_MP_TRACE_TEXT_MAX', 240)

  const TRACE_MAX = envInt('DSH_MP_TRACE_MAX', 200)

  const FAILURE_MSG_MAX = envInt('DSH_MP_FAILURE_MSG_MAX', 300)

  function failureOf(src, extra) {
    const f = (src && typeof src === 'object') ? src : {}
    const o = {
      ok: false,
      fatal: false,
      retrying: false,
      recovered: false,
      retry: 0,
      maxRetries: 0,
      code: '',
      type: '',
      message: '',
      time: ''
    }
    if (f.code) o.code = String(f.code)
    if (f.type) o.type = String(f.type)
    if (f.message) o.message = clip(String(f.message), FAILURE_MSG_MAX, '')

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
  function foldHistoryToTurns(events, opts) {
    const wan = isWanScope(opts)
    const caps = capsFor(wan)
    const turns = []
    const byNo = new Map()

    let lastTurn = 0

    let lastStep = 0

    const ptcAt = new Map()

    const ptcCards = new Set()

    const thinkLeft = new Map()

    let segmented = false

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

      const t = { turn: allocNo(want), seq: Number(seq) || 0, startedMs: evMs(ev), endedMs: 0, maxTokens: false, prompt: '', prompts: [], pimgs: [], response: '', rmd: '', think: '', thinks: [], steps: [], tools: [], images: [], aimages: [], time: '' }
      turns.push(t)
      return t
    }

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

      const dStep = Number(d.step) || 0
      if (dStep > 0) lastStep = dStep

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

        const cur = byNo.get(dTurn) || byNo.get(lastTurn) || null
        const rs = d.reason || {}
        if (cur) {

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

        cur.tools.push({
          name: String(d.name || d.tool || '工具'), state: 'run',

          detail: stripShellText(clipText(args, caps.toolDetail)), result: '',
          brief: briefOf(args, wan)
        })
        cur.steps.push({ k: 'o', i: cur.tools.length - 1, s: Number(d.step) || 0 })
        if (Number(d.step) > 0) lastStep = Number(d.step)
        if (!cur.time) cur.time = evTime(ev)
        continue
      }
      if (ev.type === 'tool/ptc-dispatch-start') {

        const args = d.arguments !== undefined ? d.arguments : d.input
        let s = args
        if (typeof s !== 'string') { try { s = JSON.stringify(args === undefined ? '' : args) } catch (e) { s = '' } }
        const cur = turnFor(dTurn, ev.seq, ev)
        cur.tools.push({
          name: String(d.name || d.tool || '工具'), state: 'run',
          detail: stripShellText(clipText(s, caps.toolDetail)), result: '',
          brief: briefOf(s, wan)
        })
        cur.steps.push({ k: 'o', i: cur.tools.length - 1, s: lastStep })
        const myCard = cur.tools[cur.tools.length - 1]
        ptcCards.add(myCard)
        if (d.subCallId) ptcAt.set(String(d.subCallId), myCard)
        if (!cur.time) cur.time = evTime(ev)
        continue
      }
      if (ev.type === 'tool/ptc-dispatch') {

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
            detail: stripShellText(clipText(s, caps.toolDetail)), result: '', brief: briefOf(s, wan) }
          cur.tools.push(card)
          ptcCards.add(card)
          cur.steps.push({ k: 'o', i: cur.tools.length - 1, s: lastStep })
        }
        card.state = isErr ? 'err' : 'done'
        card.result = clipText(contentText(d.content), caps.toolDetail)
        if (!cur.time) cur.time = evTime(ev)
        continue
      }
      if (ev.type === 'tool/result') {
        const m = d.message
        const errInBlocks = Array.isArray(m && m.content) &&
          m.content.some((b) => b && b.type === 'tool-result' && b.isError)
        const cur = byNo.get(dTurn) || byNo.get(lastTurn) || null

        if (cur && cur.tools) {

          let last = null
          for (let i = cur.tools.length - 1; i >= 0; i--) {
            const c = cur.tools[i]
            if (c && c.state === 'run' && !ptcCards.has(c)) { last = c; break }
          }
          if (!last) {
            const tail = cur.tools[cur.tools.length - 1]
            if (tail && tail.state === 'run') last = tail
          }

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

            last.result = clipText(contentText(m && m.content), caps.toolDetail)
            attachPview(last, d.meta)
          }
        }
        continue
      }
      let msg = null
      let isUser = false
      if (ev.type === 'user/message') { msg = d; isUser = true }
      else if (ev.type === 'assistant/message') msg = d.message

      if (!msg) continue
      const text = contentText(msg && msg.content)

      if (isUser && isGoalRoundUserData(msg)) {
        const gt = turnFor(dTurn, ev.seq, ev)
        if (gt) gt.goalRound = goalRoundOf(msg)
        continue
      }

      if (isUser && (isInjectedUserData(msg) || isInjectedUserText(text))) continue

      let think = ''
      if (!isUser && Array.isArray(msg && msg.content)) {

        think = stripAcp(msg.content
          .filter((b) => b && b.type === 'reasoning' && typeof b.text === 'string' && b.text)
          .map((b) => b.text)
          .join('\n\n'))
      }

      const imgRefs = imageRefsOf(msg && msg.content)
      if (!text && !think && !imgRefs.length) continue
      let cur = turnFor(dTurn, ev.seq, ev)

      if (isUser && (cur.response || cur.think || (cur.steps && cur.steps.length) ||
        (cur.tools && cur.tools.length) || cur.failure)) cur = forkSegment(ev, ev.seq)

      if (!cur.time) cur.time = evTime(ev)

      const imgBucket = isUser ? cur.images : cur.aimages

      const myImgIds = []
      for (const ref of imgRefs) {
        const iid = attachments.register(ref)
        if (!iid) continue
        if (myImgIds.indexOf(iid) < 0) myImgIds.push(iid)
        if (imgBucket.indexOf(iid) < 0) imgBucket.push(iid)
      }

      if (!isUser && think) {
        if (!thinkLeft.has(cur.turn)) thinkLeft.set(cur.turn, caps.thinkStepsTotal)
        const left = thinkLeft.get(cur.turn)
        if (left > 0) {

          const cap = Math.min(cur.thinks.length === 0 ? caps.thinkStep : caps.thinkTail, left)
          const seg = clipText(think, cap)
          thinkLeft.set(cur.turn, left - Math.min(Array.from(think).length, cap))
          cur.thinks.push(seg)
          cur.steps.push({ k: 't', i: cur.thinks.length - 1, s: Number(d.step) || 0 })
        }
      }
      if (isUser) {

        cur.prompts.push(text)
        cur.pimgs.push(myImgIds)
        cur.prompt = cur.prompt ? cur.prompt + '\n\n' + text : text
      } else {
        if (think) cur.think = cur.think ? cur.think + '\n\n' + think : think
        if (text) cur.response = cur.response ? cur.response + '\n\n' + text : text

        const lmd = localImagesOf(text, LOCAL_IMG_PER_TURN)
        for (const lid of lmd.ids) {
          if (cur.aimages.indexOf(lid) < 0) cur.aimages.push(lid)
        }
        if (text) {
          const segRmd = lmd.changed ? lmd.rmd : text
          cur.rmd = cur.rmd ? cur.rmd + '\n\n' + segRmd : segRmd
        }
      }
    }
    for (const t of turns) {

      t.images = (t.images || []).map((id) => attachments.infoOf(id)).filter(Boolean)

      t.aimages = (t.aimages || []).map((id) => attachments.infoOf(id)).filter(Boolean)

      t.pimgs = (t.pimgs || []).map((ids) => (Array.isArray(ids) ? ids : [])
        .map((id) => attachments.infoOf(id)).filter(Boolean))

      if (t.think) t.think = clipText(t.think, caps.thinkMax)

      if (typeof t.rmd === 'string' && (!t.rmd || t.rmd === t.response)) delete t.rmd
    }

    let left = OLD_TOOL_BUDGET
    for (let ti = wan ? turns.length - 1 : -1; ti >= 0; ti--) {
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

        if (fromTail >= BRIEF_KEEP && typeof c.brief === 'string' && c.brief) {
          const before = c.brief
          c.brief = clip(before, capOf(OLD_BRIEF_MAX))
          left -= Math.min(byteLen(before), byteLen(c.brief))
        }
      }
    }

    for (const t of turns) {
      if (!Array.isArray(t.prompts) || !t.prompts.length) t.prompts = t.prompt ? [t.prompt] : []

      if (!Array.isArray(t.pimgs)) t.pimgs = []
      if (t.pimgs.length > t.prompts.length) t.pimgs.length = t.prompts.length
      while (t.pimgs.length < t.prompts.length) t.pimgs.push([])
      if (!Array.isArray(t.steps)) t.steps = []
      if ((!Array.isArray(t.thinks) || !t.thinks.length) && t.think) {
        t.thinks = [clip(t.think, caps.thinkStep)]
        t.steps.push({ k: 't', i: 0, s: 0 })
      }
    }

    for (const t of turns) {
      if (!Array.isArray(t.thinks)) continue
      let hasThinks = false
      for (const s of t.thinks) { if (String(s || '').trim()) { hasThinks = true; break } }
      if (hasThinks) delete t.think
    }

    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]
      if (!t.failure) continue
      const hasBody = (t.prompt && t.prompt.length) || (t.response && t.response.length) ||
        (t.think && t.think.length) || (t.tools && t.tools.length) ||
        (t.images && t.images.length) || (t.aimages && t.aimages.length) ||
        (t.steps && t.steps.length)
      if (!hasBody) { byNo.delete(t.turn); turns.splice(i, 1) }
    }

    if (segmented) {
      for (let i = 0; i < turns.length; i++) turns[i].turn = i + 1
    } else {
      turns.sort((a, b) => a.turn - b.turn)
    }
    return turns
  }

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

  function clip(s, n, mark) {
    const t = String(s || '')
    const cps = Array.from(t)
    if (cps.length <= n) return t
    const tag = mark === undefined ? '…' : String(mark)
    return cps.slice(0, n).join('') + tag
  }

  function clipTag(cutChars) {
    return cutChars > 0 ? '…（已截断 ' + cutChars + ' 字）' : ''
  }

  function clipText(s, n) {
    const t = String(s || '')
    const cps = Array.from(t)
    if (cps.length <= n) return t
    return cps.slice(0, n).join('') + clipTag(cps.length - n)
  }

  function briefOf(args, wan) {
    if (typeof args !== 'string' || !args) return ''
    const briefMax = capsFor(wan === true).brief
    const keys = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'content']
    let o = null
    try { o = JSON.parse(args) } catch (e) { o = null }
    if (o && typeof o === 'object') {
      for (const k of keys) {
        const v = o[k]
        if (typeof v === 'string' && v) return clip(v.replace(/\s+/g, ' ').trim(), briefMax)
      }
    }
    return clip(args.replace(/\s+/g, ' ').trim(), briefMax)
  }

  function attachPview(card, meta) {
    if (!card || !meta || typeof meta !== 'object') return
    const view = meta['dsh-hm/view']
    if (view === null || view === undefined || typeof view === 'function') return
    try {
      const rawView = typeof view === 'string' ? view : JSON.stringify(view)
      if (typeof rawView !== 'string' || rawView.length === 0 || rawView.length > 8192) return
      JSON.parse(rawView)
      card.pview = rawView
    } catch (e) { }
  }

  function hmWeatherTool() {
    const hourly = [
      { t: '09:00', deg: 18 }, { t: '12:00', deg: 23 },
      { t: '15:00', deg: 25 }, { t: '18:00', deg: 21 }
    ]
    const schema = {
      type: 'object', additionalProperties: false,
      required: ['city', 'tempC', 'condition', 'humidity', 'wind', 'summary', 'hourly'],
      properties: {
        city: { type: 'string' }, tempC: { type: 'number' },
        condition: { type: 'string' }, humidity: { type: 'number' },
        wind: { type: 'string' }, summary: { type: 'string' },
        hourly: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['t', 'deg'], properties: { t: { type: 'string' }, deg: { type: 'number' } } } }
      }
    }
    return {
      name: 'hm_weather_card',
      description: '展示鸿蒙原生天气卡片。用于演示可视化工具结果，返回固定杭州测试数据，不是实时天气。',
      parameters: { type: 'object', additionalProperties: false, properties: {
        city: { type: 'string', description: '显示在卡片上的城市名，默认杭州' } } },
      output: {
        schema: schema,
        render: (_args, value) => [{ type: 'text', text: value.city + ' ' + value.tempC + '°C，' + value.condition + '。' + value.summary }],
        presentationMeta: (_args, value) => ({ 'dsh-hm/view': {
          version: 1,
          root: { type: 'stack', children: [
            { type: 'text', text: value.city + ' · ' + value.condition, size: 18 },
            { type: 'metric', label: '当前气温', value: String(value.tempC), unit: '°C', hint: value.summary },
            { type: 'keyValue', items: [
              { key: '湿度', value: String(value.humidity) + '%' },
              { key: '风力', value: value.wind }
            ] },
            { type: 'progress', label: '相对湿度', amount: value.humidity, total: 100 },
            { type: 'list', items: value.hourly.map((h) => ({ text: h.t + '  ' + h.deg + '°C' })) }
          ] }
        } })
      },
      execute: async (args) => ({
        city: typeof args.city === 'string' && args.city.trim() ? args.city.trim() : '杭州',
        tempC: 23, condition: '晴间多云', humidity: 58, wind: '东风 2 级',
        summary: '固定演示数据 · 非实时天气', hourly: hourly
      })
    }
  }

  function absorbStream(L, ev, opts) {
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

        const s = stripAcp(arr.join(""))
        if (!s) continue
        if (it === "text-chunks") L.text += s
        else L.think += s
        got = true
      } else if (it === "chunk" && item.chunk && item.chunk.type === "block-end") {
        const b = item.chunk.block
        if (!b || typeof b.text !== "string" || !b.text) continue

        if (b.type === "text" && !L.text) { L.text = stripAcp(b.text); got = true }
        else if (b.type === "reasoning" && !L.think) { L.think = stripAcp(b.text); got = true }
      }
    }
    if (got) {
      const cap = capsFor(isWanScope(opts))
      if (L.text.length > cap.liveTextCap) L.text = L.text.slice(-cap.liveTextKeep)
      if (L.think.length > cap.liveTextCap) L.think = L.think.slice(-cap.liveTextKeep)
      L.lastAt = Number(ev.time) || Date.now()
    }
    return got
  }

  function liveFromLog(sid, opts) {
    const wan = isWanScope(opts)
    const caps = capsFor(wan)
    try {
      const store = (() => { try { return ctx.get('sessions') } catch (e) { return null } })()
      const sess = store && typeof store.get === 'function' ? store.get(sid) : null
      if (!sess || !Array.isArray(sess.log) || !sess.log.length) return null
      const log = sess.log

      let start = -1
      let busy = false
      for (let i = log.length - 1; i >= 0; i--) {
        const t = unwrapEvent(log[i])
        const tt = t && t.type
        if (tt === 'turn/end') { busy = false; start = log.length; break }
        if (tt === 'turn/start' || tt === 'user/message') { start = i; busy = true; break }
      }
      if (start < 0) return null
      if (start >= log.length) return { think: '', text: '', rmd: '', tools: [], acts: [], todos: [], images: [], aimages: [], lastAt: 0, busy: false }
      const L = { think: '', text: '', rmd: '', thinks: [], steps: [], tools: [], acts: [], todos: [], images: [], aimages: [], startedMs: 0, lastAt: 0 }

      L.seq = Number((unwrapEvent(log[start]) || {}).seq) || 0
      for (let i = start; i < log.length; i++) {
        const ev = unwrapEvent(log[i])
        if (!ev || typeof ev !== 'object') continue

        if (!L.startedMs) L.startedMs = evMs(ev)

        if (ev.type === 'assistant/message') {
          absorbStream(L, ev, { wan: wan })
          const rz = streamReasoning(ev)
          if (rz) {
            L.thinks.push(clip(rz, caps.thinkStep))
            L.steps.push({ k: 't', i: L.thinks.length - 1, s: Number((ev.data || {}).step) || 0 })
          }
          const mImg = ev.data && ev.data.message

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

          L.lastAt = Number(ev.time) || L.lastAt
        } else if (ev.type === 'tool/call') {
          const d = ev.data || {}
          let args = d.arguments
          if (typeof args !== 'string') { try { args = JSON.stringify(d.arguments || d.input || '') } catch (e) { args = '' } }
          L.tools.push({
            name: String(d.name || d.tool || '工具'), state: 'run',

            detail: stripShellText(clip(args, caps.toolDetail)), result: '',
            brief: briefOf(args, wan)
          })
          L.steps.push({ k: 'o', i: L.tools.length - 1, s: Number(d.step) || 0 })
          trimLiveTools(L, wan)
          L.lastAt = Number(ev.time) || L.lastAt
        } else if (ev.type === 'tool/ptc-dispatch-start') {

          const d = ev.data || {}
          pushAct(L, d.name || d.tool, d.arguments !== undefined ? d.arguments : d.input, ev.time, d.subCallId, wan)
          L.lastAt = Number(ev.time) || L.lastAt
        } else if (ev.type === 'tool/ptc-dispatch') {
          const d = ev.data || {}
          markActDone(L, d.name || d.tool, d.isError === true || !!d.error, d.subCallId)
          L.lastAt = Number(ev.time) || L.lastAt
        } else if (ev.type === 'todo/write') {

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

            last.result = clip(contentText(m && m.content), caps.toolDetail)
            attachPview(last, d.meta)
          }
          L.lastAt = Number(ev.time) || L.lastAt
        }
      }

      const lmdLog = localImagesOf(L.text, LOCAL_IMG_PER_TURN)
      if (!Array.isArray(L.aimages)) L.aimages = []
      for (const lid of lmdLog.ids) {
        if (L.aimages.indexOf(lid) < 0) L.aimages.push(lid)
      }
      L.rmd = lmdLog.changed ? lmdLog.rmd : ''
      trimLiveTools(L, wan)

      settleActs(L)
      L.busy = busy
      return L
    } catch (e) { return null }
  }

  const OWN_TAIL = 300
  const OWN_MIN = 24
  function ownsText(host, piece) {
    const h = String(host || '')
    const p = String(piece || '')
    if (!h || !p) return false
    if (h.indexOf(p) >= 0) return true
    if (p.length <= OWN_MIN) return false
    const tail = p.slice(-OWN_TAIL)
    return tail.length >= OWN_MIN && h.indexOf(tail) >= 0
  }

  function ownsThinkText(t, piece) {
    const th = String((t && t.think) || '')
    if (th && ownsText(th, piece)) return true
    const arr = Array.isArray(t && t.thinks) ? t.thinks : []
    if (!arr.length) return false
    const joined = arr.join('\n\n')
    return !!joined && ownsText(joined, piece)
  }

  function liveOwnedByTurn(lc, t) {
    if (!lc || !t) return false
    const lt = String(lc.text || '')
    if (lt) return ownsText(t.response, lt)
    const lth = String(lc.think || '')
    if (lth) return ownsThinkText(t, lth)
    return false
  }

  function liveFoldedInLastTurn(lc, turns) {
    if (!lc || !Array.isArray(turns) || !turns.length) return false
    const t = turns[turns.length - 1]
    if (!t) return false
    const seq = Number(lc.seq) || 0
    const sm = Number(lc.startedMs) || 0

    const sameStart = !!sm && ((sm === (Number(t.startedMs) || 0)) || (!!seq && seq === (Number(t.seq) || 0)))
    const owned = liveOwnedByTurn(lc, t)

    if (owned) {
      const hasProc = (Array.isArray(t.tools) && t.tools.length) || (Array.isArray(t.steps) && t.steps.length)
      return !!hasProc || Number(t.endedMs) > 0
    }
    if (!sameStart) return false
    const tools = Array.isArray(t.tools) ? t.tools.length : 0
    const steps = Array.isArray(t.steps) ? t.steps.length : 0
    if (!tools && !steps) return false
    const lt = String(lc.text || '')
    if (lt && String(t.response || '').indexOf(lt) < 0) return false
    return true
  }

  function buildTrace(events, opts) {
    const wan = isWanScope(opts)
    const caps = capsFor(wan)
    const traceTextMax = caps.traceText
    const out = []

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

        if (isGoalRoundUserData(d) || isInjectedUserData(d) || isInjectedUserText(text)) continue
        out.push({ kind: 'user', turn: turnNo, seq, time, text: clipText(text, traceTextMax) })
      } else if (t === 'assistant/message') {
        const m = d.message
        out.push({ kind: 'assistant', turn: turnNo, seq, time,
          text: clipText(contentText(m && m.content), traceTextMax) })
      } else if (t === 'tool/call') {
        let args = d.arguments
        if (typeof args !== 'string') { try { args = JSON.stringify(d.arguments || d.input || '') } catch (e) { args = '' } }
        out.push({ kind: 'tool-call', turn: turnNo, seq, time,
          tool: String(d.name || d.tool || '工具'), text: clipText(stripShellText(args), traceTextMax) })
      } else if (t === 'tool/result') {
        const m = d.message
        const errInBlocks = Array.isArray(m && m.content) &&
          m.content.some((b) => b && b.type === 'tool-result' && b.isError)
        out.push({ kind: 'tool-result', turn: turnNo, seq, time,
          tool: String(d.name || d.tool || ''),
          status: (d.isError || errInBlocks) ? '出错' : '已完成',
          text: clipText(contentText(m && m.content), traceTextMax) })
      } else if (t === 'request/context') {
        let brief = ''
        if (typeof d.summary === 'string') brief = d.summary
        else if (typeof d.text === 'string') brief = d.text
        else { try { brief = JSON.stringify(d) } catch (e) { brief = '' } }

        out.push({ kind: 'context', turn: turnNo, seq, time, text: clipText(stripAcp(brief), traceTextMax) })
      }
    }

    const byTurn = new Map()
    for (const e of out) {
      let arr = byTurn.get(e.turn)
      if (!arr) { arr = []; byTurn.set(e.turn, arr) }
      arr.push(e)
    }

    if (!wan) {
      const all = []
      for (const k of [...byTurn.keys()].sort((a, b) => a - b)) all.push(...byTurn.get(k))
      if (all.length > caps.traceMax) {
        const cut = all.length - caps.traceMax
        const tail = all.slice(-caps.traceMax)
        return [{ kind: 'note', turn: (tail[0] && tail[0].turn) || 0, seq: 0, time: '',
          text: '轨迹较早的 ' + cut + ' 条已省略' }].concat(tail)
      }
      return all
    }

    const kept = []
    for (const k of [...byTurn.keys()].sort((a, b) => a - b)) {
      const arr = byTurn.get(k)
      if (arr.length <= TRACE_PER_TURN) { kept.push(...arr); continue }

      const head = arr.slice(0, Math.min(1, TRACE_PER_TURN))
      const tail = arr.slice(-Math.max(1, TRACE_PER_TURN - head.length))
      kept.push(...head, ...tail)
      const dropped = arr.length - head.length - tail.length
      if (dropped > 0) {
        kept.push({ kind: 'note', turn: k, seq: 0, time: '',
          text: '本轮另有 ' + dropped + ' 条过程已省略' })
      }
    }
    if (kept.length > caps.traceMax) {
      const cut = kept.length - caps.traceMax
      const tail = kept.slice(-caps.traceMax)

      return [{ kind: 'note', turn: (tail[0] && tail[0].turn) || 0, seq: 0, time: '',
        text: '轨迹较早的 ' + cut + ' 条已省略' }].concat(tail)
    }
    return kept
  }

  function omitOldToolBodies(turns) {
    return omitToolBodies(turns, TOOLBODY_KEEP_TURNS)
  }

  async function readToolBody(sid, meta, p) {
    const payload = p || {}
    const base = (meta && typeof meta === 'object') ? meta : {}

    const full = await readDetail(sid, Object.assign({}, base, { toolBody: false }))
    if (!full || full.ok !== true) return { ok: false, error: 'detail-unavailable' }
    const turns = Array.isArray(full.turns) ? full.turns : []
    if (turns.length === 0) return { ok: false, error: 'tool-not-found' }

    const wantTurn = Math.trunc(Number(payload.turn) || 0)
    let turnObj = null
    if (wantTurn > 0) {
      for (const t of turns) { if (Number(t.turn) === wantTurn) { turnObj = t; break } }
    } else {
      turnObj = turns[turns.length - 1]
    }
    if (!turnObj) return { ok: false, error: 'tool-not-found' }
    const tl = Array.isArray(turnObj.tools) ? turnObj.tools : []
    const turn = Number(turnObj.turn) || 0

    const idxRaw = Number(payload.index)
    const idx = Number.isFinite(idxRaw) ? Math.trunc(idxRaw) : -1
    let card = (idx >= 0 && idx < tl.length) ? tl[idx] : null
    if (!card && payload.name) {
      const wantName = String(payload.name)
      const wantNth = Math.max(0, Math.trunc(Number(payload.nth) || 0))
      let seen = 0
      for (const c of tl) {
        if (!c || String(c.name || '') !== wantName) continue
        if (seen === wantNth) { card = c; break }
        seen++
      }
    }
    if (!card) return { ok: false, error: 'tool-not-found' }

    return {
      ok: true,
      turn: turn,
      index: (idx >= 0 ? idx : tl.indexOf(card)),
      name: String(card.name || ''),
      state: String(card.state || ''),
      detail: typeof card.detail === 'string' ? card.detail : '',
      result: typeof card.result === 'string' ? card.result : '',
      brief: typeof card.brief === 'string' ? card.brief : '',
      pview: typeof card.pview === 'string' ? card.pview : ''
    }
  }

  function readDetail(sid, meta) {
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

      const GOAL_ROUND_TEXT_RE = /^\s*<goal_round[\s>]/
      const turns = (v.turnOutline || [])
        .map((t) => {
          const p = stripShellText(stripAcp(String(t.prompt || '')))
          const r = stripShellText(stripAcp(String(t.response || '')))

          return {
            turn: Number(t.turn) || 0,
            seq: Number(t.seq) || 0,

            startedMs: Number(t.startedMs) || 0,

            endedMs: 0,
            maxTokens: false,
            prompt: (isInjectedUserData(t) || isInjectedUserText(p) || GOAL_ROUND_TEXT_RE.test(p)) ? '' : p,
            response: r,

            images: [],

            aimages: [],

            pimgs: []
          }
        })
        .filter((t) => t.prompt.length > 0 || t.response.length > 0 ||
          t.images.length > 0 || t.aimages.length > 0)
      const base = {
        ok: true,
        sessionId: sid,
        title: withTitleFallback(v.title, v),

        team: normTeam(v.agentTeam),
        asOfSeq: Number(raw && raw.asOfSeq) || 0,
        running: false,
        turns: turns,
        turnCount: turns.length,

        todos: [],
        stats: {
          turns: Number(st.turns) || turns.length,
          steps: Number(st.steps) || 0,
          llmMs: Number(st.llmMs) || 0,
          toolMs: Number(st.toolMs) || 0,

          ttftMs: Number(st.ttftMs) || 0
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

      const wan = isWanScope(meta)
      const lvLog = liveFromLog(sid, { wan: wan })
      let lv = lvLog || live.get(sid) || null

      if (lv && !lvLog && !lv.text && !lv.think && !(lv.acts || []).length) lv = null

      if (wan && lv) {
        const wc = capsFor(true)
        const clampTail = (arr, keep) => (Array.isArray(arr) && keep > 0 && arr.length > keep)
          ? arr.slice(arr.length - keep)
          : arr
        lv = Object.assign({}, lv, {
          tools: clampTail(lv.tools, wc.liveToolsKeep),
          acts: clampTail(lv.acts, wc.liveActsKeep)
        })
      }

      base.running = !!(lvLog && lvLog.busy)
      if (!base.running && turns.length) {
        const lastT = turns[turns.length - 1]
        if (String(lastT.prompt).length > 0 && String(lastT.response).trim().length === 0) {
          base.running = true
        }
      }

      base.todos = (lvLog && Array.isArray(lvLog.todos)) ? lvLog.todos : []

      if (lv && (lv.text || lv.think || lv.tools.length || (lv.acts || []).length)) {

        base.live = {

          think: stripShellText(lv.think || ''),
          text: stripShellText(lv.text || ''),

          rmd: stripShellText(lv.rmd || ''),
          thinks: (lv.thinks || []).map((s) => stripShellText(s)),
          steps: lv.steps || [],
          tools: (lv.tools || []).map((tl) => (tl && (tl.detail || tl.result)
            ? Object.assign({}, tl, {
                detail: stripShellText(tl.detail || ''),
                result: stripShellText(tl.result || '')
              })
            : tl)),

          startedMs: Number(lv.startedMs) || 0,
          toolCount: (lv.tools || []).length,

          images: (lv.images || []).map((id) => attachments.infoOf(id)).filter(Boolean),

          aimages: (lv.aimages || []).map((id) => attachments.infoOf(id)).filter(Boolean),

          acts: (lv.acts || []).map((a) => ({
            name: String((a && a.name) || ''),
            state: String((a && a.state) || 'done'),
            detail: stripShellText((a && a.detail) || ''),
            at: Number(a && a.at) || 0
          }))
        }
      }

      const throughSeq = Number(raw && raw.asOfSeq) || 0

      const PAGE_MAX_MESSAGES = MAX_MESSAGES
      const canPage = ctl && typeof ctl.page === 'function'
      const canHistory = ctl && typeof ctl.history === 'function'

      const wantTurns = Math.trunc(Number(meta && meta.limitTurns) || 0)
      const wantBefore = Math.trunc(Number(meta && meta.beforeSeq) || 0)
      const paged = wantTurns > 0 || wantBefore > 0
      const pageWindow = wantTurns > 0 ? { minMessages: 1, minTurns: wantTurns } : undefined

      const pageHasMoreOf = (h) => !!(h && h.hasMore === true)
      const pageEarliestOf = (evs) => {
        let earliest = -1
        if (!paged || !Array.isArray(evs)) return earliest
        for (const ev0 of evs) {
          const e0 = unwrapEvent(ev0)
          const s0 = Number(e0 && e0.seq)
          if (!Number.isFinite(s0) || s0 < 0) continue
          if (earliest < 0 || s0 < earliest) earliest = s0
        }
        return earliest
      }
      const markPage = (o, h, evs) => {
        if (!paged || !o || typeof o !== 'object') return o
        o.hasMore = pageHasMoreOf(h)
        o.earliestSeq = pageEarliestOf(evs)
        return o
      }

      if (canPage || canHistory) {
        let usedSubAddress = false
        return Promise.resolve()
          .then(() => subagentAddressOf(sid))
          .then((subAddr) => {
            usedSubAddress = !!subAddr
            if (canPage) {
              const address = subAddr || { kind: 'session', sessionId: sid }
              const pageReq = {
                address: address,
                throughSeq: throughSeq,
                maxMessages: PAGE_MAX_MESSAGES
              }
              if (paged) {
                if (wantBefore > 0) pageReq.beforeSeq = wantBefore
                if (pageWindow) pageReq.turnWindow = pageWindow
              }
              return ctl.page(pageReq, AbortSignal.timeout(20000))
            }
            return ctl.history({ sessionId: sid, maxMessages: PAGE_MAX_MESSAGES }, AbortSignal.timeout(20000))
          })
          .then((h) => {

            const events = extractEvents(h)

            const fullTurns = stripAcpInTurns(foldHistoryToTurns(events, { wan: wan }))

            const todos = projectTodos(events)

            const cardLog = logForCards(sid, events)
            const deliver = collectDeliveryFiles(sid, cardLog)

            const changeSeqs = collectChangeSeqs(sid, cardLog)
            if (fullTurns.length) {
              const out = Object.assign({}, base, {

                turns: attachDetailCards(fullTurns, deliver, sid, changeSeqs),
                turnCount: fullTurns.length,

                todos: todos.length ? todos : base.todos,

                trace: wantDetailTrace() ? buildTrace(events, { wan: wan }) : [],
                full: true
              })

              if (liveFoldedInLastTurn(lvLog, fullTurns)) delete out.live
              return markPage(out, h, events)
            }

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
            return markPage(Object.assign({}, base, {

              turns: attachDetailCards(base.turns, deliver, sid, changeSeqs),
              todos: todos.length ? todos : base.todos,
              trace: []
            }, h, events))
          })
          .catch((e) => {
            log('[detail] history 退回概要' + (usedSubAddress ? '（子会话地址）' : '') + ': ' + ((e && e.message) || e))

            return markPage(Object.assign({}, base, {
              turns: attachDetailCards(base.turns, null, sid, collectChangeSeqs(sid)),
              trace: []
            }, null, null))
          })
      }

      return Object.assign({}, base, {
        turns: attachDetailCards(base.turns, null, sid, collectChangeSeqs(sid)),
        trace: []
      })
    }).then((out) => {

      if (meta && typeof meta === 'object' && meta.toolBody === true) {
        try {
          const saved = omitOldToolBodies(out && out.turns)
          if (out && typeof out === 'object') out.toolBodyOmittedBytes = saved
        } catch (e3) {
          log('[detail] 工具体置空失败（不影响主链路）: ' + ((e3 && e3.message) || e3))
        }
      }

      let bytes = 0
      try { bytes = byteLen(JSON.stringify(out)) } catch (e2) { bytes = 0 }
      if (out && typeof out === 'object') { out.detailBytes = bytes; out.truncated = false }

      if (isWanScope(meta) || (meta && meta.__detailGate === true)) return out
      if (!(DETAIL_MAX_BYTES > 0 && bytes > DETAIL_MAX_BYTES)) return out

      log('[detail] ⚠ 局域网全量 ' + bytes + ' 字节，超过体积闸上限 ' + DETAIL_MAX_BYTES +
        ' 字节（DSH_CONSOLE_DETAIL_MAX_BYTES），已退回公网截断口径')
      return readDetail(sid, { wan: true, __detailGate: true }).then((trimmed) => {
        const to = (trimmed && typeof trimmed === 'object') ? trimmed : out
        to.truncated = true
        to.truncatedReason = 'detail-too-large: 全量 ' + bytes + ' 字节 > 体积闸上限 ' + DETAIL_MAX_BYTES +
          ' 字节（环境变量 DSH_CONSOLE_DETAIL_MAX_BYTES），已整体退回公网截断口径'
        to.detailBytes = bytes
        to.lanBytes = bytes
        to.detailMaxBytes = DETAIL_MAX_BYTES
        return to
      })
    }).catch((e) => {

      log('[detail] projections 失败，退回空骨架: ' + ((e && e.message) || e))
      return {
        ok: true, sessionId: sid, title: '', asOfSeq: 0, running: false,
        turns: [], turnCount: 0, degraded: true,
        stats: { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0 },
        token: { input: 0, output: 0, cacheRead: 0, hitRate: 0 },
        context: { used: 0, window: 0, percent: 0 },
        trace: [], error: String((e && e.message) || e)
      }
    })
  }

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
    } catch (e) {  }
    return bootTunnel()
  }

  let wanMeter = null
  try {
    wanMeter = createWanMeter({ log: log })
    log('[wan] 流量计量器就绪 month=' + wanMeter.snapshot().month + ' bytes=' + wanMeter.snapshot().bytes)
  } catch (e) {
    wanMeter = null
    log('[wan] 计量器初始化失败（不影响局域网直传）：' + ((e && e.message) || e))
  }

  let wanCloud = null

  const wanFetch = makeWanFetch({
    meter: wanMeter,
    onWan: (w) => { wanCloud = w },
    log: log
  })

  function wanEntitlements() {
    const snap = (() => { try { return wanMeter && typeof wanMeter.snapshot === 'function' ? wanMeter.snapshot() : null } catch (e) { return null } })()
    const c = (wanCloud && typeof wanCloud === 'object') ? wanCloud : null
    const pick = (k) => {
      if (c) { const v = c[k]; if (v !== null && v !== undefined && v !== '') { const n = Number(v); if (Number.isFinite(n)) return Math.floor(n) } }
      if (snap) { const v = snap[k]; if (v !== null && v !== undefined && v !== '') { const n = Number(v); if (Number.isFinite(n)) return Math.floor(n) } }
      return null
    }
    let unlimited = !!((c && c.unlimited === true) || (snap && snap.unlimited === true))
    let uploadMaxBytes = pick('uploadMaxBytes')
    let quotaBytes = pick('quotaBytes')
    const limitBps = pick('limitBps')
    if (uploadMaxBytes === null) uploadMaxBytes = WAN_DEFAULT_UPLOAD_MAX_BYTES
    if (quotaBytes === null) quotaBytes = WAN_DEFAULT_QUOTA_BYTES

    if (!unlimited && (uploadMaxBytes === 0 || quotaBytes === 0 || limitBps === 0)) unlimited = true
    if (unlimited) { uploadMaxBytes = 0; quotaBytes = 0 }
    const usedBytes = Math.max(
      Number(c && c.usedBytes) || 0,
      Number(snap && snap.usedBytes) || 0,
      Number(snap && snap.bytes) || 0
    )
    return { unlimited: unlimited, uploadMaxBytes: uploadMaxBytes, quotaBytes: quotaBytes, limitBps: limitBps || 0, usedBytes: usedBytes }
  }

  function wanCapText(bytes) {
    const mb = Math.floor(Number(bytes) / 1024 / 1024)
    return mb > 0 ? mb + 'MB' : '1MB'
  }
  function wanQuotaText(bytes) {
    const gb = Number(bytes) / 1024 / 1024 / 1024
    const txt = gb >= 1 ? String(Math.round(gb * 10) / 10) : String(Math.round(gb * 1024)) + 'MB'
    return txt + (gb >= 1 ? ' GB' : '')
  }

  let cloudLink = null
  try {
    cloudLink = createCloudLink({ log: log, config: (config && config.cloud) || {}, onTunnel: ensureTunnel, fetch: wanFetch })
    log('[cloud] 云链路已就绪 nodeId=' + String(cloudLink && cloudLink.nodeId || '').slice(0, 8) + '…')
  } catch (e) {
    cloudLink = null
    log('[cloud] 初始化失败（不影响其它功能）：' + ((e && e.message) || e))
  }

  function cloudPushReady() {
    try { return Boolean(cloudLink && cloudLink.nodeId) } catch (e) { return false }
  }

  async function reportTokenToCloud(token, p) {
    const tok = String(token || '').trim()
    if (!tok || !cloudLink) return { cloud: false }
    try {
      const r = await cloudLink.pushRegister(tok, {
        deviceId: String(p.deviceId || ''),
        deviceModel: String(p.deviceModel || '')
      })
      if (r && r.ok) {
        log('push: token 尾号 ' + tok.slice(-8) + ' 已上报云端（云端共 ' + (Number(r.count) || 0) + ' 条）')
        return { cloud: true }
      }
      log('push: token 上报云端失败（本机已存）：' + String((r && r.error) || '未知原因'))
      return { cloud: false }
    } catch (e) {
      log('push: token 上报云端异常（本机已存）：' + ((e && e.message) || e))
      return { cloud: false }
    }
  }

  async function backfillTokensToCloud() {
    if (!cloudLink) return 0
    let list = []
    try { list = readPushTokens() } catch (e) { list = [] }
    let n = 0
    for (const one of list) {
      const tok = String((one && one.token) || '').trim()
      if (!tok) continue
      const r = await reportTokenToCloud(tok, one || {})
      if (r && r.cloud) n += 1
    }
    if (n > 0) log('push: 启动时把 ' + n + ' 条本机 token 补报给云端')
    return n
  }

  async function sendPushCloudFirst(o) {
    const req = o || {}
    if (cloudPushReady()) {
      try {
        const r = await cloudLink.pushNotify({ sessionId: req.sessionId, title: req.title, body: req.body })
        if (r && r.ok) {
          return { ok: true, count: Number(r.sent) || 0, via: 'cloud', skipped: Number(r.skipped) || 0 }
        }
        log('push: 云端推送未成功（' + String((r && (r.error || r.reason)) || '未知原因') + '），回退本机直发')
      } catch (e) {
        log('push: 云端推送异常（' + ((e && e.message) || e) + '），回退本机直发')
      }
    }
    return sendPush(req)
  }

  const cloudPlugin = createCloudPlugin({
    logger: log,
    version: PLUGIN_VERSION,
    metaUrl: import.meta.url,

    onLatest: (v) => { latestVersion = v; latestAt = Date.now() }
  })

  const lan = startLanServer({
    port: Number(config.port) || 8899,

    allowShift: config.allowShiftPort === true,
    getToken: () => token,

    webGuiPort: () => {
      try {
        const ws = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : null
        return ws ? (Number(ws.port) || 0) : 0
      } catch (e) { return 0 }
    },

    getRemotePair: () => remotePairOn(),

    getMaster: () => masterOn(),

    getUpdateState: () => cloudPlugin.updateState(),
    getInfo: () => {

      const presetNow = readPresetNow()

      refreshLatestVersion()
      return {
        name: nodeName,
        nodeId: 'dsh-console',
        host: os.hostname(),
        dshOk: dshOk,
        dshError: dshError,
        version: PLUGIN_VERSION,

        latestVersion: latestVersion,

        installKind: (cloudPlugin && typeof cloudPlugin.installKind === 'function') ? cloudPlugin.installKind() : '',
        installDev: !!(cloudPlugin && typeof cloudPlugin.installDev === 'function' && cloudPlugin.installDev()),

        agentPreset: presetNow,
        agentPresetAvailable: presetProbe.available
      }
    },
    listSessions: () => listSessionsForClient(),

    runCommand: (op, payload, meta) => runCommand(op, payload, meta),

    attachmentOf: async (id) => {
      const info = attachments.infoOf(id)
      if (!info) return null
      const data = await attachments.readImageOf(id)
      if (!data || !data.length) return null
      return { mime: info.mime || '', name: info.name || '', data: data, bytes: data.length }
    },

    mp: null,

    wanMeter: wanMeter,
    getWanLimits: () => wanCloud,

    uploadSink: (info) => acceptUpload(info),

    cloud: cloudLink,
    log: log
  })

  try { lan.setTunnel(tunnelStatus) } catch (e) {  }
  try { bootTunnel() } catch (e) {  }

  const mp = attachMp(ctx, {
    log,
    config: config.mp || {},
    isPairCode: (code) => code === lan.peekPairCode(),

    onStream: (req, mode) => lan.noteStreamLink(req, mode)
  })
  lan.setMp({
    branch: mp.branch,

    onUpgrade: (typeof mp.onUpgrade === 'function') ? mp.onUpgrade : null,

    issueForCode: (code, about) => (typeof mp.issueForCode === 'function' ? mp.issueForCode(code, about) : ''),

    issueDevice: (about) => (typeof mp.issueDevice === 'function' ? mp.issueDevice(about) : ''),

    store: mp.store
  })

  function agentPresetsService() {
    try {
      if (!ctx || typeof ctx.get !== 'function') return null
      return ctx.get('agentPresets') || ctx.get('agent-preset-registry') || null
    } catch (e) { return null }
  }

  function permissionPresetsService() {
    try {
      if (!ctx || typeof ctx.get !== 'function') return null
      return ctx.get('permissionPresets') || null
    } catch (e) { return null }
  }

  function refMention(sessionId, label) {
    const sid = String(sessionId || '')
    if (!sid) return ''
    const text = String(label || sid).replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
    const uri = 'dsh-session:' + Buffer.from(JSON.stringify(sid), 'utf8').toString('base64url')
    return '@[' + text + '](' + uri + ')'
  }

  function presetSettingsValue() {
    try {
      const s = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : null
      if (!s) return null
      if (typeof s.namespace === 'function') return s.namespace('agent-preset-registry')
      if (s['agent-preset-registry'] !== undefined) return s['agent-preset-registry']
      return null
    } catch (e) { return null }
  }

  const BUSY_ENTER_NS = 'ui-conversation'
  const BUSY_ENTER_FIELD = 'busyEnter'

  function normBusyEnter(v) {
    return (v === 'steer' || v === 'queue') ? v : ''
  }

  function busyEnterService() {
    try {
      if (!ctx || typeof ctx.get !== 'function') return null
      const s = ctx.get('settings')
      return (s && typeof s.describe === 'function') ? s : null
    } catch (e) { return null }
  }

  function busyEnterRead() {
    const sett = busyEnterService()
    if (!sett) return ''
    try {
      const rows = sett.describe()
      const list = Array.isArray(rows) ? rows : []
      for (const row of list) {
        if (!row || row.ns !== BUSY_ENTER_NS) continue
        const val = (row.value && typeof row.value === 'object') ? row.value : {}
        const usr = (row.user && typeof row.user === 'object') ? row.user : {}
        const raw = (val[BUSY_ENTER_FIELD] !== undefined) ? val[BUSY_ENTER_FIELD] : usr[BUSY_ENTER_FIELD]
        return normBusyEnter(raw)
      }
      return ''
    } catch (e) { return '' }
  }

  async function busyEnterWrite(want) {
    const sett = busyEnterService()
    if (!sett || typeof sett.update !== 'function') return false
    try {
      const patch = {}
      patch[BUSY_ENTER_FIELD] = want

      await sett.update(BUSY_ENTER_NS, patch, undefined)
      return true
    } catch (e) {
      log('[busy-enter] 写电脑端 busyEnter 失败: ' + ((e && e.message) || e))
      return false
    }
  }

  function presetCurrentId(svc) {
    const norm = (raw) => {
      if (raw == null) return ''
      if (typeof raw === 'function') return ''
      if (typeof raw === 'string') return raw
      if (typeof raw === 'number') return String(raw)
      if (typeof raw === 'object') return String(raw.id ?? raw.name ?? '')
      return ''
    }
    try {
      const raw = svc ? (svc.current ?? svc.selected) : null
      const v = norm(raw)
      if (v) return v
    } catch (e) {  }
    try {
      const v = norm(svc ? svc.defaultId : null)
      if (v) return v
    } catch (e) {  }
    try {
      const cfg = svc ? svc.config : null
      if (cfg) {
        const f = cfg.selectedDefault
        const v = norm(f && typeof f.get === 'function' ? f.get() : f)
        if (v) return v
        const d = norm(cfg.default)
        if (d) return d
      }
    } catch (e) {  }
    try {
      const ns = presetSettingsValue()
      const v = norm(ns ? ns.selectedDefault : null)
      if (v) return v
    } catch (e) {  }
    return ''
  }

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

  function hostPins() {
    try {
      if (!reg) return null
      const list = reg.pinnedSessionIds
      return Array.isArray(list) ? list.map((x) => String(x)) : null
    } catch (e) {
      return null
    }
  }

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

  const WS_RENAME_UNSUPPORTED = '本机插件不支持工作区改名，或需要重启 DSH'

  function wsNormPath(s) {
    return String(s || '').replace(/[\\/]+$/, '').toLowerCase()
  }

  function wsRenameErr(e) {
    const code = String((e && e.code) || '')
    const msg = String((e && e.message) || e || '')
    const all = code + ' ' + msg
    if (/bad-request|non-blank|blank/i.test(all)) return new Error('新名字不能为空')
    if (/name-conflict|already in use/i.test(all)) return new Error('已存在同名工作区')
    if (/not-found|not found/i.test(all)) return new Error('找不到这个工作区，请刷新列表后重试')
    return new Error('工作区改名失败：' + (msg || code || '未知错误'))
  }

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

  async function acceptUpload(info) {
    const i = info || {}
    const tmpPath = String(i.tmpPath || '')
    if (!tmpPath) throw new Error('缺少 tmpPath')
    const dir = inboxDir()
    fs.mkdirSync(dir, { recursive: true })
    const out = uniquePathIn(dir, i.name)
    try {
      fs.renameSync(tmpPath, out)
    } catch (e) {
      if (e && e.code === 'EXDEV') { fs.copyFileSync(tmpPath, out); fs.unlinkSync(tmpPath) }
      else throw e
    }
    const bytes = Number(i.bytes) || 0
    const sessionId = String(i.sessionId || '')
    log('[upload] 已存 ' + out + '（' + bytes + ' bytes）')
    let notified = false
    if (sessionId && ctl && typeof ctl.prompt === 'function') {
      try {
        await ctl.prompt({
          requestId: crypto.randomUUID(),
          sessionId: sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: '【来自手机】已上传文件到电脑：' + out }]
        }, AbortSignal.timeout(20000))
        notified = true
      } catch (e) {
        log('[upload] 通知会话失败: ' + ((e && e.message) || e))
      }
    }
    return { path: out, name: path.basename(out), bytes: bytes, notified: notified }
  }

  const PV_WMO_TEXT = {
    0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 48: '霜雾',
    51: '小毛雨', 53: '毛毛雨', 55: '大毛雨', 56: '冻毛雨', 57: '冻毛雨',
    61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
    80: '小阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪',
    95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷雨伴冰雹'
  }

  function pvWmoText(code) {
    const t = PV_WMO_TEXT[Number(code)]
    return typeof t === 'string' ? t : '未知天气'
  }

  function pvWindText(deg, kmh) {
    const names = ['北', '东北偏北', '东北', '东北偏东', '东', '东南偏东', '东南', '东南偏南',
      '南', '西南偏南', '西南', '西南偏西', '西', '西北偏西', '西北', '西北偏北']
    const d = Number(deg)
    const idx = Number.isFinite(d) ? Math.round(((d % 360) + 360) % 360 / 22.5) % 16 : 0
    const v = Number(kmh)
    const speed = Number.isFinite(v) ? String(Math.round(v)) + ' 公里/小时' : '未知'
    return names[idx] + '风 ' + speed
  }

  async function pvWeatherView(city) {
    const name = String(city || '').trim() || '杭州'
    try {
      const geoUrl = 'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(name) + '&count=1&language=zh&format=json'
      const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(8000) })
      if (!geoRes || !geoRes.ok) return { ok: false, error: '查不到这个城市（地名服务没响应）' }
      const geo = await geoRes.json()
      const hit = geo && Array.isArray(geo.results) && geo.results.length ? geo.results[0] : null
      if (!hit) return { ok: false, error: '查不到这个城市：' + name }
      const lat = Number(hit.latitude)
      const lon = Number(hit.longitude)
      const realName = String(hit.name || name)
      const tz = String(hit.timezone || 'Asia/Shanghai')
      const fcUrl = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
        '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code' +
        '&hourly=temperature_2m&timezone=' + encodeURIComponent(tz) + '&forecast_days=1'
      const fcRes = await fetch(fcUrl, { signal: AbortSignal.timeout(8000) })
      if (!fcRes || !fcRes.ok) return { ok: false, error: '气象服务没响应，稍后再试' }
      const fc = await fcRes.json()
      const cur = (fc && fc.current) || {}
      const temp = Number(cur.temperature_2m)
      if (!Number.isFinite(temp)) return { ok: false, error: '气象服务回的数据不完整' }
      const feels = Number(cur.apparent_temperature)
      const hum = Number(cur.relative_humidity_2m)
      const humVal = Number.isFinite(hum) ? Math.round(hum) : 0
      const cond = pvWmoText(cur.weather_code)
      const wind = pvWindText(cur.wind_direction_10m, cur.wind_speed_10m)
      const nowKey = String(cur.time || '')
      const times = (fc && fc.hourly && Array.isArray(fc.hourly.time)) ? fc.hourly.time : []
      const temps = (fc && fc.hourly && Array.isArray(fc.hourly.temperature_2m)) ? fc.hourly.temperature_2m : []
      const hours = []
      let start = times.indexOf(nowKey)
      if (start < 0) start = 0
      for (let i = start; i < times.length && hours.length < 6; i++) {
        const t = String(times[i] || '')
        const deg = Number(temps[i])
        if (!t || !Number.isFinite(deg)) continue
        hours.push({ text: t.slice(11, 16) + '  ' + Math.round(deg) + '°C' })
      }
      const view = {
        version: 1,
        root: { type: 'stack', children: [
          { type: 'text', text: realName + ' · ' + cond, size: 18 },
          { type: 'metric', label: '当前气温', value: String(Math.round(temp)), unit: '°C',
            hint: Number.isFinite(feels) ? ('体感 ' + Math.round(feels) + '°C') : '' },
          { type: 'keyValue', items: [
            { key: '湿度', value: humVal + '%' },
            { key: '风力', value: wind },
            { key: '数据源', value: 'open-meteo' }
          ] },
          { type: 'progress', label: '相对湿度', amount: humVal, total: 100 },
          { type: 'list', items: hours }
        ] }
      }
      const rawView = JSON.stringify(view)
      if (rawView.length > 8192) return { ok: false, error: '视图太大，App 收不了' }
      const stamp = new Date().toLocaleTimeString('zh-CN', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' })
      return { ok: true, city: realName, view: rawView, updatedAt: String(stamp || '') }
    } catch (e) {
      return { ok: false, error: '取天气失败：' + String((e && e.message) || e) }
    }
  }

  async function runCommand(op, payload, meta) {
    const p = payload || {}

    const scopeMeta = (p.__wan === true && !isWanScope(meta))
      ? Object.assign({}, (meta && typeof meta === 'object') ? meta : {}, { wan: true })
      : meta
    if (op === 'sessions') return listSessionsForClient()

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

      const busyMode = p.busyMode === 'steer' ? 'steer' : 'queue'
      return ctl.prompt({
        requestId: crypto.randomUUID(),
        sessionId,
        mode: busyMode,
        content: [{ type: 'text', text }]
      }, AbortSignal.timeout(20000))
    }

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

      const wanImg = !!(scopeMeta && scopeMeta.wan === true)
      let totalBytes = 0
      for (const im of imgs) {
        const mt = MEDIA[String((im && im.mediaType) || '').toLowerCase()]
        const data = String((im && im.data) || '')
        if (!mt || !data) throw new Error('图片格式不支持（只收 png/jpg/webp/gif）')

        if (wanImg && data.length > 14e6) throw new Error('有图片超过大小上限（公网单张 base64 后 14MB）')
        totalBytes += decodedBase64Bytes(data)
        const nm = String((im && im.name) || '').slice(0, 80)
        content.push(nm ? { type: 'image', mediaType: mt, data, name: nm } : { type: 'image', mediaType: mt, data })
      }

      const wan = !!(scopeMeta && scopeMeta.wan === true)
      if (wan && totalBytes > 0) {
        const ent = wanEntitlements()
        const cap = ent.unlimited ? 0 : ent.uploadMaxBytes
        if (cap > 0 && totalBytes > cap) throw new Error('图片过大（公网上传单次上限 ' + wanCapText(cap) + '）')
        const quotaBytes = ent.unlimited ? 0 : ent.quotaBytes
        const usedBytes = ent.unlimited ? 0 : ent.usedBytes
        if (quotaBytes > 0 && usedBytes + totalBytes > quotaBytes) {
          throw new Error('本月公网流量已用完（' + wanQuotaText(quotaBytes) + '/月，每月 1 号刷新）')
        }

        if (typeof scopeMeta.record === 'function') {
          try { scopeMeta.record(totalBytes) } catch (e) { log('[uploadImage] 记账失败（忽略）：' + ((e && e.message) || e)) }
        }
      }

      const sendPrompt = (blocks) => ctl.prompt({
        requestId: crypto.randomUUID(),
        sessionId,
        mode: 'queue',
        content: blocks
      }, AbortSignal.timeout(30000))
      return Promise.resolve().then(() => sendPrompt(content)).catch((e) => {

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

    if (op === 'uploadFile') {
      const sessionId = String(p.sessionId || '')
      if (!sessionId) throw new Error('缺少 sessionId')
      const raw = String(p.data || '')
      if (!raw) throw new Error('没有收到文件内容')

      if (scopeMeta && scopeMeta.wan === true) {
        const ent0 = wanEntitlements()
        const cap0 = ent0.unlimited ? 0 : ent0.uploadMaxBytes
        if (cap0 > 0 && raw.length > Math.floor(cap0 * 4 / 3)) {
          throw new Error('文件太大（公网上传单次上限 ' + wanCapText(cap0) + '，base64 后约 ' + wanCapText(Math.floor(cap0 * 4 / 3)) + '）')
        }
      }

      const decodedBytes = decodedBase64Bytes(raw)
      if (scopeMeta && scopeMeta.wan === true) {
        const ent = wanEntitlements()
        const cap = ent.unlimited ? 0 : (Number(scopeMeta.limitBytes) > 0 ? Number(scopeMeta.limitBytes) : ent.uploadMaxBytes)
        if (cap > 0 && decodedBytes > cap) throw new Error('文件过大（公网上传单次上限 ' + wanCapText(cap) + '）')
        const quotaBytes = ent.unlimited ? 0 : ent.quotaBytes
        if (quotaBytes > 0 && ent.usedBytes + decodedBytes > quotaBytes) {
          throw new Error('本月公网流量已用完（' + wanQuotaText(quotaBytes) + '/月，每月 1 号刷新）')
        }
      }

      const name = safeUploadName(p.name || 'file.bin')
      const dir = inboxDir()
      fs.mkdirSync(dir, { recursive: true })
      const out = uniquePathIn(dir, name)
      fs.writeFileSync(out, Buffer.from(raw, 'base64'))
      log('[uploadFile] 已存 ' + out + '（' + decodedBytes + ' bytes）')

      if (scopeMeta && scopeMeta.wan === true && decodedBytes > 0 && typeof scopeMeta.record === 'function') {
        try { scopeMeta.record(decodedBytes) } catch (e) { log('[uploadFile] 记账失败（忽略）：' + ((e && e.message) || e)) }
      }
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

    if (op === 'detail') {
      const sid = String(p.sessionId || '')
      if (!sid) throw new Error('缺少 sessionId')

      return readDetail(sid, scopeMeta)
    }

    if (op === 'toolBody') {

      const sid = String(p.sessionId || '')
      if (!sid) throw new Error('缺少 sessionId')
      return readToolBody(sid, scopeMeta, p)
    }

    if (op === 'deviceRevoke') {
      try {
        const want = String(p.deviceId == null ? '' : p.deviceId).trim()

        if (want === '') return { ok: false, error: 'device-not-found' }
        const store = mp && mp.store
        if (!store || typeof store.revokeDevice !== 'function') {
          return { ok: false, error: 'device-store-unavailable' }
        }
        const removed = Number(store.revokeDevice(want)) || 0

        if (removed <= 0) return { ok: false, error: 'device-not-found' }
        return { ok: true, removed: removed }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }

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

    if (op === 'wsRename') return wsRenameOnHost(p)

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

    if (op === 'create') {
      if (!ctl || typeof ctl.create !== 'function') throw new Error('sessionController.create 不可用')
      const cwdArg = p.cwd ? String(p.cwd) : ''
      const idArg = p.workspaceId ? String(p.workspaceId) : ''

      let regNow = null
      try { regNow = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null } catch (e) { regNow = null }
      let wsList = null
      try { if (regNow && typeof regNow.list === 'function') wsList = regNow.list() } catch (e) { wsList = null }
      if (!Array.isArray(wsList)) wsList = null

      let wsHit = null
      if (wsList && wsList.length > 0) {
        if (idArg) wsHit = wsList.find((c) => c && String(c.id) === idArg) || null
        if (!wsHit && cwdArg) {
          const want = wsNormPath(cwdArg)
          wsHit = wsList.find((c) => c && wsNormPath(c.path) === want) || null
        }

        if (!wsHit && !idArg && !cwdArg) wsHit = wsList[0] || null
      }

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

    if (op === 'unarchive') {
      const sid = String(p.sessionId || '')
      if (!sid) throw new Error('缺少 sessionId')
      const who = await unarchiveOnHost(sid)
      if (who === null) throw new Error('这个 DSH 版本没有可用的取消归档入口')
      await archiveSync(sid, false)
      return { ok: true, done: 'unarchive' }
    }

    if (op === 'archive' || op === 'delete') {
      const sid = String(p.sessionId || '')
      if (!sid) throw new Error('缺少 sessionId')
      if (op === 'archive') {

        if (ctl && typeof ctl.archive === 'function') {
          try {
            await ctl.archive({ sessionId: sid })
            await archiveSync(sid, true)
            return { ok: true, done: 'archive' }
          } catch (e) {
            const msg = (e && e.message) || String(e)

            if (/active/i.test(msg) && ctl && typeof ctl.cancel === 'function') {
              try { await ctl.cancel({ sessionId: sid }) } catch (e2) {  }
              await ctl.archive({ sessionId: sid })
              await archiveSync(sid, true)
              return { ok: true, done: 'archive', cancelledFirst: true }
            }
            throw e
          }
        }

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
            try { await ctl.cancel({ sessionId: sid }) } catch (e2) {  }
            await reg.archiveSession(sid)
            await archiveSync(sid, true)
            return { ok: true, done: 'archive', cancelledFirst: true }
          }
          throw e
        }
      }

      const get = (svc) => {
        try { return ctx.get(svc) } catch (e) { return undefined }
      }
      const sessions = get('sessions')
      const agents = get('agents')
      const query = get('sessionQuery')
      const home = path.join(os.homedir(), '.dsh')
      let sessionsRoot = home + path.sep + 'sessions'
      try {
        const persistence = get('sessionPersistence')
        if (persistence && typeof persistence.root === 'string' && persistence.root) {
          sessionsRoot = path.resolve(persistence.root)
        }
      } catch (e) {  }
      const storagesRoot = home + path.sep + 'storages'

      const targets = [sid]
      if (query && typeof query.traceSession === 'function') {
        try {
          const lineage = await query.traceSession(sid)
          for (const node of (lineage && lineage.descendants) || []) {
            const id = node && node.session && node.session.header && node.session.header.id
            if (typeof id === 'string' && id && targets.indexOf(id) < 0) targets.push(id)
          }
        } catch (e) {  }
      }

      const isLive = (id) => {
        try { return !!(sessions && typeof sessions.get === 'function' && sessions.get(id) !== undefined) }
        catch (e) { return false }
      }

      const closed = []
      let stillLive = targets.filter(isLive)
      for (const id of stillLive) {
        const agent = (() => {
          try { return agents && typeof agents.get === 'function' ? agents.get(id) : undefined }
          catch (e) { return undefined }
        })()
        if (agent && typeof agent.dispose === 'function') {
          try { await agent.dispose(); closed.push(id) } catch (e) {  }
        }
      }

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
        } catch (e) {  }
      }

      const directories = []
      const cacheFiles = []
      for (const id of targets) {

        let r = { dirs: [], caches: [] }
        try { r = sweepSessionFilesNow(id, { sessionsRoot: sessionsRoot, storagesRoot: storagesRoot }) }
        catch (e) {  }
        for (const d of r.dirs) directories.push(d)
        for (const f of r.caches) cacheFiles.push(f)
      }

      let sweepScheduled = 0
      for (const id of targets) { if (sweeper.schedule(id)) sweepScheduled += 1 }

      if (reg) {
        for (const id of targets) {
          for (const m of ['unpinSession', 'unarchiveSession']) {
            if (typeof reg[m] === 'function') {
              try { await reg[m].call(reg, id) } catch (e) {  }
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

        sweepScheduled: sweepScheduled,
        closedLive: closed,
        evictedLive: evicted,
        stillLive: leftLive
      }
    }

    if (op === 'fsDrives') {
      const drives = []
      for (let i = 67; i <= 90; i++) {
        const d = String.fromCharCode(i) + ':\\'
        try { fs.accessSync(d, fs.constants.R_OK); drives.push(d.slice(0, 2)) } catch (e) {  }
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
        try { isDir = fs.statSync(path.join(dir, String(n))).isDirectory() } catch (e) { continue }
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

    if (op === 'readFile') {
      const fp = String(p.path || '').trim()
      if (!fp) throw new Error('缺少 path')
      if (!path.isAbsolute(fp)) throw new Error('必须是绝对路径：' + fp)
      const st = fs.statSync(fp)
      if (!st.isFile()) throw new Error('不是文件：' + fp)

      const wanRead = isWanScope(scopeMeta)
      const readCapDefault = wanRead ? 3 * 1024 * 1024 : 0
      const explicitCap = Number(p.maxBytes) > 0 ? Math.floor(Number(p.maxBytes)) : 0
      const cap = explicitCap > 0 ? explicitCap : readCapDefault
      const name = path.basename(fp)
      if (cap > 0 && st.size > cap) {
        const mb = (st.size / 1048576).toFixed(1)
        const capMb = (cap / 1048576).toFixed(cap % 1048576 === 0 ? 0 : 1)
        const scopeHint = wanRead ? '（公网 3MB / 局域网不限）' : '（局域网不限 / 公网 3MB）'
        throw new Error('文件过大：' + name + ' ' + mb + ' MB，超过 ' + capMb + ' MB 上限' + scopeHint)
      }
      return {
        ok: true,
        path: path.resolve(fp),
        name: name,
        mime: mimeOfName(name),
        bytes: st.size,
        b64: fs.readFileSync(fp).toString('base64')
      }
    }

    if (op === 'desktopWeb') {
      const ws = (() => { try { return ctx.get('webServer') } catch (e) { return null } })()
      const c2 = (() => { try { return ctx.get('connection') } catch (e) { return null } })()
      if (!ws || typeof c2.authenticatedUrl !== 'function') {
        return { ok: false, error: '这个 DSH 版本没有 desktop web 能力' }
      }
      const port = Number(ws.port) || 0
      if (!(port > 0)) return { ok: false, error: 'webServer 未监听' }
      const proto = String(ws.protocol || 'http:')

      const base = proto + '//127.0.0.1:' + String(port) + '/'
      const url = String(c2.authenticatedUrl(base))
      return { ok: true, url: url, port: port }
    }

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

    if (op === 'selectPreset') {
      const sid = String(p.sessionId || '').trim()
      const pid = String(p.presetId || '').trim()

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

          presetProbe.available = true
          presetProbe.current = pid

          return { ok: true, selected: pid, scope: 'global' }
        } catch (e) {
          log('[select-preset] settings 回退失败: ' + ((e && e.message) || e))
        }
      }
      throw new Error('切不了预设：' + (sid ? ('拿不到会话 ' + sid + ' 的 Agent') : '会话未开过、也没有可用的全局设置') + '（' + (ns ? 'settings 回退也失败' : '且 settings 不可用') + '）')
    }

    if (op === 'permissionCatalog') {
      return Promise.resolve().then(async () => {
        const svc = permissionPresetsService()
        if (!svc || typeof svc.catalog !== 'function') {
          log('[permission-catalog] 宿主 permissionPresets 服务不可用（懒注册 / 版本差异），降级为空目录')
          return { ok: true, presets: [], current: '', defaultPreset: '', unavailable: true }
        }
        const cat = svc.catalog()
        const opts = (cat && Array.isArray(cat.options)) ? cat.options : []
        const presets = []
        for (let k = 0; k < opts.length; k++) {
          const o = opts[k] || {}
          const value = String(o.value || '')
          if (!value) continue
          presets.push({
            value: value,
            name: String(o.name || value),
            description: String(o.description || ''),
            isDefault: String((cat && cat.defaultPreset) || '') === value
          })
        }
        let current = ''
        const sid = String(p.sessionId || '').trim()
        if (sid) {
          const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : null
          const agent = (agents && typeof agents.get === 'function') ? agents.get(sid) : null
          if (agent && agent.session && typeof svc.current === 'function') {
            try { current = String(svc.current(agent.session) || '') } catch (e2) { current = '' }
          }
        }
        return { ok: true, presets: presets, current: current, defaultPreset: String((cat && cat.defaultPreset) || ''), unavailable: false }
      }).catch((e) => {
        log('[permission-catalog] 读取失败，降级为空目录: ' + ((e && e.message) || e))
        return { ok: true, presets: [], current: '', defaultPreset: '', unavailable: true }
      })
    }

    if (op === 'permissionSet') {
      const preset = String(p.permission || '').trim()
      const sid = String(p.sessionId || '').trim()
      if (!preset) throw new Error('缺少 permission')
      const svc = permissionPresetsService()
      if (!svc || typeof svc.set !== 'function') throw new Error('permissionPresets 服务不可用')
      if (!sid) throw new Error('缺少 sessionId（权限预设要落到具体会话上）')
      const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : null
      const agent = (agents && typeof agents.get === 'function') ? agents.get(sid) : null
      if (!agent || !agent.session) throw new Error('拿不到会话 ' + sid + ' 的 Agent')
      svc.set(agent.session, preset)
      let current = preset
      try { current = String(svc.current(agent.session) || preset) } catch (e3) { current = preset }
      return { ok: true, preset: preset, current: current }
    }

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

    if (op === 'pluginBundles') {
      return Promise.resolve().then(async () => {
        const svc = ctx && typeof ctx.get === 'function' ? ctx.get('pluginManager') : null
        if (!svc || typeof svc.listBundles !== 'function') {
          log('[plugin-bundles] 宿主 pluginManager 服务不可用（懒注册 / 版本差异），降级为空清单')
          return { ok: true, managementAvailable: false, entries: [] }
        }
        const list = (await svc.listBundles()) || []
        const entries = (Array.isArray(list) ? list : []).map((b) => {
          const name = String((b && b.name) || '')
          const meta = (b && b.meta) || null
          const title = pickLocale(meta && meta.title)
          const desc = pickLocale(meta && meta.description) || String((b && b.description) || '')
          const installTarget = (b && b.installTarget) || null
          return {
            name,
            title: title || name,
            description: desc,
            version: String((b && b.version) || (installTarget && installTarget.version) || ''),
            enabled: !!(b && b.enabled),
            installed: !!(b && b.installed),
            official: !!(b && b.official),
            source: String((b && b.source) || ''),
            error: pickLocale(meta && meta.error),

            optional: !!(b && b.optional),
            removable: !!(b && b.removable),
            availability: String((b && b.availability) || ''),
            readOnlyReason: String((b && b.readOnlyReason) || ''),
            icon: (function () { const ic = String((meta && typeof meta.icon === 'string') ? meta.icon : ''); return ic.length > 9000 ? '' : ic })(),
          }
        })
        return { ok: true, managementAvailable: true, entries }
      }).catch((e) => {
        log('[plugin-bundles] 读取失败，降级为空清单: ' + ((e && e.message) || e))
        return { ok: true, managementAvailable: false, entries: [] }
      })
    }

    if (op === 'pluginBundleToggle') {
      return Promise.resolve().then(async () => {
        const svc = ctx && typeof ctx.get === 'function' ? ctx.get('pluginManager') : null
        if (!svc || typeof svc.setBundleEnabled !== 'function') {
          log('[plugin-bundles] 宿主 pluginManager 服务不可用，开关无法下发')
          return { ok: false, error: '电脑端的插件管理还没起来（插件版本较旧或正在启动），稍后重试' }
        }
        const name = String(p.name || '').trim()
        if (!name) { return { ok: false, error: '缺少插件名' } }
        const want = p.enabled !== false
        const res = (await svc.setBundleEnabled(name, want)) || {}
        const app = String(res.application || '')
        const errCode = res.error && res.error.code ? String(res.error.code) : ''
        const diag = res.error && res.error.diagnostic ? String(res.error.diagnostic) : ''
        if (app === 'failed' || app === 'cancelled' || errCode) {
          const why = diag || errCode || app
          log('[plugin-bundles] 开关失败 ' + name + ' → ' + want + ' : ' + why)
          return { ok: false, error: '没能改这一项的开关：' + why }
        }
        const needRestart = app === 'restart-required'
        log('[plugin-bundles] 开关 ' + name + ' → ' + want + ' application=' + app)
        return {
          ok: true,
          changed: !!res.changed,
          enabled: res.enabled === undefined ? want : !!res.enabled,
          needRestart,
          restartReason: String(res.restartReason || ''),
          notice: needRestart ? '开关已记下，但要重启电脑端 DSH 才真正生效' : '',
        }
      }).catch((e) => {
        log('[plugin-bundles] 开关异常: ' + ((e && e.message) || e))
        return { ok: false, error: '改开关时出错：' + ((e && e.message) || String(e)) }
      })
    }

    if (op === 'pins') {
      const h = hostPins()
      return { ok: true, pinned: h !== null ? h : readPinFile() }
    }
    if (op === 'pin') {
      const sid = String(p.sessionId || '').trim()
      if (!sid) throw new Error('缺少 sessionId')
      const want = p.pinned !== false

      const exists = await sessionExists(sid)
      if (exists === false) throw new Error('找不到这个会话：' + sid)
      const host = await pinOnHost(sid, want)
      if (host !== null) return { ok: true, pinned: host }
      const cur = readPinFile()
      const next = want
        ? (cur.indexOf(sid) >= 0 ? cur : [sid].concat(cur))
        : cur.filter((x) => x !== sid)
      writePinFile(next)
      return { ok: true, pinned: next }
    }

    if (op === 'queueList') {
      const sid = String(p.sessionId || '').trim()
      if (!sid) throw new Error('缺少 sessionId')

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

          preview: text.replace(/\s+/g, ' ').trim().slice(0, 80),
        }
      }

      let agent = null
      try {
        const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : null
        if (agents && typeof agents.get === 'function') agent = agents.get(sid) || null
      } catch (e) { agent = null }

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
          if (isGoalRoundUserData(row.message)) continue
          const s = split(row.message)
          items.push({ id: row.id, placement: row.placement, text: s.text, preview: s.preview, editable: s.editable })
        }
        return { ok: true, items }
      }

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
              if (isGoalRoundUserData(msg)) continue
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

      log('[queue-list] 会话 ' + sid + ' 拿不到待发队列（本进程没开过它 / agents 与投影都没有队列），'
        + 'projections 键=[' + projKeys.join(',') + ']，回 queue-unavailable')
      return { ok: false, err: 'queue-unavailable', items: [] }
    }

    if (op === 'queueUpdate') {
      const sid = String(p.sessionId || '').trim()

      const itemId = String(p.itemId || p.queueItemId || '').trim()
      const kind = String(p.action || p.queueAction || '').trim()
      if (!sid) throw new Error('缺少 sessionId')
      if (!itemId) throw new Error('缺少 itemId')
      if (kind !== 'edit' && kind !== 'remove' && kind !== 'steer') {
        throw new Error('action 只支持 edit / remove / steer')
      }

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

    if (op === 'updateCheck') return await cloudPlugin.refresh(!!p.force)
    if (op === 'updateState') return cloudPlugin.state()
    if (op === 'updateStart') return cloudPlugin.startUpdate(String(p.mode || 'update'))
    if (op === 'updateCancel') return cloudPlugin.cancel()
    if (op === 'updateRollback') return cloudPlugin.startUpdate('rollback')

    if (op === 'remotePairGet') {
      return { ok: true, on: remotePairOn(), persisted: true }
    }
    if (op === 'remotePairSet') {
      try {
        const want = (p.on === true || p.on === 'true' || p.on === 1 || p.on === '1')
        const persisted = setRemotePair(want)
        return { ok: true, on: remotePairOn(), persisted }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }

    if (op === 'masterGet') {
      return { ok: true, on: masterOn(), persisted: true }
    }
    if (op === 'masterSet') {
      try {
        const want = !(p.on === false || p.on === 'false' || p.on === 0 || p.on === '0')
        const persisted = setMaster(want)
        log('[master] 总开关 → ' + (masterOn() ? '开' : '关') + (persisted ? '' : '（未落盘）'))
        return { ok: true, on: masterOn(), persisted }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }

    if (op === 'pushRegister') {
      const r = pushRegister(p)

      if (r && r.ok) {
        Promise.resolve()
          .then(() => reportTokenToCloud(p.pushToken, p))
          .catch(() => {})
      }
      return r
    }
    if (op === 'pushTokenList') return pushTokenList()

    if (op === 'pushStatus') {
      try {
        const groups = splitPushTokens(readPushTokens())
        const st = pushStatus({
          readTokens: () => readPushTokens(),
          emulatorCount: groups.emulator.length,
          test: pushTestMessage()
        })

        st.cloud = { ready: cloudPushReady(), via: cloudPushReady() ? 'cloud' : 'local' }
        return st
      } catch (e) {
        return { ok: false, ready: false, error: String((e && e.message) || e) }
      }
    }

    if (op === 'remotePairCodeRefresh') {
      try {
        const code = lan.refreshRemoteCode()
        const snap = (typeof lan.peekRemoteCode === 'function') ? lan.peekRemoteCode() : code
        return { ok: true, code: String(code || snap || ''), leftMs: Number(lan.remoteCodeLeftMs ? lan.remoteCodeLeftMs() : 0) || 0 }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }

    if (op === 'busyEnterGet') {
      const cur = busyEnterRead()
      const sett = busyEnterService()
      return { ok: true, available: !!(sett && cur), busyEnter: cur }
    }

    if (op === 'busyEnterSet') {
      const want = normBusyEnter(p.busyEnter)
      if (!want) return { ok: true, available: false, busyEnter: '' }
      const wrote = await busyEnterWrite(want)
      const cur = wrote ? want : busyEnterRead()
      return { ok: true, available: wrote, busyEnter: cur }
    }

    if (op === 'refCandidates') {
      const sid = String(p.sessionId || '')
      const query = String(p.query || '')
      let self = null
      try {
        const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : null
        self = agents && typeof agents.get === 'function' ? (agents.get(sid) || null) : null
      } catch (e) { self = null }

      let resolver = null
      try { resolver = ctx.get('sessionReferenceResolver') || null } catch (e) { resolver = null }

      if (resolver && self && typeof resolver.listCandidates === 'function') {
        try {
          const rows = await resolver.listCandidates(self, query, 50, AbortSignal.timeout(15000))
          const items = []
          for (const c of (rows || [])) {
            if (!c || !c.sessionId) continue
            const title = String(c.displayTitle || c.label || c.sessionId)
            items.push({
              sessionId: String(c.sessionId),
              label: String(c.label || c.sessionId),
              title,
              cwd: c.cwd ? String(c.cwd) : '',
              sameWorkspace: !!c.sameWorkspace,
              createdAt: Number(c.createdAt) || 0,
              mention: refMention(c.sessionId, title)
            })
          }
          return { ok: true, source: 'resolver', items }
        } catch (e) {                       }
      }

      try {
        const rows = await listSessionsForClient()
        const needle = query.toLocaleLowerCase()
        const items = []
        for (const s of (rows || [])) {
          if (!s || !s.id || s.id === sid) continue
          const title = String(s.title || '').trim() || String(s.id)
          const cwd = s.cwd ? String(s.cwd) : ''
          if (needle && !(String(s.id).toLocaleLowerCase().includes(needle) || title.toLocaleLowerCase().includes(needle) || cwd.toLocaleLowerCase().includes(needle))) continue
          items.push({
            sessionId: String(s.id),
            label: title,
            title,
            cwd,
            sameWorkspace: false,
            createdAt: Number(s.createdAt) || 0,
            mention: refMention(s.id, title)
          })
          if (items.length >= 50) break
        }
        return { ok: true, source: 'sessions', items }
      } catch (e) {
        return { ok: true, unavailable: true, items: [], error: String((e && e.message) || e) }
      }
    }

    if (op === 'slashCatalog') {
      const sid = String(p.sessionId || '')
      let goal = null
      let plan = null
      try {
        if (ctl && typeof ctl.projections === 'function' && sid) {
          const raw = await ctl.projections({ sessionId: sid }, AbortSignal.timeout(20000))
          const v = (raw && raw.values) || {}
          const g = v.goal
          if (g && typeof g === 'object') {
            goal = {
              objective: String(g.objective || ''),
              phase: String(g.phase || ''),
              activation: String(g.activation || ''),
              rounds: Number(g.roundsStarted) || 0,
              maxRounds: Number(g.maxGoalRounds) || 0
            }
          }
          const pl = v.plan
          if (pl && typeof pl === 'object') plan = { active: !!pl.active, pending: !!pl.pending }
        }
      } catch (e) {                             }

      const skills = []
      let skillsUnavailable = false
      try {
        const catalog = ctx && typeof ctx.get === 'function' ? ctx.get('sessionSkillCatalog') : null
        if (catalog && typeof catalog.list === 'function' && sid) {
          const r = await catalog.list({ sessionId: sid }, AbortSignal.timeout(15000))
          for (const s of ((r && r.skills) || [])) {
            if (!s || !s.name) continue
            skills.push({ name: String(s.name), description: String(s.description || ''), whenToUse: String(s.whenToUse || '') })
          }
        } else skillsUnavailable = true
      } catch (e) { skillsUnavailable = true }
      return { ok: true, goal, plan, skills, skillsUnavailable }
    }

    if (op === 'slashRun') {
      const sid = String(p.sessionId || '')
      const line = String(p.line || '').trim()
      if (!line) return { ok: false, error: '缺少命令内容' }
      let agent = null
      try {
        const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : null
        agent = agents && typeof agents.get === 'function' ? (agents.get(sid) || null) : null
      } catch (e) { agent = null }
      if (!agent) {
        return { ok: true, unavailable: true, error: '这个会话还没在这台电脑上跑起来，先在 App 里发一条普通消息唤醒它，再用 / 菜单' }
      }
      let commands = null
      try { commands = ctx.get('commands') || null } catch (e) { commands = null }
      if (!commands || typeof commands.execute !== 'function') {
        return { ok: true, unavailable: true, error: '这台电脑的 DSH 没有 commands 服务，斜杠命令用不了' }
      }
      const r = await commands.execute(agent, line, [], AbortSignal.timeout(30000))
      if (!r) return { ok: true, unavailable: true, error: '命令没被识别：' + line }
      const res = (r && r.result) || {}
      return { ok: true, commandId: String(r.commandId || ''), kind: String(res.kind || ''), text: String(res.text || '') }
    }

    if (op === 'pvWeather') {
      return await pvWeatherView(String(p.city || ''))
    }

    throw new Error('这个指令不支持：' + op)
  }

  async function fetchLocal(pathname) {
    const port = lan.port
    if (!port) return { ok: false, error: '服务还没起来' }
    const r = await fetch('http://127.0.0.1:' + port + pathname)
    return await r.json()
  }

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

    if (registerOne(conn, {
      path: STATE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {

          let light = false
          try {
            light = new URL(request.url).searchParams.get('light') === '1'
          } catch (e) {  }
          return json(200, await lan.panelData(!light))
        } catch (e) {
          return json(500, { ok: false, error: err(e) })
        }
      }
    }, '面板数据')) count += 1

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

    if (registerOne(conn, {
      path: SESSIONS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const list = await listSessionsForClient()
          return json(200, { ok: true, count: list.length, sessions: list })
        } catch (e) {
          dshOk = false
          dshError = err(e)
          return json(500, { ok: false, error: dshError })
        }
      }
    }, '会话列表')) count += 1

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

  const started = lan.start().then((r) => {
    if (!r) {
      say('warn', '局域网服务没起来，手机 App 连不上')
      return
    }
    say('info', '配对码 ' + r.code + '（15 分钟内有效）')
  })

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

  const pushReadTokens = () => {

    const g = splitPushTokens(readPushTokens())
    if (g.real.length > 0) {
      if (g.emulator.length > 0) {
        log('push: 跳过 ' + g.emulator.length + ' 条模拟器 token（收不到真机通知，不参与推送）')
      }
      return g.real
    }
    if (g.emulator.length > 0) {
      log('push: ⚠️ 名单里只有 ' + g.emulator.length + ' 条模拟器 token，没有真机；' +
        '照发但真机侧不会收到 —— 请在真机 App 里打开推送让 token 上报上来')
    }
    return g.emulator
  }
  const pushOpts = {
    readSessions,
    readTokens: pushReadTokens,

    ready: () => {
      try {
        if (cloudPushReady()) return true
        return pushReady() === true
      } catch (e) { return false }
    },

    allowNoTokens: () => cloudPushReady(),
    send: sendPushCloudFirst,
    log,
    test: pushTestMessage()
  }

  try {
    turnAnnouncer = createTurnAnnouncer(pushOpts)
  } catch (e) {
    turnAnnouncer = null
    log('push: 完成播报器没起来（退回轮询兜底）：' + ((e && e.message) || e))
  }

  let pushWatcher = null
  if (!busHooked || !turnAnnouncer) {
    try {
      pushWatcher = createPushWatcher(pushOpts)
      pushWatcher.start()
    } catch (e) {
      log('push: 会话完成检测没起来（忽略）：' + ((e && e.message) || e))
    }
  } else {
    log('push: 完成改事件驱动（turn/end + 15s 静默），15 秒轮询兜底不启动')
  }

  Promise.resolve().then(() => backfillTokensToCloud()).catch(() => {})
  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {

      try { if (pushWatcher) pushWatcher.stop() } catch (e) {  }
      try { if (turnAnnouncer) turnAnnouncer.stop() } catch (e) {  }
      sweeper.clear()
      for (const dispose of pending) { try { dispose() } catch (e) {  } }
      try { lan.stop() } catch (e) {  }

      try { stopTunnel() } catch (e) {  }
    }, 'dsh-console: cleanup')
  }

  registerRoutes(ctx && typeof ctx.get === 'function' ? ctx.get('connection') : null)

  try {
    const tools = ctx && typeof ctx.get === 'function' ? ctx.get('tools') : null
    if (tools && typeof tools.register === 'function') {
      const dispose = tools.register(hmWeatherTool())
      if (typeof dispose === 'function') pending.push(dispose)
      log('pview: 原生天气演示工具已注册')
    } else {
      log('pview: tools 服务不可用，跳过演示工具')
    }
  } catch (e) {
    log('pview: 演示工具注册失败（不影响控制台）：' + ((e && e.message) || e))
  }

  return started
}

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
      } catch (e) {  }
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
        } catch (e) {  }
      }
    }
    walk(cacheRoot, 0)
  }
  return out
}

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
  const timers = new Map()

  function clear() {
    for (const ts of timers.values()) for (const t of ts) { try { clearTimeout(t) } catch (e) {  } }
    timers.clear()
  }

  function schedule(id) {
    const sid = String(id || '')
    if (!sid) return false
    const prev = timers.get(sid)
    if (prev) for (const t of prev) { try { clearTimeout(t) } catch (e) {  } }
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

export function stripAcpInTurns(turns) {
  if (!Array.isArray(turns)) return turns
  for (const t of turns) {
    if (!t || typeof t !== 'object') continue

    if (typeof t.prompt === 'string') t.prompt = stripShellText(stripAcp(t.prompt))
    if (typeof t.response === 'string') t.response = stripShellText(stripAcp(t.response))
    if (typeof t.think === 'string') t.think = stripShellText(stripAcp(t.think))
    if (Array.isArray(t.prompts)) t.prompts = t.prompts.map((x) => (typeof x === 'string' ? stripAcp(x) : x))
    if (Array.isArray(t.thinks)) t.thinks = t.thinks.map((x) => (typeof x === 'string' ? stripAcp(x) : x))

    if (typeof t.rmd === 'string') {
      t.rmd = stripShellText(stripAcp(t.rmd))
      if (!t.rmd || t.rmd === t.response) delete t.rmd
    }
  }
  return turns
}

export function omitToolBodies(turns, keepTurns = 2) {
  if (!Array.isArray(turns) || turns.length === 0) return 0
  const keepRaw = Number(keepTurns)
  const keep = Number.isFinite(keepRaw) ? Math.max(0, Math.trunc(keepRaw)) : 2
  const keepFrom = Math.max(0, turns.length - keep)
  let saved = 0
  for (let ti = 0; ti < keepFrom; ti++) {
    const tl = turns[ti] && turns[ti].tools
    if (!Array.isArray(tl)) continue
    for (const c of tl) {
      if (!c || typeof c !== 'object') continue
      let hit = false
      for (const k of ['detail', 'result']) {
        const v = c[k]
        if (typeof v === 'string' && v !== '') { saved += Buffer.byteLength(v, 'utf8'); c[k] = ''; hit = true }
      }
      if (hit) c.bodyOmitted = true
    }
  }
  return saved
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

  return crypto.randomBytes(bytes).toString('hex')
}

export default { name, inject, apply }
