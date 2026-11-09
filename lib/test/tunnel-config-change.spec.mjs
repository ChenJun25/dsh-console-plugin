import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tomlText, tunnelConfigDigest, tunnelGeneratedDigest, tunnelConfigChanged } from '../tunnel.mjs'

const SHORT = 'A1B2C3D4E5F6G7H'

let seq = 0
const TMP_DIRS = []
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-1341-' + (seq++) + '-'))
  TMP_DIRS.push(d)
  return d
}
after(() => {
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (_) { } }
})

const autoCfg = (over = {}) => Object.assign({
  enabled: true,
  type: 'http',
  name: 'dsh-' + SHORT,
  serverAddr: '118.178.129.217',
  serverPort: 7000,
  authToken: 'TOK-OLD',
  customDomains: ['gaoshou25.cn'],
  locations: ['/dsh-console/' + SHORT],
  publicUrl: 'https://gaoshou25.cn/dsh-console/' + SHORT,
  updatedMs: 1
}, over)

function scene(cfgOver = {}) {
  const dir = tmpDir()
  const cfgPath = path.join(dir, 'manual-none.json')
  const autoPath = path.join(dir, 'tunnel.auto.json')
  const tomlPath = path.join(dir, 'frpc.toml')
  fs.writeFileSync(autoPath, JSON.stringify(autoCfg(cfgOver), null, 2), 'utf8')
  const want = tunnelConfigDigest({ localPort: 8899, configPath: cfgPath, autoPath: autoPath })
  assert.notEqual(want, '', '前置：这份配置必须是合法的（能算出指纹）')
  fs.writeFileSync(tomlPath, want, 'utf8')
  return { dir, cfgPath, autoPath, tomlPath }
}

test('#1341 配置没变 ⇒ 不许重启（好着的隧道绝不打断）', () => {
  const s = scene()
  assert.equal(tunnelConfigChanged({ localPort: 8899, configPath: s.cfgPath, autoPath: s.autoPath, tomlPath: s.tomlPath }), false)
})

test('#1341 指纹就是 writeToml 写出的字节（同源，不许各算一套）', () => {
  const s = scene()
  const onDisk = fs.readFileSync(s.tomlPath, 'utf8')
  assert.equal(onDisk, tunnelConfigDigest({ localPort: 8899, configPath: s.cfgPath, autoPath: s.autoPath }))
  assert.equal(onDisk, tunnelGeneratedDigest({ tomlPath: s.tomlPath }))
})

test('#1341 只有 updatedMs 变了 ⇒ 不许重启（心跳不许触发重启风暴）', () => {
  const s = scene()
  fs.writeFileSync(s.autoPath, JSON.stringify(autoCfg({ updatedMs: Date.now() }), null, 2), 'utf8')
  assert.equal(tunnelConfigChanged({ localPort: 8899, configPath: s.cfgPath, autoPath: s.autoPath, tomlPath: s.tomlPath }), false)
})

test('#1341 frps auth.token 轮换 ⇒ 必须重启（本次事故就是这个）', () => {
  const s = scene()
  fs.writeFileSync(s.autoPath, JSON.stringify(autoCfg({ authToken: 'TOK-NEW-ROTATED', updatedMs: 2 }), null, 2), 'utf8')
  assert.equal(tunnelConfigChanged({ localPort: 8899, configPath: s.cfgPath, autoPath: s.autoPath, tomlPath: s.tomlPath }), true)
})

test('#1341 代理名（短号）/ 域名 / 公网端口任一变化 ⇒ 必须重启', () => {
  for (const over of [
    { name: 'dsh-Z9Y8X7W6V5U4T3S', locations: ['/dsh-console/Z9Y8X7W6V5U4T3S'] },
    { customDomains: ['new.example.com'] },
    { serverPort: 7001 },
    { serverAddr: '10.0.0.1' }
  ]) {
    const s = scene()
    fs.writeFileSync(s.autoPath, JSON.stringify(autoCfg(over), null, 2), 'utf8')
    assert.equal(tunnelConfigChanged({ localPort: 8899, configPath: s.cfgPath, autoPath: s.autoPath, tomlPath: s.tomlPath }), true, JSON.stringify(over))
  }
})

test('#1341 本地端口变了 ⇒ 必须重启（端口换了 frpc 转发还是老端口）', () => {
  const s = scene()
  assert.equal(tunnelConfigChanged({ localPort: 8898, configPath: s.cfgPath, autoPath: s.autoPath, tomlPath: s.tomlPath }), true)
})

