import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { ossGateCheck, ossGateCommit, resetManualAttempt } from './dl-gate.mjs'

export const FFMPEG_MANIFEST_URL = 'https://gaoshou25.cn/ffmpeg/manifest.json'

export const FFMPEG_MIRROR_BASES = [

  { id: 'github', base: 'https://github.com/ChenJun25/dsh-console-plugin/releases/download/ffmpeg-2026-11-09' },

  { id: 'oss', base: String(process.env.DSH_FFMPEG_OSS_BASE || 'https://dsh-bin.oss-cn-hangzhou.aliyuncs.com/ffmpeg').trim() },

  { id: 'self', base: 'https://gaoshou25.cn/ffmpeg' }
]

export function ffmpegBasesNow(plan) {
  const ids = plan && Array.isArray(plan.ids) ? plan.ids : null
  const skipOss = !!(plan && plan.skipOss === true)
  const out = []
  for (const b of FFMPEG_MIRROR_BASES) {
    const id = String((b && b.id) || '')
    const base = String((b && b.base) || '').trim().replace(/\/+$/, '')
    if (!base) continue
    if (ids && ids.indexOf(id) < 0) continue
    if (skipOss && id === 'oss') continue
    out.push({ id: id, base: base })
  }
  return out
}

export function ffmpegManifestUrlsNow(plan) {
  const env = String(process.env.DSH_FFMPEG_MANIFEST || '').trim()
  const list = []
  if (env) list.push(env)
  for (const b of ffmpegBasesNow(plan)) {
    if (list.indexOf(b.base + '/manifest.json') < 0) list.push(b.base + '/manifest.json')
  }
  if (list.length === 0) list.push(FFMPEG_MANIFEST_URL)
  return list
}

export const FFMPEG_DIR = path.join(os.homedir(), '.dsh', 'ffmpeg')

const READY_MARK = '.ready'

const AVAILABLE_KEYS = ['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']

export const AUTO_MAX_FAILS = 3
let autoFails = 0
let autoPaused = false
let autoLastReason = ''
let autoLastError = ''

export function ffmpegAutoState() {
  return {
    fails: autoFails,
    maxFails: AUTO_MAX_FAILS,
    paused: autoPaused === true,
    reason: autoLastReason,
    error: autoLastError
  }
}

export function resetFfmpegAuto() {
  autoFails = 0
  autoPaused = false
  autoLastReason = ''
  autoLastError = ''
}

function noteAutoResult(r) {
  const ok = !!(r && r.ok === true)
  if (ok) { resetFfmpegAuto(); return r }
  const reason = String((r && r.reason) || '')
  autoLastReason = reason
  autoLastError = String((r && r.error) || '')
  autoFails += 1

  if (reason === 'unsupported' || reason === 'no-fetch' || autoFails >= AUTO_MAX_FAILS) autoPaused = true
  return r
}

const inflightByDir = new Map()

function exeName(platform = process.platform) {
  return String(platform || '') === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
}

function platformKey(platform = process.platform, arch = process.arch) {
  const key = String(platform || '') + '-' + String(arch || '')

  return AVAILABLE_KEYS.indexOf(key) >= 0 ? key : ''
}

function errText(e) { return String((e && e.message) || e || '') }

export function ffmpegExePath(dir = FFMPEG_DIR) {
  return path.join(dir, exeName())
}

export function isReady(dir = FFMPEG_DIR) {
  try {
    const exe = ffmpegExePath(dir)
    const mark = path.join(dir, READY_MARK)
    return fs.existsSync(exe) && fs.existsSync(mark) && fs.statSync(exe).size > 0
  } catch (_) { return false }
}

export function findLocalFfmpeg() {

  if (String(process.env.DSH_FFMPEG_FORCE_DOWNLOAD || '') === '1') return ''
  const env = String(process.env.DSH_FFMPEG || '').trim()
  if (env && fs.existsSync(env)) return env
  const cands = [
    join2(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg'
  ]
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c } catch (_) { }
  }
  return ''
}

