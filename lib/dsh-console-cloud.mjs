/**
 * DSH控制台插件 · 面板「检测升级」引擎（第209节 · task-1）
 *
 * 用户需求（2026-10-16）：面板里能看到 npm 上的最新版号，**点一下就能升级**。
 *
 * 三条硬约束（写码前实测确认过，别再改回去）：
 *   ① 官方 dsh-market 更新 API 对本插件**无效** —— 实测
 *      GET /dsh-market/api/v1/updates?name=dsh-console-plugin 对 link 装法返回
 *      source=linked / latestVersion=null / updateAvailable=false
 *      （2026-10-16 起本机已改成版本号装法：profile/package.json 里是
 *      "dsh-console-plugin": "0.5.13"，不再是 link:），拿不到可升级版本，
 *      所以版本号必须自己问 npm registry。
 *   ② 升级动作分两种装法，绝不混淆：
 *      - source（带 .git 的源码目录）：在插件源码目录跑
 *        git fetch + git merge --ff-only（有本地未推送提交就拒绝，绝不 reset）；
 *      - npm（市场装进 profile/node_modules 的形态）：在 profile 目录装指定版本。
 *        ⚠️ 第218节：这里**优先 pnpm**（宿主 runtime 自带），因为 profile 的
 *        package.json 里有 6 条 link: 依赖，npm 解析整棵树会直接报
 *        EUNSUPPORTEDPROTOCOL "Unsupported URL Type \"link:\""（实测），
 *        而 pnpm 认得 link:（实测 pnpm install --frozen-lockfile EXIT=0）。
 *        找不到 pnpm 才退回 npm install（旧行为）。
 *   ③ 绝不阻塞请求路径：/info 与 /state 只会读**缓存**（now() 是同步的），
 *      网络与子进程全在 refresh() / startUpdate() 里异步跑，失败只落日志。
 *
 * 进程与超时：子进程 10 分钟硬超时，输出各留尾部 4000 字符（进日志给用户看）。
 * 重启：桌面宿主托管进程，外部不许自己重启（dsh-market capabilities 里
 * restart.supported=false），所以升级成功只提示「重启 DSH 生效」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const NPM_PACKAGE = 'dsh-console-plugin'
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
export const DEFAULT_REPO = 'https://github.com/ChenJun25/dsh-console-plugin.git'
/** 子进程硬超时（10 分钟）。 */
export const CMD_TIMEOUT_MS = 10 * 60 * 1000
/** 单条命令留存的输出上限（字）。 */
const OUT_CAP = 4000
/** 版本号缓存 TTL（10 分钟，与 index.js 的 LATEST_TTL_MS 同口径）。 */
const TTL_MS = 10 * 60 * 1000
/** 能力探测缓存 TTL。 */
const CAP_TTL_MS = 5 * 60 * 1000

function text(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : ''
}

/** "0.5.10" -> { core:[0,5,10], pre:[] }；非法返回 null。 */
export function parseVersion(v) {
  const s = text(v).replace(/^v/i, '')
  if (!s) return null
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/.exec(s)
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** 语义化比较：a>b 返回 1，a<b 返回 -1，相等 0；任一非法返回 0。 */
export function cmpVersion(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i += 1) {
    if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1
  }
  if (x.pre.length === 0 && y.pre.length === 0) return 0
  if (x.pre.length === 0) return 1   // 正式版 > 预发布版
  if (y.pre.length === 0) return -1
  const n = Math.max(x.pre.length, y.pre.length)
  for (let i = 0; i < n; i += 1) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) { if (Number(p) !== Number(q)) return Number(p) > Number(q) ? 1 : -1; continue }
    if (pn !== qn) return pn ? -1 : 1
    if (p !== q) return p > q ? 1 : -1
  }
  return 0
}

const isFile = (p) => { try { return fs.statSync(p).isFile() } catch (_) { return false } }

