import { createTurnAnnouncer, TURN_SETTLE_MS } from '../lib/hw-push.mjs'

const results = []
function ok(name, cond, extra) { results.push({ name, pass: !!cond, extra: extra || '' }) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  ok('默认静默窗口 15 秒（对齐 DSH-Mizar DEFAULT_SETTLE_MS）', TURN_SETTLE_MS === 15000, String(TURN_SETTLE_MS))

  const sent = []
  let sessions = [{ id: 's1', title: '会话一', running: false, updatedAt: 100 }]
  const ctx = {
    readSessions: () => Promise.resolve(JSON.parse(JSON.stringify(sessions))),
    readTokens: () => ['tok'],
    ready: () => true,
    allowNoTokens: false,
    settleMs: 60,
    log: () => {},
    send: (o) => { sent.push({ title: o.title, sessionId: o.sessionId, test: o.test }); return Promise.resolve({ ok: true, count: 1 }) }
  }
  const a = createTurnAnnouncer(ctx)

  a.ping('s1')
  await sleep(120)
  ok('turn/end 静默满 ⇒ 推一条', sent.length === 1 && sent[0].sessionId === 's1', JSON.stringify(sent))
  ok('推送标题沿用「」生成完成 口径', sent[0].title === '「会话一」生成完成', sent[0] && sent[0].title)
  ok('正式消息不走测试通道', sent[0].test === false, String(sent[0].test))

  a.ping('s1')
  await sleep(120)
  ok('同一 updatedAt 去重，不重复推', sent.length === 1, String(sent.length))

  sessions = [{ id: 's1', title: '会话一', running: false, updatedAt: 200 }]
  a.ping('s1')
  await sleep(120)
  ok('updatedAt 变了（真又跑一轮）⇒ 再推一次', sent.length === 2, String(sent.length))

  sessions = [{ id: 's2', title: '会话二', running: false, updatedAt: 300 }]
  a.ping('s2'); a.hold('s2'); a.ping('s2')
  await sleep(120)
  ok('多轮合并：hold 撤膛后重新 ping 仍只推一条', sent.length === 3 && sent[2].sessionId === 's2', JSON.stringify(sent.slice(2)))

  sessions = [{ id: 's3', title: '会话三', running: true, updatedAt: 400 }]
  a.ping('s3')
  await sleep(120)
  ok('回查仍 running ⇒ 不推', sent.length === 3, String(sent.length))
  sessions = [{ id: 's3', title: '会话三', running: false, updatedAt: 401 }]
  await sleep(120)
  ok('下一轮回查翻 false ⇒ 补推', sent.length === 4 && sent[3].sessionId === 's3', JSON.stringify(sent.slice(3)))

  a.ping('gone')
  await sleep(120)
  ok('列表里找不到的会话不推', sent.length === 4, String(sent.length))

  const sent2 = []
  const a2 = createTurnAnnouncer(Object.assign({}, ctx, { ready: () => false, send: (o) => { sent2.push(o.sessionId); return Promise.resolve({ ok: true, count: 1 }) } }))
  sessions = [{ id: 's4', title: '会话四', running: false, updatedAt: 500 }]
  a2.ping('s4')
  await sleep(120)
  ok('ready 假 ⇒ 一条都不发', sent2.length === 0, JSON.stringify(sent2))

  a.stop(); a2.stop()
  const bad = results.filter((r) => !r.pass)
  for (const r of results) console.log((r.pass ? '  ✓ ' : '  ✗ ') + r.name + (r.pass ? '' : '  ← ' + r.extra))
  console.log(bad.length === 0 ? 'turn-announcer: 全部通过 ✓' : 'turn-announcer: ' + bad.length + ' 条失败')
  process.exit(bad.length === 0 ? 0 : 1)
}
run().catch((e) => { console.log('异常: ' + (e && e.message)); process.exit(1) })