function join2(...parts) { return path.join(...parts) }

async function ensureFfmpegOnce(o = {}) {
  const dir = o.dir || FFMPEG_DIR
  const log = typeof o.log === 'function' ? o.log : () => { }
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : () => { }

  const outerSignal = o.signal || null
  const aborted = () => !!(outerSignal && outerSignal.aborted === true)

  const local = (o.forceDownload === true) ? '' : findLocalFfmpeg()
  if (local) {
    log('[ffmpeg] 使用本机已有：' + local)
    return { ok: true, exe: local, downloaded: false, local: true }
  }

  if (o.forceDownload !== true && isReady(dir)) {
    log('[ffmpeg] 使用已下载版本')
    return { ok: true, exe: ffmpegExePath(dir), downloaded: false, local: false }
  }

  const key = platformKey()
  if (!key) {
    return { ok: false, reason: 'unsupported', error: '这台电脑的系统暂不支持自动下载（目前支持 Windows x64、macOS Intel / Apple Silicon、Linux x64 / arm64）' }
  }

  const hasFetchOpt = Object.prototype.hasOwnProperty.call(o, 'fetch')
  const fetchFn = hasFetchOpt
    ? (typeof o.fetch === 'function' ? o.fetch : null)
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
  if (!fetchFn) {
    return { ok: false, reason: 'no-fetch', error: '当前运行环境没有 fetch，无法下载' }
  }

  let entry = null
  let entryBase = ''
  let version = ''
  const sources = String(o.manifestUrl || '').trim()
    ? [{ id: 'explicit', base: '', url: String(o.manifestUrl).trim() }]
    : ffmpegBasesNow(o.plan).map((b) => ({ id: b.id, base: b.base, url: b.base + '/manifest.json' }))
  let srcId = ''
  let srcBase = ''
  let lastFail = null
  for (const src of sources) {
    if (aborted()) return { ok: false, reason: 'aborted', error: '已停止下载' }

    if (src.id === 'oss') {
      const g = ossGateCheck()
      if (!g.ok) { log('[ffmpeg] 跳过 OSS 源（闸门：' + g.reason + '）'); continue }
    }
    const murl = src.url
    try {
      const mres = await fetchFn(murl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20000)
      })
      if (!mres || mres.ok !== true) {
        lastFail = { ok: false, reason: 'manifest-http', error: '下载清单取不到（HTTP ' + String(mres && mres.status) + '）：' + murl }
        continue
      }
      let mj = null
      try { mj = await mres.json() } catch (e2) {
        lastFail = { ok: false, reason: 'manifest-http', error: '下载清单不是合法 JSON：' + murl }
        continue
      }
      const e1 = mj && mj.files ? mj.files[key] : null
      if (!e1 || !e1.file) {
        lastFail = { ok: false, reason: 'no-entry', error: '清单里没有本平台的包（' + key + '）：' + murl }
        continue
      }
      entry = e1
      entryBase = murl
      srcId = String(src.id || '')
      srcBase = String(src.base || '')
      version = String((mj && mj.version) || '')
      break
    } catch (e) {
      lastFail = { ok: false, reason: 'fetch', error: '取下载清单失败：' + errText(e) + '（' + murl + '）' }
      continue
    }
  }
  if (!entry) {
    if (aborted()) return { ok: false, reason: 'aborted', error: '已停止下载' }
    if (!sources.length) return { ok: false, reason: 'no-source', error: '没有配置任何 ffmpeg 下载源' }
    return lastFail || { ok: false, reason: 'fetch', error: '没有可用的 ffmpeg 下载源' }
  }

  try { fs.mkdirSync(dir, { recursive: true }) } catch (_) { }
  const zipPath = path.join(dir, 'download.zip')

  const urlBase = srcBase ? (srcBase + '/') : String(entryBase || FFMPEG_MANIFEST_URL)
  const url = new URL(String(entry.file), urlBase).toString()
  const total = Number(entry.size) || 0
  log('[ffmpeg] 开始下载 ' + url + ' (' + Math.round(total / 1048576) + 'MB)')

  try {

    const hardTimeout = AbortSignal.timeout(600000)
    const sig = (outerSignal && typeof AbortSignal.any === 'function')
      ? AbortSignal.any([outerSignal, hardTimeout])
      : (outerSignal || hardTimeout)
    const res = await fetchFn(url, { signal: sig })
    if (!res || res.ok !== true) {
      return { ok: false, reason: 'download-http', error: '下载失败（HTTP ' + String(res && res.status) + '）' }
    }

    const { Readable } = await import('node:stream')
    const { pipeline } = await import('node:stream/promises')
    let got = 0
    let lastPct = -1
    let nodeStream = null
    if (res.body && typeof res.body.getReader === 'function') {

      nodeStream = Readable.fromWeb(res.body)
    } else {

      const buf = Buffer.from(await res.arrayBuffer())
      fs.writeFileSync(zipPath, buf)
      onProgress(99, buf.length, buf.length)
      got = buf.length
    }
    if (nodeStream !== null) {
      nodeStream.on('data', (c) => {
        const n = (c && c.length) ? c.length : 0
        got += n
        if (total > 0) {
          const pct = Math.min(99, Math.floor((got / total) * 100))
          if (pct !== lastPct) { lastPct = pct; onProgress(pct, got, total) }
        } else {
          onProgress(0, got, 0)
        }
      })
      await pipeline(nodeStream, fs.createWriteStream(zipPath))
    }

    if (srcId === 'oss') { try { ossGateCommit(got) } catch (_) { } }
  } catch (e) {
    try { fs.unlinkSync(zipPath) } catch (_) { }

    if (aborted() || (e && (e.name === 'AbortError' || /abort/i.test(String(e && e.message || ''))))) {
      return { ok: false, reason: 'aborted', error: '已停止下载（已删掉下到一半的文件）' }
    }
    return { ok: false, reason: 'download', error: '下载中断：' + errText(e) }
  }

  let sha = ''
  try {
    sha = createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')
  } catch (e) {
    return { ok: false, reason: 'read', error: '读下载包失败' }
  }
  const want = String(entry.sha256 || '').trim().toLowerCase()
  if (want && sha.toLowerCase() !== want) {
    try { fs.unlinkSync(zipPath) } catch (_) { }
    return { ok: false, reason: 'sha256', error: '下载包校验失败（可能没下全，请重试）' }
  }
  log('[ffmpeg] 下载完成 sha256 ok')

  try {
    const keepName = path.basename(zipPath)
    const names = fs.readdirSync(dir)
    for (const nm of names) {
      if (nm === keepName) continue
      try {
        fs.rmSync(path.join(dir, nm), { recursive: true, force: true })
      } catch (e2) {

        return {
          ok: false,
          reason: 'locked',
          error: '解压失败：文件被占用（可能有别的程序正在用 ffmpeg），请关掉后重试'
        }
      }
    }
  } catch (e0) {
    return { ok: false, reason: 'dir', error: '无法清理旧组件目录：' + errText(e0) }
  }

  try {
    await unzipTo(zipPath, dir)
  } catch (e) {
    return { ok: false, reason: 'unzip', error: '解压失败：' + errText(e) }
  }

  try { flattenInto(dir) } catch (_) { }

  if (process.platform !== 'win32') {
    try { fs.chmodSync(ffmpegExePath(dir), 0o755) } catch (_) { }
  }

  try { fs.unlinkSync(zipPath) } catch (_) { }

  const exe = ffmpegExePath(dir)
  if (!fs.existsSync(exe) || fs.statSync(exe).size === 0) {
    return { ok: false, reason: 'no-exe', error: '解压后没找到 ' + exeName() }
  }
  const probe = await runVersion(exe)
  if (!probe.ok) {
    return { ok: false, reason: 'probe', error: '下载的 ffmpeg 无法运行：' + probe.error }
  }

  log('[ffmpeg] 预热中（首次加载 DLL + 初始化编码器）…')
  try {
    await warmupEncode(exe, dir)
    log('[ffmpeg] 预热完成')
  } catch (e) {

    log('[ffmpeg] 预热失败（忽略）：' + errText(e))
  }

  try {
    fs.writeFileSync(path.join(dir, READY_MARK), JSON.stringify({
      version: version, at: Date.now(), sha256: sha
    }), 'utf8')
  } catch (_) { }

  onProgress(100, total, total)
  log('[ffmpeg] 就绪：' + exe + ' (' + probe.version + ')')
  return { ok: true, exe: exe, downloaded: true, local: false, version: probe.version }
}

