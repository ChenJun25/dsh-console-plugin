/**
 * 第215节 · 修法3 缺口补丁单测：**自动隧道文件写出来后，隧道要能被补拉起来**。
 *
 * 背景（真实成因）：
 *   新用户首次启动插件时 ~/.dsh/dsh-console-tunnel.auto.json 还不存在（register 之后才写），
 *   index.js 里那次同步的 startTunnel() 于是走到 tunnel.mjs「没有配置文件 ⇒ 隧道功能关闭」，
 *   之后 register 哪怕把文件写好了，也**没有任何人再拉起 frpc** ⇒ 用户必须重启一次宿主才有公网。
 *   两个真问题（m01977「装了最新插件 + 开了会员仍连不上公网」）：
 *     ① root: frpc 二进制缺失（修法3 主体，frpc-bootstrap.spec.mjs 覆盖）
 *     ② root: 首次启动不会补拉隧道（**本文件覆盖**）
 *
 * 为什么不在单测里真拉隧道：tunnel.mjs 的★坑 3（node --test 下 inTestEnv() 恒真）会直接短路，
 *   而且真 spawn frpc 会抢 remotePort。所以这里只验「**该通知宿主**」这件事（onTunnel 钩子契约）
 *   + 「index.js 确实把钩子接到了补拉函数上」的源码接线（与运行时行为一一对应，无多余假设）。
 *
 * 跑法：node --test lib/test/tunnel-revive.spec.mjs（**不要加 --test-force-exit**）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCloudLink } from '../cloud-link.mjs'

const SHORT = 'A1B2C3D4E5F6G7H'
const TOKEN = 'TOK-215'

let tmpSeq = 0
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-215-' + (tmpSeq++) + '-')) }

const cloudTunnel = (over = {}) => Object.assign({
  name: 'dsh-' + SHORT,
  type: 'http',
  customDomains: ['gaoshou25.cn'],
  locations: ['/dsh-console/' + SHORT],
  publicUrl: 'https://gaoshou25.cn/dsh-console/' + SHORT,
  serverAddr: '118.178.129.217',
  serverPort: 7000,
  authToken: TOKEN
}, over)

/** 只认 /register 的最小假 fetch：返回的 tunnel 可以被用例改（模拟云端换短号 / 换 locations）。 */
function fakeFetch(state) {
  return async (url, init) => {
    const body = JSON.parse(init.body)
    assert.equal(typeof body.nodeId, 'string')
    return {
      status: 200,
      async json() {
        return Object.assign(
          { ok: true, shortId: state.shortId, vipExpireMs: Date.now() + 86400000, tunnel: cloudTunnel(state.tunnel) },
          state.extra || {}
        )
      }
    }
  }
}

function links(dir, state, opts = {}) {
  const calls = []
  const c = createCloudLink(Object.assign({
    autoStart: false,
    storePath: path.join(dir, 'cloud.json'),
    autoPath: path.join(dir, 'tunnel.auto.json'),
    fetch: fakeFetch(state),
    onTunnel: (data) => calls.push(data)
  }, opts))
  return { c, calls }
}

/* =======================================================================
 * ① 首次 register 落地自动文件 ⇒ 必须回调一次（这就是「补拉隧道」的触发点）
 * ===================================================================== */
test('#215 首次 register 拿到 tunnel ⇒ onTunnel 回调一次，参数就是刚落盘的那份', async () => {
  const dir = tmpDir()
  const state = { shortId: SHORT, tunnel: {} }
  const { c, calls } = links(dir, state)
  const r = await c.register()
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1, '首次落盘必须通知宿主补拉隧道（否则新用户要重启一次宿主）')
  assert.equal(calls[0].enabled, true, '传给宿主的是落盘后的形状（enabled 由插件写死 true）')
  assert.equal(calls[0].type, 'http')
  assert.equal(calls[0].name, 'dsh-' + SHORT)
  assert.deepEqual(calls[0].locations, ['/dsh-console/' + SHORT])
  assert.equal(fs.existsSync(path.join(dir, 'tunnel.auto.json')), true)
})

/* =======================================================================
 * ② 心跳每 60s 都走 register/status ⇒ 内容没变**绝不许**再回调（否则隧道被反复重启）
 * ===================================================================== */
