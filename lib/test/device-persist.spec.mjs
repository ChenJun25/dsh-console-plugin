import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDeviceStore } from '../mp-support.mjs'
import { createMpBranch } from '../mp-routes.mjs'
import { startLanServer } from '../lan-server.mjs'

const CODE6 = '314159'

let tmpSeq = 0
function tmpPath(tag) {
  return path.join(os.tmpdir(), 'dsh-console-devices-spec-' + (tag || 'dev') + '-' + process.pid + '-' + (tmpSeq++) + '.json')
}
function rmFile(p) { try { fs.rmSync(p, { force: true }) } catch (e) {  } }
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const writeJson = (p, j) => fs.writeFileSync(p, JSON.stringify(j, null, 2))

function rec(deviceId, secrets, uid) {
  return {
    deviceId, secrets,
    model: 'HUAWEI Mate 60', name: '我的手机',
    pairedAt: 1700000000000, lastSeen: 1700000000000,
    uid: uid || '', cloudUid: '', pubId: '', account: '', nickName: '',
    selfAccountUid: '', selfAccountName: '',
  }
}

test('① 配对后落盘：新建 store 实例（模拟重启）能读回同一台手机，secret 不落在 list() 里', () => {
  const p = tmpPath('a')
  const rp = tmpPath('a-revoked')
  try {
    const s1 = createDeviceStore({ devicesPath: p, revokedPath: rp })
    const m = s1.mint({ uid: 'u-persist-1', model: 'HUAWEI Mate 60', name: '我的手机', accountUid: 'hw-openid-1', accountName: '小美' })
    assert.ok(m && m.secret, 'mint 必须成功')
    assert.ok(String(m.deviceId).startsWith('mp-'))

    assert.ok(fs.existsSync(p), '配对后设备表文件必须已落盘：' + p)
    const onDisk = readJson(p)
    assert.equal(onDisk.version, 1, '落盘文件必须带 version=1')
    assert.equal(onDisk.records.length, 1, '盘上应恰好一条记录')
    assert.equal(onDisk.records[0].deviceId, m.deviceId)
    assert.deepEqual(onDisk.records[0].secrets, [m.secret], '记录行必须带上它名下的 secret（读回时靠它重建 Map 键）')
    assert.equal(onDisk.records[0].selfAccountUid, 'hw-openid-1')
    assert.equal(onDisk.records[0].selfAccountName, '小美')
    console.log('   [证据] 盘上 records[0] = ' + JSON.stringify(onDisk.records[0]))

    const s2 = createDeviceStore({ devicesPath: p, revokedPath: rp })
    assert.equal(s2.isPaired(m.secret), true, '重启后旧 secret 必须仍然认得（否则手机要重新配对）')
    const rows = s2.list()
    assert.equal(rows.length, 1, '重启后名单必须有 1 台')
    assert.equal(rows[0].deviceId, m.deviceId, 'deviceId 必须逐字一致')
    assert.equal(rows[0].uid, 'u-persist-1', 'uid 必须读回')
    assert.equal(rows[0].model, 'HUAWEI Mate 60')
    assert.equal(rows[0].name, '我的手机')
    assert.equal(rows[0].accountUid, 'hw-openid-1', '手机自报账号必须读回')
    assert.equal(rows[0].accountName, '小美')

    assert.ok(!JSON.stringify(rows).includes(m.secret), 'list() 绝不能带 secret')
    assert.ok(!Object.prototype.hasOwnProperty.call(rows[0], 'secret'), 'list() 行里不许有 secret 键')
    assert.ok(!Object.prototype.hasOwnProperty.call(rows[0], 'secrets'), 'list() 行里不许有 secrets 键')

    const again = s2.mint({ uid: 'u-persist-1', model: 'HUAWEI Mate 60' })
    assert.equal(again.deviceId, m.deviceId, '同 uid 重连必须沿用同一 deviceId（不许多出一台）')
    assert.equal(s2.list().length, 1, '名单仍只有 1 台')
    const disk2 = readJson(p)
    assert.equal(disk2.records.length, 1, '盘上也仍只有 1 行（同一记录的多张 secret 合并成一行）')
    assert.equal(disk2.records[0].secrets.length, 2, '新 secret 必须写进同一行的 secrets 数组')
    assert.ok(disk2.records[0].secrets.includes(m.secret), '旧 secret 不能丢')

    const before = Number(readJson(p).records[0].lastSeen) || 0
    const t = s2.touch(m.secret, { model: 'HUAWEI Mate 60 Pro' })
    assert.equal(t, true, 'touch 命中的旧 secret 应返回 true')
    assert.ok((Number(readJson(p).records[0].lastSeen) || 0) >= before, 'touch 后盘上 lastSeen 不许倒退（5s 节流窗口内可能仍是旧值，这是允许的）')

    const s3 = createDeviceStore({ devicesPath: p, revokedPath: rp })
    assert.equal(s3.touch(m.secret, { model: 'HUAWEI Mate 60 Pro' }), true, '新实例 touch 旧 secret 必须命中')
    const disk3 = readJson(p)
    assert.equal(Number(disk3.records[0].lastSeen) || 0, s3.list()[0].lastSeen, '新实例 touch 必须把 lastSeen 真写进盘')
    assert.equal(disk3.records.length, 1, 'touch 不许把记录写多')
    assert.equal(disk3.records[0].secrets.length, 2, 'touch 不许丢 secret')
    const s4 = createDeviceStore({ devicesPath: p, revokedPath: rp })
    assert.equal(s4.list()[0].lastSeen, s3.list()[0].lastSeen, '第四次建实例读回的 lastSeen 与写盘值一致')
    console.log('   [证据] 重启读回：rows=' + JSON.stringify(s2.list()) + ' 盘上 secrets 数=' + disk2.records[0].secrets.length)
  } finally { rmFile(p); rmFile(rp) }
})

