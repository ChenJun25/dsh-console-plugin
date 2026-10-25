import test from 'node:test'
import assert from 'node:assert/strict'
import { startLanServer, pairPayload } from '../lan-server.mjs'

let liveSeq = 0
const PUBLIC_URL = 'https://console.example.test/dsh-console'
const tunnelUp = () => ({ enabled: true, ready: true, phase: 'connected', lastError: '',
  serverAddr: '203.0.113.10', remotePort: 8899, since: 1234, publicUrl: PUBLIC_URL })

async function serve(over = {}) {
  const srv = startLanServer(Object.assign({
    port: 21301 + (liveSeq++ * 2),
    allowShift: true,
    log: () => {},
    getToken: () => 'TOK',
    getInfo: () => ({ name: '我的电脑', nodeId: 'dsh-console', host: 'host-1', dshOk: true,
      dshError: '', version: '9.9.9', agentPreset: 'ptc', agentPresetAvailable: true }),
    listSessions: async () => [],
    runCommand: async () => ({ ok: true }),
    cloud: null,
  }, over))
  const started = await srv.start()
  assert.ok(started, '临时 lan-server 必须起得来（端口段 21301+）')
  const base = 'http://127.0.0.1:' + started.port
  return {
    srv,
    base,
    claim: async (code) => {
      const r = await fetch(base + '/claim', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code })
      })
      return { status: r.status, json: await r.json() }
    },

    close: async () => { srv.stop(); await new Promise((r) => setTimeout(r, 30)) },
  }
}

const keysOf = (payload) => {
  const q = payload.slice('dsh-console://pair?'.length)
  const out = {}
  for (const kv of q.split('&')) { const i = kv.indexOf('='); out[kv.slice(0, i)] = kv.slice(i + 1) }
  return out
}

test('① pairPayload：不传 cloud / 传空串 ⇒ 载荷一个字节都不加（键序 b/k/n/i/v）', () => {

  const noCloud = pairPayload({ base: 'http://192.168.1.5:8899/dsh-console', ticket: ' pt_TOK ',
    name: '我的电脑', node: 'dsh-console' })
  const emptyCloud = pairPayload({ base: 'http://192.168.1.5:8899/dsh-console', ticket: ' pt_TOK ',
    name: '我的电脑', node: 'dsh-console', cloud: '' })

  const k = keysOf(noCloud)
  assert.deepEqual(Object.keys(k), ['b', 'k', 'n', 'i', 'v'], '载荷键序必须是 b/k/n/i/v')
  assert.equal(noCloud.includes('c='), false, '不传 cloud ⇒ 绝不许出现 c=')
  assert.equal(emptyCloud.includes('c='), false, 'cloud 空串 ⇒ 绝不许出现 c=')
  assert.equal(/[?&]t=/.test(noCloud), false, '红线：载荷里绝不许再出现 t= 长期访问码')

  const strip = (s) => s.replace(/&v=[^&]*$/, '')
  assert.equal(strip(emptyCloud), strip(noCloud), '空串与不传必须完全同形')
  assert.equal(strip(noCloud),
    'dsh-console://pair?b=' + encodeURIComponent('http://192.168.1.5:8899/dsh-console') +
    '&k=' + encodeURIComponent(' pt_TOK ') + '&n=' + encodeURIComponent('我的电脑') + '&i=dsh-console',
    '（键序与逐字格式）依旧成立')
  assert.equal(k.b, encodeURIComponent('http://192.168.1.5:8899/dsh-console'))
  console.log('   [证据] 无 c= 载荷 = ' + noCloud)
})

test('①-b pairPayload：传 cloud ⇒ 多一个 c=（逗号整串编码），b/t/n/i/v 一个不动', () => {
  const p = pairPayload({ base: 'http://192.168.1.5:8899/dsh-console', ticket: 'pt_TOK',
    name: '我的电脑', node: 'dsh-console', cloud: PUBLIC_URL + ',https://b.example.test/x' })
  const k = keysOf(p)

  assert.deepEqual(Object.keys(k).sort(), ['b', 'c', 'i', 'k', 'n', 'v'], '只许多出 c 一个键')
  assert.equal(Object.keys(k).filter((x) => x === 'c').length, 1, 'c 键只能出现一次')
  assert.equal(decodeURIComponent(k.c), PUBLIC_URL + ',https://b.example.test/x', 'c= 值原样还原')
  assert.equal(k.c, encodeURIComponent(PUBLIC_URL + ',https://b.example.test/x'), '逗号也要整体编码（不能裸逗号）')
  assert.equal(k.b, encodeURIComponent('http://192.168.1.5:8899/dsh-console'), 'b= 不受影响')
  assert.equal(k.k, 'pt_TOK'); assert.equal(k.i, 'dsh-console')
  console.log('   [证据] 带 c= 载荷 = ' + p)
})

