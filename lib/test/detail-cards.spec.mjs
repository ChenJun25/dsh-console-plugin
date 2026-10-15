/**
 * 第 191 节 · 用户 m00001 · task-C：detail 每轮 turn 的两个**后补**字段
 *   changes = { turn, files:[{path,added,deleted,binary?,oversized?}], total, added, deleted } | null
 *   files   = [ { path, description, seq, index } ] | null
 *
 * App 端消费契约（D:/dsh-console-hm Session.ets:7541 / :7578）：
 *   changes 只读 turn/files/total/added/deleted（binary/oversized 多给无害）；
 *   files 每项**四键一个都不能少**（path/description/seq/index）。
 * 两个字段是「后补」的 —— 老客户端读到 undefined 无感，所以：
 *   🔴 键一定在（没有就是 null，绝不让 undefined 漏出去）；
 *   🔴 取数任何异常都不许把 detail 打成 500（手机端整页红字比没有卡严重得多）。
 *
 * 数据源分两路（这点最容易搞错）：
 *   changes ← 宿主进程内 ctx.get('workspaceChanges').summary(sid, turn.seq)
 *   files   ← **会话日志**里的事件 deliverables/presented（与 page/history 窗口不是一份）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** 照抄 todo-projection.spec.mjs 的范式；额外支持 workspaceChanges / sessions 两个可选服务。 */
async function detailOf(opts) {
  const o = opts || {}
  const asOfSeq = o.asOfSeq === undefined ? 100 : o.asOfSeq
  const seen = []
  let cmdFetch = null
  const conn = { fetch: { register: (r) => { if (r.path === '/api/dsh-console/cmd') cmdFetch = r.fetch; return () => {} } } }
  const ctl = {
    projections: async () => ({ asOfSeq, values: { title: 't', turnOutline: o.turnOutline || [] } }),
    list: async () => ({ items: [] }),
  }
  if (o.events) ctl.page = async () => ({ records: o.events.map((e) => ({ type: 'event', event: e })) })
  const ctx = {
    get: (n) => {
      if (n === 'connection') return conn
      if (n === 'sessionController') return ctl
      if (n === 'sessions') return o.sessions === undefined ? null : o.sessions
      if (n === 'workspaceChanges') {
        if (o.wc === 'throw') throw new Error('老宿主没有这个服务')
        if (!o.wc) return null
        return {
          summary: (sessionId, seq) => {
            seen.push([sessionId, seq])
            if (o.wcSummary) return o.wcSummary(sessionId, seq)
            return seq <= 5
              ? {
                turn: 1,
                cwd: 'C:/work',                       /* 🔴 宿主字段，绝不许下发 */
                snapshot: { before: 'a', after: 'b' }, /* 🔴 同上 */
                files: [
                  { path: 'src/a.ts', display: 'a.ts', added: 12, deleted: 3 },
                  { path: '', display: '空路径', added: 1, deleted: 0 },
                  { path: 'bin/x.png', display: 'x.png', added: 0, deleted: 0, binary: true },
                  { path: 'big.bin', display: 'big.bin', added: 5, deleted: 5, oversized: true },
                ],
                total: 4, added: 18, deleted: 8,
              }
              : undefined
          },
        }
      }
      return null
    },
    on: () => () => {},
    effect: () => () => {},
  }
  const mod = await import('../index.js?t=' + Math.random())
  mod.apply(ctx, { port: 0 })
  const r = await cmdFetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: 's' } }) }))
  const body = await r.json()
  return { status: r.status, body, result: body.result || {}, seen }
}

