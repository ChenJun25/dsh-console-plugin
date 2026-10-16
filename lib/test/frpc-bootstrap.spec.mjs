/**
 * 第215节 · 修法3 回归：frpc 自动引导（frpc-bootstrap.mjs）+ tunnel.mjs 接入点。
 *
 * 为什么必须有这个 spec：这条链路是**别人机器能不能用公网**的唯一开关 ——
 * 老实现把 frpc 路径写死成开发机路径，别人静默失败；新实现要在「缺失时下载 + 校验 + 原子落盘」，
 * 任何一步写错都会回到「连不上公网且面板无原因」。
 *
 * 跑法（**不要加 --test-force-exit**，见第213节抖动结论）：
 *   node --test lib/test/*.spec.mjs
 * 单跑本文件：node lib/test/frpc-bootstrap.spec.mjs
 *
 * 全部走注入 fetch / 注入目录（mkdtemp），**不联网、不碰真实 ~/.dsh/frp**。
 *
 * 🔴 夹具为什么用 tool-*.bin 这种"看不出是什么"的名字（第216节补）：
 *   原先清单/断言里写的是真名 frpc_0.62.1_linux_amd64，本机 Windows Defender 会按名字+特征
 *   把这个 1KB 假文件判成 HackTool/Linux.Frp.alcrit **当场删掉**（内容其实只是 FAKE-FRPC-BINARY- 重复），
 *   测试于是变成"跑一次弹一次杀软弹窗"。夹具只用文件名/大小/sha 参与逻辑，叫什么都一样 ⇒ 用中性名。
 *   真正下载的二进制在 frpc-bootstrap.mjs 的 FILE_BY_KEY 里，不受这里影响。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { platformKey, frpcTargetPath, verifyFrpc, ensureFrpc, sha256OfFile, legacyFrpcPaths } from '../frpc-bootstrap.mjs'

let seq = 0
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-frpc-' + (seq++) + '-'))
}
const BODY = Buffer.from('FAKE-FRPC-BINARY-'.repeat(64), 'utf8')
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

/** 假 fetch：p 以 /manifest.json 结尾回清单 JSON，否则回二进制。 */
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
  const names = Object.keys(MANIFEST_JSON.files).map((k) => MANIFEST_JSON.files[k].file)
  assert.equal(names.some((n) => /frpc|frp_|0\.62\.1/i.test(n)), false, '夹具文件名不许含 frpc/版本号：' + names.join(','))
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
  const p = path.join(dir, 'frpc')
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
  const p = path.join(dir, 'frpc')
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
  // 大小蒙对但内容变了 ⇒ 必须由 sha 拦住
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
  // 包一层 fetch，在第一跳（manifest）之后检查目录里还没有正式文件
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
  const legacy = path.join(dir, 'legacy-frpc')
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
