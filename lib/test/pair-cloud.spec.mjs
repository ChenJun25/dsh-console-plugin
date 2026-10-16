/**
 * task-11 单测（插件半 · #A3）：二维码与 /claim 下发公网候选（新键 c=）。
 *
 * 用户原话（paraphrase）：手机在外网/蜂窝时首页「未识别到绑定的设备」——**马上先修这个重大bug**。
 *
 * 根因链（App 侧 LanClient.ets）：
 *   adoptPublicUrlsFromInfo() ← refreshEndpoint() 30s 节流，fire-and-forget；
 *   而它内部 heartbeat() 打的是**当前节点 base**（二维码下发的 b= 恒为局域网地址）
 *   ⇒ 手机在蜂窝网时必失败 ⇒ 公网候选永远进不了节点表
 *   ⇒ 一断 WiFi，pickActiveBase 落 offline ⇒ 首页报「未识别到绑定的设备」。
 *
 * 修法：让**配对握手那一次**就把公网候选带回去（那是手机在没有任何可用节点时
 * 唯一能成功的通路）。三处同一个 cloud 变量喂出去，保证同源：
 *   lan-server.mjs  pairPayload({...,cloud})  ⇒ 二维码/载荷新键 c=
 *                   panelData() out.cloud      ⇒ 面板自己也能看到同一串
 *                   /claim 成功分支 200 {c}     ⇒ App 拿到公网候选
 *
 * 🔴 兼容性红线（本文件逐一钉死）：
 *   - cloud 为空/未传 ⇒ 载荷**一个字节都不加**，与改动前逐字一致（老客户端
 *     用正则逐键取 b/t/n，未知键安全忽略；老 App 同理）。
 *   - publicUrls 字段语义一个字不改（隧道没就绪仍是 []）。
 *   - /claim 失败分支（400 非 6 位 / 403 码错或过期）**绝不许**带 c 键。
 *   - pickBase / ports / PUB_BLOCKED / CLOUD_GATED / 鉴权 token 逻辑本任务一律不碰。
 *
 * 跑法：node lib/test/pair-cloud.spec.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startLanServer, pairPayload } from '../lan-server.mjs'

/* ⚠️ 端口段与其它 spec 错开（node --test 并行跑各文件）：
   18901 preset-info / 19101 device-roster+sec-gate / 19501 cloud-link+host-isolation /
   19601 vip-gate / 19701 device-revoke / 19901 device-revoke-blacklist /
   20901 device-persist / 21101 revoke-uid ⇒ 本文件用 21301 起。 */
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
    /* 🔴 force-exit 收尾红线（本 spec 独有）：fetch 走 undici 连接池，srv.stop()
       只关掉监听 socket，池里那条连接的 FIN/收尾事件还挂在事件循环里。下一个
       用例再起服务时两边撞上，node --test --test-force-exit 在进程退出时踩到
       libuv 已关闭的 async 句柄 ⇒
         Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
       ⇒ 整个文件级 fail 1（用例内部其实全 pass）。
       实测（3 用例 × 起服务 + fetch + stop 的最小复现）：不等待必崩；
       setImmediate / setTimeout 0 不够；≥3ms 连续 20 次全过；本文件取 30ms。
       别改成 Connection: close 了事——实测那样也崩。 */
    close: async () => { srv.stop(); await new Promise((r) => setTimeout(r, 30)) },
  }
}
/* 从载荷里逐键取值（不依赖 URL 类解析 dsh-console:// 这种自定义协议） */
const keysOf = (payload) => {
  const q = payload.slice('dsh-console://pair?'.length)
  const out = {}
  for (const kv of q.split('&')) { const i = kv.indexOf('='); out[kv.slice(0, i)] = kv.slice(i + 1) }
  return out
}

/* ============================================================
 * ① pairPayload 三态（纯函数层）：无 cloud / 空串 ⇒ 逐字不变；有 cloud ⇒ 新键 c=
 * ============================================================ */
