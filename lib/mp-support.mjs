/**
 * mp 支持的接线 —— 把契约层、分发器、路由、WS 接到一起。
 *
 * 单独一个文件是为了让 index.js 的改动最小：那边只要多一行
 * `mp: attachMp(ctx, { log, config, getToken })`。
 *
 * 配对沿用 dsh-console 已有的 6 位码：同一个码换 mp_device Cookie，
 * 不另搞一套 —— 用户已经在面板上看见那个码了，再给一个会记错。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMpBranch, mountMpUpgrade } from './mp-routes.mjs'
import { createDispatcher } from './mp-dispatch.mjs'
import { createLiveUpgrade } from './mp-ws-live.mjs'
import {
  approvalFrame, mergePending, pendingSnapshot, questionFrame,
} from './mp-contract.mjs'

/** 设备在线判定：最近这么久内有活动就算在线（面板状态灯的 PHONE_TTL 同量级）。 */
const DEVICE_ONLINE_TTL = 10 * 60 * 1000

/* ═══════════════════════════════════════════════════════════════════════════
 * 🔴 第193节 · task-1（A）· 设备撤销黑名单（**落盘**）
 * ---------------------------------------------------------------------------
 * 为什么必须落盘：createDeviceStore 的 devices 是**进程内 Map**（见下面 :50 的注释），
 * DSH 一重启就空。而「面板上移除这台手机」的用户预期是**这台手机从此连不上**：
 * 只删 Map 的话，手机持长期 token 打一发 /mp-cookie 就被免码签发重新塞回登记表
 * （lan-server.mjs 的 /mp-cookie → issueDevice → mint），「移除」形同虚设；重启更是
 * 把删过的设备全部忘光。所以撤销事实必须落盘。
 *
 * 存哪：默认 ~/.dsh/dsh-console-revoked.json；可用 createDeviceStore(deps).revokedPath
 *      或环境变量 DSH_CONSOLE_REVOKED_FILE 覆盖（单测/多实例隔离全靠它）。
 * 结构：{ version, updatedMs, deviceIds:[], secrets:[], uids:[],
 *         entries:[{ deviceId, uid, secrets:[], revokedMs }] }
 * 写：先写同目录 '<file>.<pid>.tmp' 再 rename ⇒ 原子（不会留下半个 JSON）。
 * 读：文件不存在 / 读失败 / JSON 解析失败 / 形状不对 ⇒ **一律当空表**，绝不抛错
 *     （黑名单文件坏掉不该让整个插件起不来）。
 * ⚠️ node --test 下默认落到 os.tmpdir() 的唯一临时文件：单测会真拉黑 uid，
 *    写用户真实文件既污染用户主目录，又会让同文件里后续用例的 mint() 被拒签。
 * ═══════════════════════════════════════════════════════════════════════════ */
const REVOKED_VERSION = 1
let revokedTestSeq = 0

function plainTxt(v) { return String(v == null ? '' : v).trim() }

/** 黑名单文件路径：显式 deps.revokedPath → 环境变量 → node --test 临时文件 → 用户主目录。 */
function resolveRevokedPath(deps) {
  const explicit = plainTxt(deps && deps.revokedPath)
    || plainTxt(process.env && process.env.DSH_CONSOLE_REVOKED_FILE)
  if (explicit !== '') return explicit
  if (process.env && process.env.NODE_TEST_CONTEXT) {
    return path.join(os.tmpdir(),
      'dsh-console-revoked-test-' + process.pid + '-' + (revokedTestSeq++) + '.json')
  }
  return path.join(os.homedir(), '.dsh', 'dsh-console-revoked.json')
}

function revokedEmpty() {
  return { version: REVOKED_VERSION, updatedMs: 0, deviceIds: [], secrets: [], uids: [], entries: [] }
}

/** 去空去重字符串数组（文件里可能被手改出脏值，一律洗一遍）。 */
function strList(v) {
  if (!Array.isArray(v)) return []
  const seen = new Set()
  const out = []
  for (const x of v) {
    const s = plainTxt(x)
    if (s === '' || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/** 读黑名单：任何毛病都退化成空表（不抛错）。 */
function readRevoked(file) {
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) { return revokedEmpty() }
  let j = null
  try { j = JSON.parse(raw) } catch (e) { return revokedEmpty() }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return revokedEmpty()
  const entries = []
  if (Array.isArray(j.entries)) {
    for (const e of j.entries) {
      if (!e || typeof e !== 'object') continue
      entries.push({
        deviceId: plainTxt(e.deviceId),
        uid: plainTxt(e.uid),
        secrets: strList(e.secrets),
        revokedMs: Number(e.revokedMs) || 0,
      })
    }
  }
  return {
    version: REVOKED_VERSION,
    updatedMs: Number(j.updatedMs) || 0,
    deviceIds: strList(j.deviceIds),
    secrets: strList(j.secrets),
    uids: strList(j.uids),
    entries,
  }
}

/** 原子落盘（.tmp + rename）；失败只返回 false，绝不抛（撤销流程不因 IO 挂掉）。 */
function writeRevoked(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
    return true
  } catch (e) { return false }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 🔴 第193节 · task-5 · 设备登记表（**落盘**）
 * ---------------------------------------------------------------------------
 * 为什么必须落盘：devices 以前只是进程内 Map（见下面 createDeviceStore 里那行），
 * 用户 m00320 实测「刚重启电脑，DSH 节点管理页还是显示『还没有手机配对过』」——
 * 手机侧 mp_device 还能靠 liveCookie 重签自愈，**电脑端的名单却永远回不来**。
 * 所以配对记录必须落盘。
 *
 * 存哪：默认 ~/.dsh/dsh-console-devices.json；可用 createDeviceStore(deps).devicesPath
 *      或环境变量 DSH_CONSOLE_DEVICES_FILE 覆盖；node --test 下走 os.tmpdir() 唯一
 *      临时文件（口径与上面的撤销黑名单完全一致，**单测绝不碰用户真实文件**）。
 * 结构：{ version, updatedMs, records:[{ deviceId, secrets:[], model, name, pairedAt,
 *         lastSeen, uid, cloudUid, pubId, account, nickName, selfAccountUid,
 *         selfAccountName }] }
 *        ⚠️ 落盘的是**记录**（一条记录可挂多张 secret 别名，见 mint/mergeSameIdentity），
 *        不是 Map 的直接快照 —— 同一记录对象的多个 secret 键只写成一行，读回再展开。
 * 写：与 writeRevoked 同一套 .tmp + rename 原子写；失败只返回 false，绝不抛。
 * 读：文件不存在 / 读失败 / JSON 坏 / 缺 version（老文件或手工文件）/ 形状不对
 *     ⇒ **一律当空表**，不抛错、不崩路由。
 * 🔴 secret 绝不外泄：这个文件在磁盘上，但 list() 的白名单一字不动 —— 任何 HTTP 响应
 *    （/info /cmd /state ...）都不会出现 secret；读回只用于 isPaired/touch 命中。
 * ⚠️ devices 与 revoked 是**两个独立文件**：设备表坏掉不该让黑名单失效，反之亦然。
 * ═══════════════════════════════════════════════════════════════════════════ */
const DEVICES_VERSION = 1
let devicesTestSeq = 0

/** 设备表文件路径：显式 deps.devicesPath → 环境变量 → node --test 临时文件 → 用户主目录。 */
function resolveDevicesPath(deps) {
  const explicit = plainTxt(deps && deps.devicesPath)
    || plainTxt(process.env && process.env.DSH_CONSOLE_DEVICES_FILE)
  if (explicit !== '') return explicit
  if (process.env && process.env.NODE_TEST_CONTEXT) {
    return path.join(os.tmpdir(),
      'dsh-console-devices-test-' + process.pid + '-' + (devicesTestSeq++) + '.json')
  }
  return path.join(os.homedir(), '.dsh', 'dsh-console-devices.json')
}

function devicesEmpty() {
  return { version: DEVICES_VERSION, updatedMs: 0, records: [] }
}

/** 盘上一条记录 → 干净的记录（字段逐个洗，绝不直接信文件内容）。 */
function deviceRecFromJson(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const deviceId = plainTxt(r.deviceId)
  const secrets = strList(r.secrets)
  if (deviceId === '' || secrets.length === 0) return null
  return {
    deviceId,
    secrets,
    model: plainTxt(r.model).slice(0, 80),
    name: plainTxt(r.name).slice(0, 80),
    pairedAt: Number(r.pairedAt) || 0,
    lastSeen: Number(r.lastSeen) || 0,
    uid: plainTxt(r.uid).slice(0, 120),
    cloudUid: plainTxt(r.cloudUid).slice(0, 120),
    pubId: plainTxt(r.pubId).slice(0, 120),
    account: plainTxt(r.account).slice(0, 80),
    nickName: plainTxt(r.nickName).slice(0, 80),
    selfAccountUid: plainTxt(r.selfAccountUid).slice(0, 120),
    selfAccountName: plainTxt(r.selfAccountName).slice(0, 80),
  }
}

/** 读设备表：任何毛病都退化成空表（不抛错）。老文件没有 version ⇒ 空表（红线）。 */
function readDevices(file) {
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) { return devicesEmpty() }
  let j = null
  try { j = JSON.parse(raw) } catch (e) { return devicesEmpty() }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return devicesEmpty()
  if (j.version !== DEVICES_VERSION) return devicesEmpty()  /* 严格相等：无 version / 版本号是字符串 / 将来版本一律当空表 */
  const records = []
  if (Array.isArray(j.records)) {
    for (const r of j.records) {
      const rec = deviceRecFromJson(r)
      if (rec) records.push(rec)
    }
  }
  return { version: DEVICES_VERSION, updatedMs: Number(j.updatedMs) || 0, records }
}

/** 原子落盘（.tmp + rename）；失败只返回 false，绝不抛（路由不因 IO 挂掉）。 */
function writeDevices(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
    return true
  } catch (e) { return false }
}

