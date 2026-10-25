import assert from 'node:assert/strict'
import { startLanServer } from '../lib/lan-server.mjs'
import { attachMp } from '../lib/mp-support.mjs'

let n = 0
const ok = (t) => { n++; console.log('  ok - ' + t) }
const section = (t) => console.log('\n' + t)
const noop = () => {}

async function boot() {
  const events = []
  const listeners = new Map()
  const sessions = [{
    sessionId: 's1', title: '测试会话', cwd: 'C:/w', updatedAt: 100, running: false,
  }]
  const ctl = {
    async list() { return { items: sessions } },
    async history() { return { events: [{ seq: 1, type: 'user/message' }], maxSeq: 1 } },
    async prompt(req) { events.push(['prompt', req]); return { accepted: true } },
    async cancel() { return { cancelled: true } },
    async modelCatalog() { return { items: [] } },
    async commands() { return { items: [] } },
  }
  const ctx = {
    get: (k) => (k === 'sessionController' ? ctl : null),
    on: (evt, fn) => {
      if (!listeners.has(evt)) listeners.set(evt, [])
      listeners.get(evt).push(fn)
      return () => {
        const arr = listeners.get(evt) || []
        const i = arr.indexOf(fn)
        if (i !== -1) arr.splice(i, 1)
      }
    },
  }
  const emit = (evt, ...args) => {
    for (const fn of listeners.get(evt) || []) fn(...args)
  }

  const lan = startLanServer({
    port: 0,
    allowShift: true,
    getToken: () => 'tok',
    getInfo: () => ({ name: 'n', nodeId: 'x', host: 'h', dshOk: true, version: '0.5.0' }),
    listSessions: async () => sessions,
    runCommand: async () => ({}),
    log: noop,
  })
  const info = await lan.start()
  const mp = attachMp(ctx, {
    log: noop,
    config: {},
    isPairCode: (code) => code === lan.peekPairCode(),
  })
  lan.setMp({ branch: mp.branch, onUpgrade: null })

  return {
    lan, mp, emit, events, info,

    listeners,

    base: 'http://127.0.0.1:' + info.port,
    code: lan.peekPairCode(),
    stop: async () => { mp.dispose(); lan.stop() },
  }
}

section('客户端完整流程')

{
  const b = await boot()
  try {

    const blocked = await fetch(b.base + '/mp/pair/status', { headers: { Cookie: 'mp_device=nope' } })
    assert.equal(blocked.status, 403)
    ok('an unpaired device is refused before anything else')

    assert.ok(/^\d{6}$/.test(b.code), 'the panel code is six digits: ' + b.code)
    const pair = await fetch(b.base + '/mp/pair/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: b.code }),
    })
    assert.equal(pair.status, 200, 'the panel code is accepted for mp pairing')
    const cookie = pair.headers.get('set-cookie').split(';')[0]
    assert.ok(cookie.startsWith('mp_device='))
    ok('the same code shown on the panel also yields an mp_device cookie')

    const st = await fetch(b.base + '/mp/pair/status', { headers: { Cookie: cookie } })
    assert.equal((await st.json()).paired, true)
    ok('the paired device passes the status check')

    const list = await fetch(b.base + '/mp/api/session.list', {
      method: 'POST', headers: { Cookie: cookie },
      body: JSON.stringify({ rpcId: 'r1', payload: {} }),
    })
    const body = await list.json()
    assert.equal(body.result.ok, true)
    assert.equal(body.result.value.items[0].sessionId, 's1')
    assert.equal(body.result.value.items[0].title, '测试会话')
    ok('the session list loads through the mp contract')

    const hist = await fetch(b.base + '/mp/api/session.history', {
      method: 'POST', headers: { Cookie: cookie },
      body: JSON.stringify({ rpcId: 'r2', payload: { sessionId: 's1', maxMessages: 20 } }),
    })
    assert.equal((await hist.json()).result.value.events.length, 1)
    ok('history loads through the mp contract')

    const send = await fetch(b.base + '/mp/api/session.prompt', {
      method: 'POST', headers: { Cookie: cookie },
      body: JSON.stringify({ rpcId: 'r3', payload: { sessionId: 's1', content: [{ type: 'text', text: '在吗' }] } }),
    })
    assert.equal((await send.json()).result.ok, true)
    assert.equal(b.events.length, 1, 'the host actually received the prompt')
    assert.equal(b.events[0][1].content[0].text, '在吗')
    ok('a prompt reaches the host with its content intact')

    const panel = await fetch(b.base + '/info', { headers: { 'x-dsh-console-token': 'tok' } })
    assert.equal(panel.status, 200)
    ok('the existing panel route still works after the mp branch went in')
  } finally {
    await b.stop()
  }
}

