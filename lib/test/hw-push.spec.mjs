import crypto from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  SA_PATHS, loadSa, pushReady, pushStatus, buildJwt, buildBody, normTokens,
  sendPush, createPushWatcher
} from '../hw-push.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass += 1; console.log('  \u2713 ' + label) }
  else { fail += 1; console.log('  \u2717 ' + label + (extra === undefined ? '' : ' \u2192 ' + extra)) }
}
const flush = (ms) => new Promise((r) => setTimeout(r, ms || 20))

const kp = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})
const SA = {
  key_id: 'TEST_KEY_ID_0001',
  sub_account: '1234567890',
  project_id: '99887766',
  private_key: kp.privateKey
}
const SA_TEXT = JSON.stringify(SA)

const SA_ESCAPED = JSON.stringify(Object.assign({}, SA, { private_key: kp.privateKey.replace(/\n/g, '\\n') }))
const NO_SA_OPTS = { ignoreEnv: true, saPaths: [path.join(os.tmpdir(), 'no-such-sa-file.json')] }

console.log('\u30101\u3011 没配服务账号：静默失败、绝不抛')

{
  const r = loadSa(NO_SA_OPTS)
  ok(r.ok === false && r.reason === 'no-sa', 'loadSa 回 no-sa', JSON.stringify(r))
  ok(pushReady(NO_SA_OPTS) === false, 'pushReady() === false')
  const st = pushStatus(Object.assign({ readTokens: () => [] }, NO_SA_OPTS))
  ok(st.ready === false && st.reason === 'no-sa', 'pushStatus 回 ready:false', JSON.stringify(st))
  ok(Array.isArray(st.expectedPaths) && st.expectedPaths.length === 1, 'pushStatus 回实际在查的路径', JSON.stringify(st.expectedPaths))
  ok(st.problems.length >= 2 && st.problems.some((s) => /服务账号/.test(s)) && st.problems.some((s) => /push token/.test(s)), 'pushStatus 明确列出缺什么', JSON.stringify(st.problems))
  const stDefault = pushStatus({ ignoreEnv: true })
  ok(stDefault.expectedPaths.length === 2 && /hw-push-sa\.json$/.test(stDefault.expectedPaths[0]), '默认回 ~/.dsh 两个期望路径（照它放文件）', JSON.stringify(stDefault.expectedPaths))
  let threw = false
  let ret = null
  try {
    ret = await sendPush({ tokens: ['tok-aaaaaaaa'], title: 't', saOpts: NO_SA_OPTS })
  } catch (e) { threw = true }
  ok(!threw, 'sendPush 不抛')
  ok(ret && ret.ok === false && ret.reason === 'no-sa', 'sendPush 回 no-sa', JSON.stringify(ret))
  const r2 = await sendPush({ tokens: [], title: 't', saOpts: NO_SA_OPTS })
  ok(r2 && r2.ok === false && r2.reason === 'no-token', '空 token 回 no-token', JSON.stringify(r2))
  const r3 = await sendPush({ tokens: ['tok'], title: '  ', saOpts: NO_SA_OPTS })
  ok(r3 && r3.ok === false && r3.reason === 'no-title', '空标题回 no-title', JSON.stringify(r3))

  const r4 = loadSa({ ignoreEnv: true, saPaths: [], saText: '{not json' })
  ok(r4.ok === false && (r4.reason === 'bad-sa' || r4.reason === 'no-sa'), '坏 sa JSON 不抛', JSON.stringify(r4))
  ok(SA_PATHS.length === 2 && /hw-push-sa\.json$/.test(SA_PATHS[0]), '默认路径含 ~/.dsh/hw-push-sa.json')
}

console.log('\u30102\u3011 服务账号解析：snake/camel、\\n 还原、环境变量优先级')

