/**
 * 第210节 · 单测：插件「检测升级」引擎（lib/dsh-console-cloud.mjs）+ 面板透传。
 *
 * 用户场景（m00001）：控制台面板里显示 npm 上的最新版号，能一键升级。
 * 这台机器的硬约束决定了用例怎么盯：
 *
 *   ① 版本号只能自己问 npm registry —— 官方 dsh-market 更新 API 对
 *      link 装法直接给 latestVersion=null（source=linked），拿不到可升级版本。
 *   ② 升级动作按装法分流：目录里有 .git ⇒ 源码形态（git fetch --ff-only only，
 *      绝不 reset）；否则 ⇒ npm 形态（profile 里 npm install 指定版本）。
 *   ③ 单测环境必须完全离线确定：不许打 registry、不许起子进程，否则每个真起
 *      apply() 的 spec 都会顺手真跑一次外网 + spawn git。
 *   ④ 升级详情（插件根绝对路径）只走宿主面板 /state，绝不进公网 /info。
 *
 * 测试缝（只在单测用，生产不设 env）：
 *   DSH_CONSOLE_REGISTRY 指向本地假 registry（给了它 = 退出单测离线豁免）；
 *   DSH_CONSOLE_NPM_CLI 直接指一个真实存在的文件，冒充找到 npm 入口。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { startLanServer } from '../lan-server.mjs'
import {
  parseVersion, cmpVersion, detectInstallKind, pluginRootOf, createCloudPlugin,
} from '../dsh-console-cloud.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询等一个条件成立（任务在后台异步跑，没有 promise 可 await）。 */
async function waitFor(fn, ms = 3000) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(30)
  }
}

