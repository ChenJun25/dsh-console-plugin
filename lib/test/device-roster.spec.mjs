/**
 * task-6 单测（插件半 · #A3）：面板多设备在线名单。
 *
 * 用户原话（交接文档 209-217，paraphrase）：面板要能看到"多台手机连着这台电脑、
 * 每台是什么机型、哪台在线、哪台掉线了"。根因是插件侧**机型数据为零** ——
 * devices 表根本不存在，面板只能靠一个 phoneLastSeen 布尔猜。
 *
 * 落点（都已落盘）：
 *   mp-support.mjs  createDeviceStore() 记 { deviceId, model, name, pairedAt, lastSeen }
 *                   + touch(secret, about) 续期 + list() 只读名单（**绝不含 secret**）
 *   mp-routes.mjs   accept 时 aboutOf(req, body)（自报 deviceModel/Name 优先，兜底 UA 抽机型）
 *                   gate() 里给已配对设备 touch（未配对的请求不许污染登记表）
 *   lan-server.mjs  deviceRoster() + rosterCounts() + panelData / INFO 两条通道都带
 *                   devices/deviceCount/onlineCount + /info /mp-cookie /sessions /attachment
 *                   四处 noteDevice(req)
 *
 * 两条通道分开验，别混：
 *   - devices 在 panelData（宿主面板 /api/dsh-console/state）**和** LAN /info
 *     （手机端直连 8899，task-8/#A3 前半新增）都有，两处口径必须一致（同一个 rosterCounts()）。
 *   - phoneLastSeen / phoneOnline 语义一个字没改（老客户端与既有单测都读它）。
 *   - /info 仍是 safeInfo() 白名单的扩展，**绝不许**冒出 token / secret / cookie 之类鉴权料。
 *
 * 跑法：node lib/test/device-roster.spec.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startLanServer } from '../lan-server.mjs'

/* ⚠️ 端口段必须和 preset-info.spec.mjs（18901 起）错开：node --test 默认
   并行跑各 spec 文件，两文件同段会互抢端口 ⇒ 偶发 EADDRINUSE 失败。 */
let portSeq = 0
const nextPort = () => 19101 + (portSeq++ * 2)

/** 假设备登记表：形状与 mp-support.mjs 的 createDeviceStore().list() 逐字对齐。 */
function fakeStore(over = {}) {
  const touched = []
  return {
    touched,
    touch: (secret, about) => { touched.push({ secret, about }); return true },
    list: () => [
      { deviceId: 'mp-aaa', model: 'HUAWEI Mate 60 Pro', name: '我的手机',
        pairedAt: 1000, lastSeen: 2000, online: true },
      { deviceId: 'mp-bbb', model: '', name: '', pairedAt: 900, lastSeen: 800, online: false },
    ],
    ...over,
  }
}

/** 起一个真 lan-server（照 preset-info.spec.mjs：高位端口 + allowShift，port:0 会落回 8899 被占）。 */
async function serve(over = {}) {
  const o = Object.assign({
    port: nextPort(),
    allowShift: true,
    log: () => {},
    getToken: () => 'TOK',
    getInfo: () => ({ name: '我的电脑', nodeId: 'dsh-console', host: 'host-1', dshOk: true,
      dshError: '', version: '9.9.9', agentPreset: 'ptc', agentPresetAvailable: true }),
    listSessions: async () => [],
    runCommand: async () => ({ ok: true }),
  }, over)
  const srv = startLanServer(o)
  const started = await srv.start()
  assert.ok(started, 'lan server 必须起得来')
  return { srv, base: 'http://127.0.0.1:' + started.port, close: () => srv.stop() }
}

const infoOf = async (base, headers = {}) => {
  const r = await fetch(base + '/dsh-console/info', Object.assign(
    { headers: Object.assign({ 'x-dsh-console-token': 'TOK' }, headers) }))
  assert.equal(r.status, 200)
  return r.json()
}

/* ---------------- ① panelData 的名单 ---------------- */

