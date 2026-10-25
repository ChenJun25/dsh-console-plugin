import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCloudLink } from '../cloud-link.mjs'

const SHORT = 'A1B2C3D4E5F6G7H'
const TOKEN = 'TOK-215'

let tmpSeq = 0

const TMP_DIRS = []
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-215-' + (tmpSeq++) + '-'))
  TMP_DIRS.push(d)
  return d
}
after(() => {
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (_) {} }
})

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

test('#215 同内容重复下发 ⇒ 只有第一次回调（心跳不许反复重启隧道）', async () => {
  const dir = tmpDir()
  const state = { shortId: SHORT, tunnel: {} }
  const { c, calls } = links(dir, state)
  await c.register()
  assert.equal(calls.length, 1)

  await c.register({ force: true })
  await c.status()
  await c.status()
  assert.equal(calls.length, 1, 'updatedMs 每次都变，比对必须剔除它；内容没变就不许再回调')
})

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

test('#215 index.js 把 onTunnel 接到补拉函数，且 startTunnel 只在一处调用', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(src.includes('onTunnel: ensureTunnel'), 'index.js 必须把钩子接到 ensureTunnel')
  assert.ok(src.includes('const ensureTunnel = () => {'), 'ensureTunnel 必须存在')
  assert.ok(src.includes('const bootTunnel = () => {'), 'bootTunnel 必须存在')

  const hits = src.split('const st = startTunnel({ localPort').length - 1
  assert.equal(hits, 1, 'startTunnel( 全文件只许一处真实调用（tunnel.mjs 头部契约：别的文件不许再 spawn frpc）')
  assert.ok(src.includes("phase !== 'disabled' && st.phase !== 'error'"),
    '已连上/正在连的隧道一律不重拉，绝不打断一条好着的隧道')
})
