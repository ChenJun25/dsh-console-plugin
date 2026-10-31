import { spawn, execFileSync } from 'node:child_process'

import { ensureFfmpeg, findLocalFfmpeg, isReady as ffmpegIsReady, ffmpegExePath, FFMPEG_DIR } from './ffmpeg-bootstrap.mjs'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import os from 'node:os'
import { join } from 'node:path'

const DEF_FPS = 30

const LAN_FPS = 60
const LAN_BITRATE = '12M'
const LAN_SCALE = 1920

const DEF_BITRATE = '4M'
const DEF_SCALE = 1280

let current = null

const IDLE_STOP_MS = (function () {
  const v = Number(process.env.DSH_SCREEN_IDLE_MS)
  return v > 0 ? v : 5000
})()
const IDLE_CHECK_MS = 1000

const FLV_IDLE_STOP_MS = (function () {
  const v = Number(process.env.DSH_SCREEN_FLV_IDLE_MS)
  return v > 0 ? v : 15000
})()

function whichFfmpeg() {

  if (ffmpegIsReady()) return ffmpegExePath()

  const local = findLocalFfmpeg()
  if (local) return local

  return 'ffmpeg'
}

export async function ensureScreenReady(onProgress, log) {
  const r = await ensureFfmpeg({ dir: FFMPEG_DIR, onProgress, log })
  return r
}

let encCache = { at: 0, name: '' }

const ENC_BAD_MS = 30 * 60 * 1000
const encBad = {}
function encIsBad(n) {
  const t = encBad[n]
  if (!t) return false
  if (Date.now() - t > ENC_BAD_MS) { delete encBad[n]; return false }
  return true
}
function encNoteBad(n) {
  const k = String(n || '')
  if (!k || SOFT_ORDER.indexOf(k) >= 0) return
  encBad[k] = Date.now()
  encCache = { at: 0, name: '' }
}

const SOFT_ORDER = ['libopenh264', 'h264_mf', 'libx264']
let softCache = { at: 0, name: '' }
function softEncoder(ff) {
  const now = Date.now()
  if (softCache.name && now - softCache.at < 60000) return softCache.name
  let out = ''
  try {
    out = String(execFileSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 8000 }))
  } catch (e) {
    out = ''
  }
  let name = ''
  for (const sd of SOFT_ORDER) {
    if (out.indexOf(sd) >= 0) { name = sd; break }
  }
  softCache = { at: now, name: name || 'libx264' }
  return softCache.name
}

function pickEncoder(ff) {
  const now = Date.now()
  if (encCache.name && now - encCache.at < 60000) return encCache.name
  let out = ''
  try {
    out = String(execFileSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 8000 }))
  } catch (e) {
    out = ''
  }
  const soft = softEncoder(ff)
  const order = ['h264_nvenc', 'h264_qsv', 'h264_amf', soft]
  let name = soft
  for (const o of order) {
    if (encIsBad(o)) continue
    if (out.indexOf(o) >= 0) { name = o; break }
  }
  encCache = { at: now, name }
  return name
}

function encoderArgs(enc, bitrate) {
  if (enc === 'h264_nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-rc', 'cbr',
      '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bitrate]
  }
  if (enc === 'h264_qsv') {
    return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', bitrate, '-maxrate', bitrate]
  }
  if (enc === 'h264_amf') {
    return ['-c:v', 'h264_amf', '-quality', 'speed', '-b:v', bitrate, '-maxrate', bitrate]
  }
  if (enc === 'libopenh264') {
    return ['-c:v', 'libopenh264', '-b:v', bitrate, '-maxrate', bitrate]
  }
  if (enc === 'h264_mf') {
    return ['-c:v', 'h264_mf', '-b:v', bitrate, '-maxrate', bitrate]
  }
  return ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bitrate]
}

let ddCache = { at: 0, ok: false }
function ddagrabReady() {
  const now = Date.now()
  if (now - ddCache.at < 60000) return ddCache.ok
  const ff = whichFfmpeg()
  let ok = false
  if (ff !== 'ffmpeg') {
    try {
      execFileSync(ff, ['-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'ddagrab=output_idx=0:framerate=5',
        '-frames:v', '1', '-f', 'null', '-'],
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'ignore', 'ignore'] })
      ok = true
    } catch (e) {
      ok = false
    }
  }
  ddCache = { at: now, ok }
  return ok
}

