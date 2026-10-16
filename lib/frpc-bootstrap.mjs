/**
 * DSH控制台面板 —— frpc 自动引导（第215节 · 修法3 治本）。
 *
 * 为什么要有这个文件（用户 m02005 已批准）：
 *   公网访问靠 frpc 可执行文件。以前的实现把它写死在
 *   `C:\\Program Files\\dsh-frp\\frpc.exe`（tunnel.mjs DEFAULT_FRPC），这是开发机上常见的路径，
 *   别人的机器上根本没有 ⇒ 隧道静默失败、面板上还看不到原因。
 *   用户实测结论：「别人装了 npm 最新插件、也开通了会员，关掉 WiFi 依旧连不上公网。大概率是没有这个。」
 *   治本 = 服务器托管 frpc 二进制（/frpc/manifest.json + 5 个平台文件），插件首次需要时自动下载并校验 sha256。
 *   显形 = 下载失败时把原因写进 tunnelStatus().lastError（面板会小字显示），不再静默。
 *
 * 设计契约（改这个文件前先读）：
 *   ① **非破坏**：只有目标路径不存在时才联网。用户手动放好的 frpc（含本机老路径）永远优先，一个字节都不动。
 *   ② **必校验**：先对 size、再对 sha256；任何一项不符一律**不落盘**，返回 ok:false + 中文原因。
 *   ③ **原子落盘**：先写 `<目标>.download` 再 rename，绝不出现「半截二进制被当成可用 frpc」。
 *   ④ **不抛**：fetch/网络/文件异常全部 catch 成 { ok:false, reason, error }，调用方只看 ok。
 *   ⑤ **不做进程管理**：只负责「让路径上有一个可信的 frpc」，拉起/重试仍在 tunnel.mjs。
 *   ⑥ 测试可注入：o.fetch / o.dir / o.platform / o.arch / o.manifestUrl 都可由单测覆盖，别写死。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** frpc 落地目录（与老约定一致：~/.dsh/frp）。 */
export const FRPC_DIR = path.join(os.homedir(), '.dsh', 'frp')
/** 云端托管的下载清单（Caddy 静态路由，见修法3 服务端一半）。 */
export const FRPC_MANIFEST_URL = 'https://gaoshou25.cn/frpc/manifest.json'
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20000

/**
 * 平台 key → 服务器上的文件名。curl 的平台 key 用 `平台-架构`（与 manifest.files 的键一致）。
 * ⚠️ 这张表和服务端 /opt/dsh-console-cloud/frpc/ 里的文件名必须逐字一致，改一边就得改另一边。
 */
const FILE_BY_KEY = {
  'win32-x64': 'frpc_0.62.1_windows_amd64.exe',
  'linux-x64': 'frpc_0.62.1_linux_amd64',
  'linux-arm64': 'frpc_0.62.1_linux_arm64',
  'darwin-x64': 'frpc_0.62.1_darwin_amd64',
  'darwin-arm64': 'frpc_0.62.1_darwin_arm64'
}

/** 当前平台能不能自动下载 frpc？能就回 'linux-x64' 这样的 key，不能回 ''（调用方据此显形）。 */
export function platformKey(platform = process.platform, arch = process.arch) {
  const key = String(platform || '') + '-' + String(arch || '')
  return Object.prototype.hasOwnProperty.call(FILE_BY_KEY, key) ? key : ''
}

/** 本机应该把 frpc 放在哪儿。不支持自动下载的平台回 ''。 */
export function frpcTargetPath(platform = process.platform, arch = process.arch, dir = FRPC_DIR) {
  const key = platformKey(platform, arch)
  if (!key) return ''
  return path.join(dir, FILE_BY_KEY[key])
}

