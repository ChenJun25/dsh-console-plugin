import { spawn, execFileSync } from 'node:child_process'

import { ensureFfmpeg, findLocalFfmpeg, isReady as ffmpegIsReady, ffmpegExePath, FFMPEG_DIR } from './ffmpeg-bootstrap.mjs'
import fs from 'node:fs'
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
    clearPid()
  }
  child.on('error', kill)
  child.on('exit', () => {
    if (current && current.child === child) {
      if (current.timer) { try { clearInterval(current.timer) } catch (e) { } }
      current = null
      clearPid()
    }
  })
  child.stderr.on('data', () => {                          })

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
    out.stdout = child.stdout

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

export function hlsBusy() {
  return current !== null
}

export function flvCurrent() {
  const cur = current
  if (!cur || cur.mode !== 'flv' || !cur.child || !cur.child.stdout) return null
  const child = cur.child
  return {
    stdout: child.stdout,
    touch: () => { const c = current; if (c && c.child === child) c.lastAct = Date.now() },
    kill: () => {
      const c = current
      if (!c || c.child !== child) return
      stopHls()
      clearHlsDir()
    }
  }
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
