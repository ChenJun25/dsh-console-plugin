import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { platformKey, frpcTargetPath, verifyFrpc, ensureFrpc, sha256OfFile, legacyFrpcPaths } from '../frpc-bootstrap.mjs'

let seq = 0

const TMP_DIRS = []
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tool-' + (seq++) + '-'))
  TMP_DIRS.push(d)
  return d
}
after(() => {
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (_) {} }
})

const FIXTURE_NAMES = { probe: 'probe-a.bin', probeW: 'probe-w.bin', legacy: 'legacy-w.bin' }
const BODY = Buffer.from('FAKE-TOOL-BINARY-'.repeat(64), 'utf8')
const SHA = createHash('sha256').update(BODY).digest('hex')
const MANIFEST_JSON = {
  version: '0.62.1',
  files: {
    'win32-x64': { file: 'tool-w.bin', sha256: SHA, size: BODY.length },
    'linux-x64': { file: 'tool-l.bin', sha256: SHA, size: BODY.length },
    'linux-arm64': { file: 'tool-la.bin', sha256: SHA, size: BODY.length },
    'darwin-x64': { file: 'tool-m.bin', sha256: SHA, size: BODY.length },
    'darwin-arm64': { file: 'tool-ma.bin', sha256: SHA, size: BODY.length }
  }
}

function fakeFetch(map = {}) {
  const calls = []
  const fn = async (url) => {
    const u = String(url)
    calls.push(u)
    if (map.throwOn) throw new Error(String(map.throwOn))
    if (u.indexOf('manifest.json') >= 0) {
      if (map.manifestStatus) return { ok: false, status: map.manifestStatus }
      if (map.manifestBad) return { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } }
      return { ok: true, status: 200, json: async () => (map.manifest || MANIFEST_JSON) }
    }
    if (map.fileStatus) return { ok: false, status: map.fileStatus }
    return { ok: true, status: 200, arrayBuffer: async () => (map.fileBody || BODY) }
  }
  fn.calls = calls
  return fn
}

test('夹具名不含 frpc / 版本号（防杀软误报回归，见文件头）', () => {
  const bad = /frpc|frp_|0\.62\.1/i
  const names = Object.keys(MANIFEST_JSON.files).map((k) => MANIFEST_JSON.files[k].file)
  assert.equal(names.some((n) => bad.test(n)), false, '清单夹具名不许含 frpc/版本号：' + names.join(','))
  const disk = Object.keys(FIXTURE_NAMES).map((k) => FIXTURE_NAMES[k])
  assert.equal(disk.some((n) => bad.test(n)), false, '落盘夹具名不许含 frpc/版本号：' + disk.join(','))
  assert.equal(bad.test(BODY.toString('utf8')), false, '夹具内容不许含 frpc 字样（Defender 也看内容特征）')
})