/** 两轮正文（**不含** presented —— 交付事件按生产实际放在会话日志里）。 */
function pageEvents() {
  return [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { turn: 1, content: [{ type: 'text', text: '第一轮' }] } },
    { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '一号答复' }] } } },
    { type: 'turn/end', seq: 5, time: 5, data: { turn: 1 } },
    { type: 'turn/start', seq: 6, time: 6, data: { turn: 2 } },
    { type: 'user/message', seq: 7, time: 7, data: { turn: 2, content: [{ type: 'text', text: '第二轮' }] } },
    { type: 'assistant/message', seq: 8, time: 8, data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '二号答复' }] } } },
    { type: 'turn/end', seq: 10, time: 10, data: { turn: 2 } },
  ]
}

/** 会话日志（sessions.get('s') → { log })：presented 事件按生产实际落在这里。 */
function sessWith(deliverEvents) {
  return new Map([['s', { log: deliverEvents }]])
}

test('① 每轮挂 changes/files：空路径丢弃、cwd/snapshot 不下发、拿不到的轮为 null', async () => {
  const d = await detailOf({
    events: pageEvents(),
    sessions: sessWith([
      { type: 'deliverables/presented', seq: 4, time: 4, data: { turn: 1, files: [{ path: '/tmp/one.txt', description: '一号交付' }] } },
      { type: 'deliverables/presented', seq: 9, time: 9, data: { turn: 2, files: [
        { path: '/tmp/two.txt', description: '二号交付' },
        { path: '   ', description: '空路径项必须丢' },
        { path: '/tmp/three.txt' },                                   /* 没有 description */
      ] } },
    ]),
    wc: true,
  })
  assert.equal(d.status, 200, 'detail 必须 200')
  assert.equal(d.result.turns.length, 2, '前置条件：应折出 2 轮')
  const t1 = d.result.turns[0]
  const t2 = d.result.turns[1]

  /* --- changes：白名单字段 + 空路径丢弃 + 宿主字段不外泄 --- */
  assert.deepEqual(t1.changes, {
    turn: 1,
    files: [
      { path: 'src/a.ts', added: 12, deleted: 3 },
      { path: 'bin/x.png', added: 0, deleted: 0, binary: true },
      { path: 'big.bin', added: 5, deleted: 5, oversized: true },
    ],
    total: 4, added: 18, deleted: 8,
  }, 'changes 形状/内容不对（空路径要丢、binary/oversized 只在 true 时出现）')
  assert.equal('cwd' in t1.changes, false, '🔴 cwd 是宿主内部字段，绝不许下发')
  assert.equal('snapshot' in t1.changes, false, '🔴 snapshot 可能含整份 diff，绝不许下发')
  assert.equal(t1.changes.files.length, 3, '4 项里那条空路径必须被丢掉')
  assert.equal(t2.changes, null, 'summary 取不到（undefined）⇒ 必须是 null，不能是 undefined')

  /* --- files：四键齐全、空路径丢弃、description 缺省为 '' --- */
  assert.deepEqual(t1.files, [{ path: '/tmp/one.txt', description: '一号交付', seq: 4, index: 0 }], '第 1 轮交付卡不对')
  assert.deepEqual(t2.files, [
    { path: '/tmp/two.txt', description: '二号交付', seq: 9, index: 0 },
    { path: '/tmp/three.txt', description: '', seq: 9, index: 1 },
  ], '第 2 轮交付卡不对（空路径项要丢、description 缺省成空串、index 离散重排）')
  for (const f of t2.files) {
    assert.deepEqual(Object.keys(f).sort(), ['description', 'index', 'path', 'seq'], 'files 项必须四键齐全（App 逐键读）')
  }

  /* --- 既有字段一个都不能少 --- */
  for (const k of ['ok', 'sessionId', 'title', 'turns', 'turnCount', 'todos', 'stats', 'token', 'context']) {
    assert.ok(k in d.result, '既有字段丢了：' + k)
  }
  assert.equal(d.result.turnCount, 2)
})