test('② 设备表坏掉（非 JSON / 数组 / 空文件）⇒ 一律空表，绝不抛错、不崩路由', () => {
  const rp = tmpPath('b-revoked')
  try {
    const cases = [
      ['截断的 JSON', '{ "version": 1, "records": [ {'],
      ['根本不是 JSON', 'not json at all'],
      ['顶层是数组', '[1,2,3]'],
      ['空文件', ''],
      ['顶层是字符串', '"hello"'],
    ]
    for (const [label, raw] of cases) {
      const p = tmpPath('b')
      try {
        fs.writeFileSync(p, raw)
        const s = createDeviceStore({ devicesPath: p, revokedPath: rp })
        assert.deepEqual(s.list(), [], label + ' ⇒ list() 必须是空数组')
        assert.equal(s.isPaired('whatever'), false, label + ' ⇒ 不许凭空认得任何 secret')
        assert.equal(s.size, 0, label + ' ⇒ size 必须是 0')

        const m = s.mint({ uid: 'u-after-bad' })
        assert.ok(m && m.secret, label + ' ⇒ 坏文件之后仍必须能配对')
        assert.equal(s.list().length, 1)
        assert.equal(readJson(p).version, 1, label + ' ⇒ 下一次写盘必须覆盖成合法文件')
        console.log('   [证据] ' + label + ' ⇒ 空表可用，写盘后 version=1')
      } finally { rmFile(p) }
    }

    const p2 = tmpPath('b2')
    try {
      writeJson(p2, { version: 1, updatedMs: 1, records: [null, 42, 'x', { deviceId: '', secrets: ['s'] }, { deviceId: 'mp-x', secrets: [] }, { deviceId: 'mp-ok', secrets: ['sec-ok'] }] })
      const s = createDeviceStore({ devicesPath: p2, revokedPath: rp })
      const rows = s.list()
      assert.equal(rows.length, 1, '只有 deviceId + 至少一张 secret 的记录算数')
      assert.equal(rows[0].deviceId, 'mp-ok')
      assert.equal(s.isPaired('sec-ok'), true)
      console.log('   [证据] 脏 records 数组 ⇒ 只留下合法的 1 条')
    } finally { rmFile(p2) }
  } finally { rmFile(rp) }
})