{
  const a = loadSa({ saText: SA_TEXT, ignoreEnv: true, saPaths: [] })
  ok(a.ok === true && a.source === 'inline' && a.sa.projectId === '99887766', '内联 sa json 解析成功')
  const b = loadSa({ saText: SA_ESCAPED, ignoreEnv: true, saPaths: [] })
  ok(b.ok === true && b.sa.privateKey.indexOf('\n') >= 0, '字面量 \\n 还原成真换行')
  const c = loadSa({ saText: JSON.stringify({ keyId: 'K', subAccount: 'S', projectId: 'P', privateKey: kp.privateKey }), ignoreEnv: true, saPaths: [] })
  ok(c.ok === true && c.sa.keyId === 'K' && c.sa.subAccount === 'S', 'camelCase 字段也认')
  const d = loadSa({ saText: JSON.stringify({ key_id: 'K', project_id: 'P' }), ignoreEnv: true, saPaths: [] })
  ok(d.ok === false && d.reason === 'bad-sa', '缺字段 → bad-sa 不当成配好')
  const st = pushStatus({ saText: SA_TEXT, ignoreEnv: true, saPaths: [], readTokens: () => ['a', 'b'] })
  ok(st.ready === true && st.projectId === '99887766' && st.keyIdTail === '_ID_0001', 'pushStatus 只回非敏感信息', JSON.stringify(st))

  ok(st.tokenCount === 2 && st.problems.length === 1 && /testMessage=true/.test(st.problems[0]), 'testMessage=true 时提醒额度按台数消耗', JSON.stringify(st.problems))
  const stProd = pushStatus({ saText: SA_TEXT, ignoreEnv: true, saPaths: [], readTokens: () => ['a', 'b'], test: false })
  ok(stProd.tokenCount === 2 && stProd.problems.length === 0, '配好 + 正式消息 → problems 清空', JSON.stringify(stProd.problems))
  ok(JSON.stringify(st).indexOf('PRIVATE') < 0 && JSON.stringify(st).indexOf('1234567890') < 0, 'pushStatus 不含私钥与 sub_account')

  const stNoTok = pushStatus({ saText: SA_TEXT, ignoreEnv: true, saPaths: [], readTokens: () => [] })
  ok(stNoTok.ok === true && stNoTok.ready === false && /push token/.test(stNoTok.problems[0] || ''), 'sa 有但没 token → ready:false', JSON.stringify(stNoTok))
}

console.log('\u30103\u3011 PS256 JWT：三段式 / base64url / 真验签')

{
  const jwt = buildJwt(loadSa({ saText: SA_TEXT, ignoreEnv: true, saPaths: [] }).sa)
  const segs = jwt.split('.')
  ok(segs.length === 3, 'JWT 三段式', jwt.split('.').length)
  ok(segs.every((s) => s.length > 0 && !/[=\r\n]/.test(s)), 'base64url 无 padding 无换行')
  const header = JSON.parse(Buffer.from(segs[0], 'base64url').toString('utf8'))
  const payload = JSON.parse(Buffer.from(segs[1], 'base64url').toString('utf8'))
  ok(header.alg === 'PS256' && header.typ === 'JWT' && header.kid === 'TEST_KEY_ID_0001', 'header alg=PS256/kid 对', JSON.stringify(header))
  ok(payload.aud === 'https://oauth-login.cloud.huawei.com/oauth2/v3/token', 'aud 是华为 token 地址', payload.aud)
  ok(payload.iss === '1234567890', 'iss = sub_account')
  ok(payload.exp - payload.iat === 3600, 'exp = iat + 3600')
  ok(Math.abs(payload.iat - Math.floor(Date.now() / 1000)) <= 5, 'iat 是当前秒级时间')

  const verified = crypto.verify('RSA-SHA256',
    Buffer.from(segs[0] + '.' + segs[1], 'ascii'),
    { key: kp.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
    Buffer.from(segs[2], 'base64url'))
  ok(verified === true, 'PS256 签名用对应公钥验签通过')

  const bad = Buffer.from(segs[2], 'base64url')
  bad[0] = bad[0] ^ 0xff
  const badOk = crypto.verify('RSA-SHA256',
    Buffer.from(segs[0] + '.' + segs[1], 'ascii'),
    { key: kp.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, bad)
  ok(badOk === false, '篡改签名后验签失败')
}

console.log('\u30104\u3011 v3 请求体：字段与华为文档 / App 深链对齐')

{
  const body = buildBody({ tokens: ['a', 'a', ' b ', ''], title: '「t」生成完成', body: '点此查看结果', sessionId: 'session-x1', test: true, notifyId: 7 })
  ok(body.target.token.length === 2 && body.target.token[0] === 'a' && body.target.token[1] === 'b', 'token 去重去空', JSON.stringify(body.target.token))
  const n = body.payload.notification
  ok(n.title === '「t」生成完成' && n.body === '点此查看结果', 'title/body 原样')

  ok(n.category === 'WORK', 'category 默认 WORK（MARKETING 是静默通知）')
  ok(n.foregroundShow === false, 'foregroundShow=false（前台走 receiveMessage）')
  ok(buildBody({ title: 't', tokens: ['a'], category: 'ACCOUNT' }).payload.notification.category === 'ACCOUNT', 'category 可显式覆盖')
  ok(n.clickAction.actionType === 0 && n.clickAction.data.sessionId === 'session-x1', 'clickAction.data.sessionId 对上 App 深链', JSON.stringify(n.clickAction))
  ok(n.notifyId === 7 && n.badge.addNum === 1, 'notifyId / badge')
  ok(body.pushOptions.testMessage === true, 'testMessage=true 按测试消息发')
  ok(buildBody({ title: 't', tokens: ['a'], ttl: 1 }).pushOptions.ttl === 3600, 'ttl 低于下限被抬到 3600')
  ok(buildBody({ title: 't', tokens: ['a'], ttl: 99999999 }).pushOptions.ttl === 1296000, 'ttl 超过上限被压到 1296000')
  ok(buildBody({ title: 't', tokens: ['a'], test: false }).pushOptions.testMessage === false, 'test:false 走正式消息')
  ok(normTokens('a, b ,a').length === 2, '逗号串 token 也吃')
  ok(normTokens(Array.from({ length: 1500 }, (_, i) => 't' + i)).length === 1000, '单次最多 1000 个 token')

  const objToks = normTokens([{ token: 'a', deviceId: '1' }, { token: 'b' }, { token: 'a', deviceId: '2' }, { token: '' }, null])
  ok(objToks.length === 2 && objToks[0] === 'a' && objToks[1] === 'b', '对象数组取 token 字段并去重，不吃空/null')
}

console.log('\u30105\u3011 sendPush 走本地打桩服务器：成功 / 业务失败 / HTTP 500 都不抛')

let lastReq = null
const reqs = []
let mode = 'ok'
const srv = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    let parsed = null
    try { parsed = JSON.parse(raw) } catch (e) { parsed = null }
    lastReq = { url: req.url, headers: req.headers, body: parsed }
    reqs.push(lastReq)
    res.setHeader('Content-Type', 'application/json')
    if (mode === 'ok') { res.statusCode = 200; res.end(JSON.stringify({ code: '80000000', msg: 'Success', requestId: 'r1' })) }
    else if (mode === 'biz') { res.statusCode = 200; res.end(JSON.stringify({ code: '80400001', msg: 'token 无效' })) }
    else { res.statusCode = 500; res.end('oops') }
  })
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const port = srv.address().port
const apiBase = 'http://127.0.0.1:' + port
const saOpts = { saText: SA_TEXT, ignoreEnv: true, saPaths: [] }