/**
 * 🔴 第193节 · task-5：已配对设备登记表（**落盘**）—— 进程内 Map + 一份盘上记录，
 * DSH 重启后建实例时自动读回（以前只在内存里，重启即空）。
 *
 * 🔴 批次 H · task-6（#A3）：值从「deviceId 字符串」升级为**设备记录**
 *   { deviceId, model, name, pairedAt, lastSeen }。
 *   起因：用户要「面板显示手机型号，显示哪个已连接在线哪些未连接」——
 *   面板是**进程内**拿数据（/state 兜底路径没有 HTTP 请求上下文），
 *   机型只能在这里留档：accept 时从 User-Agent 或客户端自报字段取。
 *   exchange / mint / isPaired / revoke / size 五个旧签名**逐字不降级**，
 *   旧客户端与已有单测零影响。secret 永不出现在 list() 的结果里。
 */
export function createDeviceStore(deps) {
  /* 🔴 第135节 · task-5（#A3 数据面）· 设备身份字段 —— 用来「认出同一台手机」：
     uid      = **手机自报的设备标识**（App 可选字段 deviceUid）⇒ **唯一去重键**；
     cloudUid = 宿主 cloud 绑定的账号 openId（bound.uid）⇒ **只用于显示，绝不参与去重**；
     pubId    = 公网短 ID（= 云下发 shortId）⇒ 面板显示「脱敏公网 id」，不参与判重；
     account  = 账号名（云端 bound.name / 手机自报）⇒ 面板显示这是谁的手机。
     ── 为什么 cloudUid 必须排除在判重之外（这条别改，改之前先看完）──
     bound.uid 是**这台电脑绑定的账号**，不是设备身份：同一个账号下的两台手机（手机+平板、
     旧机+新机）拿到的 cloudUid 一模一样。若拿它当去重键，就会把「两台不同手机」并成一台 ——
     这正好撞上本任务的硬红线（宁可名单里多出一台，也绝不把两台不同手机合成一台）。
     所以判重只认手机**自己报**的设备标识；报不出来就退回 deviceId 语义（各算一台）。
     ⇒ 副作用（已在任务汇报里写明）：App 未升级、不发 deviceUid 时，同一台手机重连仍会
       多出一台（= 老行为，不回归）；要真正生效必须 App 侧新增可选的 deviceUid 字段。 */
  const ID_MAX = 120
  const ACC_MAX = 80
  /* 身份来源由 lan-server 后挂（它拿得到 o.cloud 的绑定快照）；index.js 不用改。 */
  let identityFn = (deps && typeof deps.identity === 'function') ? deps.identity : null
  /* secret -> 设备记录。有了身份字段后**别名**是常态：同一身份的多个 secret 指向同一条记录。 */
  const devices = new Map()   // secret -> { deviceId, model, name, pairedAt, lastSeen, uid, cloudUid, pubId, account, nickName, selfAccountUid, selfAccountName }
  /* 🔴 第193节 · task-5：配对记录**落盘**（文件结构/路径口径见上面 resolveDevicesPath 那段），
     DSH 重启后名单不再凭空清空。deps.devicesPath 与 deps.revokedPath 同风格。 */
  const devicesFile = resolveDevicesPath(deps)
  let devicesDirtyMs = 0

  /* ═══ 🔴 第193节 · task-1（A）· 撤销黑名单在本 store 实例里的读写 ═══
     落盘路径/结构/原子写见文件头 :24-115 那段注释。这里只做「读一次进内存、
     每次改动立刻回写」：黑名单量级是个位数，全量读写比增量拼接可靠得多。 */
  const revokedFile = resolveRevokedPath(deps)
  let revoked = readRevoked(revokedFile)
  const revokedDeviceId = (v) => { const s = plainTxt(v); return s !== '' && revoked.deviceIds.indexOf(s) >= 0 }
  const revokedSecret = (v) => { const s = plainTxt(v); return s !== '' && revoked.secrets.indexOf(s) >= 0 }
  const revokedUid = (v) => { const s = plainTxt(v); return s !== '' && revoked.uids.indexOf(s) >= 0 }
  /** 读一次盘（多实例共享同一个文件时，撤销事实立刻可见）。 */
  function reloadRevoked() { revoked = readRevoked(revokedFile); return revoked }
  function persistRevoked() {
    revoked.updatedMs = Date.now()
    return writeRevoked(revokedFile, revoked)
  }
  /** 这台设备现在挂在登记表上的全部 secret（撤销时要把它们一起拉黑）。 */
  function secretsOfDevice(deviceId) {
    const want = plainTxt(deviceId)
    const out = []
    if (want === '') return out
    for (const [sec, rec] of devices) {
      if (plainTxt(rec && rec.deviceId) === want) out.push(sec)
    }
    return out
  }
  /**
   * 拉黑一台设备：deviceId + uid + 它名下所有 secret 三个索引都记上，并立刻落盘。
   * 已有的同 deviceId 条目做并集（同一台手机可能被撤两次）。
   */
  function markRevoked(deviceId, uid, secrets) {
    const dev = plainTxt(deviceId)
    const u = plainTxt(uid)
    const secs = strList(secrets)
    let ent = null
    for (const e of revoked.entries) {
      if (e.deviceId === dev && dev !== '') { ent = e; break }
    }
    if (!ent && u !== '') {
      for (const e of revoked.entries) {
        if (e.uid === u) { ent = e; break }
      }
    }
    if (!ent) {
      ent = { deviceId: dev, uid: u, secrets: [], revokedMs: Date.now() }
      revoked.entries.push(ent)
    }
    if (dev !== '' && ent.deviceId === '') ent.deviceId = dev
    if (u !== '' && ent.uid === '') ent.uid = u
    if (dev !== '' && revoked.deviceIds.indexOf(dev) < 0) revoked.deviceIds.push(dev)
    if (u !== '' && revoked.uids.indexOf(u) < 0) revoked.uids.push(u)
    for (const s of secs) {
      if (ent.secrets.indexOf(s) < 0) ent.secrets.push(s)
      if (revoked.secrets.indexOf(s) < 0) revoked.secrets.push(s)
    }
    /* 🔴 task-5：拉黑 = 这台手机已经从 Map 删掉了，设备表要立刻反映（否则重启后
       靠盘上旧记录又把它读回来）。force=true：撤销事实绝不能被节流延后。 */
    persistDevices(true)
    return persistRevoked()
  }
  /**
   * 解黑（**只由 exchange 调用**：用户拿 6 位码主动重新配对 = 唯一自救通路）。
   * 清掉 deviceId / uid / 这台设备名下所有 secret 三处索引，并把对应条目整条删掉。
   */
  function clearRevoked(deviceId, uid) {
    const dev = plainTxt(deviceId)
    const u = plainTxt(uid)
    const secs = []
    /* ⚠️ 被清掉的条目带的 deviceId 必须**一起**从 deviceIds 索引里摘掉：
       exchange 时往往只有 uid 可用（记录已从 Map 删掉、拿不到 deviceId），
       漏摘的话 deviceIds 里会留一个指向新记录的旧 id —— isRevoked({deviceId}) 永久为真。 */
    const devs = []
    for (const e of revoked.entries) {
      const hit = (dev !== '' && e.deviceId === dev) || (u !== '' && e.uid === u)
      if (!hit) continue
      if (e.deviceId !== '' && devs.indexOf(e.deviceId) < 0) devs.push(e.deviceId)
      for (const s of e.secrets) if (secs.indexOf(s) < 0) secs.push(s)
    }
    for (const s of secretsOfDevice(dev)) if (secs.indexOf(s) < 0) secs.push(s)
    for (const d of devs) revoked.deviceIds = revoked.deviceIds.filter((x) => x !== d)
    const rm = (arr, v) => arr.filter((x) => x !== v)
    if (dev !== '') { revoked.deviceIds = rm(revoked.deviceIds, dev) }
    for (const d of devs) revoked.deviceIds = rm(revoked.deviceIds, d)
    if (u !== '') { revoked.uids = rm(revoked.uids, u) }
    for (const s of secs) revoked.secrets = rm(revoked.secrets, s)
    revoked.entries = revoked.entries.filter((e) => !((dev !== '' && e.deviceId === dev) || (u !== '' && e.uid === u)))
    /* 🔴 task-5：解黑之后设备表也要立刻反映「这台手机还在名单里」。 */
    persistDevices(true)
    return persistRevoked()
  }

  /* ═══ 🔴 第193节 · task-5 · 设备登记表的落盘读写 ═══
     思路与上面的撤销黑名单同构：**读一次进内存、每次改动回写**。区别只有一处：
     一条设备记录可能挂着多张 secret（别名，见 mergeSameIdentity），所以写盘时按
     **记录对象**去重成一行 { ..., secrets:[...] }，读回再逐张 secret 展开成 Map 键。
     节流：touch 这类高频路径默认 5 秒最多写一次；mint / revoke 这类改变配对事实的
     路径 force=true 立刻写 —— **配对绝不许因为节流丢掉**（正是本任务要修的 bug）。 */
  const DEVICES_WRITE_MIN_MS = 5000
  /** 当前 Map → 盘上结构（一条记录一行，带它名下所有 secret）。 */
  function deviceRecords() {
    const seen = new Set()
    const records = []
    for (const [sec, rec] of devices) {
      if (!rec || seen.has(rec)) continue
      seen.add(rec)
      const secrets = []
      for (const [s2, r2] of devices) {
        if (r2 === rec) secrets.push(s2)
      }
      records.push({
        deviceId: String(rec.deviceId || ''),
        secrets,
        model: String(rec.model || ''),
        name: String(rec.name || ''),
        pairedAt: Number(rec.pairedAt) || 0,
        lastSeen: Number(rec.lastSeen) || 0,
        uid: String(rec.uid || ''),
        cloudUid: String(rec.cloudUid || ''),
        pubId: String(rec.pubId || ''),
        account: String(rec.account || ''),
        nickName: String(rec.nickName || ''),
        selfAccountUid: String(rec.selfAccountUid || ''),
        selfAccountName: String(rec.selfAccountName || ''),
      })
    }
    return records
  }
  /** 回写设备表；force=false 时按 DEVICES_WRITE_MIN_MS 节流（touch 高频路径用）。 */
  function persistDevices(force) {
    const now = Date.now()
    if (!force && now - devicesDirtyMs < DEVICES_WRITE_MIN_MS) return false
    devicesDirtyMs = now
    return writeDevices(devicesFile, {
      version: DEVICES_VERSION, updatedMs: now, records: deviceRecords(),
    })
  }
  /**
   * 🔴 task-5 核心：建实例时把盘上的配对记录**读回 Map**（DSH 重启后名单不再清空）。
   * 三条纪律：
   *   ① 被拉黑的 deviceId 整条跳过；被拉黑的 secret 单张剔除（记录还剩别的 secret ⇒ 保留）；
   *   ② 同一 deviceId 的多行并成一条（时间取大的 lastSeen、更早的 pairedAt，字段只补空位）；
   *   ③ uid 相同的**不同** deviceId 一律各算一台（绝不按 uid 合并 —— 那是 task-1 的红线）。
   * 返回值只用于观测/单测，不对外暴露。
   */
  function restoreDevices() {
    const data = readDevices(devicesFile)
    let restored = 0
    for (const r of data.records) {
      const dev = plainTxt(r.deviceId)
      if (dev === '' || revokedDeviceId(dev)) continue
      const secrets = r.secrets.filter((s) => !revokedSecret(s))
      if (secrets.length === 0) continue
      let rec = null
      for (const [, d] of devices) {
        if (d && d !== null && plainTxt(d.deviceId) === dev) { rec = d; break }
      }
      if (!rec) {
        rec = {
          deviceId: dev, model: r.model, name: r.name,
          pairedAt: Number(r.pairedAt) || 0, lastSeen: Number(r.lastSeen) || 0,
          uid: r.uid, cloudUid: r.cloudUid, pubId: r.pubId,
          account: r.account, nickName: r.nickName,
          selfAccountUid: r.selfAccountUid, selfAccountName: r.selfAccountName,
        }
      } else {
        if (!rec.model && r.model) rec.model = r.model
        if (!rec.name && r.name) rec.name = r.name
        fillIdentity(rec, r)
        if ((Number(r.lastSeen) || 0) > (Number(rec.lastSeen) || 0)) rec.lastSeen = Number(r.lastSeen) || 0
        const p = Number(r.pairedAt) || 0
        if (p > 0 && (!(Number(rec.pairedAt) || 0) || p < (Number(rec.pairedAt) || 0))) rec.pairedAt = p
      }
      for (const s of secrets) devices.set(s, rec)
      restored += 1
    }
    return restored
  }
  /* 🔴 这一行就是「重启不再清空名单」：实例建好就把盘上记录装回来。 */
  restoreDevices()

  function txt(v, max) { const s = String(v == null ? '' : v).trim(); return s === '' ? '' : s.slice(0, max) }
  /** 身份索引键：uid 是唯一判据；没有 uid 就没有键（退回 deviceId 语义）。 */
  function identityKey(uid) { const u = txt(uid, ID_MAX); return u === '' ? '' : 'u:' + u }
  /**
   * 这次能拿到的身份：手机自报优先，空位用宿主云绑定补。取不到就是空串（**绝不编造**）。
   * ⚠️ uid（去重键）**只认第一个参数**（= 手机自报）；base 里的 uid 一律降级成 cloudUid。
   */
  function identityFrom(about, base) {
    const b = about || {}
    const ext = base || null
    const cloudUid = txt(b.cloudUid, ID_MAX) || txt(ext && (ext.cloudUid || ext.uid), ID_MAX)
    return {
      uid: txt(b.uid, ID_MAX),
      cloudUid,
      pubId: txt(b.pubId || b.shortId, ID_MAX) || txt(ext && (ext.pubId || ext.shortId), ID_MAX),
      account: txt(b.account || b.nickName, ACC_MAX) || txt(ext && (ext.account || ext.name), ACC_MAX),
      nickName: txt(b.nickName || b.account || ext && ext.name, ACC_MAX),
      /* 🔴 第193节 · task-1（B）· **手机自报的登录账号**（App 在 /mp-cookie query 上
         带 accountUid=华为 openId、accountName=昵称）。
         ⚠️ 硬约束：这两个字段**只认手机自报**（b = aboutOf 返回的 about），
         绝不允许拿 ext（本机云绑定）兜底 —— App 侧要靠它判「这台手机登录的账号
         是不是我自己」；拿本机账号兜底会让它永远判成「是我」，功能就废了。
         手机没自报 ⇒ 空串（list() 原样下发空串）。 */
      selfAccountUid: txt(b.accountUid, ID_MAX),
      selfAccountName: txt(b.accountName, ACC_MAX)
    }
  }
  /**
   * 宿主云绑定给的账号身份（lan-server 的 identityOf 快照）。
   * ⚠️ 它的 uid 只落到 cloudUid —— 账号是「谁的手机」，不是「哪台手机」。
   */
  function currentIdentity() {
    if (typeof identityFn !== 'function') return null
    try {
      const r = identityFn()
      if (!r || typeof r !== 'object') return null
      const id = identityFrom({}, r)
      return (id.cloudUid === '' && id.pubId === '' && id.account === '') ? null : id
    } catch (e) { return null }
  }
  /** 只填空位：手机第二次自报不会覆盖已存的名字/账号（面板上的字不跳）。 */
  function fillIdentity(rec, id) {
    if (!rec || !id) return rec
    if (!rec.uid && id.uid) rec.uid = id.uid
    if (!rec.cloudUid && id.cloudUid) rec.cloudUid = id.cloudUid
    if (!rec.pubId && id.pubId) rec.pubId = id.pubId
    if (!rec.account && id.account) rec.account = id.account
    if (!rec.nickName && id.nickName) rec.nickName = id.nickName
    /* 🔴 第193节 · task-1（B）：手机自报账号也只填空位（第二次自报不覆盖第一次）。 */
    if (!rec.selfAccountUid && id.selfAccountUid) rec.selfAccountUid = id.selfAccountUid
    if (!rec.selfAccountName && id.selfAccountName) rec.selfAccountName = id.selfAccountName
    return rec
  }
  /** 同身份的另一条记录并进 target：只补空位，lastSeen 取大的、pairedAt 取更早的。 */
  function mergeInto(target, src) {
    if (!target || !src || target === src) return
    if (!target.model && src.model) target.model = src.model
    if (!target.name && src.name) target.name = src.name
    fillIdentity(target, src)
    const ts = Number(target.lastSeen) || 0
    const ss = Number(src.lastSeen) || 0
    if (ss > ts) target.lastSeen = ss
    const tp = Number(target.pairedAt) || 0
    const sp = Number(src.pairedAt) || 0
    if (sp > 0 && (tp === 0 || sp < tp)) target.pairedAt = sp
  }
  /**
   * 🔴 task-5 · 同一台手机只留一条记录：同身份的其它记录全部并进 target，
   * 并把它们那张旧 secret **重新指向 target** —— 旧 Cookie 照常可用（配对凭据不失效）。
   */
  function mergeSameIdentity(target) {
    const key = identityKey(target && target.uid)
    if (key === '') return
    const losers = []
    for (const [sec, rec] of devices) {
      if (rec !== target && identityKey(rec.uid) === key) losers.push([sec, rec])
    }
    for (const [sec, rec] of losers) {
      mergeInto(target, rec)
      devices.set(sec, target)
    }
  }
  /** 把所有指向 from 的 secret 改指 to（canonical 化；别名先收拢再从 list() 输出）。 */
  function aliasTo(from, to) {
    if (!from || !to || from === to) return
    for (const [sec, rec] of devices) {
      if (rec === from) devices.set(sec, to)
    }
  }
  /** 这条身份已经登记的 canonical 记录（lastSeen 最大的那条；没有就 null）。 */
  function findByIdentity(uid) {
    const key = identityKey(uid)
    if (key === '') return null
    let best = null
    for (const rec of devices.values()) {
      if (identityKey(rec.uid) !== key) continue
      if (!best || (Number(rec.lastSeen) || 0) > (Number(best.lastSeen) || 0)) best = rec
    }
    return best
  }

  /**
   * 铸一张新设备凭证（本身不校验任何码）。
   * @param about 可选 { model, name } —— 配对这一刻客户端自报的机型。
   */
  function mint(about) {
    /* 🔴 第193节 · task-1（A）· 撤销后拒签：这发请求如果就是被移除的那台手机
       （uid 已在黑名单，或它的 canonical 记录 deviceId 已被拉黑），直接返回 null ——
       issueDevice/issueForCode 会把它翻成 ''，lan-server 回 409 而不是再发一张凭据。
       ⚠️ 没有 uid 的老请求识别不出来（退回 deviceId 语义）；那条通路由 lan-server
       侧用旧 mp_device Cookie 命中 isRevoked 拦在 403，两层一起兜。 */
    const guard = identityFrom(about, null)
    if (guard.uid !== '') {
      let hitRec = null
      for (const rec of devices.values()) {
        if (plainTxt(rec && rec.uid) === guard.uid) { hitRec = rec; break }
      }
      if (revokedUid(guard.uid) || (hitRec && revokedDeviceId(hitRec.deviceId))) return null
    }
    const secret = crypto.randomBytes(24).toString('hex')
    const deviceId = 'mp-' + secret.slice(0, 8)
    const now = Date.now()
    const model = String((about && about.model) || '').slice(0, 80)
    const name = String((about && about.name) || '').slice(0, 80)
    const id = identityFrom(about, currentIdentity())
    /* 🔴 task-5：这台手机的身份已经登记过（换 secret / 重新配对 / 重启后自动重连）⇒
       不再多出一台：新 secret 指向**同一条** canonical 记录，沿用它的 deviceId、
       刷新 lastSeen，其余只补空位。旧 secret 留在 Map 里 ⇒ 老 Cookie 照常可用。 */
    if (id.uid !== '') {
      const canon = findByIdentity(id.uid)
      if (canon) {
        fillIdentity(canon, id)
        canon.lastSeen = now
        devices.set(secret, canon)
        mergeSameIdentity(canon)
        /* 🔴 task-5：新 secret 落盘（force=true —— 配对事实必须立刻持久）。 */
        persistDevices(true)
        return { secret, deviceId: canon.deviceId }
      }
    }
    const rec = {
      deviceId, model, name, pairedAt: now, lastSeen: now,
      uid: id.uid, cloudUid: id.cloudUid, pubId: id.pubId, account: id.account, nickName: id.nickName,
      /* 🔴 第193节 · task-1（B）：手机自报的登录账号（手机没自报 ⇒ 两个空串）。 */
      selfAccountUid: id.selfAccountUid, selfAccountName: id.selfAccountName
    }
    devices.set(secret, rec)
    /* uid 为空 ⇒ identityKey 为 '' ⇒ 这里什么也不合并，两台不同手机绝不并成一台。 */
    mergeSameIdentity(rec)
    /* 🔴 task-5：**新配对立刻落盘** —— 这是「重启后名单还在」的关键一步。 */
    persistDevices(true)
    return { secret, deviceId }
  }

  return {
    /**
     * 6 位码换 secret，成功返回 { secret, deviceId }。
     * @param token 面板 6 位码；@param about 可选 { model, name }。
     */
    exchange(token, about) {
      const t = String(token || '').trim()
      // 与面板同一套语义：6 位数字、且必须由调用方校验是「当前有效码」。
      if (!/^\d{6}$/.test(t)) return null
      /* 🔴 第193节 · task-1（A）· **解黑**：拿面板 6 位码重新配对是用户唯一的自救通路
         （「移除设备后必须重新配对」而不是变成永久砖头）。先按 uid / 现有记录的 deviceId
         把黑名单项清掉，再 mint —— 否则刚放行就被 mint 的拒签判定挡回去。
         非 6 位码上面已经 return null，所以这里只可能是「真配对」。 */
      const id = identityFrom(about, null)
      let hitRec = null
      if (id.uid !== '') {
        for (const rec of devices.values()) {
          if (plainTxt(rec && rec.uid) === id.uid) { hitRec = rec; break }
        }
      }
      clearRevoked(hitRec ? hitRec.deviceId : '', id.uid)
      return mint(about)
    },
    /**
     * 🔴 0.4.4 · 免码铸造。
     * 调用方必须**已经验过长期 token**（见 lan-server 的 /mp-cookie：
     * 那道 401 闸在它前面）。存在的理由：6 位面板码 15 分钟就过期，
     * 而「DSH 重启后手机自动重连」是随时发生的 —— 靠码签发的话，
     * 面板没开的那段时间手机必然拿不到 Cookie，打字机永久连不上。
     */
    mint,
    isPaired(secret) {
      return devices.has(String(secret || ''))
    },
    revoke(secret) {
      devices.delete(String(secret || ''))
      /* 🔴 task-5：别让盘上的旧记录在重启后把它复活。 */
      persistDevices(true)
    },
    /**
     * 🔴 第194节 · task-9 · 按手机**自报的 deviceUid** 移除（设备自己请求下线）。
     *
     * 场景（用户 m00690）：用户在 App「节点管理」里移除了一台手机，App 拿自己
     * 保存的 deviceUid 打 /mp/pair/revoke，电脑插件面板的「已连接手机」列表
     * 必须同步少掉那一台 —— 而不是继续显示它。
     *
     * 与 revokeDevice(deviceId) 的关键区别（**别混用**）：
     *   · revokeDevice 是面板管理员「踢掉这台手机」⇒ 同时落盘**拉黑**
     *     （mint 拒签 / /mp-cookie 403 / touch 不复活）。用户 m00652 已明确取消
     *     设备级移除，那条黑名单通路不该被这条路借用。
     *   · 本方法只是**设备自己请求下线**：删表 + 落盘，**绝不 markRevoked**。
     *     手机拿 6 位码重新配对（exchange）即可正常回来。
     *
     * 为什么按 uid 而不是 secret：手机端手上没有电脑派的 mp_device Cookie 明文对应关系，
     * 它只知道自己的 deviceUid（App 侧配对时自报、mint 时写进记录的 rec.uid）。
     * 同一台手机重新配对过 ⇒ Map 里可能有多条同 uid 记录，**一次全删**。
     *
     * @param uid 手机自报的 deviceUid；空串/纯空白一律返回 0（绝不「空 uid 全清」）。
     * @returns 实际删掉的 Map 条数
     */
    revokeUid(uid) {
      const want = String(uid == null ? '' : uid).trim()
      if (want === '') return 0
      let removed = 0
      /* 遍历中删除「当前键」是 Map 的合法操作（ECMAScript 明确规定）。 */
      for (const [sec, rec] of devices) {
        if (String((rec && rec.uid) || '') === want) {
          devices.delete(sec)
          removed += 1
        }
      }
      /* 与 revokeDevice 不同：这里**不**写撤销黑名单 —— 设备是自己下线的。 */
      if (removed > 0) persistDevices(true)
      return removed
    },
    /**
     * 🔴 第191节 · 用户 m00001 · 按 **deviceId** 移除整台设备（面板「踢掉这台手机」）。
     *
     * 为什么不能复用 revoke(secret)：alias 是常态 —— 同一台手机换过 secret /
     * 重新配对 / 同一 uid 多次 mint 后，Map 里会有**多张 secret 指向同一条记录**
     * （mergeSameIdentity :111-122、mint :156-164）。只删当前那张 Cookie 的话，
     * 旧 secret 仍然 isPaired() === true ⇒ 手机照样能进来，「移除」形同虚设。
     *
     * 🔴 红线：只按 deviceId 匹配（deviceId 由 secret 派生、同一次配对必然相同）。
     * 绝不按 uid / cloudUid / 机型 之类的模糊键删 —— 那会把别人的手机一起误删。
     *
     * @param deviceId 形如 'mp-xxxxxxxx'；空值/未命中一律返回 0（不抛错）。
     * @returns 实际删掉的 Map 条数（= 这台手机名下的 secret 张数，可能 > 1）
     */
    revokeDevice(deviceId) {
      const want = String(deviceId == null ? '' : deviceId).trim()
      if (want === '') return 0
      let removed = 0
      const hitSecs = []
      let hitUid = ''
      /* 遍历中删除「当前键」是 Map 的合法操作（ECMAScript 明确规定）。 */
      for (const [sec, rec] of devices) {
        if (String((rec && rec.deviceId) || '') === want) {
          devices.delete(sec)
          hitSecs.push(sec)
          if (hitUid === '' && rec && rec.uid) hitUid = String(rec.uid)
          removed += 1
        }
      }
      /* 🔴 第193节 · task-1（A）· 只删 Map 等于没删：手机持长期 token 打一发 /mp-cookie
         就被免码签发重新塞回来，重启后更是全忘。这里把 deviceId + uid + 它名下所有
         secret 一起**落盘拉黑**（mint 拒签 / lan-server 403 / touch 不复活三处同时生效）。
         只在真删到东西时才写盘：没命中的 deviceId 一律无副作用（既有 ②⑤ 语义不变）。 */
      if (removed > 0) markRevoked(want, hitUid, hitSecs)
      return removed
    },
    /**
     * 🔴 第193节 · task-1（A）· 这一发请求是不是**已被撤销**的设备？
     * lan-server 的 /mp-cookie 在 noteDevice 之后、issueDevice 之前调它：命中就回
     * 403 {"ok":false,"error":"device-revoked"}（与现有 409「签发失败，请重启 DSH 后重试」
     * 严格区分 —— 前者是「被拉黑了」，后者是「面板码过期」）。
     * 每次调用重读一次盘：别的进程/实例刚撤销的设备也立刻算数。
     * @param q { secret, uid, deviceId } 任一命中即 true；全空/无参数一律 false（不抛错）。
     */
    isRevoked(q) {
      const o = q || {}
      reloadRevoked()
      if (revokedSecret(o.secret)) return true
      if (revokedDeviceId(o.deviceId)) return true
      const u = plainTxt(o.uid)
      if (u === '') return false
      if (revokedUid(u)) return true
      let rec = null
      for (const d of devices.values()) {
        if (plainTxt(d && d.uid) === u) { rec = d; break }
      }
      return !!(rec && revokedDeviceId(rec.deviceId))
    },
    /**
     * 🔴 批次 H · task-6（#A3）· 记一次设备活动（顺手补机型）。
     * lan-server 在每条「手机真的打进来了」的路由上调用（/info、/sessions、
     * /mp-cookie、/attachment、配对成功）。补机型时**只填空位**：
     * 客户端第二次自报不会覆盖第一次已存的名字，避免名字自己跳。
     * @param secret mp_device Cookie 里的 secret；@param about 可选 { model, name }
     */
    touch(secret, about) {
      const k = String(secret || '')
      if (k === '') return false
      const d = devices.get(k)
      if (!d) return false
      /* 🔴 第193节 · task-1（A）：已撤销的 secret / 设备**绝不复活**，也不许它把
         lastSeen 刷起来（lan-server 的 noteDevice 每条路由都会 touch 旧 Cookie）。 */
      if (revokedSecret(k) || revokedDeviceId(d.deviceId)) return false
      d.lastSeen = Date.now()
      if (about) {
        if (!d.model && about.model) d.model = String(about.model).slice(0, 80)
        if (!d.name && about.name) d.name = String(about.name).slice(0, 80)
      }
      /* 🔴 task-5：顺手补齐身份，并把同身份的**第二条记录**并进来
         （老记录还没 uid、这次云端/手机把它认出来了 ⇒ 两台变成一台）。
         uid 仍为空时这里不做任何合并（退回 deviceId 语义）。 */
      fillIdentity(d, identityFrom(about, currentIdentity()))
      mergeSameIdentity(d)
      /* 🔴 task-5：lastSeen/机型变了也回写（节流 5s；touch 是每条路由都跑的高频路径）。 */
      persistDevices(false)
      return true
    },
    /**
     * 🔴 批次 H · task-6（#A3）· 全部已配对设备的**可下发快照**。
     * 只回 { deviceId, model, name, pairedAt, lastSeen, online } ——
     * 绝不含 secret（那是能直接冒充设备的凭证，只能待在进程内存里）。
     * 排序：在线优先、其次最近活动靠前（面板顺序稳定，不随 Map 插入序乱跳）。
     */
    list() {
      const now = Date.now()
      const out = []
      const seen = new Set()
      /* 🔴 task-5 · 一台手机只出现一行。mint/touch 已经把同身份并成一条了，
         这里再按 uid **兜一次底**（旧数据 / 别名残留 / 外部直接塞进来的同 uid 记录）：
         同一身份只留 lastSeen 最大的那条；**没有 uid 的记录一律各算一台**。
         seen 去重的是**同一个记录对象**（同一记录可能挂着好几张 secret）。 */
      const byKey = new Map()
      for (const [sec, d] of devices) {
        if (seen.has(d)) continue
        /* 🔴 第193节 · task-1（A）：已撤销的设备/secret 不再出现在名单里。 */
        if (revokedDeviceId(d.deviceId) || revokedSecret(sec)) continue
        seen.add(d)
        const key = identityKey(d.uid)
        if (key === '') { out.push(d); continue }
        const prev = byKey.get(key)
        if (!prev || (Number(d.lastSeen) || 0) > (Number(prev.lastSeen) || 0)) byKey.set(key, d)
      }
      for (const d of byKey.values()) out.push(d)
      /* 🔴 task-5 · 第三层（仅 deviceId 相同）：uid 为空的老数据 + 同一台手机后来报了 uid
         ⇒ 会剩下「同 deviceId 的两条」。deviceId 由 secret 派生、同一次配对必然相同，
         所以这是**同一张配对凭据**的残留；不同手机拿到同一 deviceId 的概率≈2^-32。
         ⚠️ 只在「一条有身份、另一条身份为空」时才并 —— 两条都有 uid 时一律各算一台，
            真并错了就是把两台手机合成一台（本任务的红线）。 */
      const hasUid = (u) => txt(u, ID_MAX) !== ''
      let mergedRec = false
      const byDev = new Map()
      const kept = []
      for (const d of out) {
        const devId = String(d.deviceId || '')
        if (devId === '') { kept.push(d); continue }
        const prev = byDev.get(devId)
        if (!prev) { byDev.set(devId, d); kept.push(d); continue }
        /* 一条有身份、另一条没身份 ⇒ 并（有身份的那条当 canonical）。 */
        if (!hasUid(d.uid) && hasUid(prev.uid)) {
          mergeInto(prev, d); aliasTo(d, prev); mergedRec = true; continue
        }
        if (hasUid(d.uid) && !hasUid(prev.uid)) {
          mergeInto(d, prev); aliasTo(prev, d); mergedRec = true
          const i = kept.indexOf(prev)
          if (i >= 0) kept[i] = d
          byDev.set(devId, d)
          continue
        }
        /* 两条都有身份（或都没有）⇒ 各算一台，绝不合并。 */
        kept.push(d)
      }
      const rows = kept.map((d) => ({
        deviceId: String(d.deviceId || ''),
        model: String(d.model || ''),
        name: String(d.name || ''),
        pairedAt: Number(d.pairedAt) || 0,
        lastSeen: Number(d.lastSeen) || 0,
        online: (now - (Number(d.lastSeen) || 0)) < DEVICE_ONLINE_TTL,
        /* 🔴 task-5 新增（下游 client.js 面板认这三个 key，用于「账号名（脱敏公网 id）」）：
           secret / token / nodeId 永远不在这张白名单里。
           ⚠️ account 拿不到就退回 nickName：win 上 store 没插件时 account 可能是 ''，
              有昵称就显示昵称，别白板。 */
        uid: String(d.uid || ''),
        cloudUid: String(d.cloudUid || ''),
        pubId: String(d.pubId || ''),
        account: String(d.account || d.nickName || ''),
        /* 🔴 第193节 · task-1（B）· 手机自报账号，**对外字段名就叫 accountUid/accountName**
           （App 节点管理页按这两个键读，用来判「这台手机登录的账号是不是我自己」）。
           手机没自报 ⇒ 空串；⚠️ 绝不落本机账号兜底。 */
        accountUid: String(d.selfAccountUid || ''),
        accountName: String(d.selfAccountName || '')
      }))
      rows.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || b.lastSeen - a.lastSeen)
      /* 🔴 task-5：list() 里 rare 的合并（同 deviceId 的两条残并）也要回写 —— 节流即可，
         输出行一个字不动（红线：list() 白名单口径不变）。 */
      if (mergedRec) persistDevices(false)
      return rows
    },
    /**
     * 🔴 task-5 · 宿主侧身份来源后挂（lan-server 在 deviceRoster() 里挂）。
     * 传函数而不是快照：云绑定/公网 id 会变（重新绑定、换账号），必须每次取当下的值。
     * 返回值只表示「有没有装上」，老调用方拿不到它也不影响。
     */
    setIdentity(fn) {
      identityFn = typeof fn === 'function' ? fn : null
      return typeof identityFn === 'function'
    },
    get size() { return devices.size },
  }
}

