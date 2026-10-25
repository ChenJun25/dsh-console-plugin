import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startLanServer } from '../lan-server.mjs'
import { createMpBranch } from '../mp-routes.mjs'
import { createDeviceStore } from '../mp-support.mjs'
import { createAttachmentRegistry } from '../attachments.mjs'

let tmpSeq = 0
function tmpPath(tag) {
  return path.join(os.tmpdir(), 'dsh-console-hostiso-spec-' + tag + '-' + process.pid + '-' + (tmpSeq++) + '.json')
}
function rmFile(p) { try { fs.rmSync(p, { force: true }) } catch (e) {  } }

function testStore() {
  const dev = tmpPath('dev')
  const rev = tmpPath('rev')
  return { store: createDeviceStore({ devicesPath: dev, revokedPath: rev }), cleanup: () => { rmFile(dev); rmFile(rev) } }
}

const ENV_DEV = tmpPath('env-dev')
const ENV_REV = tmpPath('env-rev')
process.env.DSH_CONSOLE_DEVICES_FILE = ENV_DEV
process.env.DSH_CONSOLE_REVOKED_FILE = ENV_REV
test.after(() => { rmFile(ENV_DEV); rmFile(ENV_REV) })

let portSeq = 0
const nextPort = () => 19501 + (portSeq++ * 2)

const FORBIDDEN = ['secret', 'token', 'cookie', 'nodeid']

const FAKE_CLOUD_NODEID = 'CLOUD-NODE-SECRET-XYZ'

