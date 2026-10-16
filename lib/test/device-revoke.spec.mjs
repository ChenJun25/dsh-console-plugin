/**
 * 第 191 节 · 用户 m00001 · task-D：按 deviceId 移除设备（store 层单测）。
 *
 * 被验收的能力：createDeviceStore().revokeDevice(deviceId) —— 面板「踢掉这台手机」
 * 调 /cmd op=deviceRevoke 时落到的那一层。这里**不架 HTTP**，直接测 store：
 * 最快、最硬，也不会因端口/路由抖动误报。
 *
 * 🔴 为什么要按 deviceId 而不是 secret 删（这条是红线的由来）：
 *   alias 是常态 —— 同一台手机重新配对 / 同 uid 多次 mint 后，Map 里会有**多张
 *   secret 指向同一条记录**（mp-support.mjs mergeSameIdentity / mint 的 canonical 分支）。
 *   只删当前那张 Cookie，旧 secret 仍然 isPaired() === true ⇒ 手机照样能进来。
 * 🔴 红线：只按 deviceId（由 secret 派生、同一次配对必然相同）；
 *   绝不按 uid / cloudUid / 机型删 —— 那会把同一账号下别的手机一起误删。
 *
 * 🔴 落盘隔离（2026-10-16 补）：设备表/黑名单从第193节起会**落盘**，所以本文件里
 *   建 store 一律走 testStore()，把两处路径都指到 os.tmpdir() 的唯一临时文件 ——
 *   **单测绝不许再碰用户真实的 ~/.dsh/dsh-console-revoked.json 与 dsh-console-devices.json**。
 *   （直接 `node lib/test/xxx.spec.mjs` 跑时没有 NODE_TEST_CONTEXT，没有这层隔离就会写真文件。）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDeviceStore } from '../mp-support.mjs'

let tmpSeq = 0
function tmpPath(tag) {
  return path.join(os.tmpdir(), 'dsh-console-revoke-spec-' + tag + '-' + process.pid + '-' + (tmpSeq++) + '.json')
}
function rmFile(p) { try { fs.rmSync(p, { force: true }) } catch (e) { /* 忽略 */ } }
/** 建一个**只写临时文件**的 store；返回 { store, cleanup }，用例 finally 里调 cleanup。 */
function testStore() {
  const dev = tmpPath('dev')
  const rev = tmpPath('rev')
  return { store: createDeviceStore({ devicesPath: dev, revokedPath: rev }), cleanup: () => { rmFile(dev); rmFile(rev) } }
}

/* 🔴 兜底隔离（⑥⑦⑧ 要走真 index.js）：那几条用例经 attachMp 自己建 store，参数不经我的手，
   只能靠环境变量把两处路径一起挪到临时文件 —— 否则「配对成功」就会写用户的真实设备表。
   本 spec 是独立进程（node --test 每个文件一个进程），env 不会串到别的 spec。 */
const ENV_DEV = tmpPath('env-dev')
const ENV_REV = tmpPath('env-rev')
process.env.DSH_CONSOLE_DEVICES_FILE = ENV_DEV
process.env.DSH_CONSOLE_REVOKED_FILE = ENV_REV
test.after(() => { rmFile(ENV_DEV); rmFile(ENV_REV) })

test('① 按 deviceId 移除后 isPaired(该 secret) 为 false（必须重新配对）', () => {
  const { store, cleanup } = testStore()
  try {
    const a = store.mint({ uid: 'phone-A', model: 'Mate60' })
    assert.equal(store.isPaired(a.secret), true, '刚配对的 secret 必须可用（前置条件）')
    const removed = store.revokeDevice(a.deviceId)
    assert.equal(removed, 1, '这台手机名下只有一张 secret ⇒ 应删 1 条')
    assert.equal(store.isPaired(a.secret), false, '移除了还认这张 secret ⇒ 手机照样进来，等于没移除')
    assert.equal(store.list().length, 0, '设备表应清空')
  } finally { cleanup() }
})