/**
 * 审批 / 提问追踪器。
 *
 * 宿主的事件是「一次性」的：approval/request 发出来就在等回复，没有队列。
 * 但客户端每 10s 轮询一次 mobile.pending，所以必须自己把当前挂着的记下来，
 * 否则轮询永远返回空 —— 面板会看不到任何待决项。
 *
 * 🔴 第 97 节 · 真正回灌宿主（用户核心缺口）：
 *   approval/request 与 user-questions/request 在宿主里是 **cordis waterfall**，
 *   监听器「返回一个 Promise」才算认领（不返回就只能看、不能答）。所以每条挂起项
 *   还要带一个 resolve 句柄：手机上点了允许 → mobile.respond →
 *   resolveApproval() → 兑现这个句柄 → 宿主那边真正拿到 ApprovalOutcome。
 *   没有句柄时（旧路径）行为与从前一致：只从快照里摘掉。
 *   另外每条挂起项带一个 TTL 兜底：到点（或拆卸/断连）就按「没人答」兑现，
 *   绝不把宿主永久挂住。
 */

/** 挂起项没人答的最长等待（毫秒）。DSH_MP_PENDING_TTL_MS 可覆盖（0 = 不超时，仅调试）。 */
const PENDING_TTL_MS = (() => {
  const raw = process.env && process.env.DSH_MP_PENDING_TTL_MS
  const n = Number(raw)
  return (typeof raw === 'string' && raw !== '' && Number.isFinite(n) && n >= 0)
    ? n
    : 10 * 60 * 1000
})()