export async function ensureFfmpeg(o = {}) {
  const manual = o.auto === false
  const dir = String(o.dir || FFMPEG_DIR)

  const running = inflightByDir.get(dir)
  if (running) {
    const log = typeof o.log === 'function' ? o.log : () => { }
    log('[ffmpeg] 已有下载在进行中，等待它完成…')
    return await running
  }
  if (!manual && autoPaused) {
    return {
      ok: false,
      reason: 'auto-paused',
      error: '自动下载已暂停（连续 ' + String(autoFails) + ' 次失败，最后一次：' + (autoLastError || autoLastReason || '未知') +
        '）。请点面板上的「重新下载 ffmpeg」按钮重试，或重启 DSH。'
    }
  }
  const task = (async () => {
    const r = await ensureFfmpegOnce(o)
    if (manual) {
      if (r && r.ok === true) { resetFfmpegAuto(); resetManualAttempt('ffmpeg') }
      return r
    }
    return noteAutoResult(r)
  })()
  inflightByDir.set(dir, task)
  try { return await task } finally { inflightByDir.delete(dir) }
}

export function ffmpegErrorText(r) {
  const reason = String((r && r.reason) || '')
  const raw = String((r && r.error) || '')
  if (reason === 'auto-paused') return raw || '自动下载已暂停，请点「重新下载 ffmpeg」重试'
  if (reason === 'aborted') return raw || '已停止下载'
  if (reason === 'no-source') return '没有配置任何 ffmpeg 下载源（DSH_FFMPEG_OSS_BASE 为空且内置地址不可用）'
  if (reason === 'unsupported') return '这台电脑的系统/芯片暂不支持自动下载 ffmpeg（' + String(process.platform) + '-' + String(process.arch) + '），可以自己装一个'
  if (reason === 'no-fetch') return '当前运行环境没有 fetch，无法自动下载；可以把 ffmpeg 放进 ' + String(FFMPEG_DIR)
  if (reason === 'manifest-http') return '下载清单取不到（' + raw + '），可能是网络不通或在升级；稍后重试'
  if (reason === 'no-entry') return '下载清单里没有你这台电脑的平台版本（' + String(process.platform) + '-' + String(process.arch) + '）'
  if (reason === 'fetch') return '网络请求失败（' + raw + '），请检查能不能正常上外网'
  if (reason === 'download-http') return '下载 ffmpeg 压缩包失败（' + raw + '），请检查网络或稍后重试'
  if (reason === 'download') return '下载中断（' + raw + '），请重试'
  if (reason === 'read') return '读下载包失败，可能是磁盘问题，请重试'
  if (reason === 'sha256') return '下载包校验不通过（可能没下全），请重试'
  if (reason === 'locked') return '解压失败：组件文件被占用（可能另一个程序正在用 ffmpeg），请关掉后重试'
  if (reason === 'dir') return '清理旧的组件目录失败（' + raw + '），可能没有权限'
  if (reason === 'unzip') return '解压失败（' + raw + '），请重试'
  if (reason === 'no-exe') return '解压后没找到 ffmpeg 可执行文件，安装包可能不完整，请重试'
  if (reason === 'probe') return '下载的 ffmpeg 跑不起来（' + raw + '），可能是系统缺少运行库或被安全软件拦了'
  return raw || '下载 ffmpeg 失败（原因未知）'
}