test('② 移除不存在的 deviceId 返回 0，且不动任何一台真设备', () => {
  const { store, cleanup } = testStore()
  try {
    const a = store.mint({ uid: 'phone-A' })
    assert.equal(store.revokeDevice('mp-nope'), 0, '不存在的 deviceId 应返回 0')
    assert.equal(store.revokeDevice(''), 0, '空串应返回 0')
    assert.equal(store.revokeDevice('   '), 0, '全空格应返回 0')
    assert.equal(store.revokeDevice(null), 0, 'null 应返回 0（不抛错）')
    assert.equal(store.revokeDevice(undefined), 0, 'undefined 应返回 0（不抛错）')
    assert.equal(store.isPaired(a.secret), true, '误删了真设备')
  } finally { cleanup() }
})

test('③ 移除 A 不影响 B', () => {
  const { store, cleanup } = testStore()
  try {
    const a = store.mint({ uid: 'phone-A' })
    const b = store.mint({ uid: 'phone-B' })
    assert.notEqual(a.deviceId, b.deviceId, '不同手机应是不同 deviceId（前置条件）')
    assert.equal(store.revokeDevice(a.deviceId), 1)
    assert.equal(store.isPaired(a.secret), false, 'A 没被移除')
    assert.equal(store.isPaired(b.secret), true, 'B 被误伤')
    const rows = store.list()
    assert.equal(rows.length, 1, '移掉 A 后应只剩 B 一台')
    assert.equal(rows[0].deviceId, b.deviceId, '剩下的那台不是 B')
  } finally { cleanup() }
})

test('④ alias：同一台手机名下多张 secret ⇒ 一次全清，旧 Cookie 也失效', () => {
  const { store, cleanup } = testStore()
  try {
    const first = store.mint({ uid: 'phone-A' })
    const second = store.mint({ uid: 'phone-A' })     // 同身份换 secret（重新配对 / 重启重连）
    assert.equal(second.deviceId, first.deviceId, '同一 uid 应沿用同一台设备（alias 机制前置条件）')
    assert.notEqual(second.secret, first.secret, '两次 mint 应是两张不同 secret')
    assert.equal(store.isPaired(first.secret), true, '旧 secret 应仍可用（既有行为：配对凭据不失效）')
    assert.equal(store.isPaired(second.secret), true)
    const removed = store.revokeDevice(first.deviceId)
    assert.equal(removed, 2, '这台的 secret 张数 = 2，必须一起清（否则旧 Cookie 还能进来）')
    assert.equal(store.isPaired(first.secret), false, '旧 Cookie 还在 ⇒ 移除形同虚设')
    assert.equal(store.isPaired(second.secret), false)
    assert.equal(store.list().length, 0, '这台手机应彻底从名单消失')
  } finally { cleanup() }
})

test('⑤ 红线：uid 不是判据 —— 拿 uid 当参数点不动任何设备', () => {
  const { store, cleanup } = testStore()
  try {
    const a = store.mint({ uid: 'phone-A' })
    assert.equal(store.revokeDevice('phone-A'), 0, '按 uid 不该删任何东西（红线）')
    assert.equal(store.isPaired(a.secret), true, 'uid 误当 deviceId ⇒ 别人的手机被误删')
    const row = store.list()[0]
    assert.ok(row && row.uid === 'phone-A', 'uid 仍应挂在设备行上（只是不许拿它当删除键）')
    assert.equal(row.deviceId, a.deviceId, '删除键必须是 deviceId')
  } finally { cleanup() }
})

/* ============================================================
 * ⑥⑦ op 级：/cmd op=deviceRevoke 的入参/出参契约（走真实 runCommand 分支）
 * ------------------------------------------------------------
 * App 侧（LanClient.ets:282/:5199）拿到的就是这里返回的 result：
 *   成功   { ok:true,  removed:<number> }          —— 确实删掉了几条配对记录
 *   找不到 { ok:false, error:'device-not-found' }  —— 0 条 / 空 deviceId 同口径
 *   🔴 绝不许 throw：/cmd 出口把抛出转成 HTTP 500，App 侧就没有「这台早没了」
 *      这个可判断的分支了。这里**不架局域网**，直接喂假 ctx 调 /cmd 注册的 fetch。
 * ============================================================ */