test('#1341 磁盘上还没有 toml（frpc 没起来过）⇒ false，交回老逻辑处理', () => {
  const s = scene()
  fs.rmSync(s.tomlPath)
  assert.equal(tunnelConfigChanged({ localPort: 8899, configPath: s.cfgPath, autoPath: s.autoPath, tomlPath: s.tomlPath }), false)
  assert.equal(tunnelGeneratedDigest({ tomlPath: s.tomlPath }), '')
})

test('#1341 云端没下发 / enabled 不是 true / 配置坏 ⇒ 一律 false，绝不误杀正在跑的 frpc', () => {
  const d1 = tmpDir()
  assert.equal(tunnelConfigChanged({ localPort: 8899, configPath: path.join(d1, 'none.json'), autoPath: path.join(d1, 'none.json'), tomlPath: path.join(d1, 'none.toml') }), false)

  const d2 = tmpDir()
  const autoPath = path.join(d2, 'tunnel.auto.json')
  const tomlPath = path.join(d2, 'frpc.toml')
  fs.writeFileSync(tomlPath, 'whatever', 'utf8')
  fs.writeFileSync(autoPath, JSON.stringify(autoCfg({ enabled: false }), null, 2), 'utf8')
  assert.equal(tunnelConfigChanged({ localPort: 8899, configPath: path.join(d2, 'none.json'), autoPath: autoPath, tomlPath: tomlPath }), false)

  fs.writeFileSync(autoPath, JSON.stringify(autoCfg({ authToken: '' }), null, 2), 'utf8')
  assert.equal(tunnelConfigChanged({ localPort: 8899, configPath: path.join(d2, 'none.json'), autoPath: autoPath, tomlPath: tomlPath }), false)

  fs.writeFileSync(autoPath, '{ 这不是 JSON', 'utf8')
  assert.equal(tunnelConfigChanged({ localPort: 8899, configPath: path.join(d2, 'none.json'), autoPath: autoPath, tomlPath: tomlPath }), false)
})

test('#1341 手写文件打底 + 云端自动文件覆盖 ⇒ 指纹按合并后的算', () => {
  const dir = tmpDir()
  const cfgPath = path.join(dir, 'tunnel.json')
  const autoPath = path.join(dir, 'tunnel.auto.json')
  const tomlPath = path.join(dir, 'frpc.toml')
  fs.writeFileSync(cfgPath, JSON.stringify({ enabled: true, type: 'http', serverAddr: '118.178.129.217', serverPort: 7000, authToken: 'TOK-MANUAL', customDomains: ['gaoshou25.cn'], locations: ['/dsh-console/' + SHORT], name: 'dsh-' + SHORT }, null, 2), 'utf8')
  const want1 = tunnelConfigDigest({ localPort: 8899, configPath: cfgPath, autoPath: path.join(dir, 'missing.json') })
  assert.notEqual(want1, '')
  fs.writeFileSync(tomlPath, want1, 'utf8')
  assert.equal(tunnelConfigChanged({ localPort: 8899, configPath: cfgPath, autoPath: path.join(dir, 'missing.json'), tomlPath: tomlPath }), false)

  fs.writeFileSync(autoPath, JSON.stringify(autoCfg({ authToken: 'TOK-FROM-CLOUD' }), null, 2), 'utf8')
  assert.equal(tunnelConfigChanged({ localPort: 8899, configPath: cfgPath, autoPath: autoPath, tomlPath: tomlPath }), true, '云端覆盖手写也要算进指纹')
  assert.ok(tomlText({ type: 'http', serverAddr: 'a', serverPort: 1, authToken: 'x', localPort: 2, proxyName: 'p', customDomains: ['d'], locations: ['/l'] }).includes('auth.token'))
})

test('#1341 token 不匹配有专门分支 + 中文 lastError', () => {
  const tm = fs.readFileSync(new URL('../tunnel.mjs', import.meta.url), 'utf8')
  assert.ok(tm.includes("token in login doesn'?t match"), 'tunnel.mjs 要认 frps 的 token 不匹配原文')
  assert.ok(tm.includes('服务器认证 token 不匹配'), '要给中文真因，别只落英文原文')
  const ix = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(ix.includes('tunnelConfigChanged({'), 'ensureTunnel 要先比配置指纹')
  assert.ok(ix.includes("try { stopTunnel() } catch (e) {") && ix.includes('return bootTunnel()'), '配置变了走 stopTunnel + bootTunnel')
  assert.ok(ix.includes("phase !== 'disabled' && st.phase !== 'error'"), '没变时照老规矩不打断好着的隧道')
})
