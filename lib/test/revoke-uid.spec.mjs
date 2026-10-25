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
  return path.join(os.tmpdir(), 'dsh-console-revoke-uid-spec-' + (tag || 'x') + '-' + process.pid + '-' + (tmpSeq++) + '.json')
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

test('①②③ revokeUid：同 uid 多条一次全删返条数、别的 uid 不受影响、空 uid 返 0 不删', () => {
  const p = tmpPath('a')
  const rp = tmpPath('a-revoked')
  try {

    writeJson(p, {
      version: 1, updatedMs: 1,
      records: [
        rec('mp-dup00001', ['sec-dup-1'], 'u-dup'),
        rec('mp-dup00002', ['sec-dup-2'], 'u-dup'),
        rec('mp-othe0001', ['sec-other'], 'u-other'),
        rec('mp-none0001', ['sec-none'], ''),
      ],
    })
    const s = createDeviceStore({ devicesPath: p, revokedPath: rp })

    assert.equal(s.isPaired('sec-dup-1'), true, '前置：同 uid 的第 1 条 secret 在表里')
    assert.equal(s.isPaired('sec-dup-2'), true, '前置：同 uid 的第 2 条 secret 也在表里')
    assert.equal(s.list().length, 3, '前置：list() 里 4 条记录归并成 3 行（同 uid 两条算一行的同一台）')

    assert.equal(s.revokeUid(''), 0, '空 uid 必须返回 0')
    assert.equal(s.revokeUid('   '), 0, '纯空白 uid 必须返回 0')
    assert.equal(s.revokeUid(null), 0, 'null uid 必须返回 0')
    assert.equal(s.isPaired('sec-dup-1'), true, '空 uid 之后一条都不许少')
    assert.equal(s.isPaired('sec-dup-2'), true, '空 uid 之后一条都不许少')
    assert.equal(s.list().length, 3, '空 uid 之后名单行数不变')
    console.log('   [证据] 空 uid ⇒ 返回 0，名单仍 ' + s.list().length + ' 条')

    const removed = s.revokeUid('u-dup')
    assert.equal(removed, 2, '同 uid 的两条必须一次删尽（返回 2）')
    assert.equal(s.list().length, 2, '删完只剩另外两台')
    assert.equal(s.isPaired('sec-dup-1'), false, '旧 secret 1 必须失效')
    assert.equal(s.isPaired('sec-dup-2'), false, '旧 secret 2 必须失效')

    assert.equal(s.isPaired('sec-other'), true, '别的 uid 那台必须原样还在')
    assert.equal(s.isPaired('sec-none'), true, '没有 uid 的老记录不受影响')
    const uids = s.list().map((d) => d.uid).sort()
    assert.deepEqual(uids, ['', 'u-other'], '名单必须只剩 u-other 与空 uid 那条')
    assert.equal(s.revokeUid('u-not-exist'), 0, '不存在的 uid 返回 0')

    const onDisk = readJson(p)
    assert.deepEqual(onDisk.records.map((r) => r.uid).sort(), ['', 'u-other'], '盘上必须也只剩这两条')

    assert.equal(fs.existsSync(rp), false, 'revokeUid 绝不许写撤销黑名单文件')
    assert.equal(s.isRevoked({ uid: 'u-dup' }), false, 'u-dup 不许被拉黑（撤销 ≠ 拉黑）')
    console.log('   [证据] revokeUid(u-dup)=' + removed + ' ⇒ 名单 ' + JSON.stringify(uids) + '，黑名单文件未生成=' + (fs.existsSync(rp) === false))
  } finally { rmFile(p); rmFile(rp) }
})

