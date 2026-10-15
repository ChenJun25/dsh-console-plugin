// 自测：不起 DSH也能验证核心逻辑
// 验：载荷格式、6 位码一次性、二维码真能出图、/claim 通路、客户端半边格式合法
import { startLanServer, pairPayload, qrDataUrl } from '../lib/lan-server.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

let failed = 0
const ok = (c, label, extra) => {
  console.log((c ? '  ✅ ' : '  ❌ ') + label + (extra ? '  → ' + extra : ''))
  if (!c) failed++
}

const TOKEN = 'b'.repeat(64)
const INFO = { name: '客厅电脑', nodeId: 'dsh-console', host: 'DESKTOP-XYZ', dshOk: true, version: '0.1.0' }

/* ================= 1. 载荷 ================= */
console.log('【1】二维码载荷')
const payload = pairPayload({ base: 'http://192.168.1.5:8899/dsh-console', token: TOKEN, name: INFO.name, node: 'dsh-console' })
console.log('  ' + payload + '\n')
ok(payload.startsWith('dsh-console://pair?'), '协议头正确')
ok(!payload.includes('dsh-console.local'), '无假域名')
ok(payload.includes('192.168.1.5'), '含局域网地址')
ok(payload.includes(TOKEN), '含访问码')
ok(payload.includes(encodeURIComponent(INFO.name)), '中文已编码')
console.log('')

/* ================= 2. 6 位码 ================= */
console.log('【2】6 位码逻辑')
// 自测要占一个端口，但插件正常运行时占着 8899。
// 用一个固定的高位端口，两边不会撞。
const TEST_PORT = 18777
const lan = startLanServer({
  port: TEST_PORT,
  allowShift: true,
  getToken: () => TOKEN,
  getInfo: () => INFO,
  listSessions: async () => [],
  runCommand: async () => ({}),
  log: () => {}
})
const started = await lan.start()
ok(!!started, '服务起来了', '端口 ' + lan.port)
if (!lan.port) { console.log('❌ 端口是 0，后面没法测'); process.exit(1) }
ok(lan.port >= TEST_PORT, '端口是真实值（可能被顺延）', String(lan.port))
const code = lan.getPairCode()
ok(/^\d{6}$/.test(code), '6 位码格式对', code)
ok(lan.getPairCode() === code, '重复取同一个码（不刷新）')
console.log('')

const base = 'http://127.0.0.1:' + lan.port + '/dsh-console'

/* ================= 3. 面板数据 ================= */
console.log('【3】面板数据（面板路由 /api/dsh-console/state 返回的就是这个）')
const d = await lan.panelData(true)
ok(d.ok === true, 'panelData 返回 ok')
ok(d.code === code, '带 6 位码')
ok(d.token === TOKEN, '带访问码')
ok(d.base && d.base.indexOf(':' + lan.port) > 0, 'base 用的是真实端口', d.base)
ok(d.payload === payload || d.payload.indexOf('dsh-console://pair') === 0, 'payload 格式对')
ok(typeof d.qrDataUrl === 'string' && d.qrDataUrl.startsWith('data:image/'), '二维码生成了',
   d.qrDataUrl ? (Math.round(d.qrDataUrl.length / 1024) + ' KB') : '无')
ok(d.qrDataUrl && d.qrDataUrl.indexOf(String(lan.port)) < 0, '二维码 data URL 里不含明文端口（是图不是文本）')
// 手机在线状态（2026-10-03 用户要求加的「手机已连接/未连接」灯）
ok(d.phoneOnline === false && d.phoneLastSeen === 0, '还没人连过 → 手机未连接',
   'phoneOnline=' + d.phoneOnline + ' lastSeen=' + d.phoneLastSeen)
console.log('')

/* ================= 4. /claim 通路 ================= */
console.log('【4】6 位码换访问码')
const post = async (c) => {
  const r = await fetch(base + '/claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: c })
  })
  return { status: r.status, body: await r.json() }
}
const bad = await post('000000' === code ? '111111' : '000000')
ok(bad.status === 403, '错码 403')
const short = await post('12')
ok(short.status === 400, '非 6 位 400')
const good = await post(code)
ok(good.status === 200 && good.body.ok, '对码换到访问码')
ok(good.body.token === TOKEN, '访问码正确')
ok(good.body.base && good.body.base.indexOf(':' + lan.port) > 0, '同时给了 base（真实端口）')
const again = await post(code)
ok(again.status === 403, '同一个码不能用第二次（已作废）')
const d2 = await lan.panelData(false)
ok(d2.code !== code, '作废后自动换新码', code + ' → ' + d2.code)
// 配对成功 = 手机在场，状态灯应转亮
ok(d2.phoneOnline === true && d2.phoneLastSeen > 0, '对码成功后 → 手机已连接',
   'phoneOnline=' + d2.phoneOnline + ' lastSeen=' + d2.phoneLastSeen)
