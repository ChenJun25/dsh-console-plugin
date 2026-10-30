
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE_DIR = path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(STATE_DIR, 'dsh-console-screen-control.json')
const PS_NAME = 'dsh-console-input-846.ps1'

const PS_SCRIPT = "$ErrorActionPreference = 'Stop'\r\nAdd-Type -TypeDefinition @'\r\nusing System;\r\nusing System.Runtime.InteropServices;\r\npublic class DshInput {\r\n  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }\r\n  [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y);\r\n  [DllImport(\"user32.dll\")] public static extern bool GetCursorPos(out POINT p);\r\n  [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);\r\n  [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int i);\r\n  [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();\r\n}\r\n'@\r\n[void][DshInput]::SetProcessDPIAware()\r\n$sw = [DshInput]::GetSystemMetrics(78)\r\n$sh = [DshInput]::GetSystemMetrics(79)\r\n$vx = [DshInput]::GetSystemMetrics(76)\r\n$vy = [DshInput]::GetSystemMetrics(77)\r\nif ($sw -lt 1) { $sw = 1920 }\r\nif ($sh -lt 1) { $sh = 1080 }\r\n[Console]::Out.WriteLine(\"SIZE $sw $sh\")\r\n[Console]::Out.Flush()\r\n$inv = [System.Globalization.CultureInfo]::InvariantCulture\r\nwhile ($true) {\r\n  $line = [Console]::In.ReadLine()\r\n  if ($null -eq $line) { break }\r\n  $line = $line.Trim()\r\n  if ($line -eq \"\") { continue }\r\n  $a = $line.Split(\" \")\r\n  $op = $a[0]\r\n  if ($op -eq \"BYE\") { break }\r\n  try {\r\n    if ($op -eq \"M\") {\r\n      $p = New-Object DshInput+POINT\r\n      [void][DshInput]::GetCursorPos([ref]$p)\r\n      $dx = [double]::Parse($a[1], $inv) * $sw\r\n      $dy = [double]::Parse($a[2], $inv) * $sh\r\n      $nx = [int][Math]::Round($p.X + $dx)\r\n      $ny = [int][Math]::Round($p.Y + $dy)\r\n      if ($nx -lt $vx) { $nx = $vx }\r\n      if ($ny -lt $vy) { $ny = $vy }\r\n      if ($nx -gt ($vx + $sw - 1)) { $nx = $vx + $sw - 1 }\r\n      if ($ny -gt ($vy + $sh - 1)) { $ny = $vy + $sh - 1 }\r\n      [void][DshInput]::SetCursorPos($nx, $ny)\r\n    } elseif ($op -eq \"L\") {\r\n      [DshInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)\r\n      Start-Sleep -Milliseconds 30\r\n      [DshInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)\r\n    } elseif ($op -eq \"R\") {\r\n      [DshInput]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)\r\n      Start-Sleep -Milliseconds 30\r\n      [DshInput]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)\r\n    } elseif ($op -eq \"W\") {\r\n      [DshInput]::mouse_event(0x0800, 0, 0, [int]$a[1], [UIntPtr]::Zero)\r\n    }\r\n  } catch {\r\n    [Console]::Out.WriteLine(\"ERR \" + $_.Exception.Message)\r\n    [Console]::Out.Flush()\r\n  }\r\n}\r\n"