test('④ revokeUid 落盘：新建 store 实例（模拟重启）读回后该 uid 不再出现，别的仍在', () => {
  const p = tmpPath('b')
  const rp = tmpPath('b-revoked')
  try {
    const s1 = createDeviceStore({ devicesPath: p, revokedPath: rp })
    const m1 = s1.mint({ uid: 'u-restart-gone', model: 'HUAWEI Mate 60', name: '被移除的' })
    const m2 = s1.mint({ uid: 'u-restart-keep', model: 'HUAWEI P70', name: '留下的' })
    assert.ok(m1 && m1.secret && m2 && m2.secret, '先要有两条真配对')
    assert.equal(s1.list().length, 2)
    assert.equal(s1.revokeUid('u-restart-gone'), 1, '删 1 条')

    const onDisk = readJson(p)
    const diskUids = onDisk.records.map((r) => r.uid).sort()
    assert.deepEqual(diskUids, ['u-restart-keep'], '盘上必须只剩留下的那台')
    assert.ok(!JSON.stringify(onDisk).includes(m1.secret), '盘上不许再有被撤销那台的 secret')

    const s2 = createDeviceStore({ devicesPath: p, revokedPath: rp })
    assert.equal(s2.list().length, 1, '重启后名单里只剩另一台')
    assert.equal(s2.list()[0].uid, 'u-restart-keep')
    assert.equal(s2.isPaired(m1.secret), false, '被撤销的 secret 重启后不许复活')
    assert.equal(s2.isPaired(m2.secret), true, '另一台的 Cookie 照常可用')

    const again = s2.exchange(CODE6, { uid: 'u-restart-gone', model: 'HUAWEI Mate 60', name: '被移除的' })
    assert.ok(again && again.secret, '设备重新配对必须成功（没有黑名单挡着）')
    assert.equal(s2.list().length, 2, '重新配对后名单回到 2 台')
    console.log('   [证据] 重启后名单=' + s2.list().length + '，老 secret 复活=' + s2.isPaired(m1.secret) + '，重配成功=' + !!(again && again.secret))
  } finally { rmFile(p); rmFile(rp) }
})