/** 宿主 ApprovalService 只认这四个值，其它一律被钳成 unavailable（asar 实锤）。 */
const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/** 手机的答复词 → 宿主词表。未知一律 unavailable（fail-closed，与宿主一致）。 */
export function approvalOutcomeOf(body) {
  const raw = String((body && body.outcome) || '').trim().toLowerCase()
  if (raw === 'allow' || raw === 'allowed' || raw === 'allowed-once') return 'allowed-once'
  if (raw === 'deny' || raw === 'denied' || raw === 'reject' || raw === 'rejected') return 'rejected'
  if (raw.indexOf('cancel') === 0) return 'cancelled'
  return 'unavailable'
}

/** 宿主链上下一环给出的结果 → 词表；非法值按 unavailable（与宿主同一套钳法）。 */
function normalizeApprovalOutcome(value) {
  return APPROVAL_OUTCOMES.indexOf(value) >= 0 ? value : 'unavailable'
}

export function createPendingTracker() {
  // 两条 Map 的值都是槽位 { frame, resolve, timer }：frame 给快照，resolve 给宿主 waterfall
  const approvals = new Map()   // approvalId -> slot
  const questions = new Map()   // rpcId -> slot
  let seq = 0

  const slotsOf = (kind) => (kind === 'question' ? questions : approvals)
  /** 「没人答」时的兑现值：审批 = unavailable，提问 = 空答案（形状必须合法）。 */
  const fallbackOf = (kind) => (kind === 'question' ? { answers: [] } : 'unavailable')

  /** 兑现并摘掉一条挂起项；resolve 句柄与定时器一并清掉（防泄漏）。 */
  function settle(kind, id, value) {
    const slots = slotsOf(kind)
    const slot = slots.get(id)
    if (slot === undefined) return false
    slots.delete(id)
    if (slot.timer) {
      try { clearTimeout(slot.timer) } catch (e) { /* 忽略 */ }
      slot.timer = null
    }
    if (typeof slot.resolve === 'function') {
      const fn = slot.resolve
      slot.resolve = null
      try { fn(value) } catch (e) { /* 宿主已经不等了 */ }
    }
    return true
  }

  /** 建档：稳定 id + 空槽位 + TTL 兜底。 */
  function register(kind, id, frame) {
    /* ⚠️ 第 98 节 · E 段防御：id 撞车时（同一 callId 被宿主重复发一次请求，
       或合成序号被复用）旧槽位若已挂上 resolve，直接覆盖会把那个句柄永久
       丢掉 —— 宿主的 waterfall 就永远等下去。覆盖前先把旧槽位按 fallback
       兑现（旧 resolve 为 null 时 settle 只是清理，无副作用）。 */
    if (slotsOf(kind).has(id)) settle(kind, id, fallbackOf(kind))
    slotsOf(kind).set(id, { frame, resolve: null, timer: null })
    const slot = slotsOf(kind).get(id)
    if (PENDING_TTL_MS > 0) {
      slot.timer = setTimeout(() => { settle(kind, id, fallbackOf(kind)) }, PENDING_TTL_MS)
      // 定时器不拴住进程（测试/拆卸场景），清了也不影响语义
      if (slot.timer && typeof slot.timer.unref === 'function') slot.timer.unref()
    }
    return id
  }

  return {
    /** 宿主来了一道审批；返回稳定 approvalId（'' = 入不了库）。 */
    addApproval(req) {
      const f = approvalFrame(req)
      /* ⚠️ 宿主 ApprovalRequestEvent **没有 approvalId / id 字段**（asar 实锤：
         只有 agent/toolName/callId?/reason?/displayReason?/signal?），所以
         approvalFrame 现在取到的必是空串 —— 旧代码在这里直接 return，审批
         从来没入过库。优先用 callId（手机回的自然就是它），没有再合成一个
         稳定 id，并写回 frame，让手机端的回复能对上。 */
      /* 优先级：显式 approvalId / id（老宿主与既有契约测试在用）→ callId
         （真宿主唯一稳定的字段，手机回的就是它）→ 合成 id。 */
      const declared = String((req && (req.approvalId || req.id)) || '')
      const callId = String((req && req.callId) || '')
      const id = declared !== ''
        ? declared
        : (callId !== ''
          ? callId
          : 'ap-' + String((req && req.toolName) || 'tool') + '-' + (++seq))
      f.approvalId = id
      return register('approval', id, f)
    },
    /** 宿主来了一道提问；返回稳定 rpcId。 */
    addQuestion(req) {
      const f = questionFrame(req)
      /* 稳定 id：定时提问带 wait.callId（asar: askTimed 会塞 wait），否则 rpcId，
         都没有就合成 —— 旧代码没 rpcId 时同样直接 return，提问也进不了库。 */
      const wait = req && req.wait
      /* 优先级：显式 rpcId（老宿主 / 既有测试）→ wait.callId（askTimed 真宿主）→ 合成。 */
      const raw = String((req && req.rpcId) || (wait && wait.callId) || '')
      const id = raw !== '' ? raw : 'q-' + (++seq)
      f.rpcId = id
      return register('question', id, f)
    },
    /**
     * 把「等答复」的 resolve 句柄挂到某条挂起项上 —— 宿主 waterfall 的认领句柄。
     * 找不到条目返回 false（调用方应立刻把请求交回宿主，别挂住）。
     */
    attachResolve(id, resolve, kind) {
      const key = String(id || '')
      if (key === '' || typeof resolve !== 'function') return false
      let slot = null
      if (kind === 'question') slot = questions.get(key)
      else if (kind === 'approval') slot = approvals.get(key)
      else slot = approvals.get(key) || questions.get(key)
      if (!slot) return false
      slot.resolve = resolve
      return true
    },
    /** mp-contract 的形状：{ approvals, questions }（Map 里存的是槽位，这里只给 frame）。 */
    list() {
      return {
        approvals: [...approvals.values()].map((s) => s.frame),
        questions: [...questions.values()].map((s) => s.frame),
      }
    },
    /** 客户端轮询的入口。 */
    snapshot() {
      return pendingSnapshot({
        list: () => [...approvals.values()].map((s) => s.frame),
        questions: () => [...questions.values()].map((s) => s.frame),
      })
    },
    /**
     * 收到答复 —— 除了摘掉挂起项，还要**兑现宿主的 resolve 句柄**。
     *
     * 宿主把答复交回给「等着的那个请求」，也就是需要一个 resolve 句柄；
     * 事件回调里拿不到，所以认领时（attachResolve）存进来，这里兑现。
     * 找不到条目就如实回 false，不假装成功 —— 假装成功的话客户端会以为
     * 审批过了，实际那边还挂着，界面与真实状态脱节。
     * 返回值形状 { ok:true, resolved:bool, ... } 保持不变（客户端与面板在用）。
     */
    resolveApproval(body) {
      const id = String((body && body.approvalId) || '')
      const outcome = approvalOutcomeOf(body)
      const existed = settle('approval', id, outcome)
      return { ok: true, resolved: existed, approvalId: id, outcome }
    },
    resolveQuestion(body) {
      const id = String((body && (body.rpcId || body.id)) || '')
      const answers = Array.isArray(body && body.answers) ? body.answers : []
      const existed = settle('question', id, { answers })
      return { ok: true, resolved: existed, rpcId: id }
    },
    /** 这条审批是不是等我们回复（是的话才能拿到句柄）。 */
    takeApproval(approvalId) {
      const slot = approvals.get(String(approvalId || ''))
      return slot ? slot.frame : null
    },
    takeQuestion(rpcId) {
      const slot = questions.get(String(rpcId || ''))
      return slot ? slot.frame : null
    },
    get counts() {
      return { approvals: approvals.size, questions: questions.size }
    },
    /**
     * 拆卸 / 断连：把所有挂起项按「没人答」兑现掉。
     * 不做的话手机断线后宿主会一直等我们的 Promise（审批卡死、发言卡死）。
     */
    dispose() {
      for (const id of [...approvals.keys()]) settle('approval', id, fallbackOf('approval'))
      for (const id of [...questions.keys()]) settle('question', id, fallbackOf('question'))
    },
  }
}