/** 单测环境判定（与 index.js 第202节同一口径）。 */
const inTest = () => !!(process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test')

/** 插件根目录 = <root>/lib/dsh-console-cloud.mjs 的上一级。 */
export function pluginRootOf(metaUrl) {
  try { return path.dirname(path.dirname(fileURLToPath(metaUrl))) } catch (_) { return '' }
}

/** 'source' = 目录里有 .git（link 到源码仓）；'npm' = 装进 node_modules 的拷贝。 */
export function detectInstallKind(root) {
  try {
    if (fs.lstatSync(path.join(root, '.git')).isDirectory()) return 'source'
  } catch (_) { /* 没有 .git */ }
  try {
    if (fs.statSync(path.join(root, '.git')).isFile()) return 'source'   // worktree/submodule
  } catch (_) { /* 继续 */ }
  return 'npm'
}

/** node 可执行文件：环境变量 > 当前进程 > DevEco 自带 > 常见 unix 路径。 */
export function findNodeBin() {
  const cands = [
    text(process.env.DSH_CONSOLE_NODE_BIN),
    process.execPath,
    'C:\\Program Files\\Huawei\\DevEco Studio\\tools\\node\\node.exe',
    '/usr/bin/node',
    '/usr/local/bin/node'
  ]
  for (const c of cands) if (c && isFile(c)) return c
  return process.execPath
}

/** npm 入口（npm-cli.js）——PATH 里没有 npm，只能拿 node 直接跑它。 */
export function findNpmCli(nodeBin) {
  const dir = (() => { try { return path.dirname(nodeBin) } catch (_) { return '' } })()
  const cands = [
    text(process.env.DSH_CONSOLE_NPM_CLI),
    dir && path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    dir && path.join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js'
  ]
  for (const c of cands) if (c && isFile(c)) return c
  return ''
}

/**
 * pnpm 入口（pnpm.mjs / pnpm.cjs）—— 宿主 runtime 自带，也可用 DSH_CONSOLE_PNPM 指定。
 * 为什么需要它：profile 里 npm 装不动（6 条 link: 依赖 ⇒ EUNSUPPORTEDPROTOCOL），
 * pnpm 才认得 link:（第218节）。
 * ⚠️ 单测环境（没显式给 DSH_CONSOLE_PNPM）一律返空：用例⑩ 特意把 npm 入口按掉、
 *    断言 canUpdate=false；若这里在测试里探到宿主 pnpm，那个用例就会真去跑一次安装。
 */
export function findPnpmMjs(nodeBin) {
  if (inTest() && !text(process.env.DSH_CONSOLE_PNPM)) return ''
  const cands = []
  const push = (p) => { const s = text(p); if (s) cands.push(s) }
  push(text(process.env.DSH_CONSOLE_PNPM))

  const nodeDirs = []
  try { nodeDirs.push(path.dirname(nodeBin)) } catch (_) { /* ignore */ }
  try { nodeDirs.push(path.dirname(process.execPath)) } catch (_) { /* ignore */ }
  /* node 在 <X>/dependencies/node/bin ⇒ pnpm 在 <X>/dependencies/pnpm/bin；
     宿主 runtime 的 node 在 <Y>/primary-runtime/dependencies/node/bin ⇒ pnpm 在 <Y>/pnpm/bin。 */
  const rels = [
    ['..', '..', 'pnpm', 'bin', 'pnpm.mjs'],
    ['..', '..', 'pnpm', 'bin', 'pnpm.cjs'],
    ['..', '..', '..', 'pnpm', 'bin', 'pnpm.mjs'],
    ['..', '..', '..', 'pnpm', 'bin', 'pnpm.cjs']
  ]
  for (const d of nodeDirs) {
    if (!d) continue
    for (const rel of rels) push(path.join(d, ...rel))
  }

  /* 🔴 第218节补：只从 nodeBin 推导在真机上会落空——Electron 宿主里
     process.execPath 就是「DeepSeek Harness.exe」（不是 runtime 的 node），而 nodeBin
     又可能被 DSH_CONSOLE_NODE_BIN 指到别处（本机 = DevEco 的 node）。所以要直接给
     宿主安装根与 DSH 自带 runtime 两条绝对根：
       <安装根>/resources/runtime/pnpm/bin/pnpm.mjs（宿主自带，实测存在）
       <安装根>/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs
       ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs
     否则 caps.pnpm 为空 ⇒ 升级退回 npm ⇒ link: 依赖树报 EUNSUPPORTEDPROTOCOL。 */
  const roots = []
  const resPath = text(process.resourcesPath)
  if (resPath) roots.push(resPath)
  try { roots.push(path.join(path.dirname(process.execPath), 'resources')) } catch (_) { /* ignore */ }
  try { roots.push(path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime')) } catch (_) { /* ignore */ }
  for (const r of roots) {
    for (const rel of [
      ['runtime', 'pnpm', 'bin', 'pnpm.mjs'],
      ['runtime', 'pnpm', 'bin', 'pnpm.cjs'],
      ['runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'],
      ['runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'],
      ['dependencies', 'pnpm', 'bin', 'pnpm.mjs'],
      ['dependencies', 'pnpm', 'bin', 'pnpm.cjs']
    ]) push(path.join(r, ...rel))
  }

  for (const c of ['/usr/local/bin/pnpm', '/usr/bin/pnpm']) push(c)
  for (const c of cands) if (c && isFile(c)) return c
  return ''
}

/** profile 目录（装法下 pnpm/npm 的执行位置）。 */
export function findProfileDir() {
  const env = text(process.env.DSH_PROFILE_DIR) || text(process.env.DSH_PROFILE)
  if (env && isFile(path.join(env, 'package.json'))) return env
  const cwd = process.cwd()
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))
    if (j && j.dependencies && typeof j.dependencies === 'object') return cwd
  } catch (_) { /* cwd 不是 profile */ }
  const guess = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
  return isFile(path.join(guess, 'package.json')) ? guess : cwd
}