function fakeCloud(snap) {
  let cur = snap === undefined ? null : snap
  return {
    nodeId: FAKE_CLOUD_NODEID,
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

async function serve(over = {}) {
  const codes = new Set(over.codes || [])

  const owned = testStore()
  const store = owned.store
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
    close: () => { srv.stop(); owned.cleanup() },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('①/②  /info 设备行含 uid/pubId/account，且逐键不含 secret/token/cookie/nodeId', async () => {
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

    assert.equal(row.uid, 'u-test-1', '行里必须有手机自报的 deviceUid')
    assert.equal(row.pubId, 'pub-abc123', '行里必须有公网短 ID（云端 shortId）')
    assert.equal(row.account, '张三', '行里必须有账号名（云端 bound.name）')
    assert.equal(row.cloudUid, 'cloud-uid-1', '账号级 uid 只显示、不判重')

    const hits = forbiddenPaths(row)
    assert.deepEqual(hits, [], '设备行不许出现任何凭据键，命中：' + hits.join(','))

    const bodyHits = forbiddenPaths(json).filter((p) => p !== '$.nodeId')
    assert.deepEqual(bodyHits, [], '/info 整包里出现了凭据键：' + bodyHits.join(','))
    assert.equal(json.nodeId, 'dsh-console', '顶层 nodeId 必须是静态常量，不许变成云端凭据')

    assert.ok(!text.includes(a.secret), '响应正文里出现了 mp_device secret')
    assert.ok(!text.includes(FAKE_CLOUD_NODEID), '响应正文里出现了云端 nodeId 凭据')
    assert.ok(!text.includes('TOK'), '响应正文里出现了访问码')

    assert.deepEqual(Object.keys(json.cloud).sort(), ['online', 'shortId', 'vipExpireMs'])

    console.log('   [证据] /info 顶层 nodeId = ' + JSON.stringify(json.nodeId) + '（静态常量，非云端凭据）')
    console.log('   [证据] 设备行键 = ' + Object.keys(row).sort().join(','))
  } finally { s.close() }
})

test('③  同 deviceUid 两个不同 token ⇒ 1 行 + deviceId 不变 + lastSeen 刷新；换 uid ⇒ 2 行', async () => {
  const s = await serve({ codes: ['200001', '200002', '200003'] })
  try {
    const a = await s.accept('200001', { deviceModel: 'HUAWEI Mate 60 Pro', deviceName: '我的手机', deviceUid: 'u-test-1' })
    assert.equal(a.status, 200)
    const d1 = a.json.deviceId
    const r1 = (await s.info()).json
    assert.equal(r1.devices.length, 1)
    const seen1 = r1.devices[0].lastSeen

    await sleep(30)

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

    const allHits = r3.devices.flatMap((d, i) => forbiddenPaths(d).map((p) => 'row' + i + p))
    assert.deepEqual(allHits, [], '名单里出现了凭据键：' + allHits.join(','))

    const plain = testStore()
    const noUidStore = plain.store
    const x1 = noUidStore.mint({ model: 'A' })
    const x2 = noUidStore.mint({ model: 'B' })
    assert.notEqual(x1.deviceId, x2.deviceId, '没有 deviceUid 时必须各算一台（老行为不回归）')
    assert.equal(noUidStore.list().length, 2)
    assert.equal(noUidStore.list().every((d) => d.uid === ''), true, '没有 uid 时行里 uid 是空串')
    plain.cleanup()
    console.log('   [证据] 第二次 accept 前后行数 1 -> 1，deviceId ' + d1 + ' 不变，lastSeen ' + seen1 + ' -> ' + seen2)
    console.log('   [证据] 换 uid 后行数 = ' + r3.devices.length + '，deviceId = ' + r3.devices.map((d) => d.deviceId).join(' | '))
  } finally { s.close() }
})

test('④  三态灯：online+未过期 ⇒ true；online+已过期 ⇒ false；online=false / 无 cloud ⇒ 键不出现', async () => {

  {
    const s = await serve()
    try {
      const { json } = await s.info()
      assert.equal(typeof json.linkSubscribed, 'boolean', '配了云链路时必须是布尔')
      assert.equal(json.linkSubscribed, true)
    } finally { s.close() }
  }

  {
    const cloud = fakeCloud(Object.assign({}, CLOUD_ON_ALIVE, { vipExpireMs: Date.now() - 1000 }))
    const s = await serve({ cloud })
    try {
      const { json } = await s.info()
      assert.equal(typeof json.linkSubscribed, 'boolean')
      assert.equal(json.linkSubscribed, false)
    } finally { s.close() }
  }

  {
    const cloud = fakeCloud(Object.assign({}, CLOUD_ON_ALIVE, { online: false }))
    const s = await serve({ cloud })
    try {
      const { json } = await s.info()
      assert.equal('linkSubscribed' in json, false, 'online=false 时 linkSubscribed 必须不存在')
    } finally { s.close() }
  }

  {
    const s = await serve({ cloud: null })
    try {
      const { json } = await s.info()
      assert.equal('linkSubscribed' in json, false, '没配云链路时 linkSubscribed 必须不存在')
      assert.equal(json.cloud, null, '没云时 /info.cloud 必须是 null，不是 500')
    } finally { s.close() }
  }

  {
    const s = await serve()
    try {
      const d = await s.srv.panelData(false)
      assert.equal(d.linkSubscribed, true, 'panelData 与 /info 必须同口径')
    } finally { s.close() }
  }
  console.log('   [证据] 三态：online+有效=true / online+过期=false / online=false=键缺 / cloud=null=键缺')
})

test('⑤  attachments 默认上限 512：300 条全可 infoOf，第 513 条挤掉第 1 条', async () => {
  const reg = createAttachmentRegistry({})
  const refOf = (i) => ({ attachmentId: 'sha256:' + String(i).padStart(64, '0'), mediaType: 'image/png', bytes: 10 + i })

  for (let i = 0; i < 300; i++) reg.register(refOf(i), { name: 'p' + i + '.png' })
  assert.equal(reg.size, 300)
  const lost = []
  for (let i = 0; i < 300; i++) if (!reg.infoOf(refOf(i).attachmentId)) lost.push(i)
  assert.deepEqual(lost, [], '300 条里丢了：' + lost.join(','))

  for (let i = 300; i < 513; i++) reg.register(refOf(i), { name: 'p' + i + '.png' })
  assert.equal(reg.size, 512, '默认上限必须是 512')
  assert.equal(reg.infoOf(refOf(0).attachmentId), null, '第 513 条必须挤掉最旧的第 1 条')
  assert.ok(reg.infoOf(refOf(512).attachmentId), '最新登记的一条必须在')
  assert.ok(reg.infoOf(refOf(1).attachmentId), '只许丢 1 条，第 2 条仍须在')
  console.log('   [证据] 300 条 infoOf 命中 300/300；总数 513 时 size=' + reg.size + '，第 1 条已丢、第 2 条仍在')
})

test('⑥ 同一 deviceUid 走 /mp-cookie 重连 15 次 ⇒ 仍只有 1 台', async () => {

  const mintedAbout = []
  const { store, cleanup } = testStore()
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

  try {
    const a = await s.accept('300001', { deviceModel: 'HUAWEI Mate 60 Pro', deviceName: '我的手机', deviceUid: 'u-real-1' })
    assert.equal(a.status, 200, '配对应成功')

    const one = await fetch(s.base + '/mp-cookie?token=TOK&deviceUid=u-real-1')
    assert.equal(one.status, 200, '/mp-cookie 必须 200（token 闸在后面，带 ?token= 即过）')
    const j1 = await one.json()
    assert.equal(j1.ok, true)
    assert.ok(j1.cookie && j1.cookie.length > 0, '/mp-cookie 必须下发 Cookie')
    assert.equal(seen.issueDevice, 1, 'issueDevice 必须被真的调到')
    assert.equal(mintedAbout[0] && mintedAbout[0].uid, 'u-real-1',
      '🔴 lan-server 必须把 query 上的 deviceUid 递进签发口（以前这里是空）')

    assert.equal(typeof mintedAbout[0].model, 'string', 'about.model 必须是字符串（UA 兜底）')

    for (let i = 0; i < 15; i++) {
      await sleep(2)
      const r = await fetch(s.base + '/mp-cookie?token=TOK&deviceUid=u-real-1')
      assert.equal(r.status, 200, '第 ' + (i + 2) + ' 次 /mp-cookie 也必须 200')
    }
    assert.equal(seen.issueDevice, 16, '16 次重连 ⇒ 16 次签发（这条本身不是 bug）')

    const rows1 = store.list()
    assert.equal(rows1.length, 1, '🔴 同一台手机重连 16 次 ⇒ 名单必须仍是 1 行（实测曾是 15 行）')
    assert.equal(rows1[0].uid, 'u-real-1', '那一行必须带上手机自报的 deviceUid')
    console.log('   [证据] 16 次 /mp-cookie 后 store.list().length = ' + rows1.length + '，uid = ' + rows1[0].uid)

    await sleep(2)
    const r2 = await fetch(s.base + '/mp-cookie?token=TOK&deviceUid=u-other-2')
    assert.equal(r2.status, 200)
    const rows2 = store.list()
    assert.equal(rows2.length, 2, '🔴 红线：不同 deviceUid 必须各算一台，绝不许并成一台')
    const uids = rows2.map((d) => d.uid).sort().join(',')
    assert.equal(uids, 'u-other-2,u-real-1', '两行各自带自己的 uid，绝不串')
    console.log('   [证据] 换 deviceUid 后 store.list().length = ' + rows2.length + '，uid = ' + uids)

    const rowsBefore = store.list().length
    const r3 = await fetch(s.base + '/mp-cookie?token=TOK')
    assert.equal(r3.status, 200)
    assert.equal(store.list().length, rowsBefore + 1, '不带 deviceUid 的请求必须新开一行（宁可多一行，绝不误并）')
    console.log('   [证据] 不带 deviceUid 的 /mp-cookie ⇒ 行数 ' + rowsBefore + ' -> ' + store.list().length)
  } finally { s.close(); cleanup() }
})
