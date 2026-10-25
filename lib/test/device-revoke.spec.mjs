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
    const second = store.mint({ uid: 'phone-A' })
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
    assert.equal(store.revokeDevice('phone-A'), 0, '按 uid 不该删任何东西')
    assert.equal(store.isPaired(a.secret), true, 'uid 误当 deviceId ⇒ 别人的手机被误删')
    const row = store.list()[0]
    assert.ok(row && row.uid === 'phone-A', 'uid 仍应挂在设备行上（只是不许拿它当删除键）')
    assert.equal(row.deviceId, a.deviceId, '删除键必须是 deviceId')
  } finally { cleanup() }
})

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

    effect: (fn) => { cleanup = fn; return () => {} },
  }
  const mod = await import('../index.js?t=' + Math.random())

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

    close: async () => {
      if (cleanup) { try { cleanup()() } catch (e) {  } }
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
