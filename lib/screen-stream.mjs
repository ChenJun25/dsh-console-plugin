import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

const DEF_FPS = 10
const DEF_BITRATE = '2M'
const DEF_SCALE = 1280

let current = null

function whichFfmpeg() {

  const env = String(process.env.DSH_FFMPEG || '').trim()
  if (env && fs.existsSync(env)) return env

  const cands = [
    join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg'
  ]
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c } catch (e) { }
  }

  return 'ffmpeg'
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

export function startHls(opts) {
  const o = opts || {}
  const fps = Number(o.fps) > 0 ? Number(o.fps) : DEF_FPS
  const bitrate = String(o.bitrate || DEF_BITRATE)
  const scale = Number(o.scale) > 0 ? Number(o.scale) : DEF_SCALE

  const av = screenAvailable()
  if (!av.ok) {
    return { ok: false, reason: av.reason, hint: av.hint }
  }
  if (current) {
    return { ok: false, reason: 'busy' }
  }

  const dir = hlsDir()
  clearHlsDir()

  const enc = av.encoder
  const args = [
    '-hide_banner', '-loglevel', 'error',

    ...captureArgs(fps),

    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-vf', 'scale=' + scale + ':-2',
    ...encoderArgs(enc, bitrate),
    '-c:a', 'aac', '-b:a', '32k', '-ar', '44100', '-ac', '2',
    '-g', String(fps * 2),

    '-f', 'hls',
    '-hls_time', '1',

    '-hls_list_size', '6',

    '-hls_flags', 'omit_endlist',
    '-hls_segment_filename', join(dir, 'seg%05d.ts'),
    join(dir, 'live.m3u8')
  ]

  let child
  try {
    child = spawn(av.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  } catch (e) {
    return { ok: false, reason: 'spawn-failed' }
  }

  current = { child, at: Date.now(), encoder: enc, dir }

  let killed = false
  const kill = () => {
    if (killed) return
    killed = true
    try { child.kill('SIGKILL') } catch (e) { }
    if (current && current.child === child) current = null
  }
  child.on('error', kill)
  child.on('exit', () => { if (current && current.child === child) current = null })
  child.stderr.on('data', () => {                          })

  return { ok: true, encoder: enc, m3u8Path: join(dir, 'live.m3u8'), dir, kill }
}

export function readM3u8() {
  const cur = current
  if (!cur) return null
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

export function stopHls() {
  const cur = current
  if (!cur) return
  current = null
  try { cur.child.kill('SIGKILL') } catch (e) { }
}
