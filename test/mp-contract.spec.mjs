import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  ALLOW, COOKIE, ENDPOINTS, MAX_BODY, MAX_UPLOAD_BYTES, PREFIX, SESSION_PAGE,
  approvalFrame, approvalResponseBody, cookieValue, deviceCookieHeader,
  isAllowed, isRpcShaped, mergePending, methodOf, parseRpcBody,
  pendingSnapshot, pongFrame, questionFrame, questionInteractionStatus,
  questionResponseBody, readyFrame, sessionEventFrame, sessionStatusFrame,
  wrap, wrapBadRequest, wrapErr, wrapUnavailable,
} from '../lib/mp-contract.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
let n = 0
const ok = (name) => { n++; console.log('  ok - ' + name) }
const section = (t) => console.log('\n' + t)

section('/mp 路由推导')

assert.equal(PREFIX, '/mp')
ok('PREFIX is /mp')

assert.equal(methodOf('/mp/api/session.list'), 'session.list')
ok('a whitelisted method resolves from the path')

assert.equal(methodOf('/mp/api/nope.nope'), null)
ok('a method outside ALLOW does not resolve')

assert.equal(methodOf('/mp/api/'), null)
ok('the bare prefix resolves to nothing')

assert.equal(methodOf('/mp/api/session.list/extra'), null)
ok('a path with a trailing segment is rejected, not truncated')

assert.equal(methodOf('/dsh-console/session.list'), null)
ok('a different plugin prefix is not stolen')

assert.equal(isRpcShaped('/mp/api/session.list'), true)
ok('isRpcShaped accepts a real call')
assert.equal(isRpcShaped('/mp/pair/accept'), false)
ok('isRpcShaped rejects the pairing route')

assert.equal(ENDPOINTS.wsMux, '/mp/api/ws/mux')
assert.equal(ENDPOINTS.wsHost, '/mp/api/ws/host')
assert.equal(ENDPOINTS.accept, '/mp/pair/accept')
assert.equal(ENDPOINTS.status, '/mp/pair/status')
ok('the endpoints the client hardcodes match')

section('RPC 白名单')

assert.equal(ALLOW.length, 24)
ok('ALLOW has 24 methods')
assert.equal(isAllowed('session.list'), true)
assert.equal(isAllowed('session.list2'), false)
ok('isAllowed is exact-match, not prefix')

for (const m of ['session.history', 'session.prompt', 'session.list', 'mobile.respond']) {
  assert.equal(isAllowed(m), true, m)
}
ok('the methods the chat page depends on are all allowed')

section('server-response 信封')

const good = wrap('rpc-1', { items: [1, 2] })
assert.equal(good.type, 'server-response')
assert.equal(good.rpcId, 'rpc-1')
assert.equal(good.result.ok, true)
assert.deepEqual(good.result.value, { items: [1, 2] })
assert.equal(good.result.error, undefined)
ok('success puts the payload on result.value, not on result')

const bad = wrapErr('rpc-2', 'forbidden', 'too old')
assert.equal(bad.result.ok, false)
assert.equal(bad.result.error.code, 'forbidden')
assert.equal(bad.result.error.message, 'too old')
ok('failure carries a { code, message } error object')

assert.equal(wrapErr('', 'x', 'y').rpcId, '')
ok('a missing rpcId degrades to empty string, not undefined')

assert.equal(wrapUnavailable('r', 'nope').result.error.code, 'unavailable')
ok('unavailable uses its own code')
assert.equal(wrapBadRequest('r', 'bad').result.error.code, 'bad-request')
ok('bad-request uses its own code')

const { rpcId, payload } = parseRpcBody({ rpcId: 'abc', payload: { sessionId: 's1' } })
assert.equal(rpcId, 'abc')
assert.equal(payload.sessionId, 's1')
ok('the request body splits into rpcId and payload')

assert.deepEqual(parseRpcBody({}), { rpcId: '', payload: {} })
assert.deepEqual(parseRpcBody(null), { rpcId: '', payload: {} })
ok('a malformed body degrades instead of throwing')

section('mp_device Cookie')

