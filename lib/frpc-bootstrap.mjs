import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ossGateCheck, ossGateCommit, resetManualAttempt } from './dl-gate.mjs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const FRPC_DIR = path.join(os.homedir(), '.dsh', 'frp')

export const FRPC_MANIFEST_URL = 'https://gaoshou25.cn/frpc/manifest.json'
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20000

export const BUNDLED_META = {
  'win32-x64': {
    size: 15523328,
    sha256: '14cd52ca87fea607852b3a8e194146eeabe6ce87976cd1fc6327b74caebb6c77'
  }
}

export const FRPC_MIRROR_BASES = [

  { id: 'github', base: 'https://github.com/ChenJun25/dsh-console-plugin/releases/latest/download' },

  { id: 'oss', base: String(process.env.DSH_FRPC_OSS_BASE || '').trim() },

  { id: 'self', base: 'https://gaoshou25.cn/frpc' }
]

export function frpcBasesNow(plan) {
  const ids = plan && Array.isArray(plan.ids) ? plan.ids : null
  const skipOss = !!(plan && plan.skipOss === true)
  const out = []
  for (const b of FRPC_MIRROR_BASES) {
    const id = String((b && b.id) || '')
    const base = String((b && b.base) || '').trim().replace(/\/+$/, '')
    if (!base) continue
    if (ids && ids.indexOf(id) < 0) continue
    if (skipOss && id === 'oss') continue
    out.push({ id: id, base: base })
  }
  return out
}

export function manifestUrlsNow(plan) {
  const env = String(process.env.DSH_FRPC_MANIFEST || '').trim()
  const list = []
  if (env) list.push(env)
  for (const b of frpcBasesNow(plan)) {
    if (list.indexOf(b.base + '/manifest.json') < 0) list.push(b.base + '/manifest.json')
  }
  return list
}

function bundledFrpcPath(key) {
  const name = FILE_BY_KEY[key]
  if (!name) return ''
  try {
    const p = fileURLToPath(new URL('../assets/frpc/' + name, import.meta.url))
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return p
  } catch (_) { }
  return ''
}

export function installFromBundled(o = {}) {
  const key = String(o.key || platformKey())
  const log = typeof o.log === 'function' ? o.log : () => { }
  if (!key) return { ok: false, reason: 'unsupported', error: '暂不支持 frpc 的平台：' + String(process.platform) + '-' + String(process.arch) }
  const meta = BUNDLED_META[key] || null
  const src = bundledFrpcPath(key)
  if (!src) return { ok: false, reason: 'no-bundled', error: '本平台（' + key + '）没有内置 frpc' }
  const sha = verifyFrpc(src, meta || {})
  if (!sha) return { ok: false, reason: 'bundled-bad', error: '安装包内置的 frpc 校验不通过（插件包可能没下全）' }
  const target = String(o.target || frpcTargetPath(process.platform, process.arch) || '')
  if (!target) return { ok: false, reason: 'unsupported', error: '算不出 frpc 目标路径' }
  const already = verifyFrpc(target, meta || {})
  if (already) return { ok: true, path: target, size: fs.statSync(target).size, sha256: already, downloaded: false, bundled: true }
  const tmp = target + '.download'
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(src, tmp)
    fs.renameSync(tmp, target)
    try { fs.chmodSync(target, 0o755) } catch (_) { }
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch (_) { }
    return { ok: false, reason: 'io', error: '把内置 frpc 拷到 ' + target + ' 失败：' + errText(e) }
  }
  if (!fs.existsSync(target)) {
    return { ok: false, reason: 'blocked', error: '内置 frpc 写入后立刻消失，很可能是安全软件拦截；请把 ' + target + ' 加入白名单后重试' }
  }
  const size = fs.statSync(target).size
  log('[frpc] 已从插件包内释放 frpc → ' + target + '（' + size + ' 字节）')
  return { ok: true, path: target, size: size, sha256: sha, downloaded: true, bundled: true }
}