test('#A3 panelData 带上 devices / deviceCount / onlineCount（机型与在线状态）', async () => {
  const s = await serve()
  s.srv.setMp({ store: fakeStore() })
  const j = await s.srv.panelData(false)
  assert.equal(j.ok, true)
  assert.equal(Array.isArray(j.devices), true, 'devices 必须是数组')
  assert.equal(j.deviceCount, 2)
  assert.equal(j.onlineCount, 1, '只有 online:true 的那条算在线')
  assert.equal(j.devices[0].model, 'HUAWEI Mate 60 Pro', '机型要下发到面板')
  assert.equal(j.devices[0].deviceId, 'mp-aaa')
  assert.equal(typeof j.devices[0].lastSeen, 'number', 'lastSeen 给客户端算「几分钟前」')
  assert.equal(j.devices[1].online, false, '掉线设备也在名单里（要显示为未连接）')
  // 绝不许把 Cookie 密文漏给面板
  assert.equal(Object.prototype.hasOwnProperty.call(j.devices[0], 'secret'), false)
  assert.ok(JSON.stringify(j).indexOf('goodsecret') < 0, '整个面板载荷里没有设备密文')
  s.close()
})

test('#A3 老插件（没有 store.list）⇒ 空名单 + 计数 0，不报错', async () => {
  {
    const s = await serve()
    const j = await s.srv.panelData(false)
    assert.deepEqual(j.devices, [], '没 setMp 时给空数组，不是 undefined')
    assert.equal(j.deviceCount, 0)
    assert.equal(j.onlineCount, 0)
    s.close()
  }
  {
    const s = await serve()
    s.srv.setMp({ store: { touch: () => true } })   // 有 touch 没 list（半升级状态）
    const j = await s.srv.panelData(false)
    assert.deepEqual(j.devices, [])
    s.close()
  }
})

test('#A3 store.list() 抛错 ⇒ 空名单，不许把面板打成 500', async () => {
  const s = await serve()
  s.srv.setMp({ store: { list: () => { throw new Error('登记表炸了') } } })
  const j = await s.srv.panelData(false)
  assert.equal(j.ok, true)
  assert.deepEqual(j.devices, [])
  assert.equal(j.deviceCount, 0)
  s.close()
})

test('#A3 store.list() 返回非数组 ⇒ 当空名单（形状防御）', async () => {
  const s = await serve()
  s.srv.setMp({ store: { list: () => 'garbage' } })
  const j = await s.srv.panelData(false)
  assert.deepEqual(j.devices, [])
  s.close()
})

/* ---------------- ② 白名单不许被撑破 ---------------- */

test('#A3（task-8）/info 也下发设备名单：字段与 panelData 完全同口径', async () => {
  const s = await serve()
  s.srv.setMp({ store: fakeStore() })
  const j = await infoOf(s.base)
  assert.equal(Array.isArray(j.devices), true, '/info 必须带 devices 数组（手机端靠它显示名单）')
  assert.equal(j.deviceCount, 2)
  assert.equal(j.onlineCount, 1, '只有 online:true 的那条算在线')
  assert.equal(j.devices[0].model, 'HUAWEI Mate 60 Pro', '机型要能下发到手机端')
  assert.equal(j.devices[0].deviceId, 'mp-aaa')
  assert.equal(typeof j.devices[0].lastSeen, 'number')
  assert.equal(j.devices[1].online, false, '掉线设备也在名单里（显示为未连接）')
  /* 口径一致：同一次进程里 /info 与 panelData 的名单必须一模一样 */
  const p = await s.srv.panelData(false)
  assert.deepEqual(j.devices, p.devices, '/info 与 panelData 的名单必须同口径')
  assert.equal(j.deviceCount, p.deviceCount)
  assert.equal(j.onlineCount, p.onlineCount)
  s.close()
})

