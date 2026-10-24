import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const NPM_PACKAGE = 'dsh-console-plugin'
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
export const DEFAULT_REPO = 'https://github.com/ChenJun25/dsh-console-plugin.git'

export const FALLBACK_REGISTRIES = [
  DEFAULT_REGISTRY,
  'https://registry.npmmirror.com',
  'https://repo.huaweicloud.com/repository/npm',
  'https://registry.yarnpkg.com'
]

export const CMD_TIMEOUT_MS = 10 * 60 * 1000

const OUT_CAP = 4000

const TTL_MS = 10 * 60 * 1000

const CAP_TTL_MS = 5 * 60 * 1000

function text(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : ''
}

export function parseVersion(v) {
  const s = text(v).replace(/^v/i, '')
  if (!s) return null
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/.exec(s)
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

export function cmpVersion(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i += 1) {
    if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1
  }
  if (x.pre.length === 0 && y.pre.length === 0) return 0
  if (x.pre.length === 0) return 1
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

const inTest = () => !!(process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test')

export function registryList(opts = {}) {
  const out = []
  const push = (v) => {
    const s = text(v).replace(/\/+$/, '')
    if (s && out.indexOf(s) < 0) out.push(s)
  }

  if (text(opts.registry)) push(opts.registry)
  const multi = text(process.env.DSH_CONSOLE_REGISTRIES)
  if (multi) {
    for (const one of multi.split(',')) push(one)
  } else {

    const one = text(process.env.DSH_CONSOLE_REGISTRY)
    if (one) push(one)
    else for (const r of FALLBACK_REGISTRIES) push(r)
  }
  if (out.length === 0) push(DEFAULT_REGISTRY)
  return out
}

export async function fetchLatestFromSources(registries, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 6000
  const list = Array.isArray(registries) ? registries.slice() : []
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const bad = []
  const ok = []
  let best = { version: '', registry: '' }
  const tasks = list.map(async (reg) => {
    const url = String(reg).replace(/\/+$/, '') + '/' + NPM_PACKAGE + '/latest'
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
      if (!r || !r.ok) throw new Error('HTTP ' + String(r && r.status))
      const j = await r.json()
      const v = text(j && j.version)
      if (!v) throw new Error('没给 version 字段')
      return { reg, v }
    } catch (e) {
      bad.push(reg + ' → ' + ((e && e.message) || String(e)))
      return null
    }
  })
  const settled = await Promise.all(tasks)
  for (const one of settled) {
    if (!one) continue
    ok.push(one.reg + ' → ' + one.v)
    if (!best.version || cmpVersion(one.v, best.version) > 0) best = { version: one.v, registry: one.reg }
  }
  if (!best.version) {
    const err = '各源都没给出可用版号：' + (bad.join('；') || '（没有候选源）')
    log('[update] 查最新版号失败（静默）：' + err)
    return { version: '', registry: '', error: err, ok, bad }
  }
  if (bad.length) log('[update] 部分源不可用（已忽略）：' + bad.join('；'))
  return { version: best.version, registry: best.registry, error: '', ok, bad }
}

export function pluginRootOf(metaUrl) {
  try { return path.dirname(path.dirname(fileURLToPath(metaUrl))) } catch (_) { return '' }
}

export function detectInstallKind(root) {
  try {
    if (fs.lstatSync(path.join(root, '.git')).isDirectory()) return 'source'
  } catch (_) {  }
  try {
    if (fs.statSync(path.join(root, '.git')).isFile()) return 'source'   // worktree/submodule
  } catch (_) {  }
  return 'npm'
}

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

export function findPnpmMjs(nodeBin) {
  if (inTest() && !text(process.env.DSH_CONSOLE_PNPM)) return ''
  const cands = []
  const push = (p) => { const s = text(p); if (s) cands.push(s) }
  push(text(process.env.DSH_CONSOLE_PNPM))

  const nodeDirs = []
  try { nodeDirs.push(path.dirname(nodeBin)) } catch (_) { /* ignore */ }
  try { nodeDirs.push(path.dirname(process.execPath)) } catch (_) { /* ignore */ }

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

export function findProfileDir() {
  const env = text(process.env.DSH_PROFILE_DIR) || text(process.env.DSH_PROFILE)
  if (env && isFile(path.join(env, 'package.json'))) return env
  const cwd = process.cwd()
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))
    if (j && j.dependencies && typeof j.dependencies === 'object') return cwd
  } catch (_) {  }
  const guess = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
  return isFile(path.join(guess, 'package.json')) ? guess : cwd
}

