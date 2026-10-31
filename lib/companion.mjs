
import fs from 'node:fs'
import path from 'node:path'

export const COMPANION_ID = 'dsh-web-mobile'
export const COMPANION_SPEC = 'dsh-web-mobile@3.2.1'
export const COMPANION_MAX_TRIES = 3

export function companionStatePath(home) {
  const base = home ? String(home) : ''
  return base ? path.join(base, '.dsh', 'dsh-console-companion.json') : ''
}

function readState(file) {
  if (!file) return {}
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? o : {}
  } catch (e) {
    return {}
  }
}

function writeState(file, obj) {
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
  } catch (e) {}
}

function failureOf(res) {
  const r = res || {}
  const app = String(r.application || '')
  const code = r.error && r.error.code ? String(r.error.code) : ''
  const diag = r.error && r.error.diagnostic ? String(r.error.diagnostic) : ''
  if (app === 'failed' || app === 'cancelled' || code) return { failed: code || app || 'unknown', diag, app }
  return null
}

export async function ensureCompanionPlugin(opts) {
  const o = opts || {}
  const log = typeof o.log === 'function' ? o.log : () => {}
  const id = String(o.id || COMPANION_ID)
  const spec = String(o.spec || COMPANION_SPEC)
  const maxTriesRaw = Number(o.maxTries)
  const maxTries = Number.isFinite(maxTriesRaw) && maxTriesRaw > 0 ? maxTriesRaw : COMPANION_MAX_TRIES
  const file = String(o.statePath || '')
  const svc = o.svc || null

  if (o.disabled) {
    log('companion: 配置里关掉了随附插件自动安装，跳过')
    return { action: 'skipped', reason: 'disabled' }
  }

  const st = readState(file)
  if (st && st.ok) return { action: 'skipped', reason: 'done', state: st }

  const tries = Number((st && st.tries) || 0) || 0
  if (tries >= maxTries) {
    log(
      'companion: 之前连续 ' + tries + ' 次没装上，这次不再尝试（想重试就删掉 ' + file + '）'
    )
    return { action: 'skipped', reason: 'gave-up', tries }
  }

  if (!svc || (typeof svc.listBundles !== 'function' && typeof svc.installBundle !== 'function')) {
    log('companion: 宿主 pluginManager 服务不可用，跳过（不影响控制台）')
    return { action: 'skipped', reason: 'no-service' }
  }

  const bump = (extra) => {
    const next = Object.assign({ tries: tries + 1, at: new Date().toISOString() }, extra || {})
    writeState(file, next)
    return next
  }
  const done = (extra) => {
    const next = Object.assign({ ok: true, at: new Date().toISOString() }, extra || {})
    writeState(file, next)
    return next
  }

  let entry = null
  if (typeof svc.listBundles === 'function') {
    try {
      const list = (await svc.listBundles()) || []
      const arr = Array.isArray(list) ? list : []
      for (const b of arr) {
        if (String((b && b.name) || '') === id) {
          entry = b
          break
        }
      }
    } catch (e) {
      log('companion: 读插件清单失败，按「还没装」处理: ' + ((e && e.message) || e))
    }
  }

  if (entry && entry.enabled) {
    done({ how: 'preexisting', version: String(entry.version || '') })
    log('companion: ' + id + ' 已经在、且已启用，不再动它')
    return { action: 'already', version: String(entry.version || '') }
  }

  if (entry && typeof svc.setBundleEnabled === 'function') {
    log('companion: ' + id + ' 装了但没启用，打开它')
    try {
      const r = (await svc.setBundleEnabled(id, true)) || {}
      const bad = failureOf(r)
      if (bad) {
        bump({ last: bad.failed })
        log('companion: 启用失败 ' + bad.failed + (bad.diag ? '（' + bad.diag + '）' : ''))
        return { action: 'failed', stage: 'enable', reason: bad.failed }
      }
      const app = String(r.application || '')
      done({ how: 'enabled', application: app })
      log('companion: 已启用 ' + id + ' application=' + app)
      return { action: 'enabled', application: app, needRestart: app === 'restart-required' }
    } catch (e) {
      const msg = String((e && e.message) || e)
      bump({ last: msg })
      log('companion: 启用异常 ' + msg)
      return { action: 'failed', stage: 'enable', reason: msg }
    }
  }

  if (typeof svc.installBundle !== 'function') {
    log('companion: 宿主不给 installBundle，装不了（插件版本较旧），跳过')
    return { action: 'skipped', reason: 'no-install-api' }
  }

  log('companion: 开始自动安装 ' + spec + '（第一次会慢十几秒）')
  try {
    const r = (await svc.installBundle(spec, { enabled: true, saveExact: true })) || {}
    const bad = failureOf(r)
    if (bad) {
      bump({ last: bad.failed })
      log('companion: 安装失败 ' + bad.failed + (bad.diag ? '（' + bad.diag + '）' : ''))
      return { action: 'failed', stage: 'install', reason: bad.failed }
    }
    const version = String(r.version || '')
    const app = String(r.application || '')
    done({ how: 'installed', version, application: app })
    log('companion: 装好了 ' + id + ' version=' + version + ' application=' + app)
    return { action: 'installed', version, application: app, needRestart: app === 'restart-required' }
  } catch (e) {
    const msg = String((e && e.message) || e)
    bump({ last: msg })
    log('companion: 安装异常 ' + msg)
    return { action: 'failed', stage: 'install', reason: msg }
  }
}