test('② 隧道就绪 ⇒ panelData.cloud、载荷 c=、/claim 的 c 三处逐字同源', async () => {
  const s = await serve({ tunnelStatus: tunnelUp })
  try {
    const p = await s.srv.panelData(true)
    assert.equal(p.cloud, PUBLIC_URL, 'panelData 必须新增 cloud = publicUrls.join(,)')
    assert.deepEqual(p.publicUrls, [PUBLIC_URL], '既有 publicUrls 语义不动（仍是 [publicUrl]）')
    const k = keysOf(p.payload)
    assert.equal(decodeURIComponent(k.c || ''), p.cloud, '二维码载荷 c= 必须与 panelData.cloud 同源')
    assert.equal(typeof p.qrDataUrl, 'string', '二维码照旧生成（没把页面打坏）')
    assert.equal(p.qrDataUrl.startsWith('data:image/'), true)

    const r = await s.claim(p.code)
    assert.equal(r.status, 200, '对码必须 200')
    assert.equal(r.json.c, PUBLIC_URL, '/claim 成功分支必须把同一串公网候选带回给手机（本任务）')
    assert.equal(r.json.token, 'TOK')
    assert.equal(r.json.base, p.base, 'base 口径不变')
    console.log('   [证据] p.cloud=' + p.cloud + ' claim.c=' + r.json.c)
  } finally { await s.close() }
})

test('③ 没隧道 ⇒ cloud 空串、载荷无 c=、/claim 的 c 是空串', async () => {
  const s = await serve()
  try {
    const p = await s.srv.panelData(false)
    assert.equal(p.cloud, '', '没隧道时 cloud 必须是空串')
    assert.deepEqual(p.publicUrls, [], 'publicUrls 仍是 []（老断言语义不变）')
    assert.equal(p.payload.includes('c='), false, '没隧道 ⇒ 载荷绝不许有 c=（与改动前逐字一致）')
    const r = await s.claim(p.code)
    assert.equal(r.status, 200)
    assert.equal(Object.prototype.hasOwnProperty.call(r.json, 'c'), true, '/claim 成功分支必须有 c 键（空串=没有）')
    assert.equal(r.json.c, '', '没隧道 ⇒ c 是空串，App 侧据此不落表')
    console.log('   [证据] 没隧道 claim.c=' + JSON.stringify(r.json.c) + ' 载荷含 c= ' + p.payload.includes('c='))
  } finally { await s.close() }
})

test('④ /claim 失败分支（400 / 403）一个字节都不动，绝不许带 c 键', async () => {
  const s = await serve({ tunnelStatus: tunnelUp })
  try {
    const p = await s.srv.panelData(false)
    const wrong = String(Number(p.code) === 111111 ? 222222 : 111111).padStart(6, '0')
    const bad = await s.claim(wrong)
    assert.equal(bad.status, 403, '错码必须 403')

    assert.equal(bad.json.error, '配对码不对或已过期', '403 文案逐字不变')
    assert.equal(bad.json.ok, false)
    assert.equal(bad.json.reason, 'code-mismatch', '新增的 reason 码')
    assert.equal(Object.prototype.hasOwnProperty.call(bad.json, 'c'), false, '失败分支绝不许带 c 键')
    const short = await s.claim('12')
    assert.equal(short.status, 400, '非 6 位必须 400')
    assert.equal(short.json.error, '配对码是 6 位数字', '400 文案逐字不变')
    assert.equal(short.json.reason, 'bad-format', '新增的 reason 码')
    assert.equal(Object.prototype.hasOwnProperty.call(short.json, 'c'), false, '失败分支绝不许带 c 键')
    console.log('   [证据] 403=' + JSON.stringify(bad.json) + ' 400=' + JSON.stringify(short.json))
  } finally { await s.close() }
})