/**
 * 老版本插件 / 用户手工装在机器上的 frpc 惯用路径（**只读**，存在就直接用）。
 *
 * 为什么要这个：老实现的默认路径就是 `C:\Program Files\dsh-frp\frpc.exe`（开发机也这么装），
 * 老用户机器上本来就有。第215节把默认路径改成托管目录后，老用户反而会去走「下载」——
 * 一旦下载被安全软件拦下（frpc 常被杀软判成 HackTool），就出现「以前能用、升级后反而连不上」的退化。
 * 策略：目标路径 → 老路径 → 才下载。老路径上的文件一个字节都不动。
 */
export function legacyFrpcPaths(platform = process.platform) {
  if (platform === 'win32') return ['C:\\Program Files\\dsh-frp\\frpc.exe']
  if (platform === 'darwin') return ['/usr/local/bin/frpc', '/opt/homebrew/bin/frpc']
  return ['/usr/local/bin/frpc', '/usr/bin/frpc']
}

function errText(e) { return String((e && e.message) || e || '') }

/** 同步算文件 sha256（16MB 量级，同步读可接受；只在引导阶段调一次）。 */
export function sha256OfFile(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

/**
 * 校验一个已存在的 frpc 是否可用。回 sha256 字符串（可用）或 ''（不可用/不存在）。
 * expect = { size, sha256 }（来自 manifest）；不传时「只要是个文件」就算可用 ——
 * 那是用户自己放的 frpc，我们没有它的清单，不能因为对不上就否决它。
 */
export function verifyFrpc(p, expect) {
  try {
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) return ''
    const size = fs.statSync(p).size
    if (Number(expect && expect.size) > 0 && size !== Number(expect.size)) return ''
    const sha = sha256OfFile(p)
    const want = String((expect && expect.sha256) || '').trim().toLowerCase()
    if (want && sha.toLowerCase() !== want) return ''
    return sha
  } catch (_) { return '' }
}

/**
 * 从云端清单下载本机平台的 frpc。
 * 返回 { ok:true, path, version, size, sha256, downloaded:true } 或 { ok:false, reason, error }。
 * reason 取值固定（面板/日志靠它归类，别随手加）：unsupported / no-fetch / manifest-http /
 *   manifest-bad-json / no-entry / download-http / size-mismatch / sha-mismatch / io / fetch / blocked。
 */