let liveSeq = 0
async function serve(store, opts) {
  const o = opts || {}
  const shell = {
    exchange: (t, about) => (String(t) === CODE6 ? store.exchange(t, about) : null),
    isPaired: (s) => store.isPaired(s),
    revoke: (s) => store.revoke(s),
    touch: (s, about) => store.touch(s, about),
  }

  if (!o.legacyShell) shell.revokeUid = (u) => store.revokeUid(u)
  const branch = createMpBranch({ dispatch: async () => ({ ok: true }), store: shell, log: () => {} })
  const srv = startLanServer({
    port: 21101 + (liveSeq++ * 2),
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
  assert.ok(started, '临时 lan-server 必须起得来（端口段 21101+）')
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
    revoke: async (body, secret, method) => {
      const headers = { 'content-type': 'application/json' }
      if (secret) headers.Cookie = 'mp_device=' + encodeURIComponent(secret)
      const r = await fetch(base + '/mp/pair/revoke', {
        method: method || 'POST', headers,
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      })
      return { status: r.status, json: await r.json().catch(() => ({})) }
    },
    info: async () => (await fetch(base + '/info?token=TOK')).json(),
    close: () => srv.stop(),
  }
}

test('①④端到端 App 移除节点：POST {deviceUid} ⇒ 200 {ok:true,removed:1}，面板名单立刻少一台且重启后仍不在', async () => {
  const p = tmpPath('c')
  const rp = tmpPath('c-revoked')
  let s1 = null
  let s2 = null
  try {
    const store1 = createDeviceStore({ devicesPath: p, revokedPath: rp })
    s1 = await serve(store1)
    const a = await s1.accept({ deviceUid: 'u-app-removed', deviceModel: 'HUAWEI Mate 60', deviceName: '被移除的' })
    const b = await s1.accept({ deviceUid: 'u-app-kept', deviceModel: 'HUAWEI P70', deviceName: '留下的' })
    assert.equal(a.status, 200, '第一台配对成功')
    assert.equal(b.status, 200, '第二台配对成功')
    assert.equal((await s1.info()).deviceCount, 2, '移除前名单 2 台')
    const devIdA = (await s1.info()).devices.find((d) => d.uid === 'u-app-removed').deviceId

    const rv = await s1.revoke({ deviceUid: 'u-app-removed' }, b.secret)
    assert.equal(rv.status, 200, '带合法 Cookie 的撤销必须 200')
    assert.equal(rv.json.ok, true)
    assert.equal(rv.json.removed, 1, '必须回删除条数 = 1')

    const info1 = await s1.info()
    assert.equal(info1.deviceCount, 1, '面板名单必须立刻少一台（用户 m00690 的痛点）')
    assert.equal(info1.devices[0].uid, 'u-app-kept', '留下的必须是另一台')
    assert.ok(!info1.devices.some((d) => d.deviceId === devIdA), '被移除的 deviceId 不许还在')
    assert.ok(!JSON.stringify(info1).includes(a.secret), '/info 仍绝不许带出 secret')
    console.log('   [证据] 撤销后 /info.deviceCount=' + info1.deviceCount + ' devices=' + JSON.stringify(info1.devices))

    await s1.close(); s1 = null

    const store2 = createDeviceStore({ devicesPath: p, revokedPath: rp })
    s2 = await serve(store2)
    const info2 = await s2.info()
    assert.equal(info2.deviceCount, 1, '重启后名单仍只有 1 台')
    assert.equal(info2.devices[0].uid, 'u-app-kept')
    console.log('   [证据] 重启后 /info.deviceCount=' + info2.deviceCount + ' devices=' + JSON.stringify(info2.devices))
  } finally {
    if (s1) await s1.close()
    if (s2) await s2.close()
    rmFile(p); rmFile(rp)
  }
})

test('⑤ 安全红线：无 Cookie ⇒ 401 not-paired；Cookie 未配对 ⇒ 403 forbidden；两种都一条不删', async () => {
  const p = tmpPath('d')
  const rp = tmpPath('d-revoked')
  let s = null
  try {
    const store = createDeviceStore({ devicesPath: p, revokedPath: rp })
    s = await serve(store)
    const ok = await s.accept({ deviceUid: 'u-victim', deviceModel: 'HUAWEI Mate 60', deviceName: '受害人' })
    assert.equal(ok.status, 200)
    assert.equal((await s.info()).deviceCount, 1)

    const noCookie = await s.revoke({ deviceUid: 'u-victim' }, '')
    assert.equal(noCookie.status, 401, '无 Cookie 必须 401')
    assert.equal(noCookie.json.error, 'not-paired', '错误码必须逐字是 not-paired')
    assert.equal((await s.info()).deviceCount, 1, '被拒的请求一条都不许删')

    const badCookie = await s.revoke({ deviceUid: 'u-victim' }, 'ffffffffffffffffffffffffffffffffffffffffffffffff')
    assert.equal(badCookie.status, 403, '未配对 Cookie 必须 403')
    assert.equal(badCookie.json.code, 'forbidden')
    assert.equal(badCookie.json.error, 'device-not-paired')
    assert.equal((await s.info()).deviceCount, 1, '被拒的请求一条都不许删')

    const emptyBody = await s.revoke({}, '')
    assert.equal(emptyBody.status, 401, '空 body 无 Cookie 也是 401')

    assert.equal(store.revokeUid('u-victim'), 1, '合法调用（配对的电脑侧进程内）才删得掉')
    assert.equal((await s.info()).deviceCount, 0, '这次真的删掉了')
    console.log('   [证据] 无 Cookie=' + noCookie.status + '/' + noCookie.json.error + '，坏 Cookie=' + badCookie.status + '/' + badCookie.json.error + '，两次之后名单仍 1 台')
  } finally {
    if (s) await s.close()
    rmFile(p); rmFile(rp)
  }
})

test('⑤b 老客户端/老 store 回落：GET 或空 body 时删的是当前 Cookie 那条，回 {ok:true}', async () => {
  const p = tmpPath('e')
  const rp = tmpPath('e-revoked')
  let s = null
  try {
    const store = createDeviceStore({ devicesPath: p, revokedPath: rp })
    s = await serve(store, { legacyShell: true })
    const a = await s.accept({ deviceUid: 'u-legacy-1', deviceModel: 'HUAWEI Mate 60', deviceName: '老客户端' })
    assert.equal(a.status, 200)
    assert.equal((await s.info()).deviceCount, 1)

    const r1 = await s.revoke({}, a.secret)
    assert.equal(r1.status, 200)
    assert.equal(r1.json.ok, true)
    assert.equal(r1.json.removed, undefined, '旧路径的响应不许凭空多出 removed 字段')
    assert.equal((await s.info()).deviceCount, 0, '旧路径必须把当前那台删掉')

    const b = await s.accept({ deviceUid: 'u-legacy-2', deviceModel: 'HUAWEI P70', deviceName: '老客户端2' })
    const r2 = await s.revoke({ deviceUid: 'u-legacy-2' }, b.secret, 'GET')
    assert.equal(r2.status, 200)
    assert.equal(r2.json.ok, true)
    assert.equal((await s.info()).deviceCount, 0, 'GET 老行为不变（删当前 Cookie 那条）')
    console.log('   [证据] legacy 壳 + 空 body ⇒ ' + JSON.stringify(r1.json) + '；GET ⇒ ' + JSON.stringify(r2.json))
  } finally {
    if (s) await s.close()
    rmFile(p); rmFile(rp)
  }
})