function captureIsGpu() {

  return false
  return process.platform === 'win32' && ddagrabReady()
}

function captureArgs(fps) {
  if (process.platform === 'win32') {

    if (captureIsGpu()) {
      return ['-f', 'lavfi', '-i', 'ddagrab=output_idx=0:framerate=' + String(fps)]
    }
    return ['-f', 'gdigrab', '-framerate', String(fps), '-i', 'desktop']
  }
  if (process.platform === 'darwin') {
    return ['-f', 'avfoundation', '-framerate', String(fps), '-i', '1:none']
  }
  return ['-f', 'x11grab', '-framerate', String(fps), '-i', ':0.0']
}

export function screenFfmpegReady() { return ffmpegIsReady() }

export function screenAvailable() {
  const ff = whichFfmpeg()
  if (ff === 'ffmpeg') return { ok: false, reason: 'no-ffmpeg', hint: 'winget install Gyan.FFmpeg' }
  return { ok: true, ffmpeg: ff, encoder: pickEncoder(ff) }
}

export function screenBusy() {
  return current !== null
}

function hlsDir() {
  const d = join(os.tmpdir(), 'dsh-screen-hls')
  try { fs.mkdirSync(d, { recursive: true }) } catch (e) { }
  return d
}

export function clearHlsDir() {
  const d = hlsDir()
  let names = []
  try { names = fs.readdirSync(d) } catch (e) { return }
  for (const n of names) {
    try { fs.unlinkSync(join(d, n)) } catch (e) { }
  }
}

function pidFile() {
  return join(hlsDir(), 'ffmpeg.pid')
}

function readPid() {
  try {
    const n = Number(String(fs.readFileSync(pidFile(), 'utf8')).trim())
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch (e) { return 0 }
}

function writePid(pid) {
  try { fs.writeFileSync(pidFile(), String(pid), 'utf8') } catch (e) { }
}

function clearPid() {
  try { fs.unlinkSync(pidFile()) } catch (e) { }
}

function isOurFfmpeg(pid) {
  if (pid <= 0) { return false }
  try { process.kill(pid, 0) } catch (e) { return false }
  try {
    const out = String(execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true }))
    return out.toLowerCase().indexOf('ffmpeg.exe') >= 0
  } catch (e) {

    return false
  }
}

function reapOrphan() {
  const pid = readPid()

  if (current && current.child && current.child.pid === pid) { return }
  if (isOurFfmpeg(pid)) {
    try { process.kill(pid, 'SIGKILL') } catch (e) { }
    try { console.log('[screen] 回收上次遗留的采集进程 pid=' + pid) } catch (e) { }
  }
  clearPid()
}

const REAP_CHECK_MS = 30000
const reapTimer = setInterval(() => {
  try { reapOrphan() } catch (e) { }
}, REAP_CHECK_MS)
if (reapTimer && typeof reapTimer.unref === 'function') reapTimer.unref()

function scaleFilter(scale) {
  if (captureIsGpu()) {
    return 'hwdownload,format=bgra,scale=' + scale + ':-2,format=nv12'
  }
  return 'scale=' + scale + ':-2'
}

function buildArgs(mode, fps, bitrate, scale, enc, dir) {
  const base = [
    '-hide_banner', '-loglevel', 'error',

    ...captureArgs(fps),

    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-vf', scaleFilter(scale),
    ...encoderArgs(enc, bitrate),
    '-c:a', 'aac', '-b:a', '32k', '-ar', '44100', '-ac', '2',

    '-g', String(fps)
  ]
  if (mode === 'flv') {

    return base.concat([
      '-flush_packets', '1',
      '-fflags', '+nobuffer',
      '-f', 'flv',
      'pipe:1'
    ])
  }
  return base.concat([

    '-f', 'hls',
    '-hls_time', '1',

    '-hls_list_size', '4',

    '-hls_flags', 'omit_endlist',
    '-hls_segment_filename', join(dir, 'seg%05d.ts'),
    join(dir, 'live.m3u8')
  ])
}