test('③ 重启读回时：被拉黑的 deviceId 整条跳过、被拉黑的 secret 单张剔除，list() 里都不出现', () => {
  const p = tmpPath('c')
  const rp = tmpPath('c-revoked')
  try {

    writeJson(p, {
      version: 1, updatedMs: 1,
      records: [
        rec('mp-dead0001', ['dead-secret-1'], 'u-dead'),
        rec('mp-alive001', ['alive-secret', 'dead-secret-2'], 'u-alive'),
      ],
    })
    writeJson(rp, {
      version: 1, updatedMs: 1,
      deviceIds: ['mp-dead0001'], secrets: ['dead-secret-2'], uids: ['u-dead'],
      entries: [{ deviceId: 'mp-dead0001', uid: 'u-dead', secrets: ['dead-secret-1'], revokedMs: 1 }],
    })
    const s = createDeviceStore({ devicesPath: p, revokedPath: rp })
    assert.equal(s.isPaired('dead-secret-1'), false, '被拉黑 deviceId 名下的 secret 绝不能复活')
    assert.equal(s.isPaired('dead-secret-2'), false, '被单独拉黑的 secret 绝不能复活')
    assert.equal(s.isPaired('alive-secret'), true, '同一记录里没被拉黑的 secret 必须保留')
    const rows = s.list()
    assert.equal(rows.length, 1, '名单只能剩那台干净手机')
    assert.equal(rows[0].deviceId, 'mp-alive001')
    assert.ok(!JSON.stringify(rows).includes('dead-secret'), 'list() 里不许出现任何被拉黑的 secret')
    console.log('   [证据] 重启读回 rows=' + JSON.stringify(rows))

    const p3 = tmpPath('c3')
    const rp3 = tmpPath('c3-revoked')
    try {
      const s1 = createDeviceStore({ devicesPath: p3, revokedPath: rp3 })
      const m1 = s1.mint({ uid: 'u-real-1' })
      const m2 = s1.mint({ uid: 'u-real-2' })
      assert.equal(s1.list().length, 2)
      assert.equal(s1.revokeDevice(m1.deviceId), 1, '移除应删掉 1 条')
      assert.equal(s1.list().length, 1, '移除后名单立刻少一台')
      const s2 = createDeviceStore({ devicesPath: p3, revokedPath: rp3 })
      assert.equal(s2.isPaired(m1.secret), false, '重启后被移除的 secret 不许复活')
      assert.equal(s2.isPaired(m2.secret), true, '别的手机不受影响')
      assert.equal(s2.list().length, 1, '重启后名单里只剩没被移除的那台')
      assert.equal(s2.list()[0].deviceId, m2.deviceId)
      console.log('   [证据] 移除→重启：isPaired(被移除)=' + s2.isPaired(m1.secret) + ' 名单=' + s2.list().length)
    } finally { rmFile(p3); rmFile(rp3) }
  } finally { rmFile(p); rmFile(rp) }
})

test('④ 无 version 字段的老文件、以及 version 不匹配 ⇒ 一律当空表', () => {
  const rp = tmpPath('d-revoked')
  try {
    const files = [
      ['无 version（老文件）', { records: [rec('mp-old00001', ['old-secret'], 'u-old')] }],
      ['version=0', { version: 0, records: [rec('mp-old00001', ['old-secret'], 'u-old')] }],
      ['version=2（未来格式）', { version: 2, records: [rec('mp-old00001', ['old-secret'], 'u-old')] }],
      ['version 是字符串 "1"', { version: '1', records: [rec('mp-old00001', ['old-secret'], 'u-old')] }],
    ]
    for (const [label, j] of files) {
      const p = tmpPath('d')
      try {
        writeJson(p, j)
        const s = createDeviceStore({ devicesPath: p, revokedPath: rp })
        assert.deepEqual(s.list(), [], label + ' ⇒ 必须当空表')
        assert.equal(s.isPaired('old-secret'), false, label + ' ⇒ 老 secret 绝不认')
        console.log('   [证据] ' + label + ' ⇒ 空表（不抛错）')
      } finally { rmFile(p) }
    }
  } finally { rmFile(rp) }
})

let liveSeq = 0
async function serve(store) {
  const shell = {
    exchange: (t, about) => (String(t) === CODE6 ? store.exchange(t, about) : null),
    isPaired: (s) => store.isPaired(s),
    revoke: (s) => store.revoke(s),
    touch: (s, about) => store.touch(s, about),
  }
  const branch = createMpBranch({ dispatch: async () => ({ ok: true }), store: shell, log: () => {} })
  const srv = startLanServer({
    port: 20901 + (liveSeq++ * 2),
    allowShift: true,
    log: () => {},
    getToken: () => 'TOK',
    getInfo: () => ({
      name: '我的电脑', nodeId: 'dsh-console', host: 'host-1', dshOk: true,
      dshError: '', version: '9.9.9', agentPreset: 'ptc', agentPresetAvailable: true,
    }),
    listSessions: async () => [],
    runCommand: async () => ({ ok: true }),
    cloud: null,
  })

  const issueDevice = (about) => {
    const r = store.mint(about)
    return r && r.secret ? 'mp_device=' + encodeURIComponent(r.secret) : ''
  }
  srv.setMp({ branch, store, issueDevice })
  const started = await srv.start()
  assert.ok(started, '临时 lan-server 必须起得来（端口段 20901+）')
  assert.notEqual(started.port, 8899, '绝不许占用 8899')
  const base = 'http://127.0.0.1:' + started.port
  return {
    base,
    accept: async (body) => {
      const r = await fetch(base + '/mp/pair/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ token: CODE6 }, body || {})),
      })
      const sc = r.headers.get('set-cookie') || ''
      const m = sc.match(/mp_device=([^;]+)/)
      return { status: r.status, json: await r.json(), secret: m ? decodeURIComponent(m[1]) : '' }
    },
    cookie: async (qs, secret) => {
      const headers = secret ? { Cookie: 'mp_device=' + encodeURIComponent(secret) } : {}
      return fetch(base + '/mp-cookie?token=TOK' + (qs || ''), { headers })
    },
    info: async () => (await fetch(base + '/info?token=TOK')).json(),
    close: () => srv.stop(),
  }
}

