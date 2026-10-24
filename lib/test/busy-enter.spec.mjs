/**
 * 第 302 节 · 手机「忙碌时发送」↔ 电脑端 ui-conversation.busyEnter（双向同步）
 *
 * 冻结的行为：
 *   1) busyEnterGet  读电脑端现值 → { ok:true, available:true, busyEnter:'queue'|'steer' }
 *   2) busyEnterSet  写电脑端 → sett.update('ui-conversation', { busyEnter }, undefined)
 *   3) 老宿主 / 没 settings 服务 / 没装 ui-conversation / 写入被拒 / 脏值 ——
 *      **一律 { ok:true, available:false }，绝不抛、绝不写**（App 退回本地 preferences）
 *   4) 脏值（非 queue/steer）不算 available，不许覆盖 App 本地选择
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const CMD = '/api/dsh-console/cmd'

/** 起一个最小 ctx（settings 由用例自己给），返回调 cmd 的函数。 */
async function boot(settings) {
  let cmdFetch = null
  const conn = {
    fetch: {
      register: (route) => {
        if (route.path === CMD) cmdFetch = route.fetch
        return () => {}
      }
    }
  }
  const ctl = { list: async () => ({ items: [] }), modelCatalog: async () => ({}) }
  const ctx = {
    get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : n === 'settings' ? (settings || null) : null),
    on: () => () => {},
    effect: () => () => {}
  }
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  assert.ok(cmdFetch, 'cmd 路由没注册上')
  return async (op, payload) => {
    const r = await cmdFetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ op, payload }) }))
    return { status: r.status, j: await r.json() }
  }
}

/** 假 settings 服务：describe() 只回 ui-conversation 一条，update() 记录写入。 */
function fakeSettings(val, opts = {}) {
  const st = { val: val, writes: [] }
  return {
    st,
    svc: {
      describe: () => {
        if (opts.describeThrows) throw new Error('boom')
        return [{ ns: 'ui-conversation', value: { busyEnter: st.val }, user: {}, revision: 0 }]
      },
      update: async (ns, patch) => {
        if (opts.updateThrows) throw new Error('Config field "busyEnter" is not volatile')
        st.writes.push([ns, patch])
        st.val = patch.busyEnter
      }
    }
  }
}

test('busyEnterGet：读回电脑端现值', async () => {
  const { svc } = fakeSettings('queue')
  const post = await boot(svc)
  const { status, j } = await post('busyEnterGet', {})
  assert.equal(status, 200)
  assert.deepEqual(j.result, { ok: true, available: true, busyEnter: 'queue' })
})

test('busyEnterSet：写 ui-conversation.busyEnter，第三参 undefined 不校验 revision', async () => {
  const { st, svc } = fakeSettings('queue')
  const post = await boot(svc)
  const { j } = await post('busyEnterSet', { busyEnter: 'steer' })
  assert.deepEqual(j.result, { ok: true, available: true, busyEnter: 'steer' })
  assert.deepEqual(st.writes, [['ui-conversation', { busyEnter: 'steer' }]])
  const again = await post('busyEnterGet', {})
  assert.equal(again.j.result.busyEnter, 'steer', '写完再读应是新值')
})

test('没有 settings 服务（老宿主）：available:false 且不抛', async () => {
  const post = await boot(null)
  const g = await post('busyEnterGet', {})
  assert.equal(g.status, 200)
  assert.deepEqual(g.j.result, { ok: true, available: false, busyEnter: '' })
  const s = await post('busyEnterSet', { busyEnter: 'steer' })
  assert.deepEqual(s.j.result, { ok: true, available: false, busyEnter: '' })
})

test('写入被拒（非 volatile / 冲突）：ok:true + available:false + 回读现值，不抛', async () => {
  const { st, svc } = fakeSettings('queue', { updateThrows: true })
  const post = await boot(svc)
  const { status, j } = await post('busyEnterSet', { busyEnter: 'steer' })
  assert.equal(status, 200)
  assert.deepEqual(j.result, { ok: true, available: false, busyEnter: 'queue' })
  assert.deepEqual(st.writes, [], '被拒时不该记成写过')
})

test('宿主没装 ui-conversation：available:false', async () => {
  const svc = { describe: () => [{ ns: 'other', value: {} }], update: async () => {} }
  const post = await boot(svc)
  const { j } = await post('busyEnterGet', {})
  assert.deepEqual(j.result, { ok: true, available: false, busyEnter: '' })
})

test('电脑端是脏值：不算 available，且非法入参不写', async () => {
  const { st, svc } = fakeSettings('whatever')
  const post = await boot(svc)
  const g = await post('busyEnterGet', {})
  assert.equal(g.j.result.available, false, '脏值不算 available')
  const s = await post('busyEnterSet', { busyEnter: 'bad' })
  assert.equal(s.j.result.available, false)
  assert.deepEqual(st.writes, [], '非法入参不该写电脑端')
})

test('settings.describe / update 抛错：仍然 200 + ok:true', async () => {
  const { svc } = fakeSettings('queue', { describeThrows: true, updateThrows: true })
  const post = await boot(svc)
  const g = await post('busyEnterGet', {})
  assert.equal(g.status, 200)
  assert.equal(g.j.ok, true)
  assert.equal(g.j.result.available, false)
  const s = await post('busyEnterSet', { busyEnter: 'steer' })
  assert.equal(s.status, 200)
  assert.equal(s.j.ok, true)
  assert.equal(s.j.result.available, false)
})