const STDERR_KEEP = 2048

const EXIT_FAST_MS = 3000

const FIRST_FRAME_WAIT_MS = 30000

let recoveredAt = 0
let lastFail = { at: 0, mode: '', reason: '', exitCode: null, signal: '', stderr: '', encoder: '', fps: 0, bitrate: '', scale: 0, livedMs: 0 }

function noteFail(o) {
  try {
    recoveredAt = 0
    lastFail = {
      at: Date.now(),
      mode: String(o.mode || ''),
      reason: String(o.reason || ''),
      exitCode: o.exitCode === null || o.exitCode === undefined ? null : Number(o.exitCode),
      signal: String(o.signal || ''),
      stderr: String(o.stderr || ''),
      encoder: String(o.encoder || ''),
      fps: Number(o.fps) || 0,
      bitrate: String(o.bitrate || ''),
      scale: Number(o.scale) || 0,
      livedMs: Number(o.livedMs) || 0
    }
  } catch (e) { }
}

export function diagText(d) {
  const x = d === undefined ? lastFail : d
  if (!x || !x.at) return ''
  const bits = []
  if (x.reason === 'no-first-frame') {
    bits.push('采集 ' + String(Math.round(Number(x.livedMs || 0) / 1000)) + ' 秒没出第一帧画面')
  } else if (x.reason === 'ffmpeg-exit') {
    bits.push('ffmpeg 启动 ' + String(x.livedMs || 0) + 'ms 就退出了（退出码 '
      + String(x.exitCode === null ? '-' : x.exitCode) + '）')
  } else if (x.reason === 'retry-failed') {
    bits.push('自动降档重试也没起来')
  } else {
    bits.push('采集启动失败：' + String(x.reason || 'unknown'))
  }
  if (x.encoder) bits.push('编码器 ' + String(x.encoder))
  if (x.stderr) bits.push('ffmpeg 报错：' + String(x.stderr).replace(/\s+/g, ' ').slice(-400))
  return bits.join('；')
}

export function screenDiag() {
  if (!lastFail || !lastFail.at) return null
  const d = Object.assign({}, lastFail)
  d.recovered = recoveredAt > lastFail.at
  d.text = diagText(lastFail)
  return d
}

function bitrateMbps(v) {
  const t = String(v || '').trim().toLowerCase()
  const m = t.match(/^([0-9.]+)\s*([mk]?)$/)
  if (!m) return 4
  const n = Number(m[1])
  if (!(n > 0)) return 4
  return m[2] === 'k' ? n / 1000 : n
}

function retryDowngraded(mode, me, why) {
  const fps0 = Number(me.fps) || DEF_FPS
  const b0 = String(me.bitrate || DEF_BITRATE)
  const sc0 = Number(me.scale) || DEF_SCALE
  const enc0 = String(me.encoder || '')
  const fps1 = Math.min(fps0, DEF_FPS)
  const b1 = Math.min(bitrateMbps(b0), 4)
  const sc1 = Math.min(sc0, DEF_SCALE)
  const encS = softEncoder(whichFfmpeg())
  const o1 = Object.assign({}, me.opts || {}, {
    fps: fps1, bitrate: String(b1) + 'M', scale: sc1, enc: encS, retry: false
  })
  try {
    console.log('[screen] 采集失败（' + why + '），自动降档重试一次：'
      + 'fps ' + String(fps0) + '→' + String(fps1)
      + '，码率 ' + b0 + '→' + String(b1) + 'M'
      + '，缩放 ' + String(sc0) + '→' + String(sc1)
      + '，编码器 ' + enc0 + '→' + encS)
  } catch (e) { }
  let r = { ok: false, reason: 'retry-failed' }
  try {
    r = startCapture(mode, o1)
  } catch (e) {
    r = { ok: false, reason: 'retry-failed' }
  }
  if (r && r.ok) {
    recoveredAt = Date.now()
    try { console.log('[screen] 降档重试已起 stream enc=' + String(r.encoder || '')) } catch (e) { }
  } else {
    noteFail({
      mode, reason: 'retry-failed', exitCode: null, signal: '',
      stderr: String(lastFail.stderr || ''), encoder: encS,
      fps: fps1, bitrate: String(b1) + 'M', scale: sc1, livedMs: 0
    })
    try { console.log('[screen] 降档重试也没起来：' + String((r && r.reason) || 'unknown')) } catch (e) { }
  }
  return r
}

