/**
 * 🔴 第193节 · task-1（插件半）单测：A「移除设备必须真断开、须重新配对」+ B「手机自报登录账号」。
 *
 * 为什么要有这个文件（背景）：
 *   A) 面板上「移除这台手机」以前只做 devices.delete(...)（mp-support.mjs 的 revokeDevice）——
 *      devices 是**进程内 Map**，所以 ① DSH 一重启就全忘 ② 手机持长期 token 打一发
 *      /dsh-console/mp-cookie 就被免码签发（issueDevice → mint）立刻塞回登记表。
 *      本次新增**落盘撤销黑名单**（默认 ~/.dsh/dsh-console-revoked.json，原子写），
 *      移除时把 deviceId / uid / 名下所有 secret 一起拉黑；mint 拒签、/mp-cookie 回
 *      403 device-revoked、touch 不复活；只有**拿 6 位码重新配对**才解黑（用户自救通路）。
 *   B) 手机在 /mp-cookie 的 query 上自报 accountUid（华为 openId）/ accountName（昵称），
 *      由 aboutOf 解析进设备记录 selfAccountUid/selfAccountName，list() 以
 *      accountUid/accountName 原样下发，供 App 判「这台手机登录的账号是不是我自己」。
 *      ⚠️ 硬约束：**绝不许拿本机云绑定兜底**（手机没自报就是空串）。
 *
 * 端口段：19901 起（与 18901 preset-info / 19101 device-roster / 19501 host-isolation /
 *   19701 device-revoke 都错开，node --test 并行跑各 spec 时不互抢）。
 * 落盘隔离：每条用例显式传自己的 os.tmpdir() 文件（createDeviceStore({revokedPath, devicesPath})），
 *   **绝不碰用户的 ~/.dsh/dsh-console-revoked.json**；用例结束删掉临时文件。
 *   🔴 2026-10-16 补：以前漏传 devicesPath ⇒ 落进 TEMP 默认名 dsh-console-devices-test-<pid>-<seq>.json，
 *   Windows 复用 pid 且 seq 每进程从 0 起 ⇒ 撞上历史残留文件，用例①起步就带 2 条旧记录
 *   （store.list().length=3 ≠ 1）⇒ ① ② ③ ⑤ ⑥ ⑦ 连锁 fail 6，且只在全量跑时偶发。
 *
 * 跑法：node --test lib/test/device-revoke-blacklist.spec.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDeviceStore } from '../mp-support.mjs'
import { aboutOf, createMpBranch } from '../mp-routes.mjs'
import { startLanServer } from '../lan-server.mjs'

/** 真配对码（createMpBranch 的 shell 只认它，模拟「面板当前有效码」）。 */
const CODE6 = '314159'

let tmpSeq = 0
function tmpPath() {
  return path.join(os.tmpdir(), 'dsh-console-revoked-spec-' + process.pid + '-' + (tmpSeq++) + '.json')
}
function rmFile(p) { try { fs.rmSync(p, { force: true }) } catch (e) { /* 忽略 */ } }
/** 设备登记表的临时文件路径：与 revokedPath 同源不同名，绝不落进 TEMP 默认名（防 pid 复用撞旧文件）。 */
function devPath(p) { return p.replace('dsh-console-revoked-spec-', 'dsh-console-devices-spec-') }
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

/* ============================================================
 * ① 拉黑后 mint 拒签
 * ============================================================ */
test('task-1 ① 按 deviceId 移除后：同一 uid 的 mint 一律拒签（返回 null），别的手机不受影响', () => {
  const p = tmpPath()
  try {
    const store = createDeviceStore({ revokedPath: p, devicesPath: devPath(p) })
    const a = store.mint({ uid: 'phone-A', model: 'Mate60' })
    assert.ok(a && a.secret, '配对必须成功')
    assert.equal(store.list().length, 1)

    assert.equal(store.revokeDevice(a.deviceId), 1, '移除应删掉 1 条')
    assert.equal(store.isPaired(a.secret), false, '旧 secret 立刻失效')
    assert.equal(store.list().length, 0, '名单立刻清空')

    /* 🔴 核心：同一台手机再走免码铸造（/mp-cookie 的 issueDevice → mint）必须拒签 */
    assert.equal(store.mint({ uid: 'phone-A' }), null, '被移除的手机不许再铸造新凭据')
    assert.equal(store.mint({ uid: 'phone-A', model: 'Mate60' }), null, '带机型也一样拒签')
    assert.equal(store.list().length, 0, '拒签之后名单里仍不许出现它')

    /* 反向红线：黑名单不许误伤别的手机 / 不带 uid 的老请求 */
    const b = store.mint({ uid: 'phone-B' })
    assert.ok(b && b.secret, '别的手机必须能正常配对')
    assert.ok(store.mint({ model: '不带 uid 的老客户端' }), '不带 uid 的老请求不许被黑名单误杀')
    assert.equal(store.list().length, 2)
    console.log('   [证据] 移除后 mint(phone-A)=null；mint(phone-B) 正常；名单 ' + store.list().map((d) => d.deviceId).join(' | '))
  } finally { rmFile(p); rmFile(devPath(p)) }
})