test('#215 同内容重复下发 ⇒ 只有第一次回调（心跳不许反复重启隧道）', async () => {
  const dir = tmpDir()
  const state = { shortId: SHORT, tunnel: {} }
  const { c, calls } = links(dir, state)
  await c.register()
  assert.equal(calls.length, 1)
  // 第二次：force 才真的再打一次网络（否则 register 走缓存早退），模拟心跳那发 status
  await c.register({ force: true })
  await c.status()
  await c.status()
  assert.equal(calls.length, 1, 'updatedMs 每次都变，比对必须剔除它；内容没变就不许再回调')
})

/* =======================================================================
 * ③ 云端换了短号 / locations（内容真变）⇒ 必须**再**回调，让宿主重新拉起
 * ===================================================================== */
test('#215 云端改了 locations（内容真变）⇒ 再回调一次', async () => {
  const dir = tmpDir()
  const state = { shortId: SHORT, tunnel: {} }
  const { c, calls } = links(dir, state)
  await c.register()
  assert.equal(calls.length, 1)
  state.shortId = 'Z9Y8X7W6V5U4T3S'
  state.tunnel = { locations: ['/dsh-console/Z9Y8X7W6V5U4T3S'], name: 'dsh-Z9Y8X7W6V5U4T3S' }
  await c.register({ force: true })
  assert.equal(calls.length, 2, '云端换了短号必须通知宿主重拉，不然还挂在旧短号上')
  assert.deepEqual(calls[1].locations, ['/dsh-console/Z9Y8X7W6V5U4T3S'])
})

/* =======================================================================
 * ④ 回调抛异常 ⇒ 绝不许把注册链路弄崩（写文件是 cloud-link 的职责）
 * ===================================================================== */
test('#215 onTunnel 抛异常 ⇒ register 照常 ok', async () => {
  const dir = tmpDir()
  const state = { shortId: SHORT, tunnel: {} }
  const { c } = links(dir, state, {
    onTunnel: () => { throw new Error('宿主炸了') }
  })
  const r = await c.register()
  assert.equal(r.ok, true, '隧道拉不拉得起来，不该影响注册与 shortId 落盘')
  assert.equal(r.shortId, SHORT)
})

/* =======================================================================
 * ⑤ 没传 onTunnel（老宿主）⇒ 行为与从前逐字相同：只落盘，不回调、不抛
 * ===================================================================== */
test('#215 缺省无 onTunnel ⇒ 只落盘不回调（老宿主零回归）', async () => {
  const dir = tmpDir()
  const state = { shortId: SHORT, tunnel: {} }
  const c = createCloudLink({
    autoStart: false,
    storePath: path.join(dir, 'cloud.json'),
    autoPath: path.join(dir, 'tunnel.auto.json'),
    fetch: fakeFetch(state)
  })
  const r = await c.register()
  assert.equal(r.ok, true)
  assert.deepEqual(Object.keys(r).sort(), ['allow', 'ok', 'shortId', 'vipDays', 'vipExpireMs'],
    'register() 返回形状是既有契约，一个字都不许加')
  assert.equal(fs.existsSync(path.join(dir, 'tunnel.auto.json')), true)
})

/* =======================================================================
 * ⑥ index.js 接线（源码断言）：钩子必须接到「没起来才补拉」的函数上，且 spawn 入口仍唯一
 * ===================================================================== */
test('#215 index.js 把 onTunnel 接到补拉函数，且 startTunnel 只在一处调用', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(src.includes('onTunnel: ensureTunnel'), 'index.js 必须把钩子接到 ensureTunnel')
  assert.ok(src.includes('const ensureTunnel = () => {'), 'ensureTunnel 必须存在')
  assert.ok(src.includes('const bootTunnel = () => {'), 'bootTunnel 必须存在')
  /* 只数**真实调用**那一行（注释里出现 startTunnel() 字样不算，2880/2882 行的注释就含它）。 */
  const hits = src.split('const st = startTunnel({ localPort').length - 1
  assert.equal(hits, 1, 'startTunnel( 全文件只许一处真实调用（tunnel.mjs 头部契约：别的文件不许再 spawn frpc）')
  assert.ok(src.includes("phase !== 'disabled' && st.phase !== 'error'"),
    '已连上/正在连的隧道一律不重拉，绝不打断一条好着的隧道')
})