test('#A3（task-8）/info 仍然是白名单：token / secret / cookie 一个字都不许漏', async () => {
  const s = await serve()
  s.srv.setMp({ store: fakeStore() })
  const j = await infoOf(s.base, { Cookie: 'mp_device=goodsecret' })
  for (const k of ['token', 'secret', 'cookie', 'payload', 'qrDataUrl']) {
    assert.equal(Object.prototype.hasOwnProperty.call(j, k), false, '/info 不许下发 ' + k)
  }
  assert.equal(j.ok, true, '原有 ok 结构不变')
  for (const k of ['name', 'nodeId', 'host', 'dshOk', 'version', 'ports', 'agentPreset',
                   'agentPresetAvailable']) {
    assert.equal(Object.prototype.hasOwnProperty.call(j, k), true, 'safeInfo 老字段 ' + k + ' 不许丢')
  }
  const raw = JSON.stringify(j)
  assert.equal(raw.indexOf('goodsecret'), -1, '整个 /info 响应里没有设备密文')
  assert.equal(raw.indexOf('TOK'), -1, '整个 /info 响应里没有访问码')
  s.close()
})

test('#A3（task-8）老插件（没有 store.list）⇒ /info 回空名单 + 计数 0，不报错不 500', async () => {
  {
    const s = await serve()
    const j = await infoOf(s.base)
    assert.deepEqual(j.devices, [], '没 setMp 时给空数组，不是 undefined')
    assert.equal(j.deviceCount, 0)
    assert.equal(j.onlineCount, 0)
    s.close()
  }
  {
    const s = await serve()
    s.srv.setMp({ store: { touch: () => true } })   // 有 touch 没 list（半升级状态）
    const j = await infoOf(s.base)
    assert.deepEqual(j.devices, [])
    assert.equal(j.deviceCount, 0)
    s.close()
  }
  {
    const s = await serve()
    s.srv.setMp({ store: { list: () => { throw new Error('登记表炸了') } } })
    const j = await infoOf(s.base)
    assert.equal(j.ok, true)
    assert.deepEqual(j.devices, [])
    assert.equal(j.deviceCount, 0)
    s.close()
  }
  {
    const s = await serve()
    s.srv.setMp({ store: { list: () => 'garbage' } })   // 形状防御
    const j = await infoOf(s.base)
    assert.deepEqual(j.devices, [])
    s.close()
  }
})

test('#A3 phoneLastSeen / phoneOnline 语义不变（老客户端依赖）', async () => {
  const s = await serve()
  s.srv.setMp({ store: fakeStore() })
  const before = await s.srv.panelData(false)
  assert.equal(before.phoneLastSeen, 0, '还没人访问过 ⇒ 0')
  assert.equal(before.phoneOnline, false)
  await infoOf(s.base)   // 打一次 /info ⇒ phoneLastSeen 被刷新
  assert.ok(s.srv.getPhoneLastSeen() > 0, '/info 仍然刷新 phoneLastSeen（老行为）')
  const after = await s.srv.panelData(false)
  assert.equal(after.phoneOnline, true, 'TTL 内视为在线')
  s.close()
})

/* ---------------- ③ noteDevice：谁来访问就把谁续期 ---------------- */

test('#A3 /info 带 mp_device Cookie ⇒ 调 store.touch 续期该设备', async () => {
  const store = fakeStore()
  const s = await serve()
  s.srv.setMp({ store })
  await infoOf(s.base, { Cookie: 'mp_device=goodsecret' })
  assert.equal(store.touched.length, 1, '已配对设备访问 /info 要续期')
  assert.equal(store.touched[0].secret, 'goodsecret')
  s.close()
})

test('#A3 带 Cookie 但夹在别的键中间 / 有空格的也能认出来', async () => {
  const store = fakeStore()
  const s = await serve()
  s.srv.setMp({ store })
  await infoOf(s.base, { Cookie: 'other=1; mp_device=goodsecret; x=2' })
  assert.equal(store.touched.length, 1)
  assert.equal(store.touched[0].secret, 'goodsecret')
  s.close()
})

test('#A3 没带 Cookie 的请求不许污染登记表（touch 一次都不调）', async () => {
  const store = fakeStore()
  const s = await serve()
  s.srv.setMp({ store })
  await infoOf(s.base)
  assert.equal(store.touched.length, 0)
  s.close()
})