/* ============================================================
 * ② 端到端：真起 LAN 服务 —— 移除后 /mp-cookie 回 403 device-revoked
 * ============================================================ */
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
    port: 19901 + (liveSeq++ * 2),
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
  /* 与 mp-support.attachMp 的 issueDevice 逐字同形：mint(about) + 拼 Cookie 或 '' */
  const issueDevice = (about) => {
    const r = store.mint(about)
    return r && r.secret ? 'mp_device=' + encodeURIComponent(r.secret) : ''
  }
  srv.setMp({ branch, store, issueDevice })
  const started = await srv.start()
  assert.ok(started, '临时 lan-server 必须起得来（端口段 19901+）')
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

test('task-1 ② 真 socket：移除后 /mp-cookie 必须 403 device-revoked（不是被免码重签回去）', async () => {
  const p = tmpPath()
  const store = createDeviceStore({ revokedPath: p, devicesPath: devPath(p) })
  const s = await serve(store)
  try {
    const a = await s.accept({ deviceModel: 'HUAWEI Mate 60', deviceName: '我的手机', deviceUid: 'u-e2e-1' })
    assert.equal(a.status, 200, '配对必须成功')
    assert.ok(a.secret.length > 0)
    assert.equal((await s.info()).deviceCount, 1)

    /* —— 移除之前：带旧 Cookie 打 /mp-cookie 是 200（这就是那条「重新入表」的通路）—— */
    const before = await s.cookie('&deviceUid=u-e2e-1', a.secret)
    assert.equal(before.status, 200, '移除前 /mp-cookie 必须 200')

    const rows = (await s.info()).devices
    const deviceId = String(rows[0].deviceId || '')
    assert.ok(deviceId.startsWith('mp-'))
    /* ⚠️ 上面那次「移除前 200」的 /mp-cookie 又免码铸了一张 secret（别名是既有常态：
       同一 uid 多次 mint ⇒ 多张 secret 指向同一条记录）⇒ 这里应恰好删掉 2 条。 */
    assert.equal(store.revokeDevice(deviceId), 2, '面板移除应把这台手机名下两张 secret 全删掉')
    assert.equal((await s.info()).deviceCount, 0, '移除后名单立刻清零')

    /* 🔴 核心：移除后再打 —— 带旧 Cookie 也罢、不带 Cookie 只报同一个 uid 也罢，都 403 */
    const again = await s.cookie('&deviceUid=u-e2e-1', a.secret)
    assert.equal(again.status, 403, '被移除的设备再打 /mp-cookie 必须 403')
    assert.deepEqual(await again.json(), { ok: false, error: 'device-revoked' }, '错误码必须是 device-revoked（不许混用 409 的签发失败）')
    const noCookie = await s.cookie('&deviceUid=u-e2e-1', '')
    assert.equal(noCookie.status, 403, '不带旧 Cookie、但报的是被移除那台手机的 uid，也必须 403')

    /* 反向红线：全新手机照常 200，且 403 的那台不会借别的请求重新入表 */
    const fresh = await s.cookie('&deviceUid=u-fresh-9', '')
    assert.equal(fresh.status, 200, '没被移除的手机不许被误杀')
    const j = await s.info()
    assert.equal(j.deviceCount, 1, '名单里只该有那台全新手机')
    assert.equal(j.devices[0].uid, 'u-fresh-9')

    /* ⑥ 6 位码重新配对 ⇒ 放行 + 解黑，之后 /mp-cookie 恢复可用 */
    const re = await s.accept({ deviceModel: 'HUAWEI Mate 60', deviceName: '我的手机', deviceUid: 'u-e2e-1' })
    assert.equal(re.status, 200, '用户主动重新配对必须放行（唯一自救通路）')
    assert.ok(re.secret.length > 0)
    const healed = await s.cookie('&deviceUid=u-e2e-1', re.secret)
    assert.equal(healed.status, 200, '解黑之后 /mp-cookie 必须恢复 200')

    /* 端到端（B）：手机在 query 上自报登录账号 ⇒ 走过真 /mp-cookie → mint → 面板 /info
       的设备行必须以 accountUid/accountName 原样出现（App 节点管理页读的就是它）。 */
    const acct = await s.cookie('&deviceUid=u-e2e-1&accountUid=hw-openid-XYZ&accountName=%E5%B0%8F%E7%BE%8E', '')
    assert.equal(acct.status, 200, '自报账号的 /mp-cookie 必须 200')
    const j2 = await s.info()
    const row = j2.devices.find((d) => d.uid === 'u-e2e-1')
    assert.ok(row, '名单里必须有这台手机')
    assert.equal(row.accountUid, 'hw-openid-XYZ', '端到端：面板行必须带手机自报的 accountUid')
    assert.equal(row.accountName, '小美', '端到端：面板行必须带手机自报的 accountName')
    console.log('   [证据] 移除前 200 → 移除后带旧Cookie ' + again.status + ' / 不带Cookie ' + noCookie.status + '（device-revoked）→ 重新配对后 ' + healed.status)
  } finally { s.close(); rmFile(p); rmFile(devPath(p)) }
})