console.log('')

/* ================= 5. 配对页 ================= */
console.log('【5】浏览器配对页')
const page = await fetch(base + '/pair')
const html = await page.text()
ok(page.status === 200, '免 token 能打开')
ok(html.includes(d2.code), '页面显示当前 6 位码', d2.code)
ok(html.includes('data:image/png;base64'), '页面嵌了二维码')
ok(html.includes('width:280px'), '二维码 280px（实测稳定尺寸）')
ok(html.includes('background:#fff'), '白底（深色页面上也能扫）')
ok(html.includes('局域网地址'), '面板最下面有局域网地址区')
ok(html.includes(d2.token), '显示访问码（手动填时用）')
console.log('')

/* ================= 6. 安全边界 ================= */
console.log('【6】安全边界')
const noTok = await fetch(base + '/info')
ok(noTok.status === 401, '没访问码读 /info 被拒')
const badTok = await fetch(base + '/info?token=wrong')
ok(badTok.status === 401, '错访问码被拒')
const withTok = await fetch(base + '/info?token=' + TOKEN)
ok(withTok.status === 200, '对访问码放行')
const qrNoTok = await fetch(base + '/qr')
ok(qrNoTok.status === 200, '/qr 免 token（本机可达即可，页面上本来就显示着）')
const sessNoTok = await fetch(base + '/sessions')
ok(sessNoTok.status === 401, '没访问码读会话被拒')
console.log('')

/* ================= 7. 端口锁死（不许静默顺延） ================= */
console.log('【7】端口被占时必须报错，不许偷偷换端口')
// 6 位码那条路把 8899 写死了，
// 插件一旦顺延到 8900，手机就再也找不到电脑。
const COLLIDE_PORT = 18888
const occupied = startLanServer({
  port: COLLIDE_PORT,
  getToken: () => TOKEN, getInfo: () => INFO,
  listSessions: async () => [], runCommand: async () => ({}),
  log: () => {}
})
const occupiedStarted = await occupied.start()
ok(!!occupiedStarted && occupied.port === COLLIDE_PORT, '第一个服务占了 ' + COLLIDE_PORT)
const blocked = startLanServer({
  port: COLLIDE_PORT,
  getToken: () => TOKEN, getInfo: () => INFO,
  listSessions: async () => [], runCommand: async () => ({}),
  log: () => {}
})
const blockedStarted = await blocked.start()
ok(blockedStarted === null && blocked.port === 0,
   '第二个服务占同一端口 → 启动失败并返回 null（没顺延到 ' + (COLLIDE_PORT + 1) + '）')
// 显式 allowShift 才允许换端口 —— 这条路是留给「手机端也改端口」的场合
const shifting = startLanServer({
  port: COLLIDE_PORT,
  allowShift: true,
  getToken: () => TOKEN, getInfo: () => INFO,
  listSessions: async () => [], runCommand: async () => ({}),
  log: () => {}
})
const shiftingStarted = await shifting.start()
ok(!!shiftingStarted && shifting.port === COLLIDE_PORT + 1,
   '显式 allowShift 才顺延（拿到 ' + shifting.port + '）', '预期 ' + (COLLIDE_PORT + 1))
await shifting.stop()
await occupied.stop()
await blocked.stop()
console.log('')