test('② 没有 presented 事件 ⇒ files 每轮都是 null（键仍在，不是 undefined）', async () => {
  const d = await detailOf({ events: pageEvents(), sessions: sessWith([]), wc: true })
  assert.equal(d.status, 200)
  for (const t of d.result.turns) {
    assert.ok('files' in t, 'files 键必须一定在')
    assert.equal(t.files, null, '没有交付事件就该是 null')
    assert.notEqual(t.files, undefined)
  }
})

test('③ 老宿主：ctx.get("workspaceChanges") 抛错 ⇒ changes 全 null，detail 仍 200', async () => {
  const d = await detailOf({ events: pageEvents(), sessions: sessWith([]), wc: 'throw' })
  assert.equal(d.status, 200, '🔴 拿不到服务绝不许把 detail 打成 500')
  assert.equal(d.result.ok, true)
  for (const t of d.result.turns) assert.equal(t.changes, null, '服务抛错 ⇒ null')
})

test('④ summary() 自己抛错 ⇒ changes 全 null，detail 仍 200', async () => {
  const d = await detailOf({
    events: pageEvents(),
    sessions: sessWith([]),
    wc: true,
    wcSummary: () => { throw new Error('summary 内部炸了') },
  })
  assert.equal(d.status, 200, '🔴 summary 抛错必须在插件侧吞掉')
  for (const t of d.result.turns) assert.equal(t.changes, null)
})

test('⑤ 没有 sessions 服务（老宿主 / 无日志）⇒ files 全 null，不抛错', async () => {
  const d = await detailOf({ events: pageEvents(), wc: true })
  assert.equal(d.status, 200, '🔴 ctx.get("sessions") 拿不到也绝不许 500')
  for (const t of d.result.turns) {
    assert.equal(t.files, null, '拿不到日志 ⇒ files 一律 null')
    assert.ok('changes' in t, 'files 取不到不影响 changes 的键存在')
  }
  // changes 与日志完全无关：summary 有值的轮照旧有卡（第 1 轮 seq=1 ⇒ 命中）
  assert.ok(d.result.turns[0].changes, 'changes 与 sessions 无关，该有值的轮仍要有')
})

test('⑥ 交付事件能落在**当前轮**：presented 的 seq 决定归属轮', async () => {
  const d = await detailOf({
    events: pageEvents(),
    sessions: sessWith([
      { type: 'deliverables/presented', seq: 11, time: 11, data: { turn: 2, files: [{ path: '/tmp/late.txt', description: '晚到的' }] } },
    ]),
    wc: true,
  })
  assert.equal(d.status, 200)
  assert.equal(d.result.turns[0].files, null, '末轮之后的事件不该串到第 1 轮')
  assert.deepEqual(d.result.turns[1].files, [{ path: '/tmp/late.txt', description: '晚到的', seq: 11, index: 0 }], '归属算错了')
})

test('⑦ 概要通道（没有 page/history）也带两个键：changes 照挂、files 为 null', async () => {
  const d = await detailOf({
    turnOutline: [{ turn: 1, seq: 2, prompt: '问', response: '答' }],
    wc: true,
  })
  assert.equal(d.status, 200)
  assert.equal(d.result.turns.length, 1, '前置条件：走概要投影')
  const t = d.result.turns[0]
  assert.ok('changes' in t && 'files' in t, '概要通道两个键也必须都在')
  assert.equal(t.files, null, '概要通道没有事件流 ⇒ files = null')
})