try {
  mode = 'ok'
  const r1 = await sendPush({ tokens: ['tok-1234567890abcd'], title: 'hello', body: 'world', sessionId: 's1', apiBase, saOpts })
  ok(r1.ok === true && r1.code === '80000000' && r1.count === 1, '成功码 80000000 → ok:true', JSON.stringify(r1))
  ok(lastReq && lastReq.url === '/99887766/messages:send', 'URL 走 /v3/{projectId}/messages:send', lastReq && lastReq.url)
  ok(lastReq && /^Bearer [A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(lastReq.headers.authorization), 'Authorization: Bearer <三段 JWT>')
  ok(lastReq && lastReq.headers['push-type'] === '0', 'push-type: 0')
  ok(lastReq && lastReq.body && lastReq.body.target.token[0] === 'tok-1234567890abcd', '请求体带到 token')
  ok(lastReq && lastReq.body.payload.notification.clickAction.data.sessionId === 's1', '请求体带到 sessionId')

  mode = 'biz'
  const r2 = await sendPush({ tokens: ['tok'], title: 'hello', apiBase, saOpts })
  ok(r2.ok === false && r2.code === '80400001' && /token/.test(r2.msg), '业务失败码原样回，不抛', JSON.stringify(r2))

  mode = '500'
  const r3 = await sendPush({ tokens: ['tok'], title: 'hello', apiBase, saOpts })
  ok(r3.ok === false && r3.code === '500', 'HTTP 500 回 ok:false，不抛', JSON.stringify(r3))

  const deadPort = await new Promise((r) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) })
  })
  const r4 = await sendPush({ tokens: ['tok'], title: 'hello', apiBase: 'http://127.0.0.1:' + deadPort, saOpts, timeoutMs: 2000 })
  ok(r4.ok === false && r4.reason === 'exception', '连不上 → reason:exception，不抛', JSON.stringify(r4))

  mode = 'ok'
  reqs.length = 0
  const rTest = await sendPush({ tokens: ['tokA', 'tokB'], title: 'hello', apiBase, saOpts })
  ok(reqs.length === 2, 'testMessage=true + 2 个 token ⇒ 拆成 2 次请求', '实际 ' + reqs.length + ' 次')
  ok(reqs.every((q) => Array.isArray(q.body.target.token) && q.body.target.token.length === 1), '每次请求的 target.token 长度都是 1', JSON.stringify(reqs.map((q) => q.body.target.token)))
  ok(reqs[0].body.target.token[0] === 'tokA' && reqs[1].body.target.token[0] === 'tokB', '两台按顺序各发一次，没漏没重')
  ok(rTest.ok === true && rTest.sent === 2 && rTest.failed === 0 && rTest.count === 2, '拆分发送汇总回 sent/failed', JSON.stringify(rTest))
  ok(rTest.results.length === 2 && rTest.results[0].tokenTail === 'tokA', 'results 里带每台的结果（只看尾段）', JSON.stringify(rTest.results))

  reqs.length = 0
  const rProd = await sendPush({ tokens: ['tokA', 'tokB'], title: 'hello', test: false, apiBase, saOpts })
  ok(reqs.length === 1, 'testMessage=false + 2 个 token ⇒ 只发 1 次请求', '实际 ' + reqs.length + ' 次')
  ok(reqs[0].body.target.token.length === 2 && reqs[0].body.pushOptions.testMessage === false, '正式消息一次带全部 token，且 testMessage=false', JSON.stringify(reqs[0].body.target.token))
  ok(rProd.ok === true && rProd.count === 2, '正式消息按原路径回 ok', JSON.stringify(rProd))
} finally {
  await new Promise((r) => srv.close(r))
}