let allowState = false
try {
  if (fs.existsSync(STATE_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (parsed && typeof parsed.allow === 'boolean') allowState = parsed.allow
  }
} catch (e) { allowState = false }

let child = null
let warm = false
let screenSize = { w: 0, h: 0 }
let lastError = ''

export function controlAllowed() { return allowState }

export function screenControlInfo() {
  return {
    allowed: allowState,
    available: process.platform === 'win32',
    warm: warm,
    screenW: screenSize.w,
    screenH: screenSize.h,
    lastError: lastError
  }
}

function scriptPath() { return path.join(os.tmpdir(), PS_NAME) }

function ensureScript() {
  const p = scriptPath()
  let cur = ''
  try { cur = fs.readFileSync(p, 'utf8') } catch (e) { cur = '' }
  if (cur !== PS_SCRIPT) fs.writeFileSync(p, PS_SCRIPT, 'utf8')
  return p
}

export function startInjector(log) {
  if (child) return true
  if (process.platform !== 'win32') { lastError = 'unsupported-platform'; return false }
  let script = ''
  try { script = ensureScript() } catch (e) {
    lastError = 'write-script-failed: ' + String((e && e.message) || e)
    return false
  }
  let c = null
  try {
    c = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-File', script
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  } catch (e) {
    lastError = 'spawn-failed: ' + String((e && e.message) || e)
    child = null
    return false
  }
  child = c
  warm = false
  lastError = ''
  let outBuf = ''
  c.stdout.setEncoding('utf8')
  c.stdout.on('data', (d) => {
    outBuf += d
    if (outBuf.length > 65536) outBuf = outBuf.slice(-4096)
    let i = outBuf.indexOf('\n')
    while (i >= 0) {
      const line = outBuf.slice(0, i).trim()
      outBuf = outBuf.slice(i + 1)
      const m = /^SIZE (\d+) (\d+)$/.exec(line)
      if (m) {
        screenSize = { w: Number(m[1]) || 0, h: Number(m[2]) || 0 }
        warm = true
      } else if (line.indexOf('ERR ') === 0) {
        lastError = line.slice(4)
      }
      i = outBuf.indexOf('\n')
    }
  })
  let errBuf = ''
  c.stderr.setEncoding('utf8')
  c.stderr.on('data', (d) => {
    errBuf += d
    if (errBuf.length > 4000) errBuf = errBuf.slice(-4000)
    const parts = errBuf.trim().split('\n')
    if (parts.length > 0) lastError = parts[parts.length - 1]
  })
  c.on('exit', () => {
    if (child === c) { child = null; warm = false }
  })
  c.on('error', (e) => {
    lastError = 'pipe-error: ' + String((e && e.message) || e)
    if (child === c) { child = null; warm = false }
  })
  if (typeof log === 'function') log('[screen] 手机控制注入器已启动')
  return true
}

export function stopInjector() {
  const c = child
  child = null
  warm = false
  screenSize = { w: 0, h: 0 }
  if (!c) return
  try { c.stdin.write('BYE\n') } catch (e) { }
  try { c.stdin.end() } catch (e) { }
  const t = setTimeout(() => { try { c.kill() } catch (e) { } }, 800)
  if (t && typeof t.unref === 'function') t.unref()
}

export function setControlAllowed(next, log) {
  allowState = next === true
  if (!allowState) stopInjector()
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({ allow: allowState }, null, 2), { mode: 0o600 })
  } catch (e) {
    if (typeof log === 'function') log('[screen] 控制开关写盘失败：' + String((e && e.message) || e))
    return false
  }
  if (allowState) startInjector(log)
  return true
}

function send(line) {
  const c = child
  if (!c || !c.stdin || c.stdin.destroyed) return false
  try { c.stdin.write(line + '\n'); return true } catch (e) { return false }
}

export function inputMove(dx, dy, log) {
  if (!allowState) return false
  if (!child) { startInjector(log); return false }
  if (!warm) return false
  const nx = Number(dx)
  const ny = Number(dy)
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return false
  if (Math.abs(nx) > 0.5 || Math.abs(ny) > 0.5) return false
  return send('M ' + nx.toFixed(5) + ' ' + ny.toFixed(5))
}

export function inputClick(right) {
  if (!allowState) return false
  if (!child || !warm) return false
  return send(right === true ? 'R' : 'L')
}

export function inputWheel(delta) {
  if (!allowState) return false
  if (!child || !warm) return false
  const n = Number(delta)
  if (!Number.isFinite(n) || n === 0) return false
  const v = Math.max(-2400, Math.min(2400, Math.round(n)))
  return send('W ' + String(v))
}