section('审批事件接线')

{
  const b = await boot()
  try {
    const pair = await fetch(b.base + '/mp/pair/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: b.code }),
    })
    const cookie = pair.headers.get('set-cookie').split(';')[0]

    b.emit('approval/request', {
      approvalId: 'a1', rpcId: 'q1', sessionId: 's1', toolName: 'fs.write', callId: 'c1', reason: '要写文件',
    })
    const snap = await (await fetch(b.base + '/mp/api/mobile.pending', {
      method: 'POST', headers: { Cookie: cookie },
      body: JSON.stringify({ rpcId: 'r', payload: { sessionId: 's1' } }),
    })).json()
    assert.equal(snap.result.value.approvals.length, 1, 'the approval shows up in the poll')
    assert.equal(snap.result.value.approvals[0].toolName, 'fs.write')
    ok('a host approval request becomes visible to the polling client')

    const replied = await (await fetch(b.base + '/mp/api/mobile.respond', {
      method: 'POST', headers: { Cookie: cookie },
      body: JSON.stringify({ rpcId: 'r', payload: { sessionId: 's1', type: 'approval', approvalId: 'a1', outcome: 'allow' } }),
    })).json()
    assert.equal(replied.result.ok, true)
    const after = await (await fetch(b.base + '/mp/api/mobile.pending', {
      method: 'POST', headers: { Cookie: cookie },
      body: JSON.stringify({ rpcId: 'r', payload: {} }),
    })).json()
    assert.equal(after.result.value.approvals.length, 0, 'it is gone once answered')
    ok('answering an approval removes it from the snapshot')

    b.emit('user-questions/request', {
      rpcId: 'q9', sessionId: 's1',
      questions: [{ id: 'x', question: '继续吗', intent: { kind: 'plan-review' }, detail: '计划正文', options: [{ label: 'approve' }] }],
    })
    const qs = await (await fetch(b.base + '/mp/api/mobile.pending', {
      method: 'POST', headers: { Cookie: cookie },
      body: JSON.stringify({ rpcId: 'r', payload: {} }),
    })).json()
    assert.equal(qs.result.value.questions[0].kind, 'plan-review', 'plan-review is classified as such')
    ok('a plan-review question is classified with the host rule')

    const q = await (await fetch(b.base + '/mp/api/mobile.respond', {
      method: 'POST', headers: { Cookie: cookie },
      body: JSON.stringify({ rpcId: 'r', payload: { sessionId: 's1', type: 'question', rpcId: 'q9', answers: [{ id: 'x', selected: ['approve'] }] } }),
    })).json()
    assert.equal(q.result.ok, true)
    ok('answering a question is accepted')
  } finally {
    await b.stop()
  }
}

section('配对生命周期')