test('task-11 ① pairPayload：不传 cloud / 传空串 ⇒ 载荷一个字节都不加（键序 b/k/n/i/v）', () => {
  /* 🔴 task-19：token 换成 ticket（载荷里不再有 t= 长期访问码），其余键与键序不变。 */
  const noCloud = pairPayload({ base: 'http://192.168.1.5:8899/dsh-console', ticket: ' pt_TOK ',
    name: '我的电脑', node: 'dsh-console' })
  const emptyCloud = pairPayload({ base: 'http://192.168.1.5:8899/dsh-console', ticket: ' pt_TOK ',
    name: '我的电脑', node: 'dsh-console', cloud: '' })
  /* 键集合与键序都必须是 b/k/n/i/v —— 多一个键就是破坏旧客户端 */
  const k = keysOf(noCloud)
  assert.deepEqual(Object.keys(k), ['b', 'k', 'n', 'i', 'v'], '载荷键序必须是 b/k/n/i/v')
  assert.equal(noCloud.includes('c='), false, '不传 cloud ⇒ 绝不许出现 c=')
  assert.equal(emptyCloud.includes('c='), false, 'cloud 空串 ⇒ 绝不许出现 c=')
  assert.equal(/[?&]t=/.test(noCloud), false, 'task-19 红线：载荷里绝不许再出现 t= 长期访问码')
  /* 逐字一致：去掉动态 v= 之后两串必须完全相同 */
  const strip = (s) => s.replace(/&v=[^&]*$/, '')
  assert.equal(strip(emptyCloud), strip(noCloud), '空串与不传必须完全同形')
  assert.equal(strip(noCloud),
    'dsh-console://pair?b=' + encodeURIComponent('http://192.168.1.5:8899/dsh-console') +
    '&k=' + encodeURIComponent(' pt_TOK ') + '&n=' + encodeURIComponent('我的电脑') + '&i=dsh-console',
    '第194节红线（键序与逐字格式）在 task-19 后依旧成立')
  assert.equal(k.b, encodeURIComponent('http://192.168.1.5:8899/dsh-console'))
  console.log('   [证据] 无 c= 载荷 = ' + noCloud)
})

test('task-11 ①-b pairPayload：传 cloud ⇒ 多一个 c=（逗号整串编码），b/t/n/i/v 一个不动', () => {
  const p = pairPayload({ base: 'http://192.168.1.5:8899/dsh-console', ticket: 'pt_TOK',
    name: '我的电脑', node: 'dsh-console', cloud: PUBLIC_URL + ',https://b.example.test/x' })
  const k = keysOf(p)
  /* c 是 task-11 新增的键；v 仍是那次调用的 nonce。键序不敏感（消费端正则逐键取），
     所以这里只钉「键集合 = b/k/n/i/v + c，一个不多一个不少」（task-19 把 t 换成 k）。 */
  assert.deepEqual(Object.keys(k).sort(), ['b', 'c', 'i', 'k', 'n', 'v'], '只许多出 c 一个键')
  assert.equal(Object.keys(k).filter((x) => x === 'c').length, 1, 'c 键只能出现一次')
  assert.equal(decodeURIComponent(k.c), PUBLIC_URL + ',https://b.example.test/x', 'c= 值原样还原')
  assert.equal(k.c, encodeURIComponent(PUBLIC_URL + ',https://b.example.test/x'), '逗号也要整体编码（不能裸逗号）')
  assert.equal(k.b, encodeURIComponent('http://192.168.1.5:8899/dsh-console'), 'b= 不受影响')
  assert.equal(k.k, 'pt_TOK'); assert.equal(k.i, 'dsh-console')
  console.log('   [证据] 带 c= 载荷 = ' + p)
})

/* ============================================================
 * ② 隧道就绪：panelData / 二维码载荷 / /claim 三处同源
 * ============================================================ */
test('task-11 ② 隧道就绪 ⇒ panelData.cloud、载荷 c=、/claim 的 c 三处逐字同源', async () => {
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
    assert.equal(r.json.c, PUBLIC_URL, '/claim 成功分支必须把同一串公网候选带回给手机（本任务主修点）')
    assert.equal(r.json.token, 'TOK')
    assert.equal(r.json.base, p.base, 'base 口径不变')
    console.log('   [证据] p.cloud=' + p.cloud + ' claim.c=' + r.json.c)
  } finally { await s.close() }
})

/* ============================================================
 * ③ 隧道没就绪：cloud 空串、载荷无 c=、/claim 的 c 是空串（不是缺键）
 * ============================================================ */
test('task-11 ③ 没隧道 ⇒ cloud 空串、载荷无 c=、/claim 的 c 是空串', async () => {
  const s = await serve()                    // 不传 tunnelStatus = 老插件 / 没配隧道
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

/* ============================================================
 * ④ 失败分支绝不许带 c（400 非 6 位 / 403 码错或过期）
 * ============================================================ */
test('task-11 ④ /claim 失败分支（400 / 403）一个字节都不动，绝不许带 c 键', async () => {
  const s = await serve({ tunnelStatus: tunnelUp })   // 隧道**就绪**也不许漏
  try {
    const p = await s.srv.panelData(false)
    const wrong = String(Number(p.code) === 111111 ? 222222 : 111111).padStart(6, '0')
    const bad = await s.claim(wrong)
    assert.equal(bad.status, 403, '错码必须 403')
    assert.deepEqual(bad.json, { ok: false, error: '配对码不对或已过期' }, '403 响应体逐字不变')
    const short = await s.claim('12')
    assert.equal(short.status, 400, '非 6 位必须 400')
    assert.deepEqual(short.json, { ok: false, error: '配对码是 6 位数字' }, '400 响应体逐字不变')
    console.log('   [证据] 403=' + JSON.stringify(bad.json) + ' 400=' + JSON.stringify(short.json))
  } finally { await s.close() }
})