/**
 * 订阅宿主事件。
 *
 * 两个事件名是从 dsh-mobile-plus 的 lib/live-stream.js 抄的（不是猜的）：
 *   ctx.on('approval/request', ...)      → 工具要权限
 *   ctx.on('user-questions/request', ...) → 问用户
 * 外加 session/event 供实时流用 —— 那个 index.js 已经订阅了，这里不重复订，
 * 只提供一个把手让 mp 的 WS 转发放大器能挂上去。
 *
 * 🔴 第 97 节 · 这两条订阅**必须认领宿主 waterfall**（用户核心缺口）：
 * 宿主调用形如 ctx.waterfall('approval/request', req, 末端answerer)，cordis 把
 * next 作为最后一个实参传进来，监听器返回的 Promise 会被宿主 await。
 * 旧代码是 (req) => { add…; log… } —— 既没 next 形参也没返回值，等于把整条
 * 链吞掉：电脑端和手机端都答不了，且 approvalFrame 取不到 id 时审批根本没入库。
 * 现在两条都用 claim() 返回 Promise 认领；判不准就 return next() 交回宿主。
 */
export function subscribeHostEvents(ctx, tracker, log) {
  const disposers = []
  const on = (evt, fn, options) => {
    if (typeof ctx.on !== 'function') return
    try {
      const d = options === undefined ? ctx.on(evt, fn) : ctx.on(evt, fn, options)
      if (typeof d === 'function') disposers.push(d)
    } catch (e) {
      log('[mp] 订阅 ' + evt + ' 失败: ' + ((e && e.message) || e))
    }
  }

  /**
   * 认领一条 waterfall：手机答得上就答，答不上/不确定就原样交回宿主。
   *
   * ⚠️ 绝不能把电脑端的审批链弄挂：拿不到稳定 id、attachResolve 失败、
   *    或者宿主根本不按 waterfall 调（next 不是函数），一律走 forward()。
   *    只有 attachResolve 成功之后我们才接管这一环，而接管期间有 TTL 定时器
   *    与 abort 兜底，保证不永久挂住宿主（超时按 unavailable / 空答案兑现）。
   */
  function claim(event, kind) {
    const label = kind === 'approval' ? '审批' : '提问'
    /* ⚠️ next 必须是形参！这个函数由 claim() 返回，词法作用域里**没有** next
       （它是 claimed 的形参）—— 写成闭包变量就会 ReferenceError，被下面的
       try/catch 吞掉后 return undefined，而 waterfall 语义下「返回 undefined 且
       没调 next」= 整条链被吞掉（电脑端审批也会一起废掉）。 */
    const forwarding = (next) => {
      try {
        return typeof next === 'function' ? next() : undefined
      } catch (e) {
        log('[mp] ' + event + ' 委托下一环失败: ' + ((e && e.message) || e))
        return undefined
      }
    }
    return function claimed(req, next) {
      let id = ''
      try {
        id = kind === 'approval' ? tracker.addApproval(req) : tracker.addQuestion(req)
        log('[mp] 收到' + label + '请求 ' + id)
      } catch (e) {
        log('[mp] ' + event + ' 记录失败: ' + ((e && e.message) || e))
        return forwarding(next)
      }
      if (!id) return forwarding(next)
      /* 旧宿主 / 非 waterfall 调用（没有 next）：保持从前的「只推帧、不认领」行为，
         不返回 Promise —— 我们的 Promise 没人 await 的话等于白挂一条。 */
      if (typeof next !== 'function') return undefined
      return new Promise((resolve) => {
        /* 🔴 第 99 节 · 与宿主链**竞速**，两条都不能弄挂。
         *
         * 我们按 { prepend:true } 注册，所以排在最前 —— 若认领后不调 next()，
         * 宿主内置 answerer（apiproxy 的审批 / web 的提问）就再也跑不到，
         * 电脑端将无法审批（严重回归）。所以这里**必须 next()** 把链放行，
         * 拿到宿主 Promise，再让「手机答复」与「宿主答复」先到先得。
         *
         * 语义（父代定稿）：宿主给出可用结果（非 'unavailable'）就采用宿主结果；
         * 宿主说 'unavailable'（没人认领 / 没装 answerer）则继续等手机。
         * 两条都答不了时由 tracker 的 TTL / abort 兜底兑现，绝不永久挂住宿主。 */
        let settled = false
        const finish = (value) => {
          if (settled) return
          settled = true
          resolve(value)
        }
        let attached = false
        try {
          attached = tracker.attachResolve(id, finish, kind)
        } catch (e) {
          log('[mp] ' + event + ' 挂句柄失败: ' + ((e && e.message) || e))
        }
        /* 挂不上句柄 = 这一环我们答不了：立刻把链交回宿主（resolve 成 next() 的
           结果），绝不能 resolve(undefined) —— 那等于占着坑又不答，链照样被吞。 */
        if (!attached) { finish(forwarding(next)); return }
        /* 先把宿主链放行（apiproxy / web answerer 此刻才注册挂起项并广播给电脑端，
           电脑端的审批卡片照常出现），再和它的 Promise 竞速。 */
        let hostPromise = null
        try { hostPromise = next() } catch (e) {
          log('[mp] ' + event + ' 放行宿主链失败: ' + ((e && e.message) || e))
        }
        if (hostPromise && typeof hostPromise.then === 'function') {
          hostPromise.then((value) => {
            if (kind === 'approval') {
              const outcome = normalizeApprovalOutcome(value)
              /* 宿主没人答（'unavailable'）不算答复 —— 继续等手机。 */
              if (outcome === 'unavailable') return
              finish(outcome)
              /* 宿主已经答了：把手机快照里的这条一并摘掉（settle 第二次是空操作）。 */
              try { tracker.resolveApproval({ approvalId: id, outcome }) } catch (e) { /* 忽略 */ }
            } else if (value !== undefined && value !== null) {
              finish(value)
              try { tracker.resolveQuestion({ rpcId: id }) } catch (e) { /* 忽略 */ }
            }
          }, () => { /* 宿主链拒绝（提问 NO_PROVIDER）：继续等手机，TTL 兜底 */ })
        }
        /* 认领成功：宿主取消 / 连接断开时立刻放手，
           再叠加 tracker 的 TTL 兜底，双保险不永久挂住宿主。 */
        const signal = req && req.signal
        if (signal && typeof signal.addEventListener === 'function') {
          try {
            signal.addEventListener('abort', () => {
              /* 只兑现自己这一类的槽位（按 kind 分流）：审批 → 'cancelled'（宿主
                 自己 abort 也返回这个词），提问 → 空答案。另一类的 id 空间不同，
                 混着调只是白跑一趟。 */
              try {
                if (kind === 'approval') tracker.resolveApproval({ approvalId: id, outcome: 'cancelled' })
                else tracker.resolveQuestion({ rpcId: id })
              } catch (e) { /* 忽略 */ }
            }, { once: true })
          } catch (e) { /* 信号不支持监听就当没有兜底，TTL 还在 */ }
        }
      })
    }
  }

  /* ⚠️ 必须 prepend：dsh-console 在 profile 里排在 @deepseek-ai/dsh-web-app **之后**
     （profile 的 package.json 里的 bundles），
     apiproxy 的审批 answerer 先注册且认领后不 next —— 普通 push 注册我们永远
     跑不到（实测探针 lib/__probe_order.mjs：push 时 order=["apiproxy"]）。prepend
     后我们最先跑，靠 next() 放行 + 竞速保证电脑端照常可用。 */
  on('approval/request', claim('approval/request', 'approval'), { prepend: true })
  on('user-questions/request', claim('user-questions/request', 'question'), { prepend: true })

  return {
    /** mp 的 WS 放大器要转发的三种宿主事件。 */
    sources: [
      { event: 'session/event', global: true },
      { event: 'approval/request', global: false },
      { event: 'user-questions/request', global: false },
    ],
    dispose() {
      for (const d of disposers) {
        try { d() } catch (e) { /* 忽略 */ }
      }
    },
  }
}