/**
 * 跑一条命令并收尾（stdout/stderr 各留尾部 OUT_CAP 字符）。
 * @returns {Promise<{ok:boolean,code:number|null,signal:string|null,out:string,err:string,timedOut:boolean}>}
 */
export function runCommandCapture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child
    const env = Object.assign({}, process.env, opts.env || {}, {
      GIT_TERMINAL_PROMPT: '0',      // 绝不卡在「请输入用户名密码」
      GIT_ASKPASS: 'echo',
      GCM_INTERACTIVE: 'never',
      npm_config_yes: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false'
    })
    try {
      child = spawn(cmd, args, { cwd: opts.cwd || undefined, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, code: null, signal: null, out: '', err: 'spawn 失败：' + ((e && e.message) || e), timedOut: false })
      return
    }
    if (opts.onChild) opts.onChild(child)
    let out = ''
    let err = ''
    const push = (which, chunk) => {
      const s = String(chunk)
      if (which === 'out') out = (out + s).slice(-OUT_CAP)
      else err = (err + s).slice(-OUT_CAP)
      if (typeof opts.onLine === 'function') {
        for (const line of s.split(/\r?\n/)) { const t = line.trim(); if (t) opts.onLine(which, t) }
      }
    }
    child.stdout.on('data', (c) => push('out', c))
    child.stderr.on('data', (c) => push('err', c))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch (_) { /* 已退出 */ }
    }, Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : CMD_TIMEOUT_MS)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, code: null, signal: null, out, err: err + '\n' + ((e && e.message) || e), timedOut })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ ok: code === 0 && !timedOut, code, signal: signal || null, out, err, timedOut })
    })
  })
}

/** 从命令输出里挑一句人话当失败原因。 */
function brief(r) {
  const raw = text(r.err) || text(r.out) || ''
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const line = lines.length ? lines[lines.length - 1] : ('退出码 ' + String(r.code))
  return line.slice(0, 300)
}

/**
 * 造一个自更新引擎。所有网络/子进程都在这里；外面（index.js）只做转发。
 * @param {object} opts - { logger, version, pluginRoot, metaUrl, registry, repo }
 */