/* ================= 8. 客户端半边格式 ================= */
console.log('【8】客户端半边（DSH 要的格式）')
const clientPath = path.join(root, 'lib', 'client.js')
const src = fs.readFileSync(clientPath, 'utf8')
// 参考插件的 client.js 也是「注释开头 + ModuleLoader.load」，
// 所以只要求 load 那句在，而不是要求文件第一个字符就是它
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
ok(/window\.__ModuleLoader__\.load\(\{/.test(codeOnly), '包含 ModuleLoader.load')
ok(src.trim().endsWith('});'), '闭合正确')
// 整个文件只能 load 一次（数代码，不数注释里提到的）
ok((codeOnly.match(/window\.__ModuleLoader__\.load\(/g) || []).length === 1, '只 load 一次')
ok(src.includes('id: "dsh-console"'), 'id 与包名一致')
ok(src.includes("factory: (require) =>"), 'factory 签名对')
ok(src.includes('require("react")'), '用了宿主的 react')
ok(src.includes('require("react/jsx-runtime")'), '用了宿主的 jsx-runtime（不用打包器）')
ok(src.includes('exports.apply = apply;'), '导出 apply（cordis 插件式，不是 activate）')
ok(src.includes('exports.inject = inject;'), '导出 inject')
ok(src.trim().endsWith('});'), 'return module.exports 收尾')
ok(src.includes('const inject = ["slots", "locale"]'), '声明 inject = slots + locale')
ok(/slots\.inject\("settings\.section"/.test(src), '注册了设置页分区')
ok(/id:\s*"dsh-console",\s*\n\s*order:\s*35/.test(src), '设置页 order=35（避开 harness-remote 的 30）')
ok(src.includes('plugins.bundle.config'), '注册了插件页配置区')
ok(src.includes('plugins.bundle.activation'), '注册了插件页激活区')
ok(src.includes('key: "dsh-console"'), 'keyed slot 用包名作 key')
ok(src.includes('const STATE_ROUTE = "/api/dsh-console/state".slice(1)'),
   '走 /api/dsh-console/state 路由（fetch 通路，.slice(1) 作用在整串上）')
// ⚠️ 这条真出过 bug：`"/api/dsh-console" + "-panel/state".slice(1)` 里的 .slice(1)
//    作用在**后半段**，真的把连字符吃掉了 → 客户端请求 /api/dsh-consolepanel/state，
//    宿主注册 /api/dsh-console/state → 面板全 404。
//    源码文本当时"看起来"是对的，10 组自测全绿也没抓到 —— 必须验**运行时真实值**。
{
  const routes = {}
  // 先剥注释，否则文档里引用 dsh-startup-control 的那行范例会被当成真代码匹配到
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const re = /const\s+(\w+_ROUTE)\s*=\s*"([^"]+)"(\.slice\(1\))?\s*;/g
  for (const m of code.matchAll(re)) {
    // 真正求值：有 .slice(1) 后缀就砍掉首字符（首字符是 '/'，结果变成相对路径，
    // 这正是 dsh-startup-control 能跑通的原因 —— 相对当前文档解析）
    routes[m[1]] = m[3] ? m[2].slice(1) : m[2]
  }
  const hostPaths = ['/api/dsh-console/state', '/api/dsh-console/newcode']
  const got = Object.values(routes)
  ok(got.length === 2, '面板只解析 2 条路由常量（会话那两条已删）: ' + got.length)
  for (const p of hostPaths) {
    // 客户端常量 = 宿主路径去掉首字符 '/'，相对当前文档解析后仍命中同一路由
    ok(got.includes(p.slice(1)),
       '客户端 ' + p.slice(1) + ' 求值后能命中宿主 ' + p + '  → 实际: ' + JSON.stringify(got))
  }
  for (const [k, v] of Object.entries(routes)) {
    ok(v.includes('dsh-console/'),
       k + ' 没被 .slice(1) 吃掉连字符（曾导致全 404）: ' + JSON.stringify(v))
  }
  // 宿主仍然提供 sessions/cmd（给 App 和排查用），只是面板不调了
  for (const p of ['/api/dsh-console/sessions', '/api/dsh-console/cmd']) {
    ok(!Object.values(routes).includes(p.slice(1)),
       '面板不再调 ' + p + '（2026-10-03 按用户要求删掉会话列表）')
  }
  ok(!code.includes('function Sessions'), '会话列表组件已删')
  ok(!/jsx\(Sessions/.test(code), '设置页不再挂 Sessions')
  ok(!code.includes('sessions.title'), '会话相关文案已删')
  ok(!code.includes('send.placeholder') && !code.includes('cancel.button'),
     '发消息/中断的文案已删')
}
// locale：register 走 ctx.effect（参考 dshmarket/dsh-ui-appearance），兜底退回内置中文典
ok(/loc\.register\(NS|loc\.provide\(NS/.test(src), '注册了中英文案')
// UI 契约（2026-10-03 按用户要求重做，又砍掉两块）：
ok(src.includes('function Badge'), '主卡图标位（DSH 文字徽标，鲸鱼被用户否掉了）')
ok(/border:\s*"2px solid " \+ C\.accent/.test(src), '6 位配对码外面加了方框')
ok(src.includes('"server.ok": "局域网正常"'), '状态灯文案改成「局域网正常」')
ok(/useState\(false\)/.test(src) && src.includes('setQrOpen'), '扫码区可折叠且默认收起')
ok(src.includes('t("qr.refresh")'), '有刷新二维码按钮')
ok(src.includes('"hero.status": "DSH 正常"'), '主卡右侧有 DSH 服务灯（原「服务正常」改成这个，用户问过它啥意思）')
ok(src.includes('"phone.on": "手机 · 刚刚活跃"') && src.includes('"phone.off": "手机 · 未连接"'),
   '主卡右侧有手机连接灯（2026-10-03 用户要求加；断开后灯要过 2 分钟才灭，所以叫「刚刚活跃」不叫「已连接」）')
ok(src.includes('state.phoneOnline') && src.includes('function StatusChip'),
   '手机灯吃 panelData 的 phoneOnline，两盏灯共用 StatusChip 组件')
ok(!src.includes('"hero.status": "服务正常"'), '旧文案「服务正常」已清（它只反映 DSH，跟手机无关，用户看不懂）')
// 2026-10-03 03:0x 用户砍掉的两块
ok(!codeOnly.includes('function MiniCard'), '三张小卡组件已删（用户嫌是废话）')
ok(!codeOnly.includes('repeat(3, minmax(0, 1fr))'), '三卡横排 grid 已删')
ok(!codeOnly.includes('cap.code.sub') && !codeOnly.includes('cap.token.title') &&
   !codeOnly.includes('cap.addr.sub'), '三张小卡文案已清')
// 2026-10-03 05:0x 用户要求把侧栏入口加回来（新设计：绿点/灰点 + 「DSH控制台」），旧的「已撤」断言随之作废
ok(!codeOnly.includes('WhaleIcon'), '鲸鱼图标组件已删')
// 2026-10-03 05:0x 用户要求把侧栏入口加回来（新设计：绿点/灰点 + 文字标签）
ok(codeOnly.includes('function SidebarEntry'), '侧栏入口组件回来了（SidebarEntry）')
ok(codeOnly.includes('sidebar.footer.action'), '侧栏入口注册回来了（sidebar.footer.action）')
// 2026-10-10 第118节 #9：侧栏标签文案「局域网连接」→「DSH控制台」（用户要求）。
// 断言改成验新文案，并把旧文案钉成「已清」——不能只把旧断言删掉。
ok(codeOnly.includes('"sidebar.label": "DSH控制台"'), '侧栏标签文案改成「DSH控制台」（第118节 #9）')
ok(!codeOnly.includes('"sidebar.label": "局域网连接"'), '旧的「局域网连接」侧栏文案已清（第118节 #9）')
ok(codeOnly.includes('pluginNavigation') && codeOnly.includes('listBundles'),
   '跳转走 pluginNavigation.openBundle + listBundles 确认（学 wechat-remote）')
ok(codeOnly.includes('boxShadow') && codeOnly.includes('sidebar.tip.on'), '绿点带光晕 + 悬停提示文案')
ok(!codeOnly.includes('sidebar.fallback') && !codeOnly.includes('sidebar.opening'),
   '旧版跳转失败文案没有回来')
// 剩下的两处挂点必须还在
ok(/slots\.inject\("settings\.section"/.test(src), '设置页分区还在')
ok(src.includes('plugins.bundle.config'), '插件页配置区还在')
ok(src.includes('plugins.bundle.activation'), '插件页激活区还在')
ok(!/ctx\.slots\.register\(\{[^}]*name:\s*"shell\.overlay"/.test(src), '没直接注册 shell.overlay（会把界面顶掉）')
ok(!/\bvar\s+(React|jsx)\b/.test(src), '没绕过 require 自造 React')
// 客户端和宿主的路径必须逐字一致（宿主常量在第 9 组已读出来）
for (const hostPath of ['/api/dsh-console/state', '/api/dsh-console/newcode']) {
  ok(src.includes('"' + hostPath + '"'), '客户端路径和宿主一致: ' + hostPath)
}
// 语法检查
try {
  new Function(src.replace(/^window\.__ModuleLoader__\.load\(\{/, 'x({'))
  ok(true, '语法合法（能构造）')
} catch (e) {
  ok(false, '语法合法', e.message)
}
console.log('')

/* ================= 9. 宿主半边 ================= */
console.log('【9】宿主半边')
const hostSrc = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
ok(/export const inject\s*=\s*\[/.test(hostSrc), '声明了 inject')
ok(/export function apply/.test(hostSrc), '导出 apply')
ok(!/\brequire\(/.test(hostSrc), 'ESM 里没用 require（会崩）')
ok(!/\bwindow\./.test(hostSrc), '宿主半边没碰 window（那是客户端的事）')
// 路由通路必须是 connection.fetch.register（rpc 没有 register 这种形式）
ok(hostSrc.includes('conn.fetch.register') || hostSrc.includes('connection.fetch.register'),
   '用 connection.fetch.register 注册路由')
ok(!/rpc\.register|\.rpc\.on\(/.test(hostSrc), '没用 rpc.register（那个方法不存在）')
for (const p of ['/api/dsh-console/state', '/api/dsh-console/newcode',
                 '/api/dsh-console/sessions', '/api/dsh-console/cmd']) {
  ok(hostSrc.includes(p), '声明路由 ' + p)
}
ok(hostSrc.includes("'connection'") && hostSrc.includes("'sessionController'"), 'inject 了 connection + sessionController')
// 端口锁死：默认不静默顺延，只有 allowShift 显式打开才换端口
ok(hostSrc.includes('allowShift: config.allowShiftPort === true'), '默认锁死 8899（allowShift 需显式打开）')
ok(hostSrc.includes('Number(config.port) || 8899'), '默认端口 8899')
// ⚠️ 这条真出过 bug：ctx.connection 拿到 undefined → 路由静默不注册 → 面板全报 404。
//    注入的服务只能通过 ctx.get(name) 拿，不是 ctx 上的属性。
ok(/ctx\.get\('connection'\)/.test(hostSrc), "用 ctx.get('connection') 取服务")
ok(/ctx\.get\('sessionController'\)/.test(hostSrc), "用 ctx.get('sessionController') 取服务")
// 只扫代码，注释里当然要写「别用 ctx.connection」来提醒
const hostCode = hostSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
ok(!/ctx\.connection\b/.test(hostCode), '代码里没写 ctx.connection（会拿到 undefined）')
ok(!/ctx\.sessionController\b/.test(hostCode), '代码里没把 sessionController 当 ctx 属性用')
// 发消息必须走 prompt（sessionController 没有 send）
ok(hostSrc.includes('ctl.prompt('), '发消息走 sessionController.prompt')
ok(!/\bctl\.send\(|\bsessionController\.send\(/.test(hostSrc), '没用 sessionController.send（不存在这个方法）')
const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
ok(patch.includes("name: './lib/index.js'"), 'patch 指向宿主半边')
ok(!/profile/.test(patch.split('\n').filter(l => l.trim().startsWith('#')).join('\n')) ||
   patch.includes('不要写到 profile'), 'patch 里有"别写进 profile"的提醒')

console.log('')

/* ================= 10. package.json ================= */
console.log('【10】包清单')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const clientInject = (pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject) || []
ok(clientInject.includes('@deepseek-ai/dsh-client-locale'), '客户端 inject 了 locale')
ok(!clientInject.includes('@deepseek-ai/dsh-client-connection'), '客户端不再 inject connection（我们走 fetch）')
ok(clientInject.includes('@deepseek-ai/dsh-client-ui-settings'), '客户端 inject 了 ui-settings')
ok(pkg.dsh.bundle.patch === './cordis.patch.yml', 'bundle 指向自己的 patch')
const peer = Object.keys(pkg.peerDependencies || {})
ok(peer.includes('@deepseek-ai/dsh-client-locale'), 'peerDependencies 里有 locale')
ok(!peer.includes('@deepseek-ai/dsh-client-connection'), 'peerDependencies 里没有 connection')
// files 列的每个文件都得真的存在
// files 列支持通配（lib/*.js、lib/*.mjs）：先按 glob 展开成真实文件，再查存在性
function expandFilesEntry(entry) {
  if (!entry.includes('*')) return [path.join(root, entry)]
  const dir = path.join(root, path.dirname(entry))
  if (!fs.existsSync(dir)) return []
  const pat = path.basename(entry).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  const re = new RegExp('^' + pat + '$')
  return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f))
}
const missing = []
for (const entry of (pkg.files || [])) {
  const hits = expandFilesEntry(entry)
  if (hits.length === 0 || hits.some((f) => !fs.existsSync(f))) missing.push(entry)
}
ok(missing.length === 0, 'files 里没有不存在的文件', missing.join(', '))
ok(fs.existsSync(path.join(root, 'node_modules', 'qrcode')), 'qrcode 依赖已装（二维码要它）')
console.log('')


lan.stop()
console.log(failed === 0 ? '全部通过 ✓' : ('有 ' + failed + ' 项失败'))
process.exit(failed === 0 ? 0 : 1)