const FILE_BY_KEY = {
  'win32-x64': 'frpc_0.62.1_windows_amd64.exe',
  'linux-x64': 'frpc_0.62.1_linux_amd64',
  'linux-arm64': 'frpc_0.62.1_linux_arm64',
  'darwin-x64': 'frpc_0.62.1_darwin_amd64',
  'darwin-arm64': 'frpc_0.62.1_darwin_arm64'
}

export function platformKey(platform = process.platform, arch = process.arch) {
  const key = String(platform || '') + '-' + String(arch || '')
  return Object.prototype.hasOwnProperty.call(FILE_BY_KEY, key) ? key : ''
}

export function frpcTargetPath(platform = process.platform, arch = process.arch, dir = FRPC_DIR) {
  const key = platformKey(platform, arch)
  if (!key) return ''
  return path.join(dir, FILE_BY_KEY[key])
}

export function legacyFrpcPaths(platform = process.platform) {
  if (platform === 'win32') return ['C:\\Program Files\\dsh-frp\\frpc.exe']
  if (platform === 'darwin') return ['/usr/local/bin/frpc', '/opt/homebrew/bin/frpc']
  return ['/usr/local/bin/frpc', '/usr/bin/frpc']
}

function errText(e) { return String((e && e.message) || e || '') }

export function sha256OfFile(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

export function verifyFrpc(p, expect) {
  try {
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) return ''
    const size = fs.statSync(p).size
    if (Number(expect && expect.size) > 0 && size !== Number(expect.size)) return ''
    const sha = sha256OfFile(p)
    const want = String((expect && expect.sha256) || '').trim().toLowerCase()
    if (want && sha.toLowerCase() !== want) return ''
    return sha
  } catch (_) { return '' }
}

