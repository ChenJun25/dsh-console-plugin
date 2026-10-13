/**
 * 第135节 · task-14 · 宿主侧新代码「隔离验证」。
 *
 * 为什么要有这个文件（背景）：
 *   本机 8899 端口上的 DSH 进程（PID 31536，StartTime 14:19:54）加载的是**旧插件代码**，
 *   而 task-5 的宿主侧改动（设备身份 uid/pubId/account、按 deviceUid 去重、panelData
 *   下发 linkSubscribed）在 lib/ 下的 mtime 是 20:16~20:56 ⇒ 源码比进程新。
 *   换言之：**用现网 http://127.0.0.1:8899/info 永远验不到新代码**。
 *   所以这里不碰 8899、不重启 DSH，而是在**空闲高位端口**起一个临时 lan-server 实例，
 *   直接加载 lib/ 下的新源码来验。
 *
 * ── 隔离约束（照 task-14 写域）──
 *   · 端口：19501 起（与 device-roster.spec.mjs 的 19101 / preset-info.spec.mjs 的 18901 错开，
 *     node --test 并行跑各 spec 时不会互抢）；**绝不 bind 8899**。
 *   · 云：注入**假 cloud 对象**（只有 snapshot()），**绝不 import cloud-link.mjs** ⇒ 不连公网、
 *     不读写 ~/.dsh/dsh-console-cloud.json、不生成 nodeId。
 *   · 登记表：进程内 createDeviceStore()（纯内存），**不落盘任何文件**。
 *   · 收尾：每个用例 stop() 临时实例；文件本身不留后台进程。
 *
 * ── 验的是什么（task-14 的五条）──
 *   ① /info 的有身份设备行含 uid / pubId / account；
 *   ② 设备行**逐键**不含 secret/token/cookie/nodeId，且响应正文里没有真 secret、没有云端 nodeId；
 *   ③ 同一 deviceUid + 两个不同配对 token ⇒ 只有 1 行、deviceId 不变、lastSeen 刷新；换 uid ⇒ 2 行；
 *   ④ 三态灯 linkSubscribed：online+Vip未过期 ⇒ true；online+已过期 ⇒ false；online=false ⇒ 键不出现；o.cloud=null ⇒ 键不出现；
 *   ⑤ attachments 登记表默认上限确为 512（登记 300 条全在、第 513 条挤掉第 1 条）。
 *
 * 跑法：
 *   node lib/test/host-isolation.spec.mjs
 *   node --test lib/test/host-isolation.spec.mjs      # 带 pass/fail 计数
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startLanServer } from '../lan-server.mjs'
import { createMpBranch } from '../mp-routes.mjs'
import { createDeviceStore } from '../mp-support.mjs'
import { createAttachmentRegistry } from '../attachments.mjs'

/* ⚠️ 端口段必须和 device-roster.spec.mjs（19101 起）/ preset-info.spec.mjs（18901 起）错开。 */
let portSeq = 0
const nextPort = () => 19501 + (portSeq++ * 2)

/* 设备行里**绝不许出现**的键名片段（逐键小写子串匹配）。 */
const FORBIDDEN = ['secret', 'token', 'cookie', 'nodeid']
/* 云端凭据的假值：它绝不能出现在任何响应正文里（云 nodeId 是插件对云的凭据）。 */
const FAKE_CLOUD_NODEID = 'CLOUD-NODE-SECRET-XYZ'

/** 假云链路：只有 snapshot()。set() 用于在用例内部切三态。 */
function fakeCloud(snap) {
  let cur = snap === undefined ? null : snap
  return {
    nodeId: FAKE_CLOUD_NODEID,           // 故意带上云端凭据：验证它一个字节都不下发
    snapshot: () => cur,
    set: (s) => { cur = s },
  }
}

const CLOUD_ON_ALIVE = {
  online: true,
  vipExpireMs: Date.now() + 24 * 3600 * 1000,
  shortId: 'pub-abc123',
  bound: { uid: 'cloud-uid-1', name: '张三', avatar: '' },
  nodeId: FAKE_CLOUD_NODEID,
}