export function runCommandCapture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child
    const env = Object.assign({}, process.env, opts.env || {}, {
      GIT_TERMINAL_PROMPT: '0',
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
      try { child.kill('SIGKILL') } catch (_) {  }
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

function brief(r) {
  const raw = text(r.err) || text(r.out) || ''
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const line = lines.length ? lines[lines.length - 1] : ('退出码 ' + String(r.code))
  return line.slice(0, 300)
}

export function createCloudPlugin(opts = {}) {
  const log = typeof opts.logger === 'function' ? opts.logger : () => {}
  const root = text(opts.pluginRoot) || pluginRootOf(opts.metaUrl || import.meta.url)
  const registries = registryList(opts)

  let registryForInstall = registries[0]

  let latestSource = ''

  const offlineTest = () => inTest() && !text(opts.registry)
    && !text(process.env.DSH_CONSOLE_REGISTRIES) && !text(process.env.DSH_CONSOLE_REGISTRY)

  let latest = { version: '', at: 0, error: '', checked: false }

  let caps = { at: 0, git: false, gitError: '', node: '', npmCli: '', pnpm: '' }

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

  const currentVersion = () => readLocalVersion() || text(opts.version) || 'unknown'

  async function probeCaps(force) {
    const now = Date.now()
    if (!force && caps.at && now - caps.at < CAP_TTL_MS) return caps

    if (offlineTest()) {
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

  async function refresh(force) {
    const now = Date.now()
    if (!force && latest.checked && now - latest.at < TTL_MS) return now0()

    if (offlineTest()) {
      latest = { version: latest.version, at: now, error: '', checked: true }
      return now0()
    }

    try {
      const res = await fetchLatestFromSources(registries, { log })
      if (res.version) {
        latest = { version: res.version, at: now, error: '', checked: true }
        registryForInstall = res.registry || registryForInstall
        latestSource = res.registry || ''

        if (typeof opts.onLatest === 'function') { try { opts.onLatest(res.version) } catch (_) {  } }
      } else {
        latest = { version: latest.version, at: now, error: res.error, checked: true }
      }
    } catch (e) {
      latest = { version: latest.version, at: now, error: (e && e.message) || String(e), checked: true }
      log('[update] 查最新版号失败（静默）：' + latest.error)
    }
    try { await probeCaps(false) } catch (_) {  }
    return now0()
  }

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
      log: job.log.slice(-30)
    }
  }

  function now0() {
    const cur = currentVersion()
    const kind = installKind()
    const dev = kind === 'source'
    const avail = !!latest.version && cmpVersion(latest.version, cur) > 0

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
        spawnOpts: { env: { CI: '1', npm_config_registry: registryForInstall, npm_config_yes: 'true' } }
      })
    }
    if (!caps.npmCli) throw new Error('找不到 npm/pnpm 入口，无法自动升级')

    return step(phase, node, [
      caps.npmCli, 'install', NPM_PACKAGE + '@' + ver, '--no-audit', '--no-fund', '--loglevel=error',
      '--registry', registryForInstall
    ], {
      cwd: profile, timeoutMs: CMD_TIMEOUT_MS,
      spawnOpts: { env: { npm_config_registry: registryForInstall, npm_config_yes: 'true' } }
    })
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
    p.catch((e) => { try { finish('failed', (e && e.message) || String(e)) } catch (_) {  } })
    return jobView()
  }

  function cancel() {
    if (!job || job.state !== 'running') return jobView()
    if (child) {
      try { child.kill('SIGKILL') } catch (_) {  }
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