/** 临时改 env，返回恢复函数。 */
function withEnv(kv) {
  const old = {}
  for (const [k, v] of Object.entries(kv)) {
    old[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return () => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

let tmpSeq = 0
/** 本轮建过的临时目录，结束时统一删掉（第217节：以前从不删 ⇒ %TEMP% 每跑一次全量就积 +14 个 dshupd-*）。 */
const TMP_DIRS = []
/** 造一个假插件根：可带 package.json 版本号，可带 .git（目录或文件）。 */
function fakeRoot({ version = '0.5.10', git = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshupd-' + (tmpSeq++) + '-'))
  TMP_DIRS.push(dir)
  if (version) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-console-plugin', version }))
  }
  if (git === 'dir') fs.mkdirSync(path.join(dir, '.git'))
  if (git === 'file') fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/x')
  return dir
}

after(() => {
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (_) {} }
})

/* ---------------- ①② 版本号解析与比较 ---------------- */

test('① parseVersion 认 v 前缀 / 预发布，非法返回 null', () => {
  assert.deepEqual(parseVersion('0.5.10'), { core: [0, 5, 10], pre: [] })
  assert.deepEqual(parseVersion('v1.2.3'), { core: [1, 2, 3], pre: [] })
  assert.deepEqual(parseVersion('1.2.3-beta.1'), { core: [1, 2, 3], pre: ['beta', '1'] })
  for (const bad of ['', '  ', 'abc', '1.2', '1.2.3.4', null, undefined]) {
    assert.equal(parseVersion(bad), null, '非法版本号必须判 null：' + String(bad))
  }
})

test('② cmpVersion 语义化比较（正式版 > 预发布版）', () => {
  assert.equal(cmpVersion('0.5.10', '0.5.9'), 1)
  assert.equal(cmpVersion('0.5.9', '0.5.10'), -1)
  assert.equal(cmpVersion('0.5.10', '0.5.10'), 0)
  assert.equal(cmpVersion('1.0.0', '0.99.99'), 1)
  assert.equal(cmpVersion('1.0.0', '1.0.0-beta.1'), 1, '正式版必须大于同号预发布版')
  assert.equal(cmpVersion('1.0.0-beta.2', '1.0.0-beta.10'), -1, '数字段按数值比，不是按字典序')
  assert.equal(cmpVersion('garbage', '1.0.0'), 0, '非法版本号不冒泡（判相等）')
})

/* ---------------- ③ 装法探测 ---------------- */

test('③ detectInstallKind：有 .git ⇒ source；没有 ⇒ npm', () => {
  assert.equal(detectInstallKind(fakeRoot({ git: 'dir' })), 'source')
  assert.equal(detectInstallKind(fakeRoot({ git: 'file' })), 'source', 'worktree 的 .git 是文件，也算源码形态')
  assert.equal(detectInstallKind(fakeRoot()), 'npm')
  assert.equal(detectInstallKind(path.join(os.tmpdir(), 'dshupd-not-exist-' + Math.random())), 'npm')
})

test('③-b pluginRootOf：metaUrl 的上一级目录', () => {
  const url = 'file:///D:/dshconsole-plugin/lib/dsh-console-cloud.mjs'
  const root = pluginRootOf(url)
  assert.ok(root.replace(/\\/g, '/').endsWith('dshconsole-plugin'), '应解析出插件根：' + root)
})

/* ---------------- ④⑤ 快照形状 + 单测离线 ---------------- */

test('④ now0() 键形状冻结：面板逐键读，缺键就显示空白', async () => {
  const root = fakeRoot({ version: '0.5.10' })
  const p = createCloudPlugin({ version: '0.5.10', pluginRoot: root, logger: () => {} })
  const s = p.updateState()
  const keys = [
    'ok', 'current', 'latest', 'latestAt', 'latestError', 'latestChecked',
    'updateAvailable', 'installKind', 'installDev', 'pluginRoot', 'repo',
    'canUpdate', 'gitAvailable', 'gitError', 'npmAvailable', 'job', 'message',
  ]
  for (const k of keys) assert.ok(Object.prototype.hasOwnProperty.call(s, k), '快照缺键: ' + k)
  assert.equal(s.current, '0.5.10', 'current 必须现读插件 package.json')
  assert.equal(s.latest, '', '还没检测时 latest 是空串（不是 undefined）')
  assert.equal(s.latestChecked, false)
  assert.equal(s.updateAvailable, false)
  assert.equal(s.installKind, 'npm')
  assert.equal(s.installDev, false)
  assert.equal(s.pluginRoot, root)
  assert.equal(s.job, null, '没跑过任务时 job 是 null')
})

test('⑤ 单测环境：不打 registry、不起子进程', async () => {
  const restore = withEnv({ DSH_CONSOLE_REGISTRY: undefined, DSH_CONSOLE_NPM_CLI: undefined })
  try {
    const p = createCloudPlugin({ version: '0.5.10', pluginRoot: fakeRoot(), logger: () => {} })
    await p.refresh(true)
    const s = p.updateState()
    assert.equal(s.latestChecked, true, '离线模式也要落「已检测」标记，面板才不会转圈')
    assert.equal(s.latestError, '', '离线跳过不算错误')
    assert.equal(s.latest, '', '离线不许编造版本号')
    const caps = p.capabilities()
    assert.equal(caps.node, '', '单测环境不许去找 node 可执行文件')
    assert.equal(caps.npmCli, '', '单测环境不许去找 npm 入口')
    assert.equal(caps.git, false)
    assert.equal(s.canUpdate, false, 'npm 形态没找到 npm 入口 ⇒ 不能升级')
    assert.ok(s.message.indexOf('npm') >= 0, '拿不到入口要给一句人话提示')
  } finally {
    restore()
  }
})

/* ---------------- ⑥⑦ 真 registry（假服务） ---------------- */

let regSeq = 0
/** 本地假 registry。 */
async function fakeRegistry({ version = '9.9.9', status = 200, body } = {}) {
  const hits = []
  const srv = http.createServer((req, res) => {
    hits.push(req.url)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body !== undefined ? body : JSON.stringify({ name: 'dsh-console-plugin', version }))
  })
  await new Promise((r) => srv.listen(21801 + (regSeq++ * 2), '127.0.0.1', r))
  return {
    url: 'http://127.0.0.1:' + srv.address().port,
    hits,
    close: () => new Promise((r) => srv.close(r)),
  }
}

test('⑥ 拿到新版号 ⇒ updateAvailable + onLatest 回调（/info 同号）', async () => {
  const reg = await fakeRegistry({ version: '9.9.9' })
  const cli = path.join(fakeRoot({ version: '' }), 'npm-cli.js')
  fs.writeFileSync(cli, '// fake npm')
  const seen = []
  const restore = withEnv({ DSH_CONSOLE_REGISTRY: reg.url, DSH_CONSOLE_NPM_CLI: cli })
  try {
    const p = createCloudPlugin({
      version: '0.5.10', pluginRoot: fakeRoot({ version: '0.5.10' }), logger: () => {},
      onLatest: (v) => seen.push(v),
    })
    await p.refresh(true)
    const s = p.updateState()
    assert.equal(s.latest, '9.9.9')
    assert.equal(s.latestError, '')
    assert.equal(s.updateAvailable, true, '9.9.9 > 0.5.10 必须判可升级')
    assert.deepEqual(seen, ['9.9.9'], 'onLatest 要把号同步给 index.js 的模块级缓存')
    assert.equal(s.npmAvailable, true, '给了 npm 入口就必须认出来')
    assert.equal(s.canUpdate, true, 'npm 形态 + 有 npm 入口 ⇒ 允许点升级')
    assert.equal(reg.hits.length, 1, '一次检测只打一次 registry')
    await p.refresh(false)
    assert.equal(reg.hits.length, 1, 'TTL 内不许重复打 registry')
  } finally {
    restore()
    await reg.close()
  }
})

test('⑦ registry 挂了 / 500 ⇒ 静默、latest 保留旧值、不抛错', async () => {
  const ok = await fakeRegistry({ version: '9.9.9' })
  const bad = await fakeRegistry({ status: 500, body: 'boom' })
  const cli = path.join(fakeRoot({ version: '' }), 'npm-cli.js')
  fs.writeFileSync(cli, '// fake npm')
  const restore = withEnv({ DSH_CONSOLE_REGISTRY: ok.url, DSH_CONSOLE_NPM_CLI: cli })
  try {
    const p = createCloudPlugin({ version: '0.5.10', pluginRoot: fakeRoot({ version: '0.5.10' }), logger: () => {} })
    await p.refresh(true)
    assert.equal(p.updateState().latest, '9.9.9')
    await ok.close()
    process.env.DSH_CONSOLE_REGISTRY = bad.url
    const p2 = createCloudPlugin({ version: '0.5.10', pluginRoot: fakeRoot({ version: '0.5.10' }), logger: () => {} })
    await assert.doesNotReject(() => p2.refresh(true), '网络失败绝不许往上抛')
    const s2 = p2.updateState()
    assert.equal(s2.latest, '', '失败时不许编造版本号')
    assert.ok(s2.latestError.indexOf('500') >= 0, '要留一句可读的失败原因：' + s2.latestError)
    assert.equal(s2.latestChecked, true)
  } finally {
    restore()
    await bad.close()
  }
})

/* ---------------- ⑧ 升级入口的前置校验 ---------------- */

test('⑧ startUpdate 前置校验：没检测过 / 已是最新 都要拒绝', async () => {
  const root = fakeRoot({ version: '0.5.10' })
  const p = createCloudPlugin({ version: '0.5.10', pluginRoot: root, logger: () => {} })
  assert.throws(() => p.startUpdate('update'), /先点/, '没检测到版号时必须拒绝并给指引')

  const reg = await fakeRegistry({ version: '0.5.10' })
  const restore = withEnv({ DSH_CONSOLE_REGISTRY: reg.url })
  try {
    const p2 = createCloudPlugin({ version: '0.5.10', pluginRoot: fakeRoot({ version: '0.5.10' }), logger: () => {} })
    await p2.refresh(true)
    assert.equal(p2.updateState().updateAvailable, false, '同号不许判可升级')
    assert.throws(() => p2.startUpdate('update'), /已经是最新/, '同号时点升级要明确拒绝')
  } finally {
    restore()
    await reg.close()
  }
})

/* ---------------- ⑨ 面板透传（真 LAN 服务） ---------------- */

let portSeq = 0
async function serve(over = {}) {
  const o = Object.assign({
    port: 21901 + (portSeq++ * 2),
    allowShift: true,
    log: () => {},
    getToken: () => 'TOK',
    getInfo: () => ({
      name: '我的电脑', nodeId: 'dsh-console', host: 'host-1', dshOk: true,
      dshError: '', version: '9.9.9', latestVersion: '9.9.10',
      agentPreset: 'ptc', agentPresetAvailable: true,
    }),
    listSessions: async () => [],
    runCommand: async () => ({ ok: true }),
  }, over)
  const srv = startLanServer(o)
  const started = await srv.start()
  assert.ok(started, 'lan server 必须起得来')
  return { srv, started }
}

test('⑨ panelData 必须带出 version / latestVersion / updateState', async () => {
  const snap = { ok: true, current: '9.9.9', latest: '9.9.10', updateAvailable: true }
  const a = await serve({ getUpdateState: () => snap })
  try {
    const d = await a.srv.panelData(false)
    assert.equal(d.version, '9.9.9', 'panelData 漏了 version ⇒ 面板显示不出当前版号')
    assert.equal(d.latestVersion, '9.9.10', 'panelData 漏了 latestVersion')
    assert.deepEqual(d.updateState, snap, '升级快照必须原样透传（面板逐键读）')
  } finally {
    await a.srv.stop()
  }

  /* 老宿主不给 getUpdateState ⇒ 键在、值为 null，面板显示「暂不可用」而不是报错。 */
  const b = await serve()
  try {
    const d = await b.srv.panelData(false)
    assert.ok(Object.prototype.hasOwnProperty.call(d, 'updateState'), '键必须存在')
    assert.equal(d.updateState, null, '拿不到快照时给 null，不许 undefined')
    assert.equal(d.version, '9.9.9', 'version 仍要在')
  } finally {
    await b.srv.stop()
  }
})

/* ---------------- ⑩ 升级台账（失败也要可读） ---------------- */

test('⑩ startUpdate 起任务：返回任务视图；缺 npm 入口时任务收敛到 failed 且原因可读', async () => {
  const reg = await fakeRegistry({ version: '9.9.9' })
  /* 🔴 拿 DSH_CONSOLE_NODE_BIN 指向一个「同目录没有 node_modules/npm」的真文件，
     并清掉 DSH_CONSOLE_NPM_CLI —— 让 npm 入口探测必然落空，任务在真正 spawn
     npm install 之前就失败。**绝不能在单测里真跑 npm install**（会动 profile）。 */
  const fakeNode = path.join(fakeRoot({ version: '' }), 'node')
  fs.writeFileSync(fakeNode, '')
  const restore = withEnv({
    DSH_CONSOLE_REGISTRY: reg.url, DSH_CONSOLE_NODE_BIN: fakeNode, DSH_CONSOLE_NPM_CLI: undefined,
  })
  try {
    const p = createCloudPlugin({ version: '0.5.10', pluginRoot: fakeRoot({ version: '0.5.10' }), logger: () => {} })
    await p.refresh(true)
    assert.equal(p.updateState().npmAvailable, false, '环境里没有 npm 入口')
    assert.equal(p.updateState().canUpdate, false, 'canUpdate 必须是 false，面板才有理由禁用按钮')
    const jv = p.startUpdate('update')
    assert.equal(jv.state, 'running', 'startUpdate 同步返回运行中的任务视图')
    assert.equal(jv.kind, 'update')
    assert.equal(jv.from, '0.5.10')
    /* ⚠️ 不要断言 jv.to === '9.9.9'：doUpdate() 一进来就重建自己那份 job
       （to 先为空，成功后才回填实际落盘版本），startUpdate 那份只是先行视图。 */
    assert.ok(Object.prototype.hasOwnProperty.call(jv, 'to'), 'to 键必须存在')
    assert.equal(jv.restarted, false)
    assert.ok(Array.isArray(jv.log), 'log 必须是数组（面板直接渲染）')
    const done = await waitFor(() => {
      const j = p.updateState().job
      return j && j.state !== 'running' ? j : null
    }, 8000)
    assert.ok(done, '任务必须收敛到终态，不许一直转圈')
    assert.equal(done.state, 'failed')
    assert.ok(String(done.error).indexOf('npm') >= 0, '失败原因要给人话：' + done.error)
    assert.ok(done.log.join('\n').length > 0, '失败也要留下任务日志')
  } finally {
    restore()
    await reg.close()
  }
})

/* ---------------- ⑪ 端到端：真 apply() 后面板走 /cmd 拿升级快照 ---------------- */

let liveSeq = 0

test('⑪ 真 apply()：POST /api/dsh-console/cmd {op:updateState} 直通返回快照，未知 op 仍报中文错', async () => {
  const routes = {}
  const conn = { fetch: { register: (r) => { routes[r.path] = r; return () => {} } } }
  const ctl = {
    projections: async () => ({ asOfSeq: 0, values: { title: '', turnOutline: [] } }),
    list: async () => ({ items: [] }),
  }
  let cleanup = null
  const ctx = {
    get: (n) => {
      if (n === 'connection') return conn
      if (n === 'sessionController') return ctl
      if (n === 'agents') return { get: () => null }
      if (n === 'settings') return { update: async () => {}, namespace: () => null }
      if (n === 'agentPresets') return null
      return null
    },
    on: () => () => {},
    effect: (fn) => { cleanup = fn; return () => {} },
  }
  const mod = await import('../index.js?t=' + Math.random())
  /* ⚠️ 必须 await：apply 的 promise 在 lan listen 完成时才 resolve。 */
  await mod.apply(ctx, { port: 21751 + (liveSeq++ * 2), allowShiftPort: true })
  try {
    const cmd = routes['/api/dsh-console/cmd']
    assert.ok(cmd, '/api/dsh-console/cmd 必须注册上（面板按钮就靠它）')
    const post = (body) => cmd.fetch(new Request('http://127.0.0.1/api/dsh-console/cmd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))

    /* op=updateState：同步快照，面板一进设置页就能显示「当前 / 最新」。 */
    const r1 = await (await post({ op: 'updateState', payload: {} })).json()
    assert.equal(r1.ok, true, 'updateState 必须成功：' + JSON.stringify(r1))
    const up = r1.result
    assert.equal(typeof up, 'object', 'result 就是快照本体（面板逐键读）')
    const pkgVersion = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
    assert.equal(up.current, pkgVersion, 'current 必须现读 package.json，不许写死')
    for (const k of ['latest', 'updateAvailable', 'installKind', 'canUpdate', 'job']) {
      assert.ok(Object.prototype.hasOwnProperty.call(up, k), '快照缺键：' + k)
    }
    assert.equal(up.installKind, 'source', '本仓有 .git ⇒ 源码形态')

    /* op=updateCheck：单测环境离线确定（不打 registry），但键要齐。 */
    const r2 = await (await post({ op: 'updateCheck', payload: { force: true } })).json()
    assert.equal(r2.ok, true, 'updateCheck 必须成功：' + JSON.stringify(r2))
    assert.equal(r2.result.latestChecked, true, '检测过就要落 checked 标记')
    assert.equal(r2.result.latestError, '', '单测环境不许真打网络（该走离线豁免）')

    /* 未知 op 的老行为不许被新 op 改掉。 */
    const r3 = await (await post({ op: 'no-such-op' })).json()
    assert.equal(r3.ok, false)
    assert.ok(String(r3.error).indexOf('不支持') >= 0, '未知 op 仍要中文报错：' + r3.error)
  } finally {
    if (cleanup) cleanup()()
  }
})