/** 递归逐键扫描：返回命中的 key 路径数组。 */
function forbiddenPaths(obj, bad = FORBIDDEN) {
  const hits = []
  const walk = (v, path) => {
    if (v === null || typeof v !== 'object') return
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']')); return }
    for (const k of Object.keys(v)) {
      const low = String(k).toLowerCase()
      if (bad.some((f) => low.includes(f))) hits.push(path + '.' + k)
      walk(v[k], path + '.' + k)
    }
  }
  walk(obj, '$')
  return hits
}

/**
 * 起一个临时实例。返回 { srv, base, store, cloud, accept, info, close }。
 * o.mp.store 必须是**真 store**（lan-server 的 deviceRoster 要 list()/setIdentity()），
 * o.mp.branch 内部包一层 shell store（校验配对码有效），与 index.js:2076-2094 的接线一致。
 */
async function serve(over = {}) {
  const codes = new Set(over.codes || [])
  const store = createDeviceStore()
  const shell = {
    exchange: (t, about) => (codes.has(String(t)) ? store.exchange(t, about) : null),
    isPaired: (s) => store.isPaired(s),
    revoke: (s) => store.revoke(s),
    touch: (s, about) => store.touch(s, about),
  }
  const branch = createMpBranch({ dispatch: async () => ({ ok: true }), store: shell, log: () => {} })
  const cloud = over.cloud === undefined ? fakeCloud(Object.assign({}, CLOUD_ON_ALIVE)) : over.cloud
  const srv = startLanServer(Object.assign({
    port: nextPort(),
    allowShift: true,
    log: () => {},
    getToken: () => 'TOK',
    getInfo: () => ({
      name: '我的电脑', nodeId: 'dsh-console', host: 'host-1', dshOk: true,
      dshError: '', version: '9.9.9', agentPreset: 'ptc', agentPresetAvailable: true,
    }),
    listSessions: async () => [],
    runCommand: async () => ({ ok: true }),
    cloud,
  }, over.opts || {}))
  /* 🔴 第170节 · Bug B 端到端靶子：/mp-cookie 的免码签发口。
     默认实现与 mp-support.attachMp 的 issueDevice **逐字同形**（mint(about) + 拼 Cookie），
     这样这条测试测的就是「lan-server 真的把 about 递到了签发口」。
     老测试不传 over.issueDevice ⇒ 行为与改动前完全一致。 */
  const issueDevice = typeof over.issueDevice === 'function'
    ? over.issueDevice
    : (about) => {
      const r = store.mint(about)
      return r && r.secret ? 'mp_device=' + encodeURIComponent(r.secret) : ''
    }
  srv.setMp({ branch, store, issueDevice })
  const started = await srv.start()
  assert.ok(started, '临时 lan-server 必须起得来（端口段 19501+）')
  assert.notEqual(started.port, 8899, '绝不许占用 8899')
  const base = 'http://127.0.0.1:' + started.port
  return {
    srv, base, store, cloud,
    info: async () => {
      const r = await fetch(base + '/info?token=TOK')
      assert.equal(r.status, 200)
      /* ⚠️ clone() 必须在读 body 之前调（读过的 body 不能再 clone）。 */
      const copy = r.clone()
      const text = await copy.text()
      return { json: await r.json(), text }
    },
    accept: async (token, body) => {
      const r = await fetch(base + '/mp/pair/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ token }, body || {})),
      })
      const j = await r.json()
      const sc = r.headers.get('set-cookie') || ''
      const m = sc.match(/mp_device=([^;]+)/)
      return { status: r.status, json: j, secret: m ? decodeURIComponent(m[1]) : '' }
    },
    close: () => srv.stop(),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- ① 身份字段 + ② 不外泄 ---------------- */

test('task-14 ①/②  /info 设备行含 uid/pubId/account，且逐键不含 secret/token/cookie/nodeId', async () => {
  const s = await serve({ codes: ['100001'] })
  try {
    const a = await s.accept('100001', {
      deviceModel: 'HUAWEI Mate 60 Pro', deviceName: '我的手机', deviceUid: 'u-test-1',
    })
    assert.equal(a.status, 200, '配对应成功')
    assert.ok(a.secret.length > 0, 'accept 必须下发 mp_device secret')

    const { json, text } = await s.info()
    assert.equal(json.devices.length, 1)
    const row = json.devices[0]

    /* ① 有身份的设备行必须带齐三件套 */
    assert.equal(row.uid, 'u-test-1', '行里必须有手机自报的 deviceUid')
    assert.equal(row.pubId, 'pub-abc123', '行里必须有公网短 ID（云端 shortId）')
    assert.equal(row.account, '张三', '行里必须有账号名（云端 bound.name）')
    assert.equal(row.cloudUid, 'cloud-uid-1', '账号级 uid 只显示、不判重')

    /* ② 设备行逐键白名单 */
    const hits = forbiddenPaths(row)
    assert.deepEqual(hits, [], '设备行不许出现任何凭据键，命中：' + hits.join(','))

    /* ②′ 整个 /info 响应体逐键扫描（不只设备行）。
       唯一被点名放行的是**顶层** nodeId —— 它是 index.js:2022 写死的文案常量 'dsh-console'，
       不是 cloud-link 的云端凭据；下面连它的值一起钉死，防止哪天被换成真凭据。 */
    const bodyHits = forbiddenPaths(json).filter((p) => p !== '$.nodeId')
    assert.deepEqual(bodyHits, [], '/info 整包里出现了凭据键：' + bodyHits.join(','))
    assert.equal(json.nodeId, 'dsh-console', '顶层 nodeId 必须是静态常量，不许变成云端凭据')

    /* ② 响应正文里不许出现真 secret，也不许出现云端 nodeId */
    assert.ok(!text.includes(a.secret), '响应正文里出现了 mp_device secret')
    assert.ok(!text.includes(FAKE_CLOUD_NODEID), '响应正文里出现了云端 nodeId 凭据')
    assert.ok(!text.includes('TOK'), '响应正文里出现了访问码')

    /* /info.cloud 只允许三个字段，nodeId 不在其中 */
    assert.deepEqual(Object.keys(json.cloud).sort(), ['online', 'shortId', 'vipExpireMs'])

    /* 记录一条事实（不是失败）：/info 顶层的 nodeId 是 index.js 写死的文案常量 'dsh-console'，
       不是 cloud-link 的云端凭据 nodeId —— 后者从不出现在任何响应里。 */
    console.log('   [证据] /info 顶层 nodeId = ' + JSON.stringify(json.nodeId) + '（静态常量，非云端凭据）')
    console.log('   [证据] 设备行键 = ' + Object.keys(row).sort().join(','))
  } finally { s.close() }
})

/* ---------------- ③ 去重 ---------------- */

test('task-14 ③  同 deviceUid 两个不同 token ⇒ 1 行 + deviceId 不变 + lastSeen 刷新；换 uid ⇒ 2 行', async () => {
  const s = await serve({ codes: ['200001', '200002', '200003'] })
  try {
    const a = await s.accept('200001', { deviceModel: 'HUAWEI Mate 60 Pro', deviceName: '我的手机', deviceUid: 'u-test-1' })
    assert.equal(a.status, 200)
    const d1 = a.json.deviceId
    const r1 = (await s.info()).json
    assert.equal(r1.devices.length, 1)
    const seen1 = r1.devices[0].lastSeen

    await sleep(30)

    /* 同一个 deviceUid，换一张配对 token（模拟「同一台手机重新配对 / 换 secret」） */
    const b = await s.accept('200002', { deviceModel: 'HUAWEI Mate 60 Pro', deviceName: '我的手机', deviceUid: 'u-test-1' })
    assert.equal(b.status, 200)
    const d2 = b.json.deviceId
    assert.equal(d2, d1, '同一 deviceUid 必须沿用同一个 deviceId')
    assert.notEqual(b.secret, a.secret, '两次配对必须是两张不同 secret（否则去重没被真验证）')

    const r2 = (await s.info()).json
    assert.equal(r2.devices.length, 1, '同一 deviceUid 第二次配对后名单仍必须只有 1 行')
    const seen2 = r2.devices[0].lastSeen
    assert.ok(seen2 > seen1, 'lastSeen 必须被刷新（' + seen1 + ' -> ' + seen2 + '）')
    assert.equal(r2.deviceCount, 1)
    assert.equal(s.store.size, 2, 'store 里两张 secret 指向同一条记录（别名是常态）')

    /* 换一台「手机」：不同 deviceUid ⇒ 必须各算一台 */
    const c = await s.accept('200003', { deviceModel: 'HONOR Magic6', deviceName: '我的平板', deviceUid: 'u-test-2' })
    assert.equal(c.status, 200)
    assert.notEqual(c.json.deviceId, d1, '不同 deviceUid 绝不许被并成同一台')
    const r3 = (await s.info()).json
    assert.equal(r3.devices.length, 2, '两个不同 deviceUid ⇒ 名单 2 行')
    assert.equal(r3.deviceCount, 2)
    assert.equal(s.store.size, 3, 'store 里 3 张 secret / 2 条记录')

    const byUid = Object.fromEntries(r3.devices.map((d) => [d.uid, d]))
    assert.equal(byUid['u-test-1'].deviceId, d1)
    assert.equal(byUid['u-test-2'].deviceId, c.json.deviceId)

    /* 「任何行」都不许有凭据键 —— 两行全扫。 */
    const allHits = r3.devices.flatMap((d, i) => forbiddenPaths(d).map((p) => 'row' + i + p))
    assert.deepEqual(allHits, [], '名单里出现了凭据键：' + allHits.join(','))

    /* 反例（防「去重过头」）：不带 deviceUid 的老客户端重连，必须退回 deviceId 语义、
       各算一台 —— 宁可多出一行，也绝不把两台不同手机并成一台。 */
    const noUidStore = createDeviceStore()
    const x1 = noUidStore.mint({ model: 'A' })
    const x2 = noUidStore.mint({ model: 'B' })
    assert.notEqual(x1.deviceId, x2.deviceId, '没有 deviceUid 时必须各算一台（老行为不回归）')
    assert.equal(noUidStore.list().length, 2)
    assert.equal(noUidStore.list().every((d) => d.uid === ''), true, '没有 uid 时行里 uid 是空串')
    console.log('   [证据] 第二次 accept 前后行数 1 -> 1，deviceId ' + d1 + ' 不变，lastSeen ' + seen1 + ' -> ' + seen2)
    console.log('   [证据] 换 uid 后行数 = ' + r3.devices.length + '，deviceId = ' + r3.devices.map((d) => d.deviceId).join(' | '))
  } finally { s.close() }
})

/* ---------------- ④ 三态灯 ---------------- */

test('task-14 ④  三态灯：online+未过期 ⇒ true；online+已过期 ⇒ false；online=false / 无 cloud ⇒ 键不出现', async () => {
  /* ① 绿：服务器连得上 + VIP 有效 */
  {
    const s = await serve()
    try {
      const { json } = await s.info()
      assert.equal(typeof json.linkSubscribed, 'boolean', '配了云链路时必须是布尔')
      assert.equal(json.linkSubscribed, true)
    } finally { s.close() }
  }
  /* ② 黄：服务器连得上但 VIP 已过期 */
  {
    const cloud = fakeCloud(Object.assign({}, CLOUD_ON_ALIVE, { vipExpireMs: Date.now() - 1000 }))
    const s = await serve({ cloud })
    try {
      const { json } = await s.info()
      assert.equal(typeof json.linkSubscribed, 'boolean')
      assert.equal(json.linkSubscribed, false)
    } finally { s.close() }
  }
  /* ③ 灰：服务器没连上（online=false）⇒ 键不下发 */
  {
    const cloud = fakeCloud(Object.assign({}, CLOUD_ON_ALIVE, { online: false }))
    const s = await serve({ cloud })
    try {
      const { json } = await s.info()
      assert.equal('linkSubscribed' in json, false, 'online=false 时 linkSubscribed 必须不存在')
    } finally { s.close() }
  }
  /* ④ 灰：本机根本没配云链路（老插件 / 没上云）⇒ 键不下发 */
  {
    const s = await serve({ cloud: null })
    try {
      const { json } = await s.info()
      assert.equal('linkSubscribed' in json, false, '没配云链路时 linkSubscribed 必须不存在')
      assert.equal(json.cloud, null, '没云时 /info.cloud 必须是 null，不是 500')
    } finally { s.close() }
  }
  /* ⑤ 面板通道同口径（panelData 也是同一套判据） */
  {
    const s = await serve()
    try {
      const d = await s.srv.panelData(false)
      assert.equal(d.linkSubscribed, true, 'panelData 与 /info 必须同口径')
    } finally { s.close() }
  }
  console.log('   [证据] 三态：online+有效=true / online+过期=false / online=false=键缺 / cloud=null=键缺')
})

/* ---------------- ⑤ attachments 默认上限 512 ---------------- */

test('task-14 ⑤  attachments 默认上限 512：300 条全可 infoOf，第 513 条挤掉第 1 条', async () => {
  const reg = createAttachmentRegistry({})
  const refOf = (i) => ({ attachmentId: 'sha256:' + String(i).padStart(64, '0'), mediaType: 'image/png', bytes: 10 + i })

  /* 「长会话」300 张：一根都不许丢 */
  for (let i = 0; i < 300; i++) reg.register(refOf(i), { name: 'p' + i + '.png' })
  assert.equal(reg.size, 300)
  const lost = []
  for (let i = 0; i < 300; i++) if (!reg.infoOf(refOf(i).attachmentId)) lost.push(i)
  assert.deepEqual(lost, [], '300 条里丢了：' + lost.join(','))

  /* 撑到 513：默认 max 必须是 512（这条就是「MAX_ENTRIES === 512」的运行时证据，不用读源码） */
  for (let i = 300; i < 513; i++) reg.register(refOf(i), { name: 'p' + i + '.png' })
  assert.equal(reg.size, 512, '默认上限必须是 512')
  assert.equal(reg.infoOf(refOf(0).attachmentId), null, '第 513 条必须挤掉最旧的第 1 条')
  assert.ok(reg.infoOf(refOf(512).attachmentId), '最新登记的一条必须在')
  assert.ok(reg.infoOf(refOf(1).attachmentId), '只许丢 1 条，第 2 条仍须在')
  console.log('   [证据] 300 条 infoOf 命中 300/300；总数 513 时 size=' + reg.size + '，第 1 条已丢、第 2 条仍在')
})

/* ---------------- ⑥ /mp-cookie 免码签发也带设备身份（第170节 · Bug B 回归靶子） ---------------- */
/*
 * 用户实测（m00001 截图）：1 台真机 + 2 台模拟器，面板显示「15 台」。
 * 根因：App 配对后每次免码重连走 GET /mp-cookie?token=..&deviceUid=..（App 侧
 * LanClient.ets:3798-3801 只带 token + deviceUid），而 lan-server 这条分支
 * **只把 6 位面板码递给 issueForCode**、about 全丢 ⇒ store.mint() 的 about.uid 为空
 * ⇒ 同一台手机每重连一次就多一行（15 行就是这么攒的）。
 * 这条测试直接钉住端到端：lan-server 必须把 about 递到签发口，且反复重连只算 1 台。
 */

test('task-14 ⑥ （第170节 · Bug B）同一 deviceUid 走 /mp-cookie 重连 15 次 ⇒ 仍只有 1 台', async () => {
  /* 记下 lan-server 到底把什么 about 递给了签发口 —— 这是「接线真的通了」的直接证据。 */
  const mintedAbout = []
  const store = createDeviceStore()
  const seen = { issueDevice: 0 }
  const s = await serve({
    codes: ['300001'],
    issueDevice: (about) => {
      seen.issueDevice += 1
      mintedAbout.push(about)
      const r = store.mint(about)
      return r && r.secret ? 'mp_device=' + encodeURIComponent(r.secret) : ''
    },
  })
  /* serve() 内部自己的 store 归它的 issueDevice 用；这条用例要用**独立 store**，
     所以签发口把 about 转给本地的 store —— 上面 serve 的 store 只用于 isPaired。 */
  try {
    const a = await s.accept('300001', { deviceModel: 'HUAWEI Mate 60 Pro', deviceName: '我的手机', deviceUid: 'u-real-1' })
    assert.equal(a.status, 200, '配对应成功')

    /* 第 1 发：模拟「重启后手机自愈重连」的免码签发 */
    const one = await fetch(s.base + '/mp-cookie?token=TOK&deviceUid=u-real-1')
    assert.equal(one.status, 200, '/mp-cookie 必须 200（token 闸在后面，带 ?token= 即过）')
    const j1 = await one.json()
    assert.equal(j1.ok, true)
    assert.ok(j1.cookie && j1.cookie.length > 0, '/mp-cookie 必须下发 Cookie')
    assert.equal(seen.issueDevice, 1, 'issueDevice 必须被真的调到')
    assert.equal(mintedAbout[0] && mintedAbout[0].uid, 'u-real-1',
      '🔴 Bug B：lan-server 必须把 query 上的 deviceUid 递进签发口（以前这里是空）')

    /* 被递进来的机型：App 的 /mp-cookie 不发 deviceModel ⇒ 只能靠 UA 兜底（不许崩、不许空身份） */
    assert.equal(typeof mintedAbout[0].model, 'string', 'about.model 必须是字符串（UA 兜底）')

    /* 再打 15 发（每次间隔 2ms，让 lastSeen 单调可辨）—— 模拟反复免码重连 */
    for (let i = 0; i < 15; i++) {
      await sleep(2)
      const r = await fetch(s.base + '/mp-cookie?token=TOK&deviceUid=u-real-1')
      assert.equal(r.status, 200, '第 ' + (i + 2) + ' 次 /mp-cookie 也必须 200')
    }
    assert.equal(seen.issueDevice, 16, '16 次重连 ⇒ 16 次签发（这条本身不是 bug）')

    /* 关键断言：16 次签发之后，登记表里**只有 1 行** */
    const rows1 = store.list()
    assert.equal(rows1.length, 1, '🔴 Bug B：同一台手机重连 16 次 ⇒ 名单必须仍是 1 行（实测曾是 15 行）')
    assert.equal(rows1[0].uid, 'u-real-1', '那一行必须带上手机自报的 deviceUid')
    console.log('   [证据] 16 次 /mp-cookie 后 store.list().length = ' + rows1.length + '，uid = ' + rows1[0].uid)

    /* 🔴 红线反向：换一台手机（另一个 deviceUid）⇒ **必须多出一行**，绝不并成一台 */
    await sleep(2)
    const r2 = await fetch(s.base + '/mp-cookie?token=TOK&deviceUid=u-other-2')
    assert.equal(r2.status, 200)
    const rows2 = store.list()
    assert.equal(rows2.length, 2, '🔴 红线：不同 deviceUid 必须各算一台，绝不许并成一台')
    const uids = rows2.map((d) => d.uid).sort().join(',')
    assert.equal(uids, 'u-other-2,u-real-1', '两行各自带自己的 uid，绝不串')
    console.log('   [证据] 换 deviceUid 后 store.list().length = ' + rows2.length + '，uid = ' + uids)

    /* 老客户端（不带 deviceUid 的 /mp-cookie）⇒ 各算一台，不回归、不误并 */
    const rowsBefore = store.list().length
    const r3 = await fetch(s.base + '/mp-cookie?token=TOK')
    assert.equal(r3.status, 200)
    assert.equal(store.list().length, rowsBefore + 1, '不带 deviceUid 的请求必须新开一行（宁可多一行，绝不误并）')
    console.log('   [证据] 不带 deviceUid 的 /mp-cookie ⇒ 行数 ' + rowsBefore + ' -> ' + store.list().length)
  } finally { s.close() }
})