/* ============================================================
 * ③ 6 位码 exchange 放行且解黑、之后 mint 恢复可用
 * ============================================================ */
test('task-1 ③ exchange（6 位码）放行并解黑：之后 mint 恢复、文件里的黑名单项被清空', () => {
  const p = tmpPath()
  try {
    const store = createDeviceStore({ revokedPath: p, devicesPath: devPath(p) })
    const a = store.mint({ uid: 'u-heal' })
    assert.equal(store.revokeDevice(a.deviceId), 1)
    assert.equal(store.mint({ uid: 'u-heal' }), null, '前置：拉黑后确实拒签')
    assert.equal(store.isRevoked({ uid: 'u-heal' }), true, '前置：isRevoked 命中')
    const onDisk = readJson(p)
    assert.ok(onDisk.deviceIds.indexOf(a.deviceId) >= 0, 'deviceId 必须落盘')
    assert.ok(onDisk.uids.indexOf('u-heal') >= 0, 'uid 必须落盘')
    assert.ok(onDisk.secrets.indexOf(a.secret) >= 0, '旧 secret 必须落盘')

    /* 🔴 用户唯一自救通路：拿面板 6 位码重新配对 */
    const r = store.exchange(CODE6, { uid: 'u-heal', model: 'Mate60' })
    assert.ok(r && r.secret, 'exchange 必须放行（返回新 secret）')
    assert.equal(store.isRevoked({ uid: 'u-heal' }), false, 'exchange 必须解黑')
    assert.equal(store.isRevoked({ secret: a.secret }), false, '旧 secret 也一并解黑')
    assert.equal(store.isRevoked({ deviceId: a.deviceId }), false, 'deviceId 也一并解黑')
    assert.equal(store.list().length, 1, '解黑后名单里应正好 1 行')
    assert.ok(store.mint({ uid: 'u-heal', model: 'Mate60' }), '解黑之后 mint 必须恢复可用')
    assert.equal(store.list().length, 1, '恢复后仍只 1 行（同 uid 去重没被破坏）')

    const cleared = readJson(p)
    assert.deepEqual(cleared.deviceIds, [], '文件里 deviceId 黑名单应清空')
    assert.deepEqual(cleared.uids, [], '文件里 uid 黑名单应清空')
    assert.deepEqual(cleared.secrets, [], '文件里 secret 黑名单应清空')
    assert.deepEqual(cleared.entries, [], '文件里条目应整条删掉')
    /* 非 6 位码不许解黑（exchange 的既有语义：不是 6 位数字直接 null） */
    assert.equal(store.exchange('abc', { uid: 'u-heal' }), null)
    console.log('   [证据] 拉黑 → exchange(' + CODE6 + ') 返回 secret → mint 恢复；文件黑名单已清空')
  } finally { rmFile(p); rmFile(devPath(p)) }
})