async function downloadFrpcOnce(o = {}) {
  const dir = o.dir || FRPC_DIR
  const platform = o.platform || process.platform
  const arch = o.arch || process.arch

  const manifestUrls = String(o.manifestUrl || '').trim()
    ? [{ id: 'explicit', base: '', url: String(o.manifestUrl).trim() }]
    : frpcBasesNow(o.plan).map((b) => ({ id: b.id, base: b.base, url: b.base + '/manifest.json' }))
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_DOWNLOAD_TIMEOUT_MS
  const log = typeof o.log === 'function' ? o.log : () => {}
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : null
  const outerSignal = o.signal || null

  const hasFetchOpt = Object.prototype.hasOwnProperty.call(o, 'fetch')
  const fetchFn = hasFetchOpt
    ? (typeof o.fetch === 'function' ? o.fetch : null)
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)

  const key = platformKey(platform, arch)
  if (!key) return { ok: false, reason: 'unsupported', error: '暂不支持自动下载 frpc 的平台：' + String(platform) + '-' + String(arch) }
  if (!fetchFn) return { ok: false, reason: 'no-fetch', error: '当前运行环境没有 fetch，无法自动下载 frpc' }

  const aborted = () => !!(outerSignal && outerSignal.aborted === true)
  if (aborted()) return { ok: false, reason: 'aborted', error: '已停止下载' }

  const target = path.join(dir, String(o.fileName || FILE_BY_KEY[key]))
  if (!manifestUrls.length) return { ok: false, reason: 'no-source', error: '没有配置任何 frpc 下载源' }

  let lastFail = null
  for (const src of manifestUrls) {
    if (aborted()) return { ok: false, reason: 'aborted', error: '已停止下载' }
    const murl = src.url || (src.base + '/manifest.json')

    if (src.id === 'oss') {
      const g = ossGateCheck()
      if (!g.ok) { log('[frpc] 跳过 OSS 源（闸门：' + g.reason + '）'); continue }
    }
    let e1 = null
    let v1 = ''
    try {
      const mres = await fetchFn(murl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
      if (!mres || mres.ok !== true) {
        lastFail = { ok: false, reason: 'manifest-http', error: '下载清单取不到（HTTP ' + String(mres && mres.status) + '）：' + murl }
        continue
      }
      let mj = null
      try { mj = await mres.json() } catch (e) {
        lastFail = { ok: false, reason: 'manifest-bad-json', error: '下载清单不是合法 JSON：' + murl }
        continue
      }
      e1 = mj && mj.files ? mj.files[key] : null
      v1 = String((mj && mj.version) || '')
      if (!e1 || !e1.file) {
        lastFail = { ok: false, reason: 'no-entry', error: '下载清单里没有本机平台（' + key + '）的 frpc：' + murl }
        continue
      }
    } catch (err) {
      lastFail = { ok: false, reason: 'fetch', error: '取下载清单失败：' + errText(err) + '（' + murl + '）' }
      continue
    }
    const url = src.base ? new URL(String(e1.file), src.base + '/').toString() : String(e1.file)
    const wantSize = Number(e1.size) || 0
    const tmp = target + '.download'
    try {

      const hardTimeout = AbortSignal.timeout(Number(o.downloadTimeoutMs) > 0 ? Number(o.downloadTimeoutMs) : 600000)
      const sig = (outerSignal && typeof AbortSignal.any === 'function')
        ? AbortSignal.any([outerSignal, hardTimeout])
        : (outerSignal || hardTimeout)
      const res = await fetchFn(url, { signal: sig })
      if (!res || res.ok !== true) {
        lastFail = { ok: false, reason: 'download-http', error: '下载 frpc 失败（HTTP ' + String(res && res.status) + '）：' + url }
        continue
      }

      fs.mkdirSync(dir, { recursive: true })
      const total = wantSize > 0 ? wantSize : (Number(res.headers && Number(res.headers.get && res.headers.get('content-length'))) || 0)
      let got = 0
      let lastPct = -1
      let nodeStream = null
      if (res.body && typeof res.body.getReader === 'function') {
        const { Readable } = await import('node:stream')
        nodeStream = Readable.fromWeb(res.body)
      }
      if (nodeStream) {
        const { pipeline } = await import('node:stream/promises')
        nodeStream.on('data', (c) => {
          got += (c && c.length) ? c.length : 0
          if (!onProgress) return
          if (total > 0) {
            const pct = Math.min(99, Math.floor(got / total * 100))
            if (pct !== lastPct) { lastPct = pct; onProgress(pct, got, total) }
          } else {
            onProgress(0, got, 0)
          }
        })
        await pipeline(nodeStream, fs.createWriteStream(tmp, { mode: 0o755 }))
        if (total > 0 && got !== total) {
          try { fs.unlinkSync(tmp) } catch (_) { }
          lastFail = { ok: false, reason: 'size-mismatch', error: 'frpc 大小不符（期望 ' + total + ' 字节，实收 ' + got + ' 字节）' }
          continue
        }
        if (onProgress) onProgress(99, got, total)
      } else {

        const buf0 = Buffer.from(await res.arrayBuffer())
        fs.writeFileSync(tmp, buf0, { mode: 0o755 })
        got = buf0.length
        if (onProgress) onProgress(99, got, got)
      }

      if (src.id === 'oss') { try { ossGateCommit(got) } catch (_) { } }
      fs.renameSync(tmp, target)
      try { fs.chmodSync(target, 0o755) } catch (_) { }
      if (!fs.existsSync(target)) {
        return { ok: false, reason: 'blocked', error: 'frpc 写入后立刻消失，很可能是安全软件拦截；请把 ' + target + ' 加入白名单后重试' }
      }
      let sha = ''
      try { sha = sha256OfFile(target) } catch (_) { }
      const wantSha = String(e1.sha256 || '').trim().toLowerCase()
      if (wantSha && sha.toLowerCase() !== wantSha) {
        try { fs.unlinkSync(target) } catch (_) { }
        lastFail = { ok: false, reason: 'sha-mismatch', error: 'frpc 校验和不符（期望 ' + wantSha.slice(0, 12) + '…，实得 ' + sha.slice(0, 12) + '…）' }
        continue
      }
      log('[frpc] 已从 ' + String(src.id || '外部源') + ' 下载 frpc ' + (v1 || '') + ' → ' + target + '（' + got + ' 字节）')
      return { ok: true, path: target, version: v1, size: got, sha256: sha, downloaded: true, source: String(src.id || '') }
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch (_) { }

      if (aborted() || (e && (e.name === 'AbortError' || /abort/i.test(String(e && e.message || ''))))) {
        return { ok: false, reason: 'aborted', error: '已停止下载（已删掉下到一半的文件）' }
      }
      lastFail = { ok: false, reason: 'download', error: '下载 frpc 失败：' + errText(e) + '（' + url + '）' }
      continue
    }
  }
  if (aborted()) return { ok: false, reason: 'aborted', error: '已停止下载' }
  return lastFail || { ok: false, reason: 'fetch', error: '没有可用的 frpc 下载源' }
}

