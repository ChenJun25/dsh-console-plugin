import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const CUSTOM_CONFIG_PATH = path.join(os.homedir(), '.dsh', 'dsh-console-custom.json')

export const CUSTOM_PROXY_PREFIX = 'dsh-console-custom'

export const CUSTOM_PROXY_NAME = CUSTOM_PROXY_PREFIX

let machineTagCache = ''

export function machineTag() {
  if (machineTagCache !== '') return machineTagCache
  const parts = []
  try { parts.push(String(os.hostname() || '')) } catch (e) { }
  try {
    const ifs = os.networkInterfaces() || {}
    const macs = []
    for (const k of Object.keys(ifs)) {
      const list = ifs[k] || []
      for (const one of list) {
        if (!one || one.internal === true) continue
        const mac = String(one.mac || '').replace(/:/g, '').toLowerCase()
        if (mac !== '' && mac !== '000000000000') macs.push(mac)
      }
    }
    macs.sort()
    if (macs.length) parts.push(macs[0])
  } catch (e) { }
  if (parts.length === 0) parts.push(String(os.platform() || '') + '|' + String(os.arch() || ''))
  let tag = ''
  try { tag = crypto.createHash('sha1').update(parts.join('|'), 'utf8').digest('hex').slice(0, 6) } catch (e) { tag = '' }
  machineTagCache = tag !== '' ? tag : 'local0'
  return machineTagCache
}

export function customProxyName(remotePort) {
  const n = Number(remotePort)
  const base = CUSTOM_PROXY_PREFIX + '-' + machineTag()
  return (Number.isInteger(n) && n > 0 && n < 65536) ? (base + '-' + n) : base
}

export const CUSTOM_DEFAULTS = {
  on: false,
  serverAddr: '',
  serverPort: 7000,
  remotePort: 9000,
  authToken: ''
}

const PROMPT_LINES = [
  '我有一台自己的公网服务器，想用它给「DSH 控制台」做公网出口。你先回我一句确认，我把服务器 IP、端口、登录方式（密码或密钥）发给你，你再动手。',
  '注意：现在你手上还没有这台机器的任何信息，不要猜 IP、不要假设已经登录，等我把信息发齐再开始。',
  '',
  '【拿到机器信息后要做的（先看懂原理，别改方案）】',
  '1. 原理：我的电脑上跑着 DSH 和 dsh-console-plugin，插件在本机 127.0.0.1:8899 提供 HTTP 服务；插件内置 frpc 会主动连到你的服务器上的 frps，把服务器的一个公网端口转发回我电脑的 8899。手机 App 访问 http://服务器公网IP:公网端口 就等于访问我这台电脑。',
  '2. 服务器上只装 frps 就够：不用装 DSH、不用跑网页、不用域名、不用 HTTPS 证书、不用 Nginx/Caddy。',
  '',
  '【在服务器上按顺序做】',
  '1. 装 frp 服务端：下载 frp 最新 Linux 版（按架构选 amd64 / arm64），把 frps 放到 /usr/local/bin/frps 并 chmod +x。',
  '2. 新建 /etc/frp/frps.toml，内容：',
  '   bindPort = 7000',
  '   auth.method = "token"',
  '   auth.token = "你自己生成一个 32 位以上随机字符串"',
  '3. 放行端口：系统防火墙和云厂商安全组都要放行 7000/tcp 和 9000-9010/tcp 这一整段。9000 只是第一台电脑用的，我以后每加一台电脑会往上用一个（9001、9002…），一次开够省得回来改。',
  '4. 用 systemd 常驻：/etc/systemd/system/frps.service，ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml，然后 enable + start。',
  '5. 自检：ss -lntp | grep 7000 能看到 frps 在监听。',
  '',
  '【做完后把这张表原样回给我，我照着填进软件面板】',
  '| 项目 | 值 |',
  '| --- | --- |',
  '| 服务器地址 | <这台服务器的公网 IP 或域名，不要带 http:// 和端口> |',
  '| frps 端口 | 7000 |',
  '| token | <第 2 步生成的 auth.token> |',
  '| 公网端口 | 9000（只有一台电脑就填 9000；第二台起用 9001、9002…） |',
  '',
  '【硬性要求，违反了一定连不上】',
  '- 必须是最朴素的 tcp 端口映射。不要用 frp 的 http 类型，也不要在前面套 Nginx / Caddy / 任何反向代理。',
  '  原因：反向代理会自动加 X-Forwarded-For 请求头，插件会把这种请求当成公网来源直接返回 403，手机永远配对失败。',
  '- 不要给公网端口配 HTTPS 或证书，手机端填的就是 http://IP:端口。',
  '- 服务器上原来跑着别的服务就照旧，只要别占用 7000 和 9000-9010 这一段端口。',
  '',
  '【如果我有不止一台电脑都要用这台服务器】',
  '- 每台电脑在面板里填**不同的公网端口**（第一台 9000、第二台 9001、第三台 9002…），',
  '  代理名会自动按机器区分，所以不会互相顶掉；端口撞了软件自己会往后挪一格并提示我。',
  '- 请把上面要放行的公网端口一次开够，比如 9000-9010 这一段，免得我每加一台电脑都要回来找你改防火墙。',
  '- 这张表里「公网端口」一栏请写成「9000（第二台起用 9001、9002…）」这种形式。'
]