test('⑧ change 事件 seq 优先于轮首 seq：宿主把摘要挂在轮末那条 workspace/changes 上', async () => {
  /* 🩸 第 198 节回归：生产里宿主 summary(sid, seq) 只认**改动事件自己**的 seq（轮末），
     而 turn.seq 是轮首事件序号 ⇒ 改前必 undefined ⇒ changes 恒 null。
     这里让 summary 只认 seq === 4 / 9（两条 workspace/changes 事件的 seq），
     若插件仍拿 turn.seq(1 / 6) 去查，两轮都会是 null —— 断言就必须失败。 */
  const d = await detailOf({
    events: pageEvents(),
    sessions: sessWith([
      { type: 'workspace/changes', seq: 4, time: 4, data: { turn: 1 } },
      { type: 'workspace/changes', seq: 9, time: 9, data: { turn: 2 } },
    ]),
    wc: true,
    /* turn 用 100+seq：宿主若给了轮号就优先用它（changesFor 里 Number(s.turn) || tn），
       这样断言能同时证明「摘要来自哪条 change 事件」而不是蒙对了插件轮号。 */
    wcSummary: (sid, seq) => (seq === 4 || seq === 9)
      ? { turn: 100 + seq, files: [{ path: 'f' + seq + '.ts', added: 1, deleted: 0 }], total: 1, added: 1, deleted: 0 }
      : undefined,
  })
  assert.equal(d.status, 200)
  assert.equal(d.result.turns.length, 2, '前置条件：应折出 2 轮')
  const t1 = d.result.turns[0]
  const t2 = d.result.turns[1]
  assert.deepEqual(t1.changes, { turn: 104, files: [{ path: 'f4.ts', added: 1, deleted: 0 }], total: 1, added: 1, deleted: 0 },
    '第 1 轮：应按 seq=4 那条 change 事件取摘要（拿轮首 seq 去查会得到 null）')
  assert.deepEqual(t2.changes, { turn: 109, files: [{ path: 'f9.ts', added: 1, deleted: 0 }], total: 1, added: 1, deleted: 0 },
    '第 2 轮：应按 seq=9 那条 change 事件取摘要（拿轮首 seq 去查会得到 null）')
  /* 每轮一条 change 事件 ⇒ 各查一次；绝不能拿轮首 seq 去查 */
  assert.deepEqual(d.seen.map((x) => x[1]).sort((a, b) => a - b), [4, 9], '查询用的 seq 必须来自日志里的 change 事件')
})

test('⑨ 一轮有多条 change 事件 ⇒ 取该轮 seq 最大那条；无 change 事件 ⇒ 退回轮首 seq 老行为', async () => {
  const seenSeqs = []
  const d = await detailOf({
    events: pageEvents(),
    sessions: sessWith([
      { type: 'workspace/changes', seq: 4, time: 4, data: { turn: 1 } },
      { type: 'workspace/changes', seq: 5, time: 5, data: { turn: 1 } },
      /* 干扰项：缺 turn / turn=0 / seq 非法的都不该被收进来（判据照抄宿主 isChangesEvent） */
      { type: 'workspace/changes', seq: 3, time: 3, data: {} },
      { type: 'workspace/changes', seq: 0, time: 3, data: { turn: 1 } },
      { type: 'deliverables/presented', seq: 8, time: 8, data: { turn: 2, files: [] } },
    ]),
    wc: true,
    wcSummary: (sid, seq) => { seenSeqs.push(seq); return { turn: 0, files: [], total: 0, added: 0, deleted: 0 } },
  })
  assert.equal(d.status, 200)
  /* 第 2 轮的 turn.seq = 7：轮是挂在 user/message(seq=7) 上建的，不是 turn/start(seq=6)。 */
  assert.deepEqual(seenSeqs.sort((a, b) => a - b), [5, 7],
    '第 1 轮取 seq=5（同轮多条取最大），第 2 轮没有 change 事件 ⇒ 退回该轮 turn.seq=7')
})

test('⑩ 拿不到 sessions 服务 ⇒ change 事件表为空，changes 退回轮首 seq（不 500）', async () => {
  const d = await detailOf({ events: pageEvents(), wc: true })   /* 不传 sessions */
  assert.equal(d.status, 200)
  assert.ok(d.result.turns[0].changes, '退回老行为：seq=1 ⇒ 命中（summary 只认 seq<=5）')
  assert.equal(d.result.turns[1].changes, null, 'seq=6 ⇒ 老行为命中不了 = null')
})
