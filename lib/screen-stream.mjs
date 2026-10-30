import { spawn, execFileSync } from 'node:child_process'

import { ensureFfmpeg, findLocalFfmpeg, isReady as ffmpegIsReady, ffmpegExePath, FFMPEG_DIR } from './ffmpeg-bootstrap.mjs'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import os from 'node:os'
import { join } from 'node:path'

const DEF_FPS = 8

const LAN_FPS = 15
const LAN_BITRATE = '6M'
const LAN_SCALE = 1920

const DEF_BITRATE = '2M'
const DEF_SCALE = 1280

let current = null

const IDLE_STOP_MS = (function () {
  const v = Number(process.env.DSH_SCREEN_IDLE_MS)
  return v > 0 ? v : 5000
})()
const IDLE_CHECK_MS = 1000

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
function pickEncoder(ff) {
  const now = Date.now()
  if (encCache.name && now - encCache.at < 60000) return encCache.name
  let out = ''
  try {
    out = String(execFileSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 8000 }))
  } catch (e) {
    out = ''
  }
  const order = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']
  let name = 'libx264'
  for (const o of order) {
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
  return ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bitrate]
}

function captureArgs(fps) {
  if (process.platform === 'win32') {
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

function buildArgs(mode, fps, bitrate, scale, enc, dir) {
  const base = [
    '-hide_banner', '-loglevel', 'error',

    ...captureArgs(fps),

    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-vf', 'scale=' + scale + ':-2',
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

function startCapture(mode, opts) {
  const o = opts || {}

  const hd = o.hd === true
  const fps = Number(o.fps) > 0 ? Number(o.fps) : (hd ? LAN_FPS : DEF_FPS)
  const bitrate = String(o.bitrate || (hd ? LAN_BITRATE : DEF_BITRATE))
  const scale = Number(o.scale) > 0 ? Number(o.scale) : (hd ? LAN_SCALE : DEF_SCALE)

  const av = screenAvailable()
  if (!av.ok) {
    return { ok: false, reason: av.reason, hint: av.hint }
  }

  if (current) {
    return { ok: false, reason: 'busy' }
  }

  reapOrphan()

  const dir = hlsDir()
  if (mode === 'hls') clearHlsDir()

  const enc = av.encoder
  const args = buildArgs(mode, fps, bitrate, scale, enc, dir)

  let child
  try {

    child = spawn(av.ffmpeg, args, {
      stdio: ['ignore', mode === 'flv' ? 'pipe' : 'ignore', 'pipe'],
      windowsHide: true
    })
  } catch (e) {
    return { ok: false, reason: 'spawn-failed' }
  }

  current = { child, mode, at: Date.now(), encoder: enc, dir, lastAct: Date.now(), timer: null }
  writePid(child.pid)

  let killed = false
  const kill = () => {
    if (killed) return
    killed = true
    if (current && current.timer) { try { clearInterval(current.timer) } catch (e) { } }
    try { child.kill('SIGKILL') } catch (e) { }
    if (current && current.child === child) current = null

    if (mode === 'flv') flvHub = null
    clearPid()
  }
  child.on('error', kill)
  child.on('exit', () => {
    if (current && current.child === child) {
      if (current.timer) { try { clearInterval(current.timer) } catch (e) { } }
      current = null

      if (mode === 'flv') flvHub = null
      clearPid()
    }
  })
  child.stderr.on('data', () => {                          })

  if (mode === 'flv') {
    const cur0 = current
    const hub = makeFlvHub(() => { if (current === cur0) cur0.lastAct = Date.now() })
    flvHub = hub
    child.stdout.on('data', (c) => {
      try { hub.feed(c) } catch (e) {                            }
    })
  }

  const timer = setInterval(() => {
    const cur = current
    if (!cur || cur.child !== child) return
    if (Date.now() - cur.lastAct > IDLE_STOP_MS) {

      try { console.log('[screen] 空闲 ' + Math.round((Date.now() - cur.lastAct) / 1000) + ' 秒无播放请求，自动停止采集') } catch (e) { }
      stopHls()
      clearHlsDir()
    }
  }, IDLE_CHECK_MS)
  if (timer && typeof timer.unref === 'function') timer.unref()
  if (current && current.child === child) current.timer = timer

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
  current = null
  if (cur.timer) { try { clearInterval(cur.timer) } catch (e) { } }
  try { cur.child.kill('SIGKILL') } catch (e) { }
  clearPid()
}