function startCapture(mode, opts) {
  const o = opts || {}

  const hd = o.hd === true
  const fps = Number(o.fps) > 0 ? Number(o.fps) : (hd ? LAN_FPS : DEF_FPS)
  const bitrate = String(o.bitrate || (hd ? LAN_BITRATE : DEF_BITRATE))
  const scale = Number(o.scale) > 0 ? Number(o.scale) : (hd ? LAN_SCALE : DEF_SCALE)

  const av = screenAvailable()
  if (!av.ok) {
    noteFail({ mode, reason: String(av.reason || 'no-ffmpeg'), exitCode: null, signal: '', stderr: '', encoder: '', fps, bitrate, scale, livedMs: 0 })
    return { ok: false, reason: av.reason, hint: av.hint }
  }

  if (current) {
    return { ok: false, reason: 'busy' }
  }

  reapOrphan()

  const dir = hlsDir()
  if (mode === 'hls') clearHlsDir()

  const enc = String(o.enc || '') || av.encoder
  const args = buildArgs(mode, fps, bitrate, scale, enc, dir)

  let child
  try {

    child = spawn(av.ffmpeg, args, {
      stdio: ['ignore', mode === 'flv' ? 'pipe' : 'ignore', 'pipe'],
      windowsHide: true
    })
  } catch (e) {
    noteFail({ mode, reason: 'spawn-failed: ' + String((e && e.message) || e), exitCode: null, signal: '', stderr: '', encoder: enc, fps, bitrate, scale, livedMs: 0 })
    return { ok: false, reason: 'spawn-failed' }
  }

  const startedAt = Date.now()

  const me = {
    child, mode, at: startedAt, encoder: enc, dir,
    lastAct: Date.now(), timer: null, ffTimer: null, stopByUser: false,
    fps, bitrate, scale, opts: o, retried: o.retry === false
  }
  current = me
  writePid(child.pid)

  let killed = false
  const kill = () => {
    if (killed) return
    killed = true
    me.stopByUser = true
    if (me.timer) { try { clearInterval(me.timer) } catch (e) { } }
    if (me.ffTimer) { try { clearTimeout(me.ffTimer) } catch (e) { } }
    try { child.kill('SIGKILL') } catch (e) { }
    if (current === me) current = null

    if (mode === 'flv') flvHub = null
    clearPid()
  }
  child.on('error', kill)

  let errTail = ''
  child.stderr.on('data', (c) => {
    try {
      errTail += String(c)
      if (errTail.length > STDERR_KEEP) errTail = errTail.slice(-STDERR_KEEP)
    } catch (e) { }
  })

  child.on('exit', (code, signal) => {
    if (me.timer) { try { clearInterval(me.timer) } catch (e) { } }
    if (me.ffTimer) { try { clearTimeout(me.ffTimer) } catch (e) { } }

    if (current === me) {
      current = null

      if (mode === 'flv') flvHub = null
      clearPid()
    }

    if (me.stopByUser) return
    const lived = Date.now() - startedAt
    const tail = String(errTail || '').trim()
    noteFail({
      mode, reason: 'ffmpeg-exit', exitCode: code === null ? null : Number(code),
      signal: String(signal || ''), stderr: tail, encoder: enc,
      fps, bitrate, scale, livedMs: lived
    })
    try {
      console.log('[screen] 采集进程退出 code=' + String(code === null ? '-' : code)
        + ' signal=' + String(signal || '-') + ' 存活=' + String(lived) + 'ms'
        + ' enc=' + enc + ' fps=' + String(fps) + ' bitrate=' + bitrate + ' scale=' + String(scale)
        + ' stderr=' + (tail ? tail.replace(/\s+/g, ' ').slice(-600) : '(空)'))
    } catch (e) { }

    if (lived < EXIT_FAST_MS) encNoteBad(enc)

    if (lived < EXIT_FAST_MS && !me.retried) {
      retryDowngraded(mode, me, 'ffmpeg 起来 ' + String(lived) + 'ms 就退出了')
    }
  })

  if (mode === 'flv') {
    const cur0 = me
    const hub = makeFlvHub(() => { if (current === cur0) cur0.lastAct = Date.now() })
    flvHub = hub
    child.stdout.on('data', (c) => {
      try { hub.feed(c) } catch (e) {                            }
    })
  }

  const timer = setInterval(() => {
    if (current !== me) return
    const cur = me

    const idleMs = mode === 'flv' ? FLV_IDLE_STOP_MS : IDLE_STOP_MS
    if (Date.now() - cur.lastAct > idleMs) {

      try { console.log('[screen] 空闲 ' + Math.round((Date.now() - cur.lastAct) / 1000) + ' 秒无播放请求，自动停止采集') } catch (e) { }
      stopHls()
      clearHlsDir()
    }
  }, IDLE_CHECK_MS)
  if (timer && typeof timer.unref === 'function') timer.unref()
  if (current === me) me.timer = timer

  if (mode === 'hls' && !me.retried) {
    me.ffTimer = setTimeout(() => {
      if (me.stopByUser) return
      if (current !== me) return
      let has = false
      try { has = fs.statSync(join(dir, 'live.m3u8')).size > 0 } catch (e) { has = false }
      if (has) return
      const tail = String(errTail || '').trim()
      noteFail({
        mode, reason: 'no-first-frame', exitCode: null, signal: '', stderr: tail,
        encoder: enc, fps, bitrate, scale, livedMs: Date.now() - startedAt
      })
      try {
        console.log('[screen] 采集 ' + String(Math.round(FIRST_FRAME_WAIT_MS / 1000)) + ' 秒仍无首片，降档重试'
          + '（enc=' + enc + ' ' + String(fps) + 'fps ' + bitrate + ' ' + String(scale) + 'px）'
          + ' stderr=' + (tail ? tail.replace(/\s+/g, ' ').slice(-600) : '(空)'))
      } catch (e) { }
      kill()
      retryDowngraded(mode, me, String(Math.round(FIRST_FRAME_WAIT_MS / 1000)) + ' 秒无首片')
    }, FIRST_FRAME_WAIT_MS)
    if (me.ffTimer && typeof me.ffTimer.unref === 'function') me.ffTimer.unref()
  }

  const out = { ok: true, mode, encoder: enc, dir, kill, pid: child.pid }
  if (mode === 'flv') {

    out.stdout = null

    out.touch = () => {
      const cur = current
      if (cur && cur.child === child) cur.lastAct = Date.now()
    }
  } else {
    out.m3u8Path = join(dir, 'live.m3u8')
  }
  return out
}