function warmupEncode(exe, dir) {

  if (process.platform !== 'win32') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const outFile = path.join(dir, 'warmup.ts')
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'gdigrab', '-framerate', '5', '-i', 'desktop',
      '-t', '1', '-vf', 'scale=640:-2',
      '-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-b:v', '1M',
      '-f', 'mpegts', '-y', outFile
    ]
    let child
    try {
      child = spawn(exe, args, { windowsHide: true })
    } catch (e) { reject(e); return }
    const timer = setTimeout(() => {
      try { child.kill() } catch (_) { }
      try { fs.unlinkSync(outFile) } catch (_) { }
      reject(new Error('warmup timeout'))
    }, 15000)
    let err = ''
    child.stderr.on('data', (c) => { err += String(c) })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      try { fs.unlinkSync(outFile) } catch (_) { }
      if (code === 0) resolve()
      else reject(new Error('warmup exit ' + String(code) + ' ' + err.slice(0, 100)))
    })
  })
}

function runQuiet(bin, args) {
  return new Promise((resolve, reject) => {
    let err = ''
    let child = null
    try {
      child = spawn(bin, args, { windowsHide: true })
    } catch (e) {
      reject(e)
      return
    }
    child.stderr.on('data', (c) => { err += String(c) })
    child.on('error', (e) => reject(e))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(bin + ' exit ' + String(code) + ' ' + err.slice(0, 200)))
    })
  })
}