{
  const b = await boot()
  try {
    const mk = async (token) => {
      const r = await fetch(b.base + '/mp/pair/accept', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      return r.status === 200 ? r.headers.get('set-cookie').split(';')[0] : null
    }

    const c1 = await mk(b.code)
    assert.ok(c1, 'first pairing works')
    b.lan.getPairCode()
    const c2 = await mk(b.lan.peekPairCode())
    assert.ok(c2, 'a fresh code pairs again')
    assert.notEqual(c1, c2, 'each pairing gets its own secret')
    ok('two pairings produce two independent secrets')

    const rev = await fetch(b.base + '/mp/pair/revoke', { method: 'POST', headers: { Cookie: c1 } })
    assert.equal(rev.status, 200)
    const after = await fetch(b.base + '/mp/api/session.list', {
      method: 'POST', headers: { Cookie: c1 }, body: JSON.stringify({ rpcId: 'r', payload: {} }),
    })
    assert.equal(after.status, 403, 'a revoked device loses access')
    const still = await fetch(b.base + '/mp/api/session.list', {
      method: 'POST', headers: { Cookie: c2 }, body: JSON.stringify({ rpcId: 'r', payload: {} }),
    })
    assert.equal(still.status, 200, 'the other device is unaffected')
    ok('revoking one device leaves the other one working')
  } finally {
    await b.stop()
  }
}

section('手机答复必须放掉宿主那一环（电脑端卡片摘除）')

{
  const b = await boot()
  try {
    const pair = await fetch(b.base + '/mp/pair/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: b.code }),
    })
    const cookie = pair.headers.get('set-cookie').split(';')[0]

    const host = (evt, req, next) => {
      const fns = b.listeners.get(evt) || []
      assert.ok(fns.length >= 1, 'the mp listener subscribed ' + evt)
      return fns.map((fn) => fn(req, next))
    }

    const req = {
      rpcId: 'q10', sessionId: 's1',
      questions: [{ id: 'x', question: '继续吗', intent: { kind: 'plan-review' }, detail: '计划正文', options: [{ label: 'approve' }] }],
    }
    let hostRuns = 0
    const pending = host('user-questions/request', req, () => { hostRuns++; return new Promise(() => {}) })[0]
    assert.ok(pending && typeof pending.then === 'function', 'mp claims the host waterfall with a Promise')
    assert.equal(hostRuns, 1, 'the host chain is still released (the desktop card still appears)')
    assert.equal(req.signal === undefined ? false : req.signal.aborted, false, 'nothing is cancelled before the phone answers')

    const replied = await (await fetch(b.base + '/mp/api/mobile.respond', {
      method: 'POST', headers: { Cookie: cookie },
      body: JSON.stringify({ rpcId: 'r', payload: { sessionId: 's1', type: 'question', rpcId: 'q10', answers: [{ id: 'x', selected: ['approve'] }] } }),
    })).json()
    assert.equal(replied.result.ok, true)
    const got = await pending
    assert.deepEqual(got, { answers: [{ id: 'x', selected: ['approve'] }] }, 'the phone answer settles our own ring')
    assert.ok(req.signal !== undefined, 'a claimed question request carries a signal the plugin owns')
    assert.equal(req.signal.aborted, true, 'after the phone answers, that signal is aborted so the desktop chain can finish')
    ok('a phone answer releases the host ring instead of leaving the desktop card hanging')

    const req2 = { rpcId: 'q11', sessionId: 's1', questions: [{ id: 'y', question: '走吗', options: [{ label: 'go' }] }] }
    const hostValue = { answers: [{ id: 'y', selected: ['go'] }] }
    const done = host('user-questions/request', req2, () => Promise.resolve(hostValue))[0]
    assert.deepEqual(await done, hostValue, 'the host answer wins when it arrives first')
    assert.equal(req2.signal === undefined ? false : req2.signal.aborted, false, 'a host-side answer cancels nothing')
    ok('a host-side answer is passed through untouched')

    const ctrl = new AbortController()
    const reqA = { approvalId: 'a9', rpcId: 'q12', sessionId: 's1', toolName: 'fs.write', callId: 'c9', reason: '要写文件', signal: ctrl.signal }
    const pendA = host('approval/request', reqA, () => new Promise(() => {}))[0]
    assert.equal(reqA.signal, ctrl.signal, 'the approval signal object is left exactly as the host sent it')
    const repA = await (await fetch(b.base + '/mp/api/mobile.respond', {
      method: 'POST', headers: { Cookie: cookie },
      body: JSON.stringify({ rpcId: 'r', payload: { sessionId: 's1', type: 'approval', approvalId: 'a9', outcome: 'allow' } }),
    })).json()
    assert.equal(repA.result.ok, true)
    assert.equal(await pendA, 'allowed-once', 'the phone answer settles the approval ring')
    assert.equal(ctrl.signal.aborted, false, 'answering an approval must never abort the calling turn')
    ok('an approval answer never touches the calling turn signal')
  } finally {
    await b.stop()
  }
}

console.log(`\n${n} 项端到端断言通过`)