export function startHls(opts) {
  return startCapture('hls', opts || {})
}

export function startFlv(opts) {
  return startCapture('flv', opts || {})
}

export function readM3u8() {
  const cur = current
  if (!cur) return null
  cur.lastAct = Date.now()
  try {
    return fs.readFileSync(join(cur.dir, 'live.m3u8'), 'utf8')
  } catch (e) {
    return null
  }
}

export function readSegment(name) {
  if (!/^seg\d{1,8}\.ts$/.test(name)) return null
  const cur = current
  if (!cur) return null
  cur.lastAct = Date.now()
  const fp = join(cur.dir, name)
  try {
    const st = fs.statSync(fp)
    if (!st || !st.isFile()) return null
    return fp
  } catch (e) {
    return null
  }
}

const HUB_RAW_KEEP = 1024 * 1024
const HUB_RAW_MIRROR_MAX = 256 * 1024
const HUB_SUB_BACKLOG_MAX = 16 * 1024 * 1024
let flvHub = null

function isFlvKeyTag(tag) {
  return tag.length >= 13 && tag[0] === 9 && (tag[11] >> 4) === 1 && (tag[11] & 0x0f) === 7 && tag[12] === 1
}

function makeFlvHub(onActivity) {
  const subs = new Set()
  let head = null
  let meta = null
  let avc = null
  let key = null
  let buf = Buffer.alloc(0)
  let rawParts = []
  let rawBytes = 0
  let rawOpen = true

  const drop = (s) => {
    if (s.closed) return
    s.closed = true
    subs.delete(s)
    try { s.pt.destroy() } catch (e) { }
  }

  const note = (tag) => {
    if (tag[0] === 18) { meta = tag; return }
    if (tag[0] !== 9) return
    if ((tag[11] & 0x0f) === 7 && tag[12] === 0) avc = tag
    if (isFlvKeyTag(tag)) key = tag
  }

  const write = (s, bytes) => {
    if (s.closed) return
    try {
      s.pt.write(bytes)

      if (s.pt.writableLength > HUB_SUB_BACKLOG_MAX) drop(s)
    } catch (e) { drop(s) }
  }

  const writeTag = (s, tag) => {
    if (s.closed) return
    if (!s.rebase) { write(s, tag); return }

    const ts = (((tag[7] << 24) | (tag[4] << 16) | (tag[5] << 8) | tag[6]) >>> 0)
    if (s.baseTs < 0) s.baseTs = ts
    const rel = ts >= s.baseTs ? (ts - s.baseTs) : 0
    const cp = Buffer.from(tag)
    cp[4] = (rel >>> 16) & 0xff
    cp[5] = (rel >>> 8) & 0xff
    cp[6] = rel & 0xff
    cp[7] = (rel >>> 24) & 0xff
    write(s, cp)
  }

  const feed = (chunk) => {
    if (rawOpen) {
      rawParts.push(chunk)
      rawBytes += chunk.length
      if (rawBytes > HUB_RAW_KEEP) { rawOpen = false; rawParts = []; rawBytes = 0 }
    }

    for (const s of subs) if (s.mirror) write(s, chunk)
    if (subs.size > 0) { try { onActivity() } catch (e) { } }

    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
    while (true) {
      if (!head) {
        if (buf.length < 13) break
        if (!(buf[0] === 0x46 && buf[1] === 0x4c && buf[2] === 0x56)) { buf = buf.subarray(1); continue }
        head = Buffer.from(buf.subarray(0, 13))
        buf = buf.subarray(13)
        continue
      }
      if (buf.length < 11) break
      const size = (buf[1] << 16) | (buf[2] << 8) | buf[3]
      const total = 11 + size + 4
      if (buf.length < total) break
      const tag = Buffer.from(buf.subarray(0, total))
      buf = buf.subarray(total)
      note(tag)
      for (const s of subs) {
        if (s.closed || s.mirror) continue
        if (s.synced) { writeTag(s, tag); continue }

        if (!isFlvKeyTag(tag)) continue
        if (head) write(s, head)
        if (meta) write(s, meta)
        if (avc) write(s, avc)
        s.rebase = true
        s.baseTs = -1
        writeTag(s, tag)
        s.synced = true
      }
    }
  }

  const subscribe = () => {
    const pt = new PassThrough()
    const s = { pt, mirror: false, synced: false, closed: false, rebase: false, baseTs: -1 }

    if (rawOpen && rawBytes <= HUB_RAW_MIRROR_MAX) {
      s.mirror = true
      for (const p of rawParts) write(s, p)
    } else {
      if (head) write(s, head)
      if (meta) write(s, meta)
      if (avc) write(s, avc)
      if (key) { s.rebase = true; s.baseTs = -1; writeTag(s, key); s.synced = true }
    }
    subs.add(s)
    return {
      stream: pt,
      count: () => subs.size,
      close: () => drop(s)
    }
  }

  return { feed, subscribe, count: () => subs.size }
}

export function flvSubscribe() {
  const h = flvHub
  if (!h) return null
  return h.subscribe()
}

export function hlsBusy() {
  return current !== null
}

export function flvCurrent() {
  return flvSubscribe()
}

export function streamMode() {
  const cur = current
  return cur ? String(cur.mode || '') : ''
}

export function stopHls() {
  const cur = current
  if (!cur) return

  cur.stopByUser = true
  current = null
  if (cur.timer) { try { clearInterval(cur.timer) } catch (e) { } }
  if (cur.ffTimer) { try { clearTimeout(cur.ffTimer) } catch (e) { } }
  try { cur.child.kill('SIGKILL') } catch (e) { }
  clearPid()
}