test('#A3 store 没有 touch（老插件）⇒ noteDevice 静默跳过，请求照常 200', async () => {
  const s = await serve()
  s.srv.setMp({ store: { list: () => [] } })
  const j = await infoOf(s.base, { Cookie: 'mp_device=goodsecret' })
  assert.equal(j.ok, true)
  s.close()
})

/* ---------------- ④ accept / gate 把机型真的记进登记表 ---------------- */

test('#A3 /mp/pair/accept：客户端自报 deviceModel/deviceName 优先落进登记表', async () => {
  const { createMpBranch } = await import('../mp-routes.mjs')
  const seen = []
  const store = {
    isPaired: () => false,
    exchange: (token, about) => { seen.push({ token, about }); return { secret: 'sec1', deviceId: 'mp-sec1' } },
    revoke: () => true,
    touch: () => true,
  }
  const branch = createMpBranch({ dispatch: async () => ({}), store, log: () => {} })
  const req = {
    method: 'POST',
    headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 12; HUAWEI Mate 60 Pro) AppleWebKit/537.36' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  let body = ''
  const res = {
    writeHead: () => {}, setHeader: () => {},
    end: (x) => { body += x === undefined ? '' : String(x) },
  }
  // 造一个能读出 body 的最小请求（mp-routes 内部走 readJson && req.on）
  const { Readable } = await import('node:stream')
  const raw = JSON.stringify({ token: '123456', deviceModel: 'HUAWEI Mate 60 Pro', deviceName: '我的手机' })
  const stream = Readable.from([raw])
  Object.assign(req, {
    on: (evt, fn) => stream.on(evt, fn),
    removeListener: () => {},
  })
  const handled = await branch(req, res, '/mp/pair/accept')
  assert.equal(handled, true, 'accept 必须被 mp 分支接住')
  assert.equal(seen.length, 1, 'exchange 要被调用一次')
  assert.equal(seen[0].token, '123456')
  assert.equal(seen[0].about.model, 'HUAWEI Mate 60 Pro', '自报机型原样进登记表')
  assert.equal(seen[0].about.name, '我的手机')
  assert.equal(JSON.parse(body).ok, true)
})

test('#A3 /mp/pair/accept：没有自报字段时兜底从 User-Agent 抽机型', async () => {
  const { createMpBranch } = await import('../mp-routes.mjs')
  const seen = []
  const store = {
    isPaired: () => false,
    exchange: (token, about) => { seen.push(about); return { secret: 'sec2', deviceId: 'mp-sec2' } },
    revoke: () => true,
    touch: () => true,
  }
  const branch = createMpBranch({ dispatch: async () => ({}), store, log: () => {} })
  const { Readable } = await import('node:stream')
  const stream = Readable.from([JSON.stringify({ token: '123456' })])
  const req = {
    method: 'POST',
    headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 12; HONOR ELP-AN00 Build/HONORELP-AN00; wv) AppleWebKit/537.36' },
    on: (evt, fn) => stream.on(evt, fn),
    removeListener: () => {},
  }
  let body = ''
  const res = { writeHead: () => {}, setHeader: () => {}, end: (x) => { body += x === undefined ? '' : String(x) } }
  await branch(req, res, '/mp/pair/accept')
  assert.equal(seen.length, 1)
  assert.ok(seen[0].model && seen[0].model.length > 0, 'UA 兜底必须抽出非空机型，实际=' + JSON.stringify(seen[0].model))
  assert.ok(seen[0].model.indexOf('HONOR') >= 0, '抽到的是手机厂商标识，实际=' + seen[0].model)
  assert.equal(JSON.parse(body).ok, true)
})