/**
 * 一次性装好 mp 支持。返回给 lan-server 用的 options，以及一个拆卸函数。
 *
 * @param ctx    DSH 上下文
 * @param deps   { log, config, isPairCode }
 *        isPairCode(code) 校验 6 位码是不是当前有效的那个 —— 复用面板那套
 *        有效码判断，不能另算一份，否则两个入口的码会打架。
 */
export function attachMp(ctx, deps) {
  const log = deps.log || (() => {})
  const isPairCode = deps.isPairCode || (() => true)
  /* 🔴 第193节 · task-1：把 deps 透给 store —— 撤销黑名单的落盘路径靠它
     （deps.revokedPath；生产不带该键 ⇒ 走 ~/.dsh/dsh-console-revoked.json）。 */
  const store = createDeviceStore(deps)
  const tracker = createPendingTracker()
  const subs = subscribeHostEvents(ctx, tracker, log)

  const dispatch = createDispatcher(ctx, log, tracker, { pins: new Set() })

  const branch = createMpBranch({
    dispatch,
    log,
    store: {
      exchange: (token, about) => (isPairCode(token) ? store.exchange(token, about) : null),
      isPaired: (s) => store.isPaired(s),
      revoke: (s) => store.revoke(s),
      /* 🔴 第194节 · task-9：手机自己请求下线（POST /mp/pair/revoke {deviceUid}）。
         旧 store 没有这个方法时 mp-routes 会回落到 revoke(Cookie) 的老行为。 */
      revokeUid: (u) => (typeof store.revokeUid === 'function' ? store.revokeUid(u) : 0),
      /* #A3：机型登记（accept 写、gate 续期）。旧 store 没有这两个方法也能跑。 */
      touch: (s, about) => (typeof store.touch === 'function' ? store.touch(s, about) : false),
    },
  })

  log('[mp] mp 契约已就绪：' + (deps.config && deps.config.enabled === false ? '（未启用）' : '24 个 RPC + WS'))

  return {
    branch,
    tracker,
    store,
    subscriptions: subs,
    /**
     * 🔴 0.4.3 · 实时流 WS upgrade handler（真打字机服务端半边）。
     * lan-server 在 createServer 时挂 server.on('upgrade', o.mp.onUpgrade)，
     * 之前 onUpgrade 传 null —— WS 根本建立不起来（打字机不动的服务端根因）。
     * 帧引擎 + 帧源见 mp-ws-live.mjs。
     */
    onUpgrade: createLiveUpgrade({
      ctx,
      log,
      store: { isPaired: (s) => store.isPaired(s) },
      tracker,
      /* 🔴 第191节：把 WS 的连接/心跳/断开透给 lan-server（deps.onStream 由 index.js 注入，
         没注入时 createLiveUpgrade 内部退化成老行为 —— 与老版完全一致）。 */
      onStream: deps.onStream,
    }),
    /**
     * 🔴 0.4.3 · 给已配对设备（持长期 token）免输码签发 mp_device Cookie。
     * lan-server 的 /dsh-console/mp-cookie 端点在 token 校验通过后，
     * 把当前面板 6 位码传进来，这里代走一遍 exchange 拿 secret。
     * 返回 `mp_device=<secret>` 整段（直接当 Cookie 头用）或 ''（码过期等）。
     * 安全面不变：6 位码本身 15 分钟过期，且必须先过 token 这关。
     */
    issueForCode(code, about) {
      /* 🔴 第170节 · Bug B：about 是可选的设备身份（model/name/uid），由 lan-server 的
         /mp-cookie 从 query 解析后传进来；老调用点（不传）行为一个字不变 ——
         uid 为空时 mint() 仍走 deviceId 语义（各算一台），与老版一致。 */
      const r = store.exchange(String(code || '').trim(), about)
      if (!r || !r.secret) return ''
      return `mp_device=${encodeURIComponent(r.secret)}`
    },
    /**
     * 🔴 0.4.4 · 免码签发（token 闸已过，不看 15 分钟面板码）。
     * 手机端在 WS 握手被拒时自愈重连用 —— 见 Session.ets healCookie()。
     */
    issueDevice(about) {
      /* 🔴 第170节 · Bug B（主修点）：**把 about 透传给 mint()**。
         以前这里是无参调用 ⇒ 手机自报的 deviceUid 到不了 mint() ⇒
         createDeviceStore.list() 里「空 uid 各算一台」（mp-support.mjs:243-245）
         ⇒ 同一台手机每次免码重连都新开一行（用户实测 1 台真机攒出 15 行）。
         about 为空时 mint() 与老版逐字同义，老行为不回归。 */
      const r = store.mint(about)
      if (!r || !r.secret) return ''
      return `mp_device=${encodeURIComponent(r.secret)}`
    },
    /** lan-server.start() 之后调它，把 upgrade 也挂上。 */
    attachServer(server, onUpgrade) {
      if (typeof onUpgrade !== 'function') return () => {}
      return mountMpUpgrade(server, {
        store: { isPaired: (s) => store.isPaired(s) },
        log,
        onUpgrade,
      })
    },
    dispose() {
      /* 先让挂起项按「没人答」兑现（否则宿主会一直等我们的 Promise），再退订。 */
      try { tracker.dispose() } catch (e) { /* 忽略 */ }
      subs.dispose()
    },
  }
}
