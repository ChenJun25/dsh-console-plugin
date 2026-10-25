import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

export const FFMPEG_MANIFEST_URL = 'https://dshconsole.pw/ffmpeg/manifest.json'

export const FFMPEG_DIR = path.join(os.homedir(), '.dsh', 'ffmpeg')

const READY_MARK = '.ready'

function platformKey(platform = process.platform, arch = process.arch) {
  const key = String(platform || '') + '-' + String(arch || '')

  return key === 'win32-x64' ? key : ''
}

function errText(e) { return String((e && e.message) || e || '') }

export function ffmpegExePath(dir = FFMPEG_DIR) {
  return path.join(dir, 'ffmpeg.exe')
}

export function isReady(dir = FFMPEG_DIR) {
  try {
    const exe = ffmpegExePath(dir)
    const mark = path.join(dir, READY_MARK)
    return fs.existsSync(exe) && fs.existsSync(mark) && fs.statSync(exe).size > 0
  } catch (_) { return false }
}

export function findLocalFfmpeg() {
  const env = String(process.env.DSH_FFMPEG || '').trim()
  if (env && fs.existsSync(env)) return env
  const cands = [
    join2(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg'
  ]
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c } catch (_) { }
  }
  return ''
}

function join2(...parts) { return path.join(...parts) }

export async function ensureFfmpeg(o = {}) {
  const dir = o.dir || FFMPEG_DIR
  const log = typeof o.log === 'function' ? o.log : () => { }
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : () => { }

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
    return { ok: false, reason: 'unsupported', error: '这台电脑的系统暂不支持自动下载（目前只支持 Windows x64）' }
  }

  const fetchFn = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null
  if (!fetchFn) {
    return { ok: false, reason: 'no-fetch', error: '当前运行环境没有 fetch，无法下载' }
  }

  let entry = null
  let version = ''
  try {
    const mres = await fetchFn(FFMPEG_MANIFEST_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20000)
    })
    if (!mres || mres.ok !== true) {
      return { ok: false, reason: 'manifest-http', error: '下载清单取不到（HTTP ' + String(mres && mres.status) + '）' }
    }
    const mj = await mres.json()
    entry = mj && mj.files ? mj.files[key] : null
    version = String((mj && mj.version) || '')
    if (!entry || !entry.file) {
      return { ok: false, reason: 'no-entry', error: '清单里没有本平台的包（' + key + '）' }
    }
  } catch (e) {
    return { ok: false, reason: 'fetch', error: '取下载清单失败：' + errText(e) }
  }

  try { fs.mkdirSync(dir, { recursive: true }) } catch (_) { }
  const zipPath = path.join(dir, 'download.zip')
  const url = new URL(String(entry.file), FFMPEG_MANIFEST_URL).toString()
  const total = Number(entry.size) || 0
  log('[ffmpeg] 开始下载 ' + url + ' (' + Math.round(total / 1048576) + 'MB)')

  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(600000) })
    if (!res || res.ok !== true) {
      return { ok: false, reason: 'download-http', error: '下载失败（HTTP ' + String(res && res.status) + '）' }
    }

    const reader = res.body && res.body.getReader ? res.body.getReader() : null
    if (reader) {
      const out = fs.createWriteStream(zipPath)
      let got = 0
      let lastPct = -1
      for (; ;) {
        const step = await reader.read()
        if (step.done) break
        const chunk = Buffer.from(step.value)
        got += chunk.length
        await new Promise((resolve) => {
          const okWrite = out.write(chunk, () => resolve())
          if (!okWrite) out.once('drain', () => resolve())
        })
        if (total > 0) {
          const pct = Math.min(99, Math.floor((got / total) * 100))
          if (pct !== lastPct) { lastPct = pct; onProgress(pct, got, total) }
        } else {
          onProgress(0, got, 0)
        }
      }
      await new Promise((resolve) => out.end(resolve))
    } else {
      const buf = Buffer.from(await res.arrayBuffer())
      fs.writeFileSync(zipPath, buf)
      onProgress(99, buf.length, buf.length)
    }
  } catch (e) {
    try { fs.unlinkSync(zipPath) } catch (_) { }
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
    await unzipTo(zipPath, dir)
  } catch (e) {
    return { ok: false, reason: 'unzip', error: '解压失败：' + errText(e) }
  }

  try { flattenInto(dir) } catch (_) { }

  try { fs.unlinkSync(zipPath) } catch (_) { }

  const exe = ffmpegExePath(dir)
  if (!fs.existsSync(exe) || fs.statSync(exe).size === 0) {
    return { ok: false, reason: 'no-exe', error: '解压后没找到 ffmpeg.exe' }
  }
  const probe = await runVersion(exe)
  if (!probe.ok) {
    return { ok: false, reason: 'probe', error: '下载的 ffmpeg 无法运行：' + probe.error }
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

function unzipTo(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true })
    let err = ''
    child.stderr.on('data', (c) => { err += String(c) })
    child.on('error', (e) => reject(e))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error('tar exit ' + String(code) + ' ' + err.slice(0, 200)))
    })
  })
}

function flattenInto(dir) {
  const exeDirect = path.join(dir, 'ffmpeg.exe')
  if (fs.existsSync(exeDirect)) return
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())
  for (const s of subs) {
    const sub = path.join(dir, s.name)
    const direct = path.join(sub, 'ffmpeg.exe')
    if (fs.existsSync(direct)) {
      for (const f of fs.readdirSync(sub)) {
        try { fs.renameSync(path.join(sub, f), path.join(dir, f)) } catch (_) { }
      }
      return
    }

    const deeper = fs.readdirSync(sub, { withFileTypes: true }).filter((d) => d.isDirectory())
    for (const d2 of deeper) {
      const sub2 = path.join(sub, d2.name)
      if (fs.existsSync(path.join(sub2, 'ffmpeg.exe'))) {
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