test('#A3 gate：已配对设备打 RPC 时续期（touch 带机型，不重配对）', async () => {
  const { createMpBranch } = await import('../mp-routes.mjs')
  const touched = []
  const store = {
    isPaired: (sec) => sec === 'goodsecret',
    exchange: () => null,
    revoke: () => true,
    touch: (sec, about) => { touched.push({ sec, about }); return true },
  }
  const branch = createMpBranch({ dispatch: async () => ({}), store, log: () => {} })
  const { Readable } = await import('node:stream')
  const stream = Readable.from([JSON.stringify({ rpcId: 'r1', payload: {} })])
  const req = {
    method: 'POST',
    headers: { cookie: 'mp_device=goodsecret' },
    on: (evt, fn) => stream.on(evt, fn),
    removeListener: () => {},
  }
  const res = { writeHead: () => {}, setHeader: () => {}, end: () => {} }
  const handled = await branch(req, res, '/mp/api/session.list')
  assert.equal(handled, true)
  assert.equal(touched.length, 1, '已配对请求要续期')
  assert.equal(touched[0].sec, 'goodsecret')
})

/* ---------------- ④之三 隧道状态 + 两条链路灯（task-2 / #21-D） ---------------- */
/*
 * 用户原话（m00001）：插件自己拉起隧道、面板显示隧道状态；「局域网直连亮=手机真的从
 * 局域网连上；远程访问这版默认未连接，只留 UI 和接口」。
 * 这里只验**数据面**（tunnel.mjs 自己的进程管理由它自己的断言覆盖）：
 *   - 没配隧道 ⇒ tunnel.phase==='disabled' 且字段齐全，本机请求 ⇒ localLink 亮、remoteLink 恒 false；
 *   - 配了隧道 ⇒ 面板如实显示 connected/remotePort，且 /info 与 panelData 完全同口径；
 *   - tunnelStatus() 抛错/返垃圾 ⇒ 兜底 disabled，绝不把面板打成 500。
 */

test('#A3（task-2）隧道没配 ⇒ phase=disabled、字段齐全、链路字段必须在', async () => {
  const s = await serve()                       // 不传 tunnelStatus = 老插件 / 没配隧道
  const p = await s.srv.panelData(false)
  assert.equal(typeof p.tunnel, 'object', '面板数据必须带 tunnel 状态')
  for (const k of ['enabled', 'ready', 'phase', 'lastError', 'serverAddr', 'remotePort', 'since']) {
    assert.equal(Object.prototype.hasOwnProperty.call(p.tunnel, k), true, 'tunnel.' + k + ' 不许缺')
  }
  assert.equal(p.tunnel.enabled, false)
  assert.equal(p.tunnel.phase, 'disabled', 'phase 只能是那 5 个固定值')
  assert.equal(p.localLink, false, '这一轮还没收到过任何请求 ⇒ 灯是灭的')
  assert.equal(p.remoteLink, false, '远程访问本版恒 false（只留 UI 与接口）')
  const j = await infoOf(s.base)                // 这一发就是从 127.0.0.1 来的
  assert.equal(j.localLink, true, '本机/局域网来的请求 ⇒ 局域网直连灯亮')
  assert.equal(j.remoteLink, false)
  assert.equal(JSON.stringify(j).indexOf('authToken'), -1, '状态字段里绝不许出现 authToken')
  /* 口径一致：同一次进程里 /info 与 panelData 的 tunnel 必须一模一样 */
  const p2 = await s.srv.panelData(false)
  assert.equal(p2.localLink, true, 'panelData 与 /info 的链路灯必须同口径')
  assert.deepEqual(p2.tunnel, j.tunnel, '/info 与 panelData 的 tunnel 必须同口径')
  s.close()
})

test('#A3（task-2）配了隧道 ⇒ 面板如实显示 phase / remotePort，两处同口径', async () => {
  const s = await serve({ tunnelStatus: () => ({ enabled: true, ready: true, phase: 'connected',
    lastError: '', serverAddr: '118.178.129.217', remotePort: 8899, since: 1234 }) })
  const p = await s.srv.panelData(false)
  assert.equal(p.tunnel.enabled, true)
  assert.equal(p.tunnel.ready, true)
  assert.equal(p.tunnel.phase, 'connected')
  assert.equal(p.tunnel.remotePort, 8899)
  assert.equal(p.tunnel.serverAddr, '118.178.129.217')
  assert.equal(p.tunnel.since, 1234)
  const j = await infoOf(s.base)
  assert.deepEqual(j.tunnel, p.tunnel, '/info 与 panelData 的 tunnel 必须同口径')
  assert.equal(j.tunnel.phase, 'connected', '手机端直连 8899 也要看到隧道真的连着')
  s.close()
})

