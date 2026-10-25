import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const FRPC_DIR = path.join(os.homedir(), '.dsh', 'frp')

export const FRPC_MANIFEST_URL = 'https://dshconsole.pw/frpc/manifest.json'
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20000

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

export async function downloadFrpc(o = {}) {
  const dir = o.dir || FRPC_DIR
  const platform = o.platform || process.platform
  const arch = o.arch || process.arch
  const manifestUrl = String(o.manifestUrl || FRPC_MANIFEST_URL)
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_DOWNLOAD_TIMEOUT_MS
  const log = typeof o.log === 'function' ? o.log : () => {}

  const hasFetchOpt = Object.prototype.hasOwnProperty.call(o, 'fetch')
  const fetchFn = hasFetchOpt
    ? (typeof o.fetch === 'function' ? o.fetch : null)
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)

  const key = platformKey(platform, arch)
  if (!key) return { ok: false, reason: 'unsupported', error: '暂不支持自动下载 frpc 的平台：' + String(platform) + '-' + String(arch) }
  if (!fetchFn) return { ok: false, reason: 'no-fetch', error: '当前运行环境没有 fetch，无法自动下载 frpc' }

  const target = path.join(dir, String(o.fileName || FILE_BY_KEY[key]))
  let entry = null
  let version = ''
  try {
    const mres = await fetchFn(manifestUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
    if (!mres || mres.ok !== true) return { ok: false, reason: 'manifest-http', error: '公网工具下载清单取不到（HTTP ' + String(mres && mres.status) + '）' }
    let mj = null
    try { mj = await mres.json() } catch (e) { return { ok: false, reason: 'manifest-bad-json', error: '公网工具下载清单不是合法 JSON' } }
    entry = mj && mj.files ? mj.files[key] : null
    version = String((mj && mj.version) || '')
    if (!entry || !entry.file) return { ok: false, reason: 'no-entry', error: '下载清单里没有本机平台（' + key + '）的 frpc' }
  } catch (e) {
    return { ok: false, reason: 'fetch', error: '取公网工具下载清单失败：' + errText(e) }
  }

  const url = new URL(String(entry.file), manifestUrl).toString()
  let buf = null
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res || res.ok !== true) return { ok: false, reason: 'download-http', error: '下载 frpc 失败（HTTP ' + String(res && res.status) + '）' }
    buf = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    return { ok: false, reason: 'fetch', error: '下载 frpc 失败：' + errText(e) }
  }

  const wantSize = Number(entry.size) || 0
  if (wantSize > 0 && buf.length !== wantSize) {
    return { ok: false, reason: 'size-mismatch', error: 'frpc 大小不符（期望 ' + wantSize + ' 字节，实收 ' + buf.length + ' 字节）' }
  }
  const sha = createHash('sha256').update(buf).digest('hex')
  const wantSha = String(entry.sha256 || '').trim().toLowerCase()
  if (wantSha && sha !== wantSha) {
    return { ok: false, reason: 'sha-mismatch', error: 'frpc 校验和不符（期望 ' + wantSha.slice(0, 12) + '…，实得 ' + sha.slice(0, 12) + '…）' }
  }

  const tmp = target + '.download'
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmp, buf, { mode: 0o755 })
    fs.renameSync(tmp, target)
    try { fs.chmodSync(target, 0o755) } catch (_) {  }

    if (!fs.existsSync(target)) {
      return { ok: false, reason: 'blocked', error: 'frpc 写入后立刻消失，很可能是安全软件拦截；请把 ' + target + ' 加入白名单后重试' }
    }
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch (_) {  }
    return { ok: false, reason: 'io', error: '写入 frpc 失败：' + errText(e) }
  }
  log('[frpc] 已从云端下载 frpc ' + (version || '') + ' → ' + target + '（' + buf.length + ' 字节）')
  return { ok: true, path: target, version, size: buf.length, sha256: sha, downloaded: true }
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
  const dir = o.dir || path.dirname(target)
  return await downloadFrpc(Object.assign({}, o, { dir }))
}