export async function downloadFrpc(o = {}) {
  const dir = o.dir || FRPC_DIR
  const platform = o.platform || process.platform
  const arch = o.arch || process.arch
  const manifestUrl = String(o.manifestUrl || FRPC_MANIFEST_URL)
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_DOWNLOAD_TIMEOUT_MS
  const log = typeof o.log === 'function' ? o.log : () => {}
  const fetchFn = o.fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)

  const key = platformKey(platform, arch)
  if (!key) return { ok: false, reason: 'unsupported', error: '暂不支持自动下载 frpc 的平台：' + String(platform) + '-' + String(arch) }
  if (!fetchFn) return { ok: false, reason: 'no-fetch', error: '当前运行环境没有 fetch，无法自动下载 frpc' }

  const target = path.join(dir, String(o.fileName || FILE_BY_KEY[key]))
  let entry = null
  let version = ''
  try {
    const mres = await fetchFn(manifestUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
    if (!mres || mres.ok !== true) return { ok: false, reason: 'manifest-http', error: '公网工具下载清单取不到（HTTP ' + String(mres && mres.status) + '）' }
    let mj = null
    try { mj = await mres.json() } catch (e) { return { ok: false, reason: 'manifest-bad-json', error: '公网工具下载清单不是合法 JSON' } }
    entry = mj && mj.files ? mj.files[key] : null
    version = String((mj && mj.version) || '')
    if (!entry || !entry.file) return { ok: false, reason: 'no-entry', error: '下载清单里没有本机平台（' + key + '）的 frpc' }
  } catch (e) {
    return { ok: false, reason: 'fetch', error: '取公网工具下载清单失败：' + errText(e) }
  }

  const url = new URL(String(entry.file), manifestUrl).toString()
  let buf = null
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res || res.ok !== true) return { ok: false, reason: 'download-http', error: '下载 frpc 失败（HTTP ' + String(res && res.status) + '）' }
    buf = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    return { ok: false, reason: 'fetch', error: '下载 frpc 失败：' + errText(e) }
  }

  const wantSize = Number(entry.size) || 0
  if (wantSize > 0 && buf.length !== wantSize) {
    return { ok: false, reason: 'size-mismatch', error: 'frpc 大小不符（期望 ' + wantSize + ' 字节，实收 ' + buf.length + ' 字节）' }
  }
  const sha = createHash('sha256').update(buf).digest('hex')
  const wantSha = String(entry.sha256 || '').trim().toLowerCase()
  if (wantSha && sha !== wantSha) {
    return { ok: false, reason: 'sha-mismatch', error: 'frpc 校验和不符（期望 ' + wantSha.slice(0, 12) + '…，实得 ' + sha.slice(0, 12) + '…）' }
  }

  const tmp = target + '.download'
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmp, buf, { mode: 0o755 })
    fs.renameSync(tmp, target)
    try { fs.chmodSync(target, 0o755) } catch (_) { /* Windows 忽略 */ }
    /* 🔴 落盘后立刻复查：安全软件（Windows Defender 对 frpc 有 HackTool/*.Frp.* 启发式特征）
       可能在 rename 后瞬间把文件挪走/删掉 —— 那就不能当成功，否则后面 spawn 报一个看不懂的 ENOENT。 */
    if (!fs.existsSync(target)) {
      return { ok: false, reason: 'blocked', error: 'frpc 写入后立刻消失，很可能是安全软件拦截；请把 ' + target + ' 加入白名单后重试' }
    }
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch (_) { /* 忽略 */ }
    return { ok: false, reason: 'io', error: '写入 frpc 失败：' + errText(e) }
  }
  log('[frpc] 已从云端下载 frpc ' + (version || '') + ' → ' + target + '（' + buf.length + ' 字节）')
  return { ok: true, path: target, version, size: buf.length, sha256: sha, downloaded: true }
}

/**
 * 引导入口：确保 o.frpcPath（默认 = 本机平台的托管路径）上有一个可用的 frpc。
 * 已有 ⇒ 直接 ok（downloaded:false，**绝不覆盖、绝不联网**）；没有 ⇒ 下载。
 */
export async function ensureFrpc(o = {}) {
  const platform = o.platform || process.platform
  const arch = o.arch || process.arch
  const target = o.frpcPath || (o.fileName
    ? path.join(o.dir || FRPC_DIR, String(o.fileName))
    : frpcTargetPath(platform, arch, o.dir || FRPC_DIR))
  if (!target) return { ok: false, reason: 'unsupported', error: '暂不支持自动下载 frpc 的平台：' + String(platform) + '-' + String(arch) }
  const pick = (p) => {
    const sha = verifyFrpc(p)
    if (!sha) return null
    return { ok: true, path: p, size: fs.statSync(p).size, sha256: sha, downloaded: false }
  }
  const own = pick(target)
  if (own) return own
  /* 目标路径没有 ⇒ 先认机器上已有的老路径（老用户零联网、零覆盖），最后才下载。
     ⚠️ 这个顺序是**故意**的，别为了「老版本可能太旧」把它反过来：老用户机器上的 frpc 是当初能用才装上的，
     我们没有它的清单、也不该为了一个新副本去下载覆盖用户的东西；真跑不起来时 tunnelStatus().lastError 会显形。
     （独立复验提出过「能联网时优先托管路径」的备选，评估后不采用：收益是版本统一，代价是老用户每次升级都联网下载 15MB。） */
  const legacy = Array.isArray(o.legacyPaths) ? o.legacyPaths : legacyFrpcPaths(platform)
  for (const cand of legacy) {
    if (!cand || cand === target) continue
    const hit = pick(cand)
    if (hit) { hit.legacy = true; return hit }
  }
  const dir = o.dir || path.dirname(target)
  return await downloadFrpc(Object.assign({}, o, { dir }))
}