/* ============================================================
 * ④ 手机自报 accountUid/accountName 落进记录并在 list() 里原样输出（不许本机兜底）
 * ============================================================ */
test('task-1 ④ 自报账号原样落库/下发；没自报的一律空串（本机云绑定绝不兜底）', () => {
  const p = tmpPath()
  try {
    const store = createDeviceStore({ revokedPath: p, devicesPath: devPath(p) })
    /* 本机云绑定有账号 —— 它就是「绝不能拿来兜底」的那个来源 */
    store.setIdentity(() => ({ account: '本机账号', cloudUid: 'cloud-uid-1', pubId: 'pub-abc123' }))

    const a = store.mint({ uid: 'u-acct-1', accountUid: 'wx-openid-AAA', accountName: '小明' })
    assert.ok(a && a.secret)
    const rowA = store.list().find((d) => d.uid === 'u-acct-1')
    assert.equal(rowA.accountUid, 'wx-openid-AAA', 'accountUid 必须原样下发')
    assert.equal(rowA.accountName, '小明', 'accountName 必须原样下发')

    /* 🔴 反例（契约红线）：没自报账号的手机 —— 哪怕本机云绑定有账号，这两字段也必须是空串 */
    const b = store.mint({ uid: 'u-acct-2', model: 'Mate60' })
    assert.ok(b && b.secret)
    const rowB = store.list().find((d) => d.uid === 'u-acct-2')
    assert.equal(rowB.accountUid, '', '🔴 不许拿本机账号兜底 accountUid')
    assert.equal(rowB.accountName, '', '🔴 不许拿本机账号兜底 accountName')
    assert.equal(rowB.account, '本机账号', '既有 account 兜底链必须保持原样（不许顺手改掉）')
    assert.equal(rowB.cloudUid, 'cloud-uid-1', '既有 cloudUid 兜底链必须保持原样')
    assert.equal(rowB.pubId, 'pub-abc123', '既有 pubId 兜底链必须保持原样')

    /* touch 续期时也只补空位：第二次不带账号的自报不许清空已存的值 */
    store.touch(a.secret, { uid: 'u-acct-1', model: 'Mate60' })
    assert.equal(store.list().find((d) => d.uid === 'u-acct-1').accountUid, 'wx-openid-AAA', 'touch 不许清掉已存的自报账号')
    /* 第一次没自报、第二次自报 ⇒ 补上（只填空位） */
    store.touch(b.secret, { uid: 'u-acct-2', accountUid: 'wx-openid-BBB', accountName: '小红' })
    const rowB2 = store.list().find((d) => d.uid === 'u-acct-2')
    assert.equal(rowB2.accountUid, 'wx-openid-BBB')
    assert.equal(rowB2.accountName, '小红')
    /* 白名单里绝不许出现 secret */
    assert.equal(Object.keys(rowA).indexOf('secret'), -1, 'list() 白名单绝不含 secret')
    console.log('   [证据] 行键 = ' + Object.keys(rowA).sort().join(',') + '；未自报行 accountUid=' + JSON.stringify(rowB.accountUid))
  } finally { rmFile(p); rmFile(devPath(p)) }
})

/* ============================================================
 * ⑤ 老请求（不带两个新键）：字段空串、行为与改动前逐字一致
 * ============================================================ */
