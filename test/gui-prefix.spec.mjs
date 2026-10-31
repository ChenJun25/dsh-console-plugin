import assert from 'node:assert/strict'
import http from 'node:http'
import vm from 'node:vm'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { startLanServer, guiPrefixBootstrap, guiTokenBootstrap } from '../lib/lan-server.mjs'

const sid = 'ABCDEFGHIJKLMNO'
const prefix = '/dsh-console/' + sid + '/gui'
const CODE = 't'.repeat(64)
const LAUNCH = 'L'.repeat(43)
const host = http.createServer((req, res) => {
  if (req.url.startsWith('/api/echo')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url, host: req.headers.host }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: 'old' })
  res.end('<!doctype html><html><head><base href="./"><script src="/plugin.js"></script></head><body>GUI<script>s.src="/widget.js";</script></body></html>')
})
const upstreamSockets = []
const upstreamWs = new WebSocketServer({ noServer: true })
upstreamWs.on('connection', (socket) => {
  upstreamSockets.push(socket)
  socket.send('gui-ready')
  socket.on('message', (data) => socket.send('echo:' + String(data)))
})
host.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/ws')) upstreamWs.handleUpgrade(req, socket, head, (client) => upstreamWs.emit('connection', client, req))
  else socket.destroy()
})
host.listen(0, '127.0.0.1')
await once(host, 'listening')
const lan = startLanServer({
  port: 0, allowShift: true, getToken: () => CODE, getInfo: () => ({}),
  listSessions: async () => [], runCommand: async () => ({}), log: () => {},
  webGuiPort: () => host.address().port,
  dshLaunchToken: () => LAUNCH,
  cloud: { snapshot: () => ({ shortId: sid }) },
})
try {
  await lan.start()
  assert.ok(lan.port > 0)
  const base = 'http://127.0.0.1:' + lan.port

  assert.equal((await fetch(base + prefix + '/')).status, 401)
  assert.equal((await fetch(base + prefix + '/api/echo?q=1')).status, 401)
  assert.equal((await fetch(base + prefix + '/?token=nope')).status, 401)

  const r = await fetch(base + prefix + '/?token=' + LAUNCH)
  assert.equal(r.status, 200)
  const html = await r.text()
  assert.ok(html.indexOf(guiPrefixBootstrap) < html.indexOf('<base'))
  assert.ok(html.includes('__DSH_CONSOLE_GUI_TOKEN__="' + LAUNCH + '"'))
  assert.ok(html.includes(guiTokenBootstrap))
  assert.ok(html.includes('src="' + prefix + '/plugin.js"'))
  assert.equal(r.headers.get('etag'), null)
  assert.ok(html.includes('<script>s.src="' + prefix + '/widget.js";</script>'))
  assert.ok(!html.includes('src="' + prefix + '/"widget.js"'))
  assert.equal(Number(r.headers.get('content-length')), Buffer.byteLength(html))

  const setCookie = String(r.headers.get('set-cookie') || '')
  assert.ok(setCookie.includes('dsh-console-gui='))
  const cookie = setCookie.split(';')[0]
  const api = await fetch(base + prefix + '/api/echo?q=1', { headers: { cookie } })
  assert.equal((await api.json()).url, '/api/echo?q=1')
  const apiByToken = await fetch(base + prefix + '/api/echo?q=2&token=' + LAUNCH)
  assert.equal((await apiByToken.json()).url, '/api/echo?q=2&token=' + LAUNCH)
  const badCookie = await fetch(base + prefix + '/api/echo?q=1', { headers: { cookie: 'dsh-console-gui=forged' } })
  assert.equal(badCookie.status, 401)

  const byCode = await fetch(base + prefix + '/?token=' + CODE)
  assert.equal(byCode.status, 200)
  assert.ok((await byCode.text()).includes('__DSH_CONSOLE_GUI_TOKEN__="' + CODE + '"'))
  const byHeader = await fetch(base + prefix + '/api/echo?q=3', { headers: { 'x-dsh-console-token': CODE } })
  assert.equal((await byHeader.json()).url, '/api/echo?q=3')

  const local = await fetch('http://127.0.0.1:' + host.address().port + '/')
  assert.ok(!(await local.text()).includes('__DSH_CONSOLE_GUI_PREFIX__'))
  const plain = await fetch(base + '/dsh-console/gui/?token=' + LAUNCH)
  assert.ok((await plain.text()).includes('window.__DSH_CONSOLE_GUI_PREFIX__'))

  const wsDenied = new WebSocket('ws://127.0.0.1:' + lan.port + prefix + '/ws')
  const denied = await new Promise((resolve) => {
    wsDenied.on('error', () => resolve('error'))
    wsDenied.on('open', () => resolve('open'))
    setTimeout(() => resolve('timeout'), 2000)
  })
  assert.equal(denied, 'error')
  const ws = new WebSocket('ws://127.0.0.1:' + lan.port + prefix + '/ws?token=' + LAUNCH)
  const messages = []
  ws.on('message', (data) => messages.push(String(data)))
  await once(ws, 'open')
  ws.send('ping')
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 回显超时')), 3000)
    const check = () => { if (messages.includes('echo:ping')) { clearTimeout(timer); resolve() } else setTimeout(check, 10) }
    check()
  })
  assert.equal(messages[0], 'gui-ready')
  ws.close()
  await once(ws, 'close')

  const wrong = await fetch(base + '/dsh-console/ZABCDEFGHIJKLMN/gui/?token=' + LAUNCH)
  assert.equal(wrong.status, 404)

  const fetched = [], xhrs = [], sockets = []
  class Req { constructor(url) { this.url = url } }
  class X { open(...args) { xhrs.push(args) } }
  class W { constructor(...args) { sockets.push(args) } }
  const context = {
    window: null, location: new URL('https://example.cn' + prefix + '/'), URL, Request: Req,
    XMLHttpRequest: X, WebSocket: W, EventSource: W, Proxy, Reflect,
    navigator: { sendBeacon: (url) => { fetched.push(url); return true } },
  }
  context.window = context
  context.fetch = (url) => fetched.push(url)
  vm.createContext(context)
  vm.runInContext(guiPrefixBootstrap, context)
  context.fetch('/api/session')
  context.fetch(new Req('https://example.cn/api/other'))
  context.fetch('https://elsewhere.cn/api/outside')
  new context.XMLHttpRequest().open('GET', '/xhr')
  new context.WebSocket('wss://example.cn/ws')
  new context.WebSocket('/socket')
  assert.equal(fetched[0], prefix + '/api/session')
  assert.equal(fetched[1].url, 'https://example.cn' + prefix + '/api/other')
  assert.equal(fetched[2], 'https://elsewhere.cn/api/outside')
  assert.equal(xhrs[0][1], prefix + '/xhr')
  assert.equal(sockets[0][0], 'wss://example.cn' + prefix + '/ws')
  assert.equal(sockets[1][0], prefix + '/socket')

  const f2 = [], x2 = [], s2 = []
  class X2 { open(...args) { x2.push(args) } }
  class W2 { constructor(...args) { s2.push(args) } }
  const c2 = {
    window: null, location: new URL('https://example.cn' + prefix + '/'), URL, Request: Req,
    XMLHttpRequest: X2, WebSocket: W2, EventSource: W2, Proxy, Reflect,
    navigator: { sendBeacon: (url) => { f2.push(url); return true } },
  }
  c2.window = c2
  c2.window.__DSH_CONSOLE_GUI_TOKEN__ = LAUNCH
  c2.fetch = (url) => f2.push(url)
  vm.createContext(c2)
  vm.runInContext(guiTokenBootstrap, c2)
  c2.fetch('/api/a')
  c2.fetch('/api/b?x=1')
  c2.fetch('https://example.cn/api/c')
  c2.fetch('https://elsewhere.cn/api/d')
  new c2.XMLHttpRequest().open('GET', '/xhr2')
  new c2.WebSocket('wss://example.cn/ws2')
  assert.equal(f2[0], '/api/a?token=' + LAUNCH)
  assert.equal(f2[1], '/api/b?x=1&token=' + LAUNCH)
  assert.equal(f2[2], 'https://example.cn/api/c?token=' + LAUNCH)
  assert.equal(f2[3], 'https://elsewhere.cn/api/d')
  assert.equal(x2[0][1], '/xhr2?token=' + LAUNCH)
  assert.equal(s2[0][0], 'wss://example.cn/ws2?token=' + LAUNCH)
  console.log('GUI 短号前缀：HTTP、WebSocket、fetch、XHR、/gui 鉴权（launch / 访问码 / cookie）全部通过')
} finally {
  await lan.stop()
  for (const socket of upstreamSockets) socket.terminate()
  upstreamWs.close()
  host.close()
}