console.log('\u30106\u3011 会话完成检测：基线不推 / true→false 推一次 / 同一次只推一次')

{

  let sentA = []
  const wA = createPushWatcher({
    readSessions: () => Promise.resolve([]),
    readTokens: () => ['tok-a'],
    ready: () => false,
    send: (o) => { sentA.push(o); return Promise.resolve({ ok: true }) },
    log: () => {}
  })
  wA.scan([{ id: 's1', running: true, updatedAt: 1 }])
  wA.scan([{ id: 's1', running: false, updatedAt: 2 }])
  await flush()
  ok(sentA.length === 0, '没配服务账号不推')

  const sent = []
  const w = createPushWatcher({
    readSessions: () => Promise.resolve([]),
    readTokens: () => ['tok-1', 'tok-2', 'tok-1'],
    ready: () => true,
    send: (o) => { sent.push(o); return Promise.resolve({ ok: true, count: 2 }) },
    log: () => {}
  })
  w.scan([{ id: 's1', running: true, updatedAt: 100 }, { id: 's2', running: false, updatedAt: 200 }])
  ok(sent.length === 0, '首次扫描只记基线不推')
  w.scan([{ id: 's1', running: false, updatedAt: 300 }, { id: 's2', running: false, updatedAt: 200 }])
  await flush()
  ok(sent.length === 1, 'running 从 true 翻 false 推一次', sent.length)
  ok(sent[0] && sent[0].sessionId === 's1', '推送带 sessionId')
  ok(sent[0] && sent[0].title === '「s1」生成完成', '标题格式「<标题>」生成完成', sent[0] && sent[0].title)
  ok(sent[0] && sent[0].body === '点此查看结果', '正文「点此查看结果」')
  ok(sent[0] && sent[0].tokens.length === 2, 'token 去重后 2 个', sent[0] && sent[0].tokens.length)
  w.scan([{ id: 's1', running: false, updatedAt: 300 }])
  await flush()
  ok(sent.length === 1, '同一次完成（updatedAt 未变）不重复推', sent.length)

  const sent2 = []
  const w2 = createPushWatcher({
    readSessions: () => Promise.resolve([]), readTokens: () => ['tok'], ready: () => true,
    send: (o) => { sent2.push(o); return Promise.resolve({ ok: true }) }, log: () => {}
  })
  w2.scan([{ id: 's9', running: false, updatedAt: 1 }])
  w2.scan([{ id: 's9', running: false, updatedAt: 2 }])
  await flush()
  ok(sent2.length === 0, '一直没跑过的会话不推')

  const w3 = createPushWatcher({
    readSessions: () => Promise.resolve([]), readTokens: () => ['tok'], ready: () => true,
    send: () => Promise.reject(new Error('boom')), log: () => {}
  })
  w3.scan([{ id: 's3', running: true, updatedAt: 1 }])
  w3.scan([{ id: 's3', running: false, updatedAt: 2 }])
  await flush()
  ok(true, 'send 抛错被就地吃掉，轮询不受影响')

  let reads = 0
  const w4 = createPushWatcher({
    readSessions: () => { reads += 1; return Promise.resolve([{ id: 'x', running: false, updatedAt: 1 }]) },
    readTokens: () => [], ready: () => false, send: () => Promise.resolve({ ok: true }), log: () => {}, intervalMs: 20
  })
  ok(w4.start() === true, 'start() 起定时器')
  ok(w4.start() === false, '重复 start 不再建第二个定时器')
  await flush(60)
  ok(reads >= 1 && w4.state().baselined === true, '定时器真的在扫且已建基线', JSON.stringify(w4.state()))
  w4.stop()
  await flush(50)
  const readsAfterStop = reads
  await flush(50)
  ok(reads === readsAfterStop && w4.state().running === false, 'stop() 后不再扫')
  ok(typeof w4.state().pushed === 'number' && w4.state().sessions === 1, 'state() 只回计数', JSON.stringify(w4.state()))
}

console.log('\n' + (fail === 0 ? '\u2705 全部通过' : '\u274c 有失败') + '  pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