async function unzipTo(zipPath, destDir) {
  if (process.platform === 'win32') {
    return runQuiet('tar', ['-xf', zipPath, '-C', destDir])
  }
  try {
    return await runQuiet('unzip', ['-o', '-q', zipPath, '-d', destDir])
  } catch (e1) {

    try {
      return await runQuiet('python3', ['-m', 'zipfile', '-e', zipPath, destDir])
    } catch (e2) {
      throw new Error(errText(e2) + ' / unzip: ' + errText(e1))
    }
  }
}

function flattenInto(dir) {
  const exeDirect = path.join(dir, exeName())
  if (fs.existsSync(exeDirect)) return
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())
  for (const s of subs) {
    const sub = path.join(dir, s.name)
    const direct = path.join(sub, exeName())
    if (fs.existsSync(direct)) {
      for (const f of fs.readdirSync(sub)) {
        try { fs.renameSync(path.join(sub, f), path.join(dir, f)) } catch (_) { }
      }
      return
    }

    const deeper = fs.readdirSync(sub, { withFileTypes: true }).filter((d) => d.isDirectory())
    for (const d2 of deeper) {
      const sub2 = path.join(sub, d2.name)
      if (fs.existsSync(path.join(sub2, exeName()))) {
        for (const f of fs.readdirSync(sub2)) {
          try { fs.renameSync(path.join(sub2, f), path.join(dir, f)) } catch (_) { }
        }
        return
      }
    }
  }
}

function runVersion(exe) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    const child = spawn(exe, ['-hide_banner', '-version'], { windowsHide: true })
    const timer = setTimeout(() => { try { child.kill() } catch (_) { } }, 10000)
    child.stdout.on('data', (c) => { out += String(c) })
    child.stderr.on('data', (c) => { err += String(c) })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: errText(e) }) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        const m = /ffmpeg version (\S+)/.exec(out)
        resolve({ ok: true, version: (m && m[1]) || '' })
      } else {
        resolve({ ok: false, error: 'exit ' + String(code) + ' ' + err.slice(0, 120) })
      }
    })
  })
}

export function removeFfmpeg(dir = FFMPEG_DIR) {
  try { fs.rmSync(dir, { recursive: true, force: true }); return true } catch (_) { return false }
}