export function frpcReady(o = {}) {
  const platform = o.platform || process.platform
  const arch = o.arch || process.arch
  const target = o.frpcPath || frpcTargetPath(platform, arch, o.dir || FRPC_DIR)
  const probe = (p) => {
    try {
      if (!p) return false
      const st = fs.statSync(p)
      return st.isFile() && st.size > 0
    } catch (_) { return false }
  }
  if (target && probe(target)) return { ok: true, path: target, legacy: false }
  const legacy = Array.isArray(o.legacyPaths) ? o.legacyPaths : legacyFrpcPaths(platform)
  for (const cand of legacy) {
    if (cand && probe(cand)) return { ok: true, path: cand, legacy: true }
  }
  return { ok: false, path: '', legacy: false }
}

export const AUTO_MAX_FAILS = 3
let autoFails = 0
let autoPaused = false
let autoLastReason = ''
let autoLastError = ''

export function frpcAutoState() {
  return {
    fails: autoFails,
    maxFails: AUTO_MAX_FAILS,
    paused: autoPaused === true,
    reason: autoLastReason,
    error: autoLastError
  }
}

export function resetFrpcAuto() {
  autoFails = 0
  autoPaused = false
  autoLastReason = ''
  autoLastError = ''
}

function noteAutoResult(r) {
  const ok = !!(r && r.ok === true)
  if (ok) { resetFrpcAuto(); return r }
  const reason = String((r && r.reason) || '')
  autoLastReason = reason
  autoLastError = String((r && r.error) || '')
  autoFails += 1

  if (reason === 'unsupported' || reason === 'no-fetch' || autoFails >= AUTO_MAX_FAILS) {
    autoPaused = true
  }
  return r
}

export async function downloadFrpc(o = {}) {
  const manual = o.auto === false
  if (!manual && autoPaused) {
    return {
      ok: false,
      reason: 'auto-paused',
      error: '自动下载已暂停（连续 ' + String(autoFails) + ' 次失败，最后一次：' + (autoLastError || autoLastReason || '未知') +
        '）。请点面板上的「重新下载 frpc」按钮重试，或重启 DSH。'
    }
  }
  const r = await downloadFrpcOnce(o)
  if (manual) {
    if (r && r.ok === true) { resetFrpcAuto(); resetManualAttempt('frpc') }
    return r
  }
  return noteAutoResult(r)
}

export async function ensureFrpc(o = {}) {
  const platform = o.platform || process.platform
  const arch = o.arch || process.arch
  const target = o.frpcPath || (o.fileName
    ? path.join(o.dir || FRPC_DIR, String(o.fileName))
    : frpcTargetPath(platform, arch, o.dir || FRPC_DIR))
  if (!target) return { ok: false, reason: 'unsupported', error: '暂不支持自动下载 frpc 的平台：' + String(platform) + '-' + String(arch) }
  const pick = (p) => {
    const sha = verifyFrpc(p)
    if (!sha) return null
    return { ok: true, path: p, size: fs.statSync(p).size, sha256: sha, downloaded: false }
  }
  const own = pick(target)
  if (own) return own

  const legacy = Array.isArray(o.legacyPaths) ? o.legacyPaths : legacyFrpcPaths(platform)
  for (const cand of legacy) {
    if (!cand || cand === target) continue
    const hit = pick(cand)
    if (hit) { hit.legacy = true; return hit }
  }

  if (o.noBundled !== true) {
    const b = installFromBundled({ key: platformKey(platform, arch), target: target, log })
    if (b && b.ok === true) return b

  }

  const dir = o.dir || path.dirname(target)
  return await downloadFrpc(Object.assign({}, o, { dir }))
}