async function cmdFetchOf() {
  let fn = null
  const conn = { fetch: { register: (r) => { if (r.path === '/api/dsh-console/cmd') fn = r.fetch; return () => {} } } }
  const ctl = { projections: async () => ({ asOfSeq: 0, values: {} }), list: async () => ({ items: [] }) }
  const ctx = { get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : null), on: () => () => {}, effect: () => () => {} }
  const mod = await import('../index.js?t=' + Math.random())
  mod.apply(ctx, { port: 0 })
  return async (op, payload) => {
    const r = await fn(new Request('http://x', { method: 'POST', body: JSON.stringify({ op: op, payload: payload || {} }) }))
    return { status: r.status, body: await r.json() }
  }
}

test('⑥ op=deviceRevoke：空 deviceId ⇒ 200 + { ok:false, error:"device-not-found" }', async () => {
  const cmd = await cmdFetchOf()
  for (const bad of [{}, { deviceId: '' }, { deviceId: '   ' }, { deviceId: null }]) {
    const r = await cmd('deviceRevoke', bad)
    assert.equal(r.status, 200, '🔴 不该是 500（App 要能判断）')
    assert.equal(r.body.ok, true, '外层信封仍是 ok:true（result 里才是业务结果）')
    assert.deepEqual(r.body.result, { ok: false, error: 'device-not-found' }, '空 deviceId 的出参形状不对')
  }
})

test('⑦ op=deviceRevoke：不存在的 deviceId ⇒ { ok:false, error:"device-not-found" }，不是 500', async () => {
  const cmd = await cmdFetchOf()
  const r = await cmd('deviceRevoke', { deviceId: 'mp-不存在' })
  assert.equal(r.status, 200, '🔴 找不到也不能 500')
  assert.deepEqual(r.body.result, { ok: false, error: 'device-not-found' })
})

/* ============================================================
 * ⑧ 端到端：真起一个 LAN 服务，配对 → /cmd deviceRevoke → 面板名单清空
 * ------------------------------------------------------------
 * 上面 ⑥⑦ 走的是假 ctx 直接喂 /cmd 的 fetch；这一条要证明 **真的打进来时**
 * op 也接得上：走真 socket + panelData 的 devices 名单（真 store.list()），
 * 而不是我手搓的替身。端口段取 19701+（与 19101/19501/18901 都错开）。
 * ============================================================ */