test('#A3（task-2）tunnelStatus() 抛错 / 返垃圾 ⇒ 兜底 disabled，绝不 500', async () => {
  const cases = [() => { throw new Error('隧道模块炸了') }, () => 'garbage', () => ({ phase: '不存在的值' })]
  for (const bad of cases) {
    const s = await serve({ tunnelStatus: bad })
    const p = await s.srv.panelData(false)
    assert.equal(p.ok, true, '面板不许被打成 500')
    assert.equal(p.tunnel.phase, 'disabled', '非法 phase 要落回 disabled')
    const j = await infoOf(s.base)
    assert.equal(j.ok, true)
    assert.equal(j.tunnel.phase, 'disabled')
    s.close()
  }
})

test('#A3（task-2）单测环境即使传真实端口也绝不拉起 frpc（坑 3 完整版）', async () => {
  const t = await import('../tunnel.mjs')
  /* ⚠️ lib/test/preset-info.spec.mjs:326 用的是**真实端口**
     （apply(ctx, { port: 19301 + liveSeq*2, allowShiftPort: true })），只判 port===0
     挡不住它 —— 用户机上配了 enabled:true 时，那个单测会真的 spawn frpc、抢 8899、
     留残留进程。所以这里用同一个形状再钉一遍。 */
  const st = t.startTunnel({ localPort: 19301 })
  assert.equal(st.phase, 'disabled', '单测环境必须短路 ⇒ disabled，不许真连服务器')
  assert.equal(st.enabled, false)
  assert.equal(t.tunnelStatus().phase, 'disabled')
  const raw = JSON.stringify(t.tunnelStatus())
  assert.equal(raw.indexOf('authToken'), -1, '状态里绝不许出现 authToken')
  assert.deepEqual(t.stopTunnel(), { enabled: false, ready: false, phase: 'disabled',
    lastError: '', serverAddr: '', remotePort: 0, since: 0 })
})

/* ---------------- ⑤ 插件侧真路由：/state 把名单发出去 ---------------- */

test('#A3 插件 /api/dsh-console/state 真的带 devices 键（面板走的就是这条）', async () => {
  const routes = {}
  const ctl = { projections: async () => ({ asOfSeq: 0, values: {} }),
    list: async () => ({ items: [] }) }
  const conn = { fetch: { register: (route) => { routes[route.path] = route; return () => {} } } }
  const ctx = {
    get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : null),
    on: () => () => {},
    effect: () => () => {}
  }
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  const route = routes['/api/dsh-console/state']
  assert.ok(route, 'state 路由没注册上')
  const r = await route.fetch(new Request('http://127.0.0.1/api/dsh-console/state?light=1'))
  const j = await r.json()
  assert.equal(j.ok, true)
  assert.equal(Array.isArray(j.devices), true, '面板数据里必须带 devices（哪怕是空数组）')
  assert.equal(typeof j.deviceCount, 'number')
  assert.equal(typeof j.onlineCount, 'number')
  /* 🔴 task-2（#21-D）：面板这条路由也要带隧道状态与两条链路灯。
     apply(ctx,{port:0}) 会让 tunnel.mjs 短路（坑 3）⇒ disabled，且单测进程里
     绝不许真的拉起 frpc。 */
  assert.equal(typeof j.tunnel, 'object', '面板数据必须带 tunnel 状态')
  assert.equal(j.tunnel.enabled, false, 'port:0 单测环境必须短路，不许真连服务器')
  assert.equal(j.tunnel.phase, 'disabled', '短路后 phase 必须是 disabled')
  assert.equal(j.localLink, false, '这条请求没有真实 socket ⇒ 局域网直连灯不亮（不许瞎亮）')
  assert.equal(j.remoteLink, false, '远程访问本版恒 false，但字段必须在')
})