assert.equal(COOKIE, 'mp_device')
ok('the cookie name matches the one the client sends')

assert.equal(cookieValue('mp_device=secret123'), 'secret123')
ok('a single cookie parses')
assert.equal(cookieValue('a=1; mp_device=secret; b=2'), 'secret')
ok('the right cookie is found among others')
assert.equal(cookieValue('mp_device=with%20space'), 'with space')
ok('percent-encoding is decoded')
assert.equal(cookieValue('mp_device='), '')
ok('an empty value is empty, not the whole header')
assert.equal(cookieValue(''), '')
assert.equal(cookieValue(undefined), '')
ok('a missing header is empty, not a crash')
assert.equal(cookieValue('mp_device=a; mp_device=b'), 'a')
ok('the first occurrence wins')

const setCookie = deviceCookieHeader('s3cret')
assert.ok(setCookie.startsWith('mp_device=s3cret'), 'sets the cookie')
assert.ok(setCookie.includes('HttpOnly'), 'is HttpOnly')
assert.ok(setCookie.includes('Path=/'), 'is scoped to the root')
ok('Set-Cookie carries the right attributes')

section('WebSocket 帧')

const r = readyFrame('mux', 'client-9')
assert.equal(r.type, 'ready')
assert.equal(r.clientId, 'client-9')
ok('the first frame says ready, which the client needs to leave connecting')
assert.ok(readyFrame('mux').clientId.length > 0)
ok('a ready frame without an explicit id still gets one')

assert.equal(pongFrame().type, 'pong')
ok('the control ping gets a pong')

const se = sessionEventFrame('s1', { type: 'user/message', seq: 3 })
assert.equal(se.type, 'session/event')
assert.equal(se.sessionId, 's1')
assert.equal(se.event.seq, 3)
ok('a host event is wrapped, not flattened')

const st = sessionStatusFrame('s1', true)
assert.equal(st.type, 'host/session-status')
assert.equal(st.running, true)
ok('the host channel gets a running indicator frame')

section('审批与提问')

const ap = approvalFrame({ approvalId: 'a1', toolName: 'fs.write', callId: 'c1', reason: '写文件' })
assert.equal(ap.type, 'approval/requested')
assert.equal(ap.approvalId, 'a1')
assert.equal(ap.toolName, 'fs.write')
ok('an approval request becomes a client frame')
assert.equal(approvalFrame({ id: 'a2' }).approvalId, 'a2')
ok('approvalId falls back to id for older hosts')
assert.equal(approvalFrame({}).toolName, 'tool')
ok('a missing tool name still names something')

const q = questionFrame({ rpcId: 'q1', questions: [{ id: 'q1', question: '继续？' }] })
assert.equal(q.type, 'question/requested')
assert.equal(q.rpcId, 'q1')
assert.equal(q.kind, 'question')
ok('a question request becomes a client frame')

const planish = { intent: { kind: 'plan-review' }, detail: '会改 3 个文件', multiSelect: false, options: [{ label: 'approve' }] }
assert.equal(questionInteractionStatus([planish]), 'plan-review')
ok('a single plan-review question with approve is a plan review')
assert.equal(questionInteractionStatus([{ ...planish, options: [{ label: 'no' }] }]), 'question')
ok('without an approve option it is a plain question')
assert.equal(questionInteractionStatus([{ ...planish, detail: '' }]), 'question')
ok('no detail means it is not a plan review')
assert.equal(questionInteractionStatus([{ ...planish, multiSelect: true }]), 'question')
ok('multi-select means it is not a plan review')
assert.equal(questionInteractionStatus([{ ...planish, options: [{ label: 'approve' }, { label: 'a' }, { label: 'b' }] }]), 'question')
ok('more than two options means it is not a plan review')
assert.equal(questionInteractionStatus([planish, planish]), 'question')
ok('two questions are never a plan review')
assert.equal(questionInteractionStatus([]), 'question')
assert.equal(questionInteractionStatus(undefined), 'question')
ok('empty input is safe')

