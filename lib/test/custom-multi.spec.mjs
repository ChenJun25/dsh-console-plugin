import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CUSTOM_PROXY_PREFIX,
  CUSTOM_PROXY_NAME,
  machineTag,
  customProxyName,
  normalizeCustom,
  writeCustomConfig,
  readCustomConfig,
  syncProxyName,
  nextPublicPort,
  publicHttpUrl,
  CUSTOM_AI_PROMPT
} from '../custom-server.mjs'
import { pickProxyName, tomlText } from '../tunnel.mjs'

const TMP = []
function tmpFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-multi-'))
  TMP.push(d)
  return path.join(d, 'custom.json')
}
after(() => {
  for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (_) {} }
})

const full = (over = {}) => Object.assign({
  on: true,
  serverAddr: '1.2.3.4',
  serverPort: 7000,
  remotePort: 9000,
  authToken: 'TK-MULTI'
}, over)

test('第1059节 代理名不再写死：同一台机器恒定、两台机器不同名', () => {
  const tag = machineTag()
  assert.match(tag, /^[0-9a-f]{6}$/, '指纹是 6 位十六进制')
  assert.equal(machineTag(), tag, '同一进程内恒定')
  assert.equal(customProxyName(9000), CUSTOM_PROXY_PREFIX + '-' + tag + '-9000')
  assert.notEqual(customProxyName(9000), customProxyName(9001), '端口不同 ⇒ 代理名不同')
  assert.ok(!customProxyName(9000).includes(CUSTOM_PROXY_NAME + '-' + tag + '-9000-'), '只有一个前缀')
})

test('第1059节 代理名非法端口时退化成 前缀+指纹（不拼出 -0 / -NaN）', () => {
  const tag = machineTag()
  for (const bad of [0, -1, NaN, null, undefined, 'abc', 70000]) {
    assert.equal(customProxyName(bad), CUSTOM_PROXY_PREFIX + '-' + tag, '非法端口 ' + String(bad))
  }
})

test('第1059节 落盘文件的 proxyName 就是本机专用名，且能穿过 pickProxyName（tcp 优先手写值）', () => {
  const p = tmpFile()
  writeCustomConfig(full(), p, () => {})
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  assert.equal(raw.proxyName, customProxyName(9000), '落盘必须带本机专用代理名')
  assert.equal(raw.type, 'tcp')
  assert.equal(pickProxyName(raw), customProxyName(9000), 'tunnel.mjs 取到的就是它')
  const toml = tomlText(Object.assign({}, raw, { localPort: 8899 }))
  assert.ok(toml.includes('name = "' + customProxyName(9000) + '"'), '生成的 frpc.toml 里名字唯一')
})

test('第1059节 两台电脑（不同指纹）生成的代理名不会撞——模拟服务端 already exists', () => {
  const pA = tmpFile()
  const pB = tmpFile()
  writeCustomConfig(full({ remotePort: 9000 }), pA, () => {})
  writeCustomConfig(full({ remotePort: 9001 }), pB, () => {})
  const a = JSON.parse(fs.readFileSync(pA, 'utf8')).proxyName
  const b = JSON.parse(fs.readFileSync(pB, 'utf8')).proxyName
  assert.equal(a, b.replace(/9001$/, '9000'), '只差端口这一段：同机同指纹')
  assert.notEqual(a, b, '端口不同 ⇒ 名字不同')

  const other = CUSTOM_PROXY_PREFIX + '-ffffff-9000'
  assert.notEqual(machineTag(), 'ffffff', '本机指纹不该撞到测试用的假指纹')
  assert.notEqual(other, a, '不同机器即便同端口也不同名（这才是 already exists 的根治点）')
})

test('第1059节 老配置惰性迁移：写死的旧代理名被就地刷掉', () => {
  const p = tmpFile()
  fs.writeFileSync(p, JSON.stringify({
    enabled: true, on: true, type: 'tcp',
    proxyName: 'dsh-console-custom',
    serverAddr: '1.2.3.4', serverPort: 7000, authToken: 'TK-OLD', remotePort: 9000
  }), 'utf8')
  const logs = []
  assert.equal(syncProxyName(p, (m) => logs.push(m)), true, '要真改写')
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  assert.equal(raw.proxyName, customProxyName(9000), '刷成本机专用名')
  assert.equal(raw.serverAddr, '1.2.3.4', '其它字段一个字都不许动')
  assert.equal(raw.authToken, 'TK-OLD')
  assert.ok(logs.join('').includes('代理名迁移'), '要留日志')
  assert.equal(syncProxyName(p, () => {}), false, '已经是最新 ⇒ 不再重复写盘')
})

test('第1059节 没配置 / 文件坏了 ⇒ 迁移安静跳过，不抛也不建文件', () => {
  const p = tmpFile()
  assert.equal(syncProxyName(p, () => {}), false, '文件不存在')
  assert.equal(fs.existsSync(p), false, '不许凭空造文件')
  fs.writeFileSync(p, '{坏 json', 'utf8')
  assert.equal(syncProxyName(p, () => {}), false, '坏 json 静默跳过')
})

test('第1059节 autoShiftedFrom 落盘 → 读盘闭环（面板要靠它提示新端口）', () => {
  const p = tmpFile()
  const saved = writeCustomConfig(full({ remotePort: 9001, autoShiftedFrom: 9000 }), p, () => {})
  assert.equal(saved.autoShiftedFrom, 9000)
  const back = readCustomConfig(p, () => {})
  assert.equal(back.ok, true)
  assert.equal(back.cfg.remotePort, 9001)
  assert.equal(back.cfg.autoShiftedFrom, 9000, '读回来还得是 9000，否则面板不提示')
  assert.equal(publicHttpUrl(back.cfg), 'http://1.2.3.4:9001', '手机上该填的就是这个地址')
})

test('第1059节 autoShiftedFrom 非法值一律归 0（不许把脏数据当避让）', () => {
  for (const bad of [-5, 0, 'x', NaN, 99999, null]) {
    const c = normalizeCustom({ on: true, serverAddr: '1.2.3.4', remotePort: 9001, autoShiftedFrom: bad })
    assert.equal(c.autoShiftedFrom, 0, '非法值 ' + String(bad))
  }
  const ok1 = normalizeCustom({ autoShiftedFrom: 9000 })
  assert.equal(ok1.autoShiftedFrom, 9000)
})

test('第1059节 AI 口令里必须写明「多台电脑各用各的公网端口」', () => {
  assert.ok(CUSTOM_AI_PROMPT.includes('公网端口'), '口令带端口项')
})

test('第1059节 nextPublicPort：+1 递增，越界/非法一律返回 0（不挪到 65536）', () => {
  assert.equal(nextPublicPort(9000, 1), 9001)
  assert.equal(nextPublicPort(65534, 1), 65535)
  assert.equal(nextPublicPort(65535, 1), 0, '顶到 65535 就没得挪了')
  for (const bad of [0, -1, NaN, null, undefined, 'x']) {
    assert.equal(nextPublicPort(bad, 1), 0, '非法 from=' + String(bad))
  }
  assert.equal(nextPublicPort(9000, 0), 9001, 'step 非法按 1 算')
  assert.equal(nextPublicPort(9000, 65535), 0, 'step 太大直接越界')
})