test('task-1 ⑤ 老客户端（不带 accountUid/accountName）：两字段空串，其余行为逐字不回归', () => {
  const p = tmpPath()
  try {
    const store = createDeviceStore({ revokedPath: p, devicesPath: devPath(p) })
    const a = store.mint({ uid: 'u-old-1', model: 'Mate60', name: '我的手机' })
    const b = store.mint({ uid: 'u-old-1', model: 'Mate60', name: '我的手机' })
    assert.equal(b.deviceId, a.deviceId, '同 uid 必须沿用同一 deviceId（既有去重语义）')
    assert.notEqual(b.secret, a.secret, '两次 mint 必须是两张 secret')
    assert.equal(store.list().length, 1, '同 uid 仍只 1 行')

    const rows = store.list()
    const row = rows[0]
    /* 逐字一致：除了新增的两个键，行的键集合与改动前完全相同 */
    const oldKeys = ['deviceId', 'model', 'name', 'pairedAt', 'lastSeen', 'online', 'uid', 'cloudUid', 'pubId', 'account']
    assert.deepEqual(
      Object.keys(row).filter((k) => k !== 'accountUid' && k !== 'accountName').sort(),
      oldKeys.slice().sort(),
      '老键集合必须逐字不变')
    assert.equal(row.accountUid, '', '没自报 ⇒ accountUid 空串')
    assert.equal(row.accountName, '', '没自报 ⇒ accountName 空串')
    assert.equal(row.uid, 'u-old-1')
    assert.equal(row.model, 'Mate60')
    assert.equal(row.name, '我的手机')
    assert.equal(row.account, '', '本机没绑账号时 account 仍为空串（老行为）')
    assert.equal(typeof row.lastSeen, 'number')
    assert.equal(row.online, true, '刚 mint 完必须在线上（口径只认 lastSeen）')

    /* 老请求的解析结果也不许变：aboutOf 不带新键 ⇒ 两个空串 */
    const q = aboutOf({ url: '/mp-cookie?token=TOK&deviceUid=u-old-1', headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 12) HUAWEI Mate 60 Build/x' } }, null)
    assert.equal(q.uid, 'u-old-1')
    assert.equal(q.accountUid, '', 'query 上没有 accountUid ⇒ 空串')
    assert.equal(q.accountName, '', 'query 上没有 accountName ⇒ 空串')

    /* 没有 uid 的老请求仍各算一台（既有红线不回归） */
    const x1 = store.mint({ model: 'A' })
    const x2 = store.mint({ model: 'B' })
    assert.notEqual(x1.deviceId, x2.deviceId, '没有 uid 时必须各算一台')
    assert.equal(store.list().length, 3)
    assert.equal(store.list().every((d) => d.accountUid === '' && d.accountName === ''), true)
    console.log('   [证据] 老请求行键 = ' + Object.keys(row).sort().join(',') + '；名单 ' + store.list().length + ' 行')
  } finally { rmFile(p); rmFile(devPath(p)) }
})

/* ============================================================
 * ⑥ 落盘：重启（新实例）后仍然拉黑；路径就是传进来的那个文件
 * ============================================================ */
test('task-1 ⑥ 落盘黑名单：重启后（新 store 实例）依然拒签，文件结构含 deviceId/uid/secret 三索引', () => {
  const p = tmpPath()
  try {
    const a = createDeviceStore({ revokedPath: p, devicesPath: devPath(p) })
    const m = a.mint({ uid: 'u-restart', model: 'Mate60' })
    assert.equal(a.revokeDevice(m.deviceId), 1)
    assert.equal(fs.existsSync(p), true, '撤销必须落盘到指定路径：' + p)
    const j = readJson(p)
    assert.equal(j.version, 1)
    assert.ok(Number(j.updatedMs) > 0, 'updatedMs 必须写')
    assert.deepEqual(j.deviceIds, [m.deviceId])
    assert.deepEqual(j.uids, ['u-restart'])
    assert.deepEqual(j.secrets, [m.secret])
    assert.equal(j.entries.length, 1)
    assert.equal(j.entries[0].deviceId, m.deviceId)
    assert.equal(j.entries[0].uid, 'u-restart')
    assert.deepEqual(j.entries[0].secrets, [m.secret])

    /* —— 模拟「DSH 重启」：同一路径上新建 store，内存 Map 是空的 —— */
    const b = createDeviceStore({ revokedPath: p, devicesPath: devPath(p) })
    assert.equal(b.size, 0, '新实例的登记表确实是空的（重启事实）')
    assert.equal(b.mint({ uid: 'u-restart' }), null, '🔴 重启后仍必须拒签（这就是落盘的意义）')
    assert.equal(b.isRevoked({ uid: 'u-restart' }), true)
    assert.equal(b.isRevoked({ secret: m.secret }), true)
    assert.equal(b.isRevoked({ deviceId: m.deviceId }), true)
    assert.equal(b.isRevoked({}), false, '空查询不许炸也不许命中')
    assert.equal(b.isRevoked(null), false, '不传参数同样安全')
    assert.ok(b.mint({ uid: 'u-other' }), '别的手机照常可用')

    /* 坏文件必须当空表、绝不抛错（黑名单文件被写坏不该让插件起不来） */
    fs.writeFileSync(p, '{ 这不是 JSON')
    const c = createDeviceStore({ revokedPath: p, devicesPath: devPath(p) })
    assert.ok(c.mint({ uid: 'u-restart' }), '解析失败 ⇒ 当空表（不抛错、不误封）')
    console.log('   [证据] 撤销落盘 ' + p + '；新实例 mint 仍为 null；坏 JSON 退化空表不抛错')
  } finally { rmFile(p); rmFile(devPath(p)) }
})

/* ============================================================
 * ⑦ 旧语义不回归：空/不存在 deviceId 无副作用；touch 不复活
 * ============================================================ */
test('task-1 ⑦ 空/不存在 deviceId 返回 0 且不写黑名单；已撤销的 touch 不复活', () => {
  const p = tmpPath()
  try {
    const store = createDeviceStore({ revokedPath: p, devicesPath: devPath(p) })
    const a = store.mint({ uid: 'phone-A' })
    for (const bad of ['', '   ', null, undefined, 'mp-nope']) {
      assert.equal(store.revokeDevice(bad), 0, '空/未命中必须返回 0：' + JSON.stringify(bad))
    }
    assert.equal(fs.existsSync(p), false, '没命中就不许写黑名单文件（无副作用）')
    assert.equal(store.isPaired(a.secret), true, '真设备仍在')
    assert.equal(store.list()[0].deviceId, a.deviceId, '没被移除 ⇒ 名单里还是它')
    assert.equal(store.mint({ uid: 'phone-A' }).deviceId, a.deviceId, '没被移除 ⇒ mint 沿用同一 deviceId')

    /* 上面那次 mint 又给同一台手机加了一张别名 secret ⇒ 这里应删掉 2 张。 */
    assert.equal(store.revokeDevice(a.deviceId), 2, '应把这台手机名下两张 secret 全删掉')
    assert.equal(store.touch(a.secret, { model: 'Mate60' }), false, '已撤销的 secret 不许被 touch 复活')
    assert.equal(store.list().length, 0, '名单里不许出现已撤销设备')
    assert.equal(store.revokeDevice(a.deviceId), 0, '同一台再撤一次返回 0（不重复计数）')
    console.log('   [证据] 空/未命中 deviceId 不落盘；撤销后 touch=false、list=0、再次撤销=0')
  } finally { rmFile(p); rmFile(devPath(p)) }
})

/* ============================================================
 * ⑧ aboutOf：body 优先、query 兜底、都没有空串（契约解析面）
 * ============================================================ */
test('task-1 ⑧ aboutOf 解析自报账号：body 优先 > query 兜底 > 空串（绝不兜本机）', () => {
  const req = (qs) => ({ url: '/mp-cookie?token=TOK&' + qs, headers: { 'user-agent': 'HUAWEI Mate 60' } })
  /* query 命中 */
  const q1 = aboutOf(req('deviceUid=u-1&accountUid=openid-q&accountName=小q'), null)
  assert.equal(q1.uid, 'u-1')
  assert.equal(q1.accountUid, 'openid-q')
  assert.equal(q1.accountName, '小q')
  /* body 优先 */
  const q2 = aboutOf(req('deviceUid=u-1&accountUid=openid-q&accountName=小q'), { accountUid: 'openid-b', accountName: '小b' })
  assert.equal(q2.accountUid, 'openid-b', 'body 的 accountUid 必须优先于 query')
  assert.equal(q2.accountName, '小b', 'body 的 accountName 必须优先于 query')
  /* 都没有 */
  const q3 = aboutOf(req(''), {})
  assert.equal(q3.accountUid, '', '都没有 ⇒ 空串')
  assert.equal(q3.accountName, '', '都没有 ⇒ 空串')
  /* req 为空 / 坏 url 也不许炸 */
  const q4 = aboutOf(null, null)
  assert.equal(q4.accountUid, '')
  assert.equal(q4.accountName, '')
  /* 长度裁剪与既有字段同款 */
  const long = aboutOf(req('accountUid=' + 'x'.repeat(200) + '&accountName=' + 'y'.repeat(200)), null)
  assert.equal(long.accountUid.length, 120)
  assert.equal(long.accountName.length, 80)
  console.log('   [证据] query=' + q1.accountUid + ' / body 优先=' + q2.accountUid + ' / 空=' + JSON.stringify(q3.accountUid))
})
