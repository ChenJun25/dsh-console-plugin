import test from 'node:test'
import assert from 'node:assert/strict'
import { startLanServer } from '../lan-server.mjs'

const TOKEN = 'P'.repeat(64)
let portSeq = 0
const nextPort = () => 21801 + (portSeq++ * 2)

const OLD_SID = 'SBWVYUAQLNT4A77'
const NEW_SID = 'RRJE5VDF3D7VWEN'
const OLD_URL = 'https://gaoshou25.cn/dsh-console/' + OLD_SID
const NEW_URL = 'https://gaoshou25.cn/dsh-console/' + NEW_SID

const tunnelUp = (publicUrl) => () => ({ enabled: true, ready: true, phase: 'connected',
  lastError: '', serverAddr: '203.0.113.10', remotePort: 8899, since: 1234, publicUrl })

const cloudWithSid = (tunnelSid, over = {}) => ({
  snapshot: () => Object.assign({ ok: true, nodeId: 'n', shortId: NEW_SID, tunnelSid,
    vipExpireMs: Date.now() + 3600 * 1000, online: true, offline: false, lastSeenMs: 0, bound: null }, over),
})

async function serve(over = {}) {
  const o = Object.assign({
    port: nextPort(),
    allowShift: true,
    log: () => {},
    getToken: () => TOKEN,
    getInfo: () => ({ name: '云上电脑', nodeId: 'dsh-console', host: 'host-1', dshOk: true,
      dshError: '', version: '9.9.9' }),
    listSessions: async () => [],
    runCommand: async () => ({ ok: true }),
    cloud: null,
  }, over)
  const srv = startLanServer(o)
  const started = await srv.start()
  assert.ok(started, '临时 lan-server 必须起得来（端口段 21801+）')
  const base = 'http://127.0.0.1:' + started.port
  return {
    srv, base,
    info: async () => {
      const r = await fetch(base + '/dsh-console/info?token=' + TOKEN)
      assert.equal(r.status, 200)
      return r.json()
    },
    close: () => srv.stop(),
  }
}

test('a 老号 + 云端给新 tunnelSid ⇒ 面板/Info 的公网入口一律改成新号', async () => {
  const s = await serve({ tunnelStatus: tunnelUp(OLD_URL), cloud: cloudWithSid(NEW_SID) })
  try {
    const p = await s.srv.panelData(false)
    assert.equal(p.tunnel.publicUrl, NEW_URL, '面板 tunnel.publicUrl 必须向云端 tunnelSid 看齐')
    assert.deepEqual(p.publicUrls, [NEW_URL], 'panelData.publicUrls 同口径')
    assert.equal(p.cloud, NEW_URL, 'panelData.cloud（喂给配对载荷的 c=）也要是同一个地址')

    const j = await s.info()
    assert.equal(j.tunnel.publicUrl, NEW_URL, '/info 的 tunnel.publicUrl 同口径')
    assert.deepEqual(j.publicUrls, [NEW_URL], '/info 的 publicUrls 是手机落表用的，必须是能连的那条')
  } finally { await s.close() }
})

test('b 上报云端的配对码 publicUrl 也用新号（老号会让手机 404）', async () => {
  const calls = []
  const cloud = Object.assign(cloudWithSid(NEW_SID), {
    publishPairCode: (code, publicUrl, ttlMs) => { calls.push({ code, publicUrl, ttlMs }); return Promise.resolve({ ok: true }) },
  })
  const s = await serve({ tunnelStatus: tunnelUp(OLD_URL), cloud, getRemotePair: () => true })
  try {
    const d = await s.srv.panelData(false)
    assert.match(String(d.remotePairCode || ''), /^[0-9]{6}$/, '前提：异地配对码已生成')
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(calls.length >= 1, true, '必须上报过配对码')
    assert.equal(calls[0].publicUrl, NEW_URL, '配对码带着老号上云 ⇒ 手机拿到必 404，必须改成新号')
  } finally { await s.close() }
})

test('c 云端短号本来就是同一个 ⇒ 原样透传（不给自己加戏）', async () => {
  const s = await serve({ tunnelStatus: tunnelUp(NEW_URL), cloud: cloudWithSid(NEW_SID) })
  try {
    const p = await s.srv.panelData(false)
    assert.equal(p.tunnel.publicUrl, NEW_URL)
    assert.deepEqual(p.publicUrls, [NEW_URL])
  } finally { await s.close() }
})

test('d URL 里没有 15 位短号段（自定义域名/测试桩）⇒ 一个字节都不改', async () => {
  for (const u of ['https://console.example.test/dsh-console', 'https://mybox.example.com/', 'http://10.0.0.5:8899']) {
    const s = await serve({ tunnelStatus: tunnelUp(u), cloud: cloudWithSid(NEW_SID) })
    try {
      const p = await s.srv.panelData(false)
      assert.equal(p.tunnel.publicUrl, u, '没有短号段就绝不瞎拼：' + u)
      assert.deepEqual(p.publicUrls, [u])
    } finally { await s.close() }
  }
})

test('e 云端没号 / cloud 为 null / snapshot 抛错 ⇒ 原样透传（老插件与断网都不受影响）', async () => {
  const cases = [
    null,
    cloudWithSid(''),
    cloudWithSid('abc'),
    { snapshot: () => ({ ok: true, shortId: NEW_SID }) },
    { snapshot: () => { throw new Error('云端炸了') } },
  ]
  for (const cloud of cases) {
    const s = await serve({ tunnelStatus: tunnelUp(OLD_URL), cloud })
    try {
      const p = await s.srv.panelData(false)
      assert.equal(p.tunnel.publicUrl, OLD_URL, '拿不到可信 tunnelSid 时保持原样（不许瞎改）')
      assert.deepEqual(p.publicUrls, [OLD_URL])
    } finally { await s.close() }
  }
})

test('f 隧道没就绪 ⇒ publicUrls 仍必须是空数组（改写层不许把空变成有）', async () => {
  const s = await serve({
    tunnelStatus: () => ({ enabled: false, ready: false, phase: 'disabled', lastError: '',
      serverAddr: '', remotePort: 0, since: 0, publicUrl: OLD_URL }),
    cloud: cloudWithSid(NEW_SID),
  })
  try {
    const p = await s.srv.panelData(false)
    assert.deepEqual(p.publicUrls, [], '没连上就没有公网入口')
    const j = await s.info()
    assert.deepEqual(j.publicUrls, [])
  } finally { await s.close() }
})