test('平台 key / 目标路径：五个平台都认，未知平台回空串', () => {
  assert.equal(platformKey('win32', 'x64'), 'win32-x64')
  assert.equal(platformKey('linux', 'x64'), 'linux-x64')
  assert.equal(platformKey('linux', 'arm64'), 'linux-arm64')
  assert.equal(platformKey('darwin', 'x64'), 'darwin-x64')
  assert.equal(platformKey('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(platformKey('freebsd', 'x64'), '')
  const p = frpcTargetPath('linux', 'arm64', '/tmp/xx')
  assert.equal(p, path.join('/tmp/xx', 'frpc_0.62.1_linux_arm64'))
  assert.equal(frpcTargetPath('freebsd', 'x64', '/tmp/xx'), '')
})

test('verifyFrpc：只认清单 sha256 与大小都对的；用户自放（无清单）只要是个文件就认', () => {
  const dir = tmpDir()
  const p = path.join(dir, FIXTURE_NAMES.probe)
  fs.writeFileSync(p, BODY)
  assert.equal(verifyFrpc(p, { sha256: SHA, size: BODY.length }), SHA)
  assert.equal(verifyFrpc(p, { sha256: 'deadbeef'.repeat(8), size: BODY.length }), '')
  assert.equal(verifyFrpc(p, { sha256: SHA, size: BODY.length + 1 }), '')
  assert.equal(verifyFrpc(p, null), SHA)
  assert.equal(verifyFrpc(path.join(dir, 'nope'), { sha256: SHA }), '')
  assert.equal(sha256OfFile(p), SHA)
})

test('⚠️ 关键：已有 frpc ⇒ 只认不下载（用户手放的文件永远优先，一个字节都不动）', async () => {
  const dir = tmpDir()
  const p = path.join(dir, FIXTURE_NAMES.probe)
  fs.writeFileSync(p, BODY)
  const f = fakeFetch()
  const r = await ensureFrpc({ dir, platform: 'linux', arch: 'x64', fileName: 'tool-l.bin', frpcPath: p, fetch: f })
  assert.equal(r.ok, true)
  assert.equal(r.downloaded, false)
  assert.equal(f.calls.length, 0)
  assert.equal(fs.readFileSync(p).equals(BODY), true)
})

test('下载成功：落盘到托管路径 + chmod + sha256 回填', async () => {
  const dir = tmpDir()
  const f = fakeFetch()
  const r = await ensureFrpc({ dir, platform: 'linux', arch: 'x64', fileName: 'tool-l.bin', fetch: f })
  assert.equal(r.ok, true)
  assert.equal(r.downloaded, true)
  assert.equal(r.path, path.join(dir, 'tool-l.bin'))
  assert.equal(r.sha256, SHA)
  assert.equal(fs.readFileSync(r.path).equals(BODY), true)
  assert.equal(fs.existsSync(r.path + '.download'), false)
  assert.equal(f.calls.length, 2)
})

test('sha 不符 ⇒ 不落盘（半截/被篡改的二进制绝不能当可用 frpc）', async () => {
  const dir = tmpDir()
  const f = fakeFetch({ fileBody: Buffer.from('TAMPERED', 'utf8') })
  const r = await ensureFrpc({ dir, platform: 'linux', arch: 'x64', fileName: 'tool-l.bin', fetch: f })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'size-mismatch')
  assert.equal(fs.readdirSync(dir).length, 0)

  const j = JSON.parse(JSON.stringify(MANIFEST_JSON))
  j.files['linux-x64'].size = 8
  const f2 = fakeFetch({ manifest: j, fileBody: Buffer.from('TAMPERED', 'utf8') })
  const r2 = await ensureFrpc({ dir, platform: 'linux', arch: 'x64', fileName: 'tool-l.bin', fetch: f2 })
  assert.equal(r2.ok, false)
  assert.equal(r2.reason, 'sha-mismatch')
  assert.equal(fs.readdirSync(dir).length, 0)
})

test('下载失败的各种 reason 都收成 ok:false，且**绝不抛**', async () => {
  const cases = [
    [{ manifestStatus: 404 }, 'manifest-http'],
    [{ manifestBad: true }, 'manifest-bad-json'],
    [{ manifest: { version: '0.62.1', files: {} } }, 'no-entry'],
    [{ fileStatus: 500 }, 'download-http'],
    [{ throwOn: 'ECONNRESET' }, 'fetch']
  ]
  for (const [map, want] of cases) {
    const dir = tmpDir()
    const r = await ensureFrpc({ dir, platform: 'linux', arch: 'x64', fileName: 'tool-l.bin', fetch: fakeFetch(map) })
    assert.equal(r.ok, false, want)
    assert.equal(r.reason, want)
    assert.equal(typeof r.error, 'string')
    assert.equal(fs.readdirSync(dir).length, 0)
  }
})

test('不支持的平台 / 没有 fetch ⇒ 明确 reason，不抛', async () => {
  const dir = tmpDir()
  const a = await ensureFrpc({ dir, platform: 'freebsd', arch: 'x64', fetch: fakeFetch() })
  assert.equal(a.ok, false)
  assert.equal(a.reason, 'unsupported')
  const b = await ensureFrpc({ dir, platform: 'linux', arch: 'x64', fileName: 'tool-l.bin', fetch: null, frpcPath: path.join(dir, 'x') })
  assert.equal(b.ok, false)
})

test('落盘是原子的：下载中只可能看到 .download 临时文件，不会看到半截正式文件', async () => {
  const dir = tmpDir()
  const f = fakeFetch()

  const probe = []
  const wrapped = async (u) => {
    probe.push(fs.readdirSync(dir).join(','))
    return await f(u)
  }
  const r = await ensureFrpc({ dir, platform: 'linux', arch: 'x64', fileName: 'tool-l.bin', fetch: wrapped })
  assert.equal(r.ok, true)
  assert.equal(probe.every((x) => x.indexOf('tool-l.bin') < 0), true)
})
test('⚠️ 老用户：机器上老位置已有 frpc ⇒ 直接用它，不下载、不覆盖（防「升级后反而连不上」）', async () => {
  const dir = tmpDir()
  const legacy = path.join(dir, FIXTURE_NAMES.legacy)
  fs.writeFileSync(legacy, BODY)
  const f = fakeFetch()
  const r = await ensureFrpc({ dir, platform: 'linux', arch: 'x64', fileName: 'tool-l.bin', legacyPaths: [legacy], fetch: f })
  assert.equal(r.ok, true)
  assert.equal(r.downloaded, false)
  assert.equal(r.legacy, true)
  assert.equal(r.path, legacy)
  assert.equal(f.calls.length, 0)
  assert.equal(fs.readFileSync(legacy).equals(BODY), true)
  assert.equal(fs.existsSync(path.join(dir, 'tool-l.bin')), false)
})

test('老路径也不存在 ⇒ 才走下载（顺序不能反）', async () => {
  const dir = tmpDir()
  const f = fakeFetch()
  const r = await ensureFrpc({ dir, platform: 'linux', arch: 'x64', fileName: 'tool-l.bin', legacyPaths: [path.join(dir, 'nope')], fetch: f })
  assert.equal(r.ok, true)
  assert.equal(r.downloaded, true)
  assert.equal(f.calls.length, 2)
})

test('legacyFrpcPaths：Windows 认老安装位置，其它平台给常见路径且都不重复', () => {
  assert.deepEqual(legacyFrpcPaths('win32'), ['C:\\Program Files\\dsh-frp\\frpc.exe'])
  assert.equal(legacyFrpcPaths('linux').length > 0, true)
  assert.equal(legacyFrpcPaths('darwin').indexOf('/opt/homebrew/bin/frpc') > 0, true)
  const uniq = new Set(legacyFrpcPaths('darwin'))
  assert.equal(uniq.size, legacyFrpcPaths('darwin').length)
})

test('落盘后文件立刻消失（安全软件拦截）⇒ ok:false + reason=blocked，不谎报成功', async () => {
  const dir = tmpDir()
  const target = path.join(dir, 'tool-l.bin')
  const f = fakeFetch()
  const realRename = fs.renameSync
  fs.renameSync = (a, b) => { realRename(a, b); try { fs.unlinkSync(b) } catch (_) {} }
  let r
  try {
    r = await ensureFrpc({ dir, platform: 'linux', arch: 'x64', fileName: 'tool-l.bin', legacyPaths: [], fetch: f })
  } finally {
    fs.renameSync = realRename
  }
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'blocked')
  assert.equal(fs.existsSync(target), false)
})

test('tunnel.mjs 接入：DEFAULT_FRPC 走托管路径 + 缺失时异步引导（不再一遇缺失就 error 收工）', async () => {
  const src = fs.readFileSync(new URL('../tunnel.mjs', import.meta.url), 'utf8')
  const decl = src.split('\n').find((l) => l.indexOf('const DEFAULT_FRPC') === 0)
  assert.ok(decl, 'DEFAULT_FRPC 声明行不见了')
  assert.equal(decl.indexOf('frpcTargetPath()') > 0, true, 'DEFAULT_FRPC 必须取托管路径：' + decl)
  assert.equal(src.indexOf("from './frpc-bootstrap.mjs'") > 0, true)
  assert.equal(/ensureThenShell\(c, myStart\)/.test(src), true)
  assert.equal(/startGen\+\+/.test(src), true)
})