const ar = approvalResponseBody('s1', { approvalId: 'a1', rpcId: 'r1', outcome: 'allow' })
assert.equal(ar.type, 'approval')
assert.equal(ar.sessionId, 's1')
assert.equal(ar.approvalId, 'a1')
ok('the approval reply is flat, which is what the host parses')

const qr = questionResponseBody('s1', { rpcId: 'q1', answers: [{ id: 'a', selected: ['x'], custom: '' }] })
assert.equal(qr.type, 'question')
assert.equal(qr.answers[0].selected[0], 'x')
assert.equal('custom' in qr.answers[0], false)
ok('an empty custom is dropped so it cannot overwrite a selection')

const qr2 = questionResponseBody('s1', { answers: [{ id: 'a', selected: [], custom: '自己写的' }] })
assert.equal(qr2.answers[0].custom, '自己写的')
ok('a real custom answer is kept')

section('待决快照与合并')

const tracker = {
  list: () => [{ approvalId: 'a1', toolName: 'fs.write', reason: 'r' }],
  questions: () => [{ rpcId: 'q1', questions: [{ id: 'x', question: '?' }] }],
}
const snap = pendingSnapshot(tracker)
assert.equal(snap.approvals.length, 1)
assert.equal(snap.questions.length, 1)
assert.equal(snap.questions[0].kind, 'question')
ok('the tracker is read into a snapshot')
assert.deepEqual(pendingSnapshot(null), { approvals: [], questions: [] })
ok('no tracker yields an empty snapshot, not a crash')

const first = { approvals: [], questions: [{ rpcId: 'q1', answers: [{ id: 'x', custom: '我输入了一半' }] }] }
const second = { approvals: [], questions: [{ rpcId: 'q1', answers: [] }] }
const merged = mergePending(first, second)
assert.equal(merged.questions[0].answers[0].custom, '我输入了一半')
ok('merging keeps an answer the host snapshot came back empty')

const fresh = mergePending(first, { approvals: [], questions: [{ rpcId: 'q2', answers: [] }] })
assert.equal(fresh.questions[0].answers.length, 0)
ok('a genuinely new question starts empty')
assert.equal(mergePending(null, second).questions.length, 1)
ok('merging from nothing works')

const MP_SRC = process.env.MP_SRC
if (MP_SRC && existsSync(join(MP_SRC, 'lib', 'constants.js'))) {
  section('与 dsh-mobile-plus 源码比对')
  const host = readFileSync(join(MP_SRC, 'lib', 'constants.js'), 'utf8')

  const hostPfx = /export const PREFIX = '([^']+)'/.exec(host)
  assert.ok(hostPfx, 'host declares PREFIX')
  assert.equal(hostPfx[1], PREFIX, 'PREFIX must equal the host value')
  ok('PREFIX matches the host')

  const hostCookie = /export const COOKIE = '([^']+)'/.exec(host)
  assert.ok(hostCookie, 'host declares COOKIE')
  assert.equal(hostCookie[1], COOKIE, 'COOKIE must equal the host value')
  ok('COOKIE matches the host')

  const hostList = host.slice(host.indexOf('ALLOW = new Set(['), host.indexOf('])', host.indexOf('ALLOW')))
  const hostMethods = [...hostList.matchAll(/'([\w.]+)'/g)].map((m) => m[1])
  assert.deepEqual(ALLOW, hostMethods, '白名单名字与顺序必须与宿主完全一致')
  ok(`all ${ALLOW.length} methods match the host, in order`)

  const hostBody = /export const MAX_BODY = ([^\n]+)/.exec(host)
  assert.ok(hostBody, 'host declares MAX_BODY')
  assert.ok(/^[\d\s*]+$/.test(hostBody[1]), 'MAX_BODY is a plain arithmetic expression')
  assert.equal(eval(hostBody[1].trim()), MAX_BODY, 'MAX_BODY must equal the host value')
  ok('MAX_BODY matches the host')
} else {
  console.log('\n(跳过跨端比对：设 MP_SRC=/path/to/dsh-mobile-plus)')
}

console.log(`\n${n} 项 mp 契约断言通过`)