export function createCloudPlugin(opts = {}) {
  const log = typeof opts.logger === 'function' ? opts.logger : () => {}
  const root = text(opts.pluginRoot) || pluginRootOf(opts.metaUrl || import.meta.url)
  const registry = (text(opts.registry) || text(process.env.DSH_CONSOLE_REGISTRY) || DEFAULT_REGISTRY).replace(/\/+$/, '')

  /* 版本号缓存：只在 refresh() 里写，now() 只读（同步，绝不发网络）。 */
  let latest = { version: '', at: 0, error: '', checked: false }
  /* 能力探测缓存。 */
  let caps = { at: 0, git: false, gitError: '', node: '', npmCli: '', pnpm: '' }
  /* 当前/最近一次任务。 */
  let job = null
  let seq = 0
  let child = null

  const installKind = () => detectInstallKind(root)
  const installDev = () => installKind() === 'source'

  function readLocalVersion() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
      return text(j && j.version)
    } catch (_) { return '' }
  }
  /** 当前磁盘上的版本：优先现读文件（升级后立刻准），读不到才用启动时的号。 */
  const currentVersion = () => readLocalVersion() || text(opts.version) || 'unknown'

  async function probeCaps(force) {
    const now = Date.now()
    if (!force && caps.at && now - caps.at < CAP_TTL_MS) return caps
    /* 单测环境（没显式给 registry 缝）⇒ 不起子进程、不打网络，纯离线确定。 */
    if (inTest() && !text(process.env.DSH_CONSOLE_REGISTRY)) {
      caps = { at: now, git: false, gitError: '测试环境未探测', node: '', npmCli: '', pnpm: '' }
      return caps
    }
    const node = findNodeBin()
    const npmCli = findNpmCli(node)
    const pnpm = findPnpmMjs(node)
    const r = await runCommandCapture('git', ['--version'], { timeoutMs: 8000 })
    caps = { at: now, git: r.ok, gitError: r.ok ? '' : brief(r), node, npmCli, pnpm }
    return caps
  }

  /**
   * 问 npm registry 要最新版号；同时刷新能力探测。
   * 失败静默保留旧值（error 只是给面板显示的一句话）。
   */
  async function refresh(force) {
    const now = Date.now()
    if (!force && latest.checked && now - latest.at < TTL_MS) return now0()
    /* 单测环境（没显式给 registry 缝）⇒ 跳过网络，缓存只落 checked 标记。 */
    if (inTest() && !text(process.env.DSH_CONSOLE_REGISTRY)) {
      latest = { version: latest.version, at: now, error: '', checked: true }
      return now0()
    }
    try {
      const url = registry + '/' + NPM_PACKAGE + '/latest'
      const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) })
      if (!r || !r.ok) throw new Error('npm registry HTTP ' + String(r && r.status))
      const j = await r.json()
      const v = text(j && j.version)
      if (!v) throw new Error('npm registry 没给 version 字段')
      latest = { version: v, at: now, error: '', checked: true }
      /* 顺手把号同步给 index.js 的模块级缓存，/info 的 latestVersion 立刻准。 */
      if (typeof opts.onLatest === 'function') { try { opts.onLatest(v) } catch (_) { /* 回调不许影响检测 */ } }
    } catch (e) {
      latest = { version: latest.version, at: now, error: (e && e.message) || String(e), checked: true }
      log('[update] 查最新版号失败（静默）：' + latest.error)
    }
    try { await probeCaps(false) } catch (_) { /* 探测失败不影响查版本 */ }
    return now0()
  }

  /** 任务视图（对外形状冻结，客户端逐键读）。 */
  function jobView() {
    if (!job) return null
    return {
      id: job.id,
      kind: job.kind,                 // 'update' | 'rollback'
      state: job.state,               // 'running' | 'succeeded' | 'failed' | 'cancelled'
      phase: job.phase,
      from: job.from,
      to: job.to,
      restarted: false,
      restartHint: job.state === 'succeeded' ? '重启 DSH 后新版本生效' : '',
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      log: job.log.slice(-30)         // 面板只显示尾部 30 行
    }
  }

  /** 同步现状（绝不发网络、绝不起子进程）。 */
  function now0() {
    const cur = currentVersion()
    const kind = installKind()
    const dev = kind === 'source'
    const avail = !!latest.version && cmpVersion(latest.version, cur) > 0
    /* 第218节：npm 装法现在优先用 pnpm（npm 在 link: 依赖树下跑不动），
       两个入口有任意一个就能升级，否则面板按钮会被禁用、用户点不动。 */
    const canUpdate = dev ? !!caps.git : (!!caps.pnpm || !!caps.npmCli)
    return {
      ok: true,
      current: cur,
      latest: latest.version,
      latestAt: latest.at,
      latestError: latest.error,
      latestChecked: latest.checked,
      updateAvailable: avail,
      installKind: kind,
      installDev: dev,
      pluginRoot: root,
      repo: DEFAULT_REPO,
      canUpdate,
      gitAvailable: !!caps.git,
      gitError: caps.gitError,
      npmAvailable: !!caps.npmCli,
      pnpmAvailable: !!caps.pnpm,
      job: jobView(),
      message: (!dev && !caps.npmCli && !caps.pnpm) ? '找不到 npm 入口，无法自动升级（可到插件市场更新）' : ''
    }
  }

  /* ---------- 任务执行 ---------- */

  function newJob(kind, from, to) {
    seq += 1
    return {
      id: 'u' + String(seq) + '-' + Date.now().toString(36),
      kind, state: 'running', phase: '准备',
      from: from || '', to: to || '',
      startedAt: Date.now(), finishedAt: 0, error: '', log: []
    }
  }

  function note(msg) {
    if (!job) return
    const line = new Date().toISOString().slice(11, 19) + ' ' + msg
    job.log.push(line)
    if (job.log.length > 200) job.log.shift()
    log('[update] ' + msg)
  }

  /** 跑一步；失败即抛出（带一句人话）。 */
  async function step(phase, cmd, args, o = {}) {
    job.phase = phase
    note(phase + '：' + cmd + ' ' + args.join(' '))
    const r = await runCommandCapture(cmd, args, Object.assign({ cwd: o.cwd, timeoutMs: o.timeoutMs, onChild: (c) => { child = c } }, o.spawnOpts))
    child = null
    if (!r.ok) {
      note('· 失败：' + brief(r))
      const e = new Error(phase + ' 失败：' + brief(r))
      e.detail = { out: r.out, err: r.err, code: r.code, timedOut: r.timedOut }
      throw e
    }
    if (text(r.out)) note('· ' + text(r.out).split(/\r?\n/).filter(Boolean).slice(-3).join(' / '))
    return r
  }

  /**
   * 在 profile 目录里装指定版本（第218节）。
   * 优先 pnpm（宿主 runtime 自带，可用 DSH_CONSOLE_PNPM 指定）：
   *   profile 的 package.json 有 6 条 link: 依赖，npm 解析整棵树直接报
   *   EUNSUPPORTEDPROTOCOL「Unsupported URL Type "link:"」（实测）；
   *   pnpm 认得 link:（实测在 profile 跑 install --frozen-lockfile EXIT=0）。
   * --config.minimumReleaseAge=0：pnpm 默认拦「刚发布太新的版本」，而 profile 的
   *   pnpm-workspace.yaml 里 minimumReleaseAgeExclude 只列到 0.5.13，新发的
   *   0.5.14 会被拦（升级就成了空转），所以显式关掉这道闸。
   * --save-exact：保持 profile/package.json 里的精确版本号（原来是 "0.5.13"），
   *   不许写成 ^0.5.14 让以后自己漂移。
   * 找不到 pnpm 才退回 npm install（旧行为；link: 依赖树下会失败）。
   */
  async function installInProfile(profile, ver, phase) {
    const node = findNodeBin()
    const pnpm = caps.pnpm || findPnpmMjs(node)
    if (pnpm) {
      return step(phase, node, [
        pnpm, 'add', NPM_PACKAGE + '@' + ver,
        '--save-exact',
        '--config.minimumReleaseAge=0',
        '--config.confirmModulesPurge=false',
        '--reporter=append-only',
        '--loglevel=error'
      ], {
        cwd: profile, timeoutMs: CMD_TIMEOUT_MS,
        spawnOpts: { env: { CI: '1', npm_config_registry: registry, npm_config_yes: 'true' } }
      })
    }
    if (!caps.npmCli) throw new Error('找不到 npm/pnpm 入口，无法自动升级')
    return step(phase, node, [
      caps.npmCli, 'install', NPM_PACKAGE + '@' + ver, '--no-audit', '--no-fund', '--loglevel=error'
    ], { cwd: profile, timeoutMs: CMD_TIMEOUT_MS })
  }

  function finish(state, error) {
    job.state = state
    job.finishedAt = Date.now()
    job.phase = state === 'succeeded' ? '完成' : (state === 'cancelled' ? '已取消' : '失败')
    job.error = text(error)
    note(state === 'succeeded' ? '升级完成' : ('结束：' + (job.error || state)))
  }

  function saveJournal(entry) {
    try {
      const f = path.join(os.homedir(), '.dsh', 'dsh-console-update.json')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, JSON.stringify(entry, null, 2))
    } catch (e) { log('[update] 写升级台账失败：' + ((e && e.message) || e)) }
  }

  function readJournal() {
    try {
      return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'dsh-console-update.json'), 'utf8'))
    } catch (_) { return null }
  }

  /** 探测 source 形态当前分支与领先/落后情况。 */
  async function gitState() {
    const head = await runCommandCapture('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 10000 })
    const headSha = text(head.out)
    const br = await runCommandCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: 10000 })
    const branch = text(br.out) || 'HEAD'
    const dirty = await runCommandCapture('git', ['status', '--porcelain'], { cwd: root, timeoutMs: 15000 })
    return { headSha, branch, dirty: text(dirty.out) }
  }

  async function doUpdate() {
    const from = currentVersion()
    /* 🔴 第218节修 bug：这里原来写的是 newJob('update', from, '')，
       会把 startUpdate() 已经算好的目标版号（latest.version）清空，
       紧接着下面就 if (!job.to) 抛「还没拿到 npm 最新版号」——
       用户点「升级」必然失败（m00398 截图红字）。目标号必须留着。 */
    job = newJob('update', from, text(latest.version))
    note('开始升级：当前 ' + from + '（' + installKind() + ' 装法）')
    try {
      await probeCaps(true)
      if (!job.from) job.from = from
      if (installDev()) {
        if (!caps.git) throw new Error('找不到 git，无法从源码目录升级：' + (caps.gitError || 'git 不可用'))
        const st = await gitState()
        if (st.dirty) throw new Error('插件源码目录有未提交改动，先提交/暂存再升级（git status --porcelain 非空）')
        job.headFrom = st.headSha
        await step('拉取远端', 'git', ['fetch', '--prune', 'origin'], { cwd: root, timeoutMs: 120000 })
        const merge = await runCommandCapture('git', ['merge', '--ff-only', 'origin/' + st.branch], { cwd: root, timeoutMs: 60000 })
        if (!merge.ok) {
          note('· 快进失败：' + brief(merge))
          throw new Error('无法快进到 origin/' + st.branch + '（本地可能有未推送提交）：' + brief(merge))
        }
        note('· git 已快进到 origin/' + st.branch)
        await step('校准依赖', findNodeBin(),
          [findNpmCli(findNodeBin()), 'install', '--no-audit', '--no-fund', '--loglevel=error'],
          { cwd: root, timeoutMs: CMD_TIMEOUT_MS })
        const st2 = await gitState()
        job.headTo = st2.headSha
      } else {
        if (!caps.npmCli && !caps.pnpm) throw new Error('找不到 npm/pnpm 入口，无法自动升级')
        if (!job.to) throw new Error('还没拿到 npm 最新版号，先点一次「检测更新」')
        const profile = findProfileDir()
        await installInProfile(profile, job.to, '安装新版本')
        try {
          const j = JSON.parse(fs.readFileSync(path.join(profile, 'node_modules', NPM_PACKAGE, 'package.json'), 'utf8'))
          note('· 落盘版本 = ' + text(j && j.version))
        } catch (_) { note('· 落盘版本读不到（不影响重启生效）') }
      }
      const after = readLocalVersion() || currentVersion()
      job.to = after
      if (after === from) note('· 版本号没变（' + after + '），可能已经是新版')
      saveJournal({ last: { kind: 'update', from: job.from, to: after, headFrom: job.headFrom || '', headTo: job.headTo || '', at: Date.now(), installKind: installKind() } })
      finish('succeeded')
    } catch (e) {
      finish('failed', (e && e.message) || String(e))
    }
  }

  async function doRollback() {
    const jr = readJournal()
    const last = jr && jr.last
    if (!last || !text(last.from)) throw new Error('没有可回滚的记录（升级台账里没有 from 版本号）')
    const from = last.from
    job = newJob('rollback', currentVersion(), from)
    note('开始回滚到 ' + from)
    try {
      await probeCaps(true)
      if (installDev() && text(last.headFrom)) {
        const st = await gitState()
        if (st.dirty) throw new Error('插件源码目录有未提交改动，先提交/暂存再回滚')
        await step('切回旧提交', 'git', ['-c', 'advice.detachedHead=false', 'checkout', text(last.headFrom)], { cwd: root, timeoutMs: 60000 })
        await step('校准依赖', findNodeBin(), [findNpmCli(findNodeBin()), 'install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: root, timeoutMs: CMD_TIMEOUT_MS })
      } else {
        if (!caps.npmCli && !caps.pnpm) throw new Error('找不到 npm/pnpm 入口，无法自动回滚')
        const profile = findProfileDir()
        await installInProfile(profile, from, '装回旧版本')
      }
      saveJournal({ last: { kind: 'rollback', from: job.from, to: from, at: Date.now(), installKind: installKind() } })
      finish('succeeded')
    } catch (e) {
      finish('failed', (e && e.message) || String(e))
    }
  }

  /** 起一个任务（同步返回任务视图，后台异步跑）。同一时刻只允许一个。 */
  function startUpdate(mode) {
    if (job && job.state === 'running') throw new Error('已经有一个升级任务在跑（' + job.id + '），等它结束')
    const kind = mode === 'rollback' ? 'rollback' : 'update'
    if (kind === 'update') {
      if (!installDev() && !text(latest.version)) throw new Error('还没检测到最新版号，先点「重新检测」')
      if (kind === 'update' && latest.version && cmpVersion(latest.version, currentVersion()) <= 0) {
        throw new Error('已经是最新版（' + currentVersion() + '）')
      }
    }
    job = newJob(kind, currentVersion(), latest.version)
    const p = kind === 'rollback' ? doRollback() : doUpdate()
    p.catch((e) => { try { finish('failed', (e && e.message) || String(e)) } catch (_) { /* 已结束 */ } })
    return jobView()
  }

  /** 取消当前任务：杀掉正在跑的子进程。 */
  function cancel() {
    if (!job || job.state !== 'running') return jobView()
    if (child) {
      try { child.kill('SIGKILL') } catch (_) { /* 已退出 */ }
      note('用户取消：已杀掉子进程')
    }
    finish('cancelled')
    return jobView()
  }

  return {
    refresh,
    state: now0,
    updateState: now0,
    jobView,
    startUpdate,
    cancel,
    pluginRoot: () => root,
    installKind,
    installDev,
    currentVersion,
    capabilities: () => ({ git: !!caps.git, node: caps.node, npmCli: caps.npmCli, pnpm: caps.pnpm })
  }
}