test('⑥ 端到端：真服务重启后，老 mp_device Cookie 照旧能用、/info 名单原样读回（名单不再清空）', async () => {
  const p = tmpPath('f')
  const rp = tmpPath('f-revoked')
  let s1 = null
  let s2 = null
  try {

    const store1 = createDeviceStore({ devicesPath: p, revokedPath: rp })
    s1 = await serve(store1)
    const a = await s1.accept({ deviceModel: 'HUAWEI Mate 60', deviceName: '我的手机', deviceUid: 'u-restart-1', accountUid: 'hw-openid-R1', accountName: '小美' })
    assert.equal(a.status, 200, '首次配对必须成功')
    assert.ok(a.secret.length > 0, '必须下发 mp_device Cookie')
    const info1 = await s1.info()
    assert.equal(info1.deviceCount, 1, '重启前名单里 1 台')
    const devId1 = String(info1.devices[0].deviceId || '')
    assert.ok(devId1.startsWith('mp-'), 'deviceId 形状必须是 mp-*')
    assert.ok(!JSON.stringify(info1).includes(a.secret), '/info 绝不能带出 secret')
    await s1.close()
    s1 = null
    console.log('   [证据] 重启前 /info.devices = ' + JSON.stringify(info1.devices))

    const store2 = createDeviceStore({ devicesPath: p, revokedPath: rp })
    s2 = await serve(store2)

    const info2 = await s2.info()
    assert.equal(info2.deviceCount, 1, '重启后 /info 必须还能看到那台手机（以前 = 0，显示「还没有手机配对过」）')
    assert.equal(info2.devices[0].deviceId, devId1, 'deviceId 必须逐字一样')
    assert.equal(info2.devices[0].uid, 'u-restart-1')
    assert.equal(info2.devices[0].accountUid, 'hw-openid-R1', '手机自报账号必须跟着重启读回')
    assert.equal(info2.devices[0].accountName, '小美')
    assert.ok(!JSON.stringify(info2).includes(a.secret), '重启后的 /info 也绝不能带出 secret')

    const again = await s2.cookie('&deviceUid=u-restart-1', a.secret)
    assert.equal(again.status, 200, '重启后带旧 Cookie 打 /mp-cookie 必须 200')
    const info3 = await s2.info()
    assert.equal(info3.deviceCount, 1, '重签不许凭空多出一台（同 uid 仍是同一台）')
    assert.equal(info3.devices[0].deviceId, devId1, '重签后 deviceId 不许变')
    assert.equal(info3.devices[0].accountName, '小美', '重签不许把自报账号擦掉')
    console.log('   [证据] 重启后 /info.deviceCount=' + info3.deviceCount + ' deviceId=' + info3.devices[0].deviceId + ' 老 Cookie 重签 status=' + again.status)
  } finally {
    if (s1) await s1.close()
    if (s2) await s2.close()
    rmFile(p); rmFile(rp)
  }
})

test('⑤ 设备表坏掉不许让黑名单失效（两文件独立），且全程不碰用户真实文件', () => {
  const p = tmpPath('e')
  const rp = tmpPath('e-revoked')
  const realDevices = path.join(os.homedir(), '.dsh', 'dsh-console-devices.json')
  const existedBefore = fs.existsSync(realDevices)
  try {
    writeJson(rp, { version: 1, updatedMs: 1, deviceIds: ['mp-x'], secrets: [], uids: [], entries: [] })
    fs.writeFileSync(p, 'broken json')
    const s = createDeviceStore({ devicesPath: p, revokedPath: rp })
    assert.equal(s.isRevoked({ deviceId: 'mp-x' }), true, '设备表坏了也不能让黑名单失效')
    assert.deepEqual(s.list(), [], '设备表坏 ⇒ 空名单')
    assert.equal(fs.existsSync(realDevices), existedBefore, '单测绝不许创建/修改用户真实设备表（' + realDevices + '）')
    console.log('   [证据] 设备表坏 + 黑名单好 ⇒ isRevoked=true，真实文件未被创建')
  } finally { rmFile(p); rmFile(rp) }
})