export const CUSTOM_AI_PROMPT = PROMPT_LINES.join('\n')

function textOf(v) {
  return String(v == null ? '' : v).trim()
}

function portOf(v, dflt) {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0 || n >= 65536) return dflt
  return n
}

export function hostOk(raw) {
  const s = textOf(raw)
  if (s === '') return false
  if (s.indexOf('://') >= 0) return false
  if (s.indexOf('/') >= 0) return false
  if (/\s/.test(s)) return false
  if (s.indexOf(':') >= 0 && !/^\[[0-9a-fA-F:.]+\]$/.test(s)) return false
  return true
}

export function normalizeCustom(j) {
  const src = (j && typeof j === 'object' && !Array.isArray(j)) ? j : {}
  const on = src.on === true || src.enabled === true
  const shifted = Number(src.autoShiftedFrom)
  return {
    on,
    serverAddr: textOf(src.serverAddr),
    serverPort: portOf(src.serverPort, CUSTOM_DEFAULTS.serverPort),
    remotePort: portOf(src.remotePort, CUSTOM_DEFAULTS.remotePort),
    authToken: textOf(src.authToken),

    autoShiftedFrom: (Number.isInteger(shifted) && shifted > 0 && shifted < 65536) ? shifted : 0
  }
}

export function publicHttpUrl(cfg) {
  const c = normalizeCustom(cfg)
  if (!hostOk(c.serverAddr)) return ''
  return 'http://' + c.serverAddr + ':' + c.remotePort
}

export function customProblems(cfg) {
  const c = normalizeCustom(cfg)
  if (c.on !== true) return []
  const bad = []
  if (c.serverAddr === '') bad.push('服务器地址')
  else if (!hostOk(c.serverAddr)) bad.push('服务器地址（不要带 http:// 或路径）')
  if (c.authToken === '') bad.push('token')
  return bad
}

export function readCustomConfig(cfgPath = CUSTOM_CONFIG_PATH, log) {
  const say = typeof log === 'function' ? log : () => {}
  try {
    if (!fs.existsSync(cfgPath)) {
      return { ok: true, exists: false, cfg: normalizeCustom(null), error: '' }
    }
    const cfg = normalizeCustom(JSON.parse(fs.readFileSync(cfgPath, 'utf8')))
    return { ok: true, exists: true, cfg, error: '' }
  } catch (e) {
    const msg = String((e && e.message) || e)
    try { fs.renameSync(cfgPath, cfgPath + '.corrupt-' + Date.now()) } catch (_) { }
    say('自定义服务器配置读不了（' + msg + '），按未配置处理')
    return { ok: false, exists: false, cfg: normalizeCustom(null), error: msg }
  }
}

export function writeCustomConfig(cfg, cfgPath = CUSTOM_CONFIG_PATH, log) {
  const say = typeof log === 'function' ? log : () => {}
  const c = normalizeCustom(cfg)
  const data = {
    enabled: c.on,
    on: c.on,
    type: 'tcp',
    proxyName: customProxyName(c.remotePort),
    serverAddr: c.serverAddr,
    serverPort: c.serverPort,
    authToken: c.authToken,
    remotePort: c.remotePort,
    autoShiftedFrom: c.autoShiftedFrom,
    publicUrl: publicHttpUrl(c)
  }
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
  fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2), { mode: 0o600 })
  say('自定义服务器配置已落盘：on=' + c.on + ' host=' + c.serverAddr + ':' + c.serverPort + ' remotePort=' + c.remotePort)
  return Object.assign({}, c, { publicUrl: data.publicUrl })
}

export function syncProxyName(cfgPath = CUSTOM_CONFIG_PATH, log) {
  const say = typeof log === 'function' ? log : () => {}
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch (e) { return false }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const c = normalizeCustom(raw)
  if (c.serverAddr === '') return false
  const want = customProxyName(c.remotePort)
  if (String(raw.proxyName || '') === want) return false
  try {
    writeCustomConfig(c, cfgPath, log)
    say('[custom] 代理名迁移：' + String(raw.proxyName || '(空)') + ' → ' + want)
    return true
  } catch (e) {
    say('[custom] 代理名迁移失败（继续用旧配置）：' + String((e && e.message) || e))
    return false
  }
}

export function nextPublicPort(fromPort, step) {
  const from = Number(fromPort)
  if (!(Number.isInteger(from) && from > 0 && from < 65536)) return 0
  const n = Number.isInteger(Number(step)) && Number(step) > 0 ? Number(step) : 1
  const next = from + n
  if (!(Number.isInteger(next) && next > 0 && next < 65536)) return 0
  return next
}
