
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE_DIR = path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(STATE_DIR, 'dsh-console-screen-control.json')
const PS_NAME = 'dsh-console-input-846.ps1'

const PS_LINES = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public class DshInput {",
  "  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }",
  "  [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y);",
  "  [DllImport(\"user32.dll\")] public static extern bool GetCursorPos(out POINT p);",
  "  [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);",
  "  [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int i);",
  "  [DllImport(\"user32.dll\")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);",
  "  [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();",
  "}",
  "'@",
  "if (-not [DshInput]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [void][DshInput]::SetProcessDPIAware() }",
  "$sw = [DshInput]::GetSystemMetrics(78)",
  "$sh = [DshInput]::GetSystemMetrics(79)",
  "$vx = [DshInput]::GetSystemMetrics(76)",
  "$vy = [DshInput]::GetSystemMetrics(77)",
  "if ($sw -lt 1) { $sw = 1920 }",
  "if ($sh -lt 1) { $sh = 1080 }",
  "[Console]::Out.WriteLine(\"PROTO 930\")",
  "[Console]::Out.WriteLine(\"SIZE $sw $sh\")",
  "[Console]::Out.Flush()",
  "$inv = [System.Globalization.CultureInfo]::InvariantCulture",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ($null -eq $line) { break }",
  "  $line = $line.Trim()",
  "  if ($line -eq \"\") { continue }",
  "  $a = $line.Split(\" \")",
  "  $op = $a[0]",
  "  if ($op -eq \"BYE\") { break }",
  "  try {",
  "    if ($op -eq \"M\") {",
  "      $p = New-Object DshInput+POINT",
  "      [void][DshInput]::GetCursorPos([ref]$p)",
  "      $nx = 0",
  "      $ny = 0",
  "      if ($a.Length -ge 7) {",
  "        $nx = [int][Math]::Round($p.X + [double]::Parse($a[1], $inv))",
  "        $ny = [int][Math]::Round($p.Y + [double]::Parse($a[2], $inv))",
  "        $fx = [int]$a[3]",
  "        $fy = [int]$a[4]",
  "        $fw = [int]$a[5]",
  "        $fh = [int]$a[6]",
  "        if ($fw -gt 0 -and $fh -gt 0) {",
  "          if ($nx -lt $fx) { $nx = $fx }",
  "          if ($ny -lt $fy) { $ny = $fy }",
  "          if ($nx -gt ($fx + $fw - 1)) { $nx = $fx + $fw - 1 }",
  "          if ($ny -gt ($fy + $fh - 1)) { $ny = $fy + $fh - 1 }",
  "        } else {",
  "          if ($nx -lt $vx) { $nx = $vx }",
  "          if ($ny -lt $vy) { $ny = $vy }",
  "          if ($nx -gt ($vx + $sw - 1)) { $nx = $vx + $sw - 1 }",
  "          if ($ny -gt ($vy + $sh - 1)) { $ny = $vy + $sh - 1 }",
  "        }",
  "      } else {",
  "        $dx = [double]::Parse($a[1], $inv) * $sw",
  "        $dy = [double]::Parse($a[2], $inv) * $sh",
  "        $nx = [int][Math]::Round($p.X + $dx)",
  "        $ny = [int][Math]::Round($p.Y + $dy)",
  "        if ($nx -lt $vx) { $nx = $vx }",
  "        if ($ny -lt $vy) { $ny = $vy }",
  "        if ($nx -gt ($vx + $sw - 1)) { $nx = $vx + $sw - 1 }",
  "        if ($ny -gt ($vy + $sh - 1)) { $ny = $vy + $sh - 1 }",
  "      }",
  "      [void][DshInput]::SetCursorPos($nx, $ny)",
  "    } elseif ($op -eq \"L\") {",
  "      [DshInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)",
  "      Start-Sleep -Milliseconds 30",
  "      [DshInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)",
  "    } elseif ($op -eq \"R\") {",
  "      [DshInput]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)",
  "      Start-Sleep -Milliseconds 30",
  "      [DshInput]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)",
  "    } elseif ($op -eq \"W\") {",
  "      [DshInput]::mouse_event(0x0800, 0, 0, 0, [int]$a[1], [UIntPtr]::Zero)",
  "    }",
  "  } catch {",
  "    [Console]::Out.WriteLine(\"ERR \" + $_.Exception.Message)",
  "    [Console]::Out.Flush()",
  "  }",
  "}"
]
const PS_SCRIPT = PS_LINES.join('\r\n')

let allowState = false
try {
  if (fs.existsSync(STATE_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (parsed && typeof parsed.allow === 'boolean') allowState = parsed.allow
  }
} catch (e) { allowState = false }

let child = null
let warm = false

let protoVersion = 0
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
    proto: protoVersion,
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
      const mp = /^PROTO (\d+)$/.exec(line)
      if (mp) { protoVersion = Number(mp[1]) || 0; continue }
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
  protoVersion = 0
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

export function inputMove(dx, dy, log, geom) {
  if (!allowState) return false
  if (!child) { startInjector(log); return false }
  if (!warm) return false
  const nx = Number(dx)
  const ny = Number(dy)
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return false
  if (Math.abs(nx) > 0.5 || Math.abs(ny) > 0.5) return false
  const g = (geom && typeof geom === 'object') ? geom : null
  const gw = g ? Number(g.w) : 0
  const gh = g ? Number(g.h) : 0
  const ok = g && Number.isFinite(gw) && Number.isFinite(gh) && gw > 0 && gh > 0
  if (!ok || protoVersion < 930) {

    return send('M ' + nx.toFixed(5) + ' ' + ny.toFixed(5))
  }

  const rot = g.rotated === true || g.rotated === 1
  const fw = rot ? gh : gw
  const fh = rot ? gw : gh
  const dfx = nx * fw
  const dfy = ny * fh
  let px = dfx
  let py = dfy
  if (rot) {

    px = dfy
    py = -dfx
  }
  const rx = Math.round(Number(g.x) || 0)
  const ry = Math.round(Number(g.y) || 0)
  const rw = Math.round(gw)
  const rh = Math.round(gh)
  return send('M ' + px.toFixed(2) + ' ' + py.toFixed(2) + ' ' + String(rx) + ' ' + String(ry) + ' ' + String(rw) + ' ' + String(rh))
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