let liveSeq = 0
async function liveOf() {
  const routes = {}
  let cleanup = null
  const conn = { fetch: { register: (r) => { routes[r.path] = r; return () => {} } } }
  const ctl = { projections: async () => ({ asOfSeq: 0, values: { title: '', turnOutline: [] } }), list: async () => ({ items: [] }) }
  const ctx = {
    get: (n) => {
      if (n === 'connection') return conn
      if (n === 'sessionController') return ctl
      if (n === 'agents') return { get: () => null }
      if (n === 'settings') return { update: async () => {}, namespace: () => null }
      return null
    },
    on: () => () => {},
    /* 🔴 必须收下 disposer 并在用例结束时调用：真 LAN 服务占着 socket，
       不关掉的话 node --test 进程永远不退出（本轮实测挂到超时）。 */
    effect: (fn) => { cleanup = fn; return () => {} },
  }
  const mod = await import('../index.js?t=' + Math.random())
  /* ⚠️ 必须 await：apply 的 promise 在 LAN listen 完成时才 resolve。 */
  await mod.apply(ctx, { port: 19701 + (liveSeq++ * 2), allowShiftPort: true })
  const stateRoute = routes['/api/dsh-console/state']
  assert.ok(stateRoute, '/api/dsh-console/state 必须注册上')
  const panel = await (await stateRoute.fetch(new Request('http://127.0.0.1/api/dsh-console/state?light=1'))).json()
  assert.ok(panel.port > 0, 'panelData 必须给出真实监听端口')
  const base = 'http://127.0.0.1:' + panel.port
  const hdr = { 'x-dsh-console-token': panel.token }
  return {
    base, hdr, panel,
    state: async () => (await stateRoute.fetch(new Request('http://127.0.0.1/api/dsh-console/state?light=1'))).json(),
    /* 配对：拿面板的 6 位码换 mp_device Cookie（App 走的正是这条路）。 */
    accept: async (body) => {
      const r = await fetch(base + '/dsh-console/mp/pair/accept', {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, hdr),
        body: JSON.stringify(Object.assign({ token: panel.code }, body || {})),
      })
      const sc = r.headers.get('set-cookie') || ''
      const m = sc.match(/mp_device=([^;]+)/)
      return { status: r.status, json: await r.json(), secret: m ? decodeURIComponent(m[1]) : '' }
    },
    cmd: async (op, payload) => {
      const r = await fetch(base + '/dsh-console/cmd', {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, hdr),
        body: JSON.stringify({ op, payload: payload || {} }),
      })
      return { status: r.status, body: await r.json() }
    },
    /* 🔴 收尾：cleanup() 只关监听 socket，真 socket 上打过的 fetch 连接收尾还挂在
       事件循环里，不等待就会在退出时踩 libuv 已关句柄 —— 实测 ≥3ms 稳定（20/20），取 30ms。
       ⚠️ 2026-10-16 追加实测：**加上 --test-force-exit 后**，全量并发跑仍会偶发同一断言
         Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
       （6 次里崩 1~3 次；单文件连跑 10/10 不崩；用例内部其实全 pass，崩的是文件级退出；
       globalThis[Symbol.for('undici.globalDispatcher.1')] 在本机 Node 上是 undefined，
       想直接关全局池也关不到）。⇒ 结论：**发版闸门不要带 --test-force-exit**，
       不带时全量 4/4 稳定 exit=0、耗时 ~3s（本机 Node 自己会干净退出，不需要强制）。 */
    close: async () => {
      if (cleanup) { try { cleanup()() } catch (e) { /* 忽略 */ } }
      await new Promise((r) => setTimeout(r, 30))
    },
  }
}

test('⑧ 端到端：配对出 1 台 → deviceRevoke → 面板名单清零；再删同台 ⇒ device-not-found', async () => {
  const s = await liveOf()
  try {
  const a = await s.accept({ deviceModel: 'HUAWEI Mate 60', deviceName: '我的手机', deviceUid: 'u-e2e-1' })
  assert.equal(a.status, 200, '配对必须成功（拿面板 6 位码换 Cookie）')
  assert.ok(a.secret.length > 0, 'accept 必须下发 mp_device secret')

  const before = await s.state()
  assert.equal(before.deviceCount, 1, '配对后面板应看到 1 台设备')
  const deviceId = String(before.devices[0].deviceId || '')
  assert.ok(deviceId.startsWith('mp-'), '面板下发的 deviceId 应是原始 mp-xxx 形态：' + deviceId)

  const r1 = await s.cmd('deviceRevoke', { deviceId: deviceId })
  assert.equal(r1.status, 200, '真 socket 上也必须 200')
  assert.deepEqual(r1.body.result, { ok: true, removed: 1 }, '应恰好删掉 1 条记录')

  const after = await s.state()
  assert.equal(after.deviceCount, 0, '移除后面板名单必须清零')
  assert.equal(after.devices.length, 0, '名单行也必须没了')

  const r2 = await s.cmd('deviceRevoke', { deviceId: deviceId })
  assert.deepEqual(r2.body.result, { ok: false, error: 'device-not-found' }, '同一台再删一次应是 not-found')
  } finally { await s.close() }
})
