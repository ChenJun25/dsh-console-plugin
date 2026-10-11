/**
 * 端到端接线测试 —— 用真正的 startLanServer 跑一遍客户端的完整流程。
 *
 * 前面的测试都是分段验的（契约 / 分发 / 挂载各测各的）。这里把它们拼起来，
 * 因为真正的风险恰恰在接缝上：mp.branch 到底有没有被 handler 调用、
 * 配对码是不是真的复用了面板那一个、WS 升级有没有挂上。
 */
import assert from 'node:assert/strict'
import { startLanServer } from '../lib/lan-server.mjs'
import { attachMp } from '../lib/mp-support.mjs'

let n = 0
const ok = (t) => { n++; console.log('  ok - ' + t) }
const section = (t) => console.log('\n' + t)
const noop = () => {}

/**
 * 起一套完整的：假 ctx + 真的 lan-server + 真的 mp 接线，
 * 走 index.js 里那几行的同一条路径。
 */
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
    port: 0,               // 0 = 让系统分配，避免撞上真的 8899
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
    // lan.urls carry the /dsh-console prefix that the panel is served under;
    // the mp routes are on the bare origin, so talk to loopback directly.
    base: 'http://127.0.0.1:' + info.port,
    code: lan.peekPairCode(),
    stop: async () => { mp.dispose(); lan.stop() },
  }
}

/* ---------------- 完整客户端流程 ---------------- */
section('客户端完整流程')

{
  const b = await boot()
  try {
    // 1. 未配对时必须被挡住 —— 这是配对页存在的理由。
    const blocked = await fetch(b.base + '/mp/pair/status', { headers: { Cookie: 'mp_device=nope' } })
    assert.equal(blocked.status, 403)
    ok('an unpaired device is refused before anything else')

    // 2. 用面板上显示的那个 6 位码配对 —— 必须是同一个码。
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

    // 3. 配对后 status 通过。
    const st = await fetch(b.base + '/mp/pair/status', { headers: { Cookie: cookie } })
    assert.equal((await st.json()).paired, true)
    ok('the paired device passes the status check')

    // 4. 拉会话列表。
    const list = await fetch(b.base + '/mp/api/session.list', {
      method: 'POST', headers: { Cookie: cookie },
      body: JSON.stringify({ rpcId: 'r1', payload: {} }),
    })
    const body = await list.json()
    assert.equal(body.result.ok, true)
    assert.equal(body.result.value.items[0].sessionId, 's1')
    assert.equal(body.result.value.items[0].title, '测试会话')
    ok('the session list loads through the mp contract')

    // 5. 拉历史。
    const hist = await fetch(b.base + '/mp/api/session.history', {
      method: 'POST', headers: { Cookie: cookie },
      body: JSON.stringify({ rpcId: 'r2', payload: { sessionId: 's1', maxMessages: 20 } }),
    })
    assert.equal((await hist.json()).result.value.events.length, 1)
    ok('history loads through the mp contract')

    // 6. 发消息。
    const send = await fetch(b.base + '/mp/api/session.prompt', {
      method: 'POST', headers: { Cookie: cookie },
      body: JSON.stringify({ rpcId: 'r3', payload: { sessionId: 's1', content: [{ type: 'text', text: '在吗' }] } }),
    })
    assert.equal((await send.json()).result.ok, true)
    assert.equal(b.events.length, 1, 'the host actually received the prompt')
    assert.equal(b.events[0][1].content[0].text, '在吗')
    ok('a prompt reaches the host with its content intact')

    // 7. 面板那条路没被弄坏。
    const panel = await fetch(b.base + '/info', { headers: { 'x-dsh-console-token': 'tok' } })
    assert.equal(panel.status, 200)
    ok('the existing panel route still works after the mp branch went in')
  } finally {
    await b.stop()
  }
}

/* ---------------- 审批事件接线 ---------------- */
section('审批事件接线')

{
  const b = await boot()
  try {
    const pair = await fetch(b.base + '/mp/pair/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: b.code }),
    })
    const cookie = pair.headers.get('set-cookie').split(';')[0]

    // 宿主发一道审批 —— 客户端轮询必须能看到它。
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

    // 回审批后应从快照里消失。
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

    // 提问同理，并且要带上正确的 kind。
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

/* ---------------- 重复配对与撤销 ---------------- */
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
    // 面板的码是一次性的：用过就作废。所以这里换两次要用两次 ensure。
    const c1 = await mk(b.code)
    assert.ok(c1, 'first pairing works')
    b.lan.getPairCode()   // 重新生成一个新码
    const c2 = await mk(b.lan.peekPairCode())
    assert.ok(c2, 'a fresh code pairs again')
    assert.notEqual(c1, c2, 'each pairing gets its own secret')
    ok('two pairings produce two independent secrets')

    // 撤销第一个设备后，它不该再能用。
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

console.log(`\n${n} 项端到端断言通过`)
