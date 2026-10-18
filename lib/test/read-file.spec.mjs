/**
 * task-1（0.5.18）单测：runCommand 新增 op 'readFile'。
 *
 * 【要治的病】App 端要按磁盘路径预览交付文件（图片/pdf 等），但插件以前只有
 * fsDrives / fsList / fsMkdir 三个「只看目录」的 op，一个字节都读不出来。
 * 这里补 readFile：绝对路径 + 必须存在 + 必须是普通文件 + 默认 3MB 上限，
 * 成功返回 { ok, path, name, mime, bytes, b64 }（mime 走 attachments.mjs 的 mimeOfName）。
 *
 * 覆盖面：
 *   ① 正常读：name / mime / bytes / b64 全对，path 是绝对路径；
 *   ② 超限：>3MB ⇒ ok:false + 「文件过大：… 超过 3 MB 上限」（不截断）；
 *   ③ 不存在 ⇒ ok:false（不崩，错误文案非空）；
 *   ④ 反面补充：相对路径、目录、缺 path 一律拒绝；
 *   ⑤ 0 字节普通文件可读；扩展名认不出 ⇒ mime 空串（不编造）。
 * 跑法：node --test lib/test/read-file.spec.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-read-file-'))
let seq = 0
function writeTemp(ext, size) {
  const p = path.join(TMPDIR, 'f' + (seq++) + (ext ? '.' + ext : ''))
  fs.writeFileSync(p, Buffer.alloc(Number.isFinite(size) ? size : 32, 0x42))
  return p
}

/** 只截 cmd 路由，别的服务一律 null（readFile 不需要宿主任何服务）。 */
function mockCtx() {
  const routes = {}
  const conn = { fetch: { register: (route) => { routes[route.path] = route; return () => {} } } }
  const ctx = {
    get: (n) => (n === 'connection' ? conn : null),
    on: () => () => {},
    effect: () => () => {}
  }
  return { ctx, routes }
}

async function cmd(op, payload) {
  const { ctx, routes } = mockCtx()
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  assert.ok(routes['/api/dsh-console/cmd'], 'cmd 路由没注册上')
  const r = await routes['/api/dsh-console/cmd'].fetch(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ op: op, payload: payload })
  }))
  return r.json()
}

test('① 正常读：name / mime / bytes / b64 全对', async () => {
  const buf = crypto.randomBytes(2048)
  const p = path.join(TMPDIR, 'shot.png')
  fs.writeFileSync(p, buf)
  const j = await cmd('readFile', { path: p })
  assert.equal(j.ok, true, '读成功')
  const r = j.result
  assert.equal(r.ok, true)
  assert.equal(r.name, 'shot.png', 'name = 文件名')
  assert.equal(r.mime, 'image/png', 'mime 走 mimeOfName（按扩展名）')
  assert.equal(r.bytes, buf.length, 'bytes = 真实文件大小')
  assert.equal(r.b64, buf.toString('base64'), 'b64 = base64(文件字节)')
  assert.equal(r.path, path.resolve(p), 'path 是规范化的绝对路径')
  assert.equal(Buffer.from(r.b64, 'base64').equals(buf), true, '解回来字节完全一致')
})

test('② 超限：>3MB ⇒ ok:false + 「文件过大 … 超过 3 MB 上限」（绝不截断）', async () => {
  const big = writeTemp('bin', 3 * 1024 * 1024 + 1024)     // 3MB + 1KB
  const j = await cmd('readFile', { path: big })
  assert.equal(j.ok, false, '超限直接失败')
  assert.equal(typeof j.result, 'undefined', '失败时不带半截内容')
  assert.ok(j.error.indexOf('文件过大：') === 0, '文案开头是「文件过大：」，实际：' + j.error)
  assert.ok(j.error.indexOf(path.basename(big)) >= 0, '文案带文件名')
  assert.ok(j.error.indexOf('3.0 MB') >= 0, '带真实大小')
  assert.ok(j.error.indexOf('超过 3 MB 上限') >= 0, '带上限说明，实际：' + j.error)
})

test('③ 不存在 ⇒ ok:false（不崩）', async () => {
  const missing = path.join(TMPDIR, '没有这个文件.png')
  const j = await cmd('readFile', { path: missing })
  assert.equal(j.ok, false, '不存在 ⇒ 失败')
  assert.equal(typeof j.error, 'string', '有错误文案')
  assert.ok(j.error.length > 0, '文案非空：' + j.error)
})

test('④ 反面：相对路径 / 目录 / 缺 path 一律拒绝', async () => {
  const j1 = await cmd('readFile', { path: 'lib/index.js' })
  assert.equal(j1.ok, false, '相对路径拒绝')
  assert.ok(j1.error.indexOf('必须是绝对路径') === 0, '文案：' + j1.error)

  const j2 = await cmd('readFile', { path: TMPDIR })
  assert.equal(j2.ok, false, '目录拒绝')
  assert.ok(j2.error.indexOf('不是文件') === 0, '文案：' + j2.error)

  const j3 = await cmd('readFile', {})
  assert.equal(j3.ok, false, '缺 path 拒绝')
  assert.equal(j3.error, '缺少 path')
})

test('⑤ 0 字节普通文件可读（b64 空串）；认不出的扩展名 mime 给空串不编造', async () => {
  const p = writeTemp('txt', 0)
  const j = await cmd('readFile', { path: p })
  assert.equal(j.ok, true, '0 字节文件可读（不是目录就行）')
  assert.equal(j.result.bytes, 0)
  assert.equal(j.result.b64, '')
  assert.equal(j.result.mime, '', 'txt 不在图片白名单里 ⇒ mimeOfName 给空串')
})

test.after(() => { try { fs.rmSync(TMPDIR, { recursive: true, force: true }) } catch (e) {} })
