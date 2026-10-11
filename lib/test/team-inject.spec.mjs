/**
 * task-6 单测（插件半）：
 *   ① #A6 顺带 —— 会话 title 剥掉 DSH 注入壳（<system-reminder>）。
 *      真机实测：36 个会话里 21 个子会话的 title 直接就是注入原文，
 *      手机抽屉/二级页会显示一整段「You are teammate ...」。
 *      列表通道 norm() 与详情通道 readDetail() 两条出口都要剥。
 *   ② #A7 —— agentTeam 团队投影下发（members / tasks 逐字段归一 + 上限 +
 *      形状不认识回 null，客户端据此显示「暂无团队」而不是红屏）。
 *
 * 跑法：node lib/test/team-inject.spec.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

// 真机原文形状（子智能体会话的 title 长这样）
const REMINDER = '<system-reminder>\nYou are teammate "plugin-inject".\n' +
  'Your Team Lead is named "lead".\n</system-reminder>'
// 普通标题里也有 '<'，但没命中 image/ 或 ' px,' ⇒ 不许误杀
const PLAIN = '第 110 节 · 文档里写 <content> 标签要转义'

function teamFixture() {
  return {
    members: [
      { id: 'lead', name: 'lead', role: 'lead', phase: 'active' },
      { id: 'task-5', name: 'session-panel', role: 'teammate', phase: 'running', error: '' },
      { name: '没有 id 的脏成员', role: 'teammate', phase: 'active' }
    ],
    tasks: [
      { id: 'task-6', revision: 3, subject: 's'.repeat(300), description: 'd'.repeat(700),
        status: 'in_progress', blockedBy: ['task-2'], writeScopes: ['lib/'],
        ready: true, writeScopeWarnings: [] },
      { id: 'task-7', revision: '7', subject: 't', description: 't', status: 'pending',
        blockedBy: [], writeScopes: [], ready: 1, writeScopeWarnings: [], ownerName: 'x'.repeat(100) },
      { subject: '没有 id 的脏任务' }
    ],
    failure: 'f'.repeat(400)
  }
}

function mockCtl(opt = {}) {
  return {
    projections: async () => ({ asOfSeq: 9, values: opt.values || {} }),
    page: async () => ({ records: [] }),
    list: async () => ({ items: opt.items || [] }),
    modelCatalog: async () => ({})
  }
}

function mockCtx(ctl) {
  const routes = {}
  const conn = { fetch: { register: (route) => { routes[route.path] = route; return () => {} } } }
  const handlers = {}
  const ctx = {
    get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : null),
    on: (evt, fn) => { handlers[evt] = fn; return () => {} },
    effect: () => () => {}
  }
  return { ctx, routes, handlers }
}

async function boot(ctl) {
  const { ctx, routes } = mockCtx(ctl)
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  assert.ok(routes['/api/dsh-console/cmd'], 'cmd 路由没注册上')
  return { routes }
}

async function cmd(routes, op, payload) {
  const r = await routes['/api/dsh-console/cmd'].fetch(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ op, payload })
  }))
  return r.json()
}

/* ---------------- ① title 剥壳 ---------------- */

test('#A6 详情通道：title 是 <system-reminder> 原文时被剥成空串', async () => {
  const { routes } = await boot(mockCtl({ values: { title: REMINDER, turnOutline: [] } }))
  const j = await cmd(routes, 'detail', { sessionId: 's-dirty' })
  assert.equal(j.ok, true)
  // 无 subagent 投影 ⇒ 剥壳后仍回空串（第 112 节兜底无 label 可取）
  assert.equal(j.result.title, '', '注入壳整个被剥（客户端 trim 后不画标题）')
  assert.ok(JSON.stringify(j.result).indexOf('system-reminder') < 0, '整个详情载荷里没有注入文本')
})

test('#A6 列表通道：抽屉列表里的 title 同样剥壳', async () => {
  const { routes } = await boot(mockCtl({
    items: [
      { sessionId: 's1', projections: { values: { title: REMINDER } } },
      { sessionId: 's2', projections: { values: { title: PLAIN } } },
      { sessionId: 's3', title: REMINDER }
    ]
  }))
  const j = await cmd(routes, 'sessions', {})
  assert.equal(j.ok, true)
  assert.equal(j.result.length, 3)
  // s1/s3 都没有 subagent 投影 ⇒ 剥壳后仍回空串（不乱编文案）
  assert.equal(j.result[0].title, '', '投影里的脏标题被剥')
  assert.equal(j.result[1].title, PLAIN, '不误杀：普通标题原样保留')
  // s3 也是无 subagent 投影 ⇒ 空串
  assert.equal(j.result[2].title, '', '兜底的 s.title 也走同一条剥壳出口')
  assert.ok(JSON.stringify(j.result).indexOf('system-reminder') < 0, '列表载荷里没有注入文本')
})

/* ---------------- ①b title 兜底子智能体标签（第 112 节） ---------------- */

test('#112 列表通道：脏 title 剥空后兜 subagent.label（wire 形状）', async () => {
  const { routes } = await boot(mockCtl({
    items: [{ sessionId: 's1', projections: { values: {
      title: REMINDER,
      subagent: { mode: 'continuable', label: '插件 lib/ 单 owner', seq: 3 }
    } } }]
  }))
  const j = await cmd(routes, 'sessions', {})
  assert.equal(j.ok, true)
  assert.equal(j.result[0].title, '插件 lib/ 单 owner', '剥空后用标签兜底')
  assert.ok(JSON.stringify(j.result).indexOf('system-reminder') < 0, '载荷里没有注入文本')
})

test('#112 详情通道：脏 title 剥空后兜 subagent.label（wire 形状）', async () => {
  const { routes } = await boot(mockCtl({ values: {
    title: REMINDER,
    turnOutline: [],
    subagent: { mode: 'continuable', label: 'Y', seq: 1 }
  } }))
  const j = await cmd(routes, 'detail', { sessionId: 's-y' })
  assert.equal(j.ok, true)
  assert.equal(j.result.title, 'Y')
  assert.ok(JSON.stringify(j.result).indexOf('system-reminder') < 0, '载荷里没有注入文本')
})

test('#112 嵌套形状：subagent.identity.label（projcache 落盘形状）', async () => {
  const { routes } = await boot(mockCtl({ values: {
    title: REMINDER,
    turnOutline: [],
    subagent: { identity: { mode: 'continuable', label: 'Z', seq: 2 } }
  } }))
  const j = await cmd(routes, 'detail', { sessionId: 's-z' })
  assert.equal(j.ok, true)
  assert.equal(j.result.title, 'Z', 'identity.label 也认')
})

test('#112 label 非法（null / 空串 / 非字符串）⇒ 回空串，不产生 "undefined"/"null"', async () => {
  const bads = [null, '', '   ', 42, true, { a: 1 }, [], undefined]
  for (const bad of bads) {
    const { routes } = await boot(mockCtl({ values: {
      title: REMINDER, turnOutline: [], subagent: { mode: 'continuable', label: bad }
    } }))
    const j = await cmd(routes, 'detail', { sessionId: 's-bad-label' })
    assert.equal(j.ok, true)
    assert.equal(j.result.title, '', '非法 label 回空串: ' + JSON.stringify(bad))
  }
  // 整体坏形状也不许抛
  for (const bad of [null, 'str', 7, { identity: null }, { identity: { label: 5 } }]) {
    const { routes } = await boot(mockCtl({ values: {
      title: REMINDER, turnOutline: [], subagent: bad
    } }))
    const j = await cmd(routes, 'detail', { sessionId: 's-bad-sa' })
    assert.equal(j.ok, true)
    assert.equal(j.result.title, '', '非法 subagent 回空串: ' + JSON.stringify(bad))
  }
})

/* ---------------- ② #A7 团队投影 ---------------- */

test('#A7 详情通道：agentTeam 归一后随载荷下发', async () => {
  const { routes } = await boot(mockCtl({ values: { title: 't', agentTeam: teamFixture() } }))
  const j = await cmd(routes, 'detail', { sessionId: 's-team' })
  const team = j.result.team
  assert.ok(team, 'team 必须下发（原来插件侧零实现）')
  assert.equal(team.members.length, 2, '没有 id 的脏成员被 filter')
  assert.equal(team.members[0].role, 'lead', 'lead 角色原样')
  assert.equal(team.members[1].role, 'teammate')
  assert.equal(team.members[1].phase, 'running')
  assert.equal(team.members[1].error, '', '空 error 保留（不是 undefined）')
  assert.equal(team.members[0].error, undefined, '没给 error 的成员不加这个键')
  assert.equal(team.tasks.length, 2, '没有 id 的脏任务被 filter')
  const t0 = team.tasks[0]
  assert.equal(t0.subject.length, 200, 'subject 截到 200 码点')
  assert.equal(t0.description.length, 500, 'description 截到 500 码点')
  assert.deepEqual(t0.blockedBy, ['task-2'])
  assert.deepEqual(t0.writeScopes, ['lib/'])
  assert.equal(t0.ready, true)
  const t1 = team.tasks[1]
  assert.equal(t1.revision, 7, "revision '7' 被强转成数字")
  assert.equal(t1.ready, true, 'ready:1 归一成 true')
  assert.equal(t1.ownerName.length, 80, 'ownerName 截到 80')
  assert.equal(team.failure.length, 300, 'failure 截到 300')
})

test('#A7 列表通道：会话条目上也带 team（列表页直接显示团队）', async () => {
  const { routes } = await boot(mockCtl({
    items: [{ sessionId: 's1', projections: { values: { title: 't', agentTeam: teamFixture() } } }]
  }))
  const j = await cmd(routes, 'sessions', {})
  const team = j.result[0].team
  assert.ok(team && team.members.length === 2 && team.tasks.length === 2, '列表通道也归一了团队')
})

test('#A7 普通会话：没有 agentTeam ⇒ team 恒为 null（客户端显示「暂无团队」）', async () => {
  const { routes } = await boot(mockCtl({ values: { title: 't' } }))
  const j = await cmd(routes, 'detail', { sessionId: 's-plain' })
  assert.equal(j.result.team, null)
  assert.ok(Object.prototype.hasOwnProperty.call(j.result, 'team'), '键必须在，否则客户端读到 undefined')
})

test('#A7 形状不认识：字符串/数字/null ⇒ null；数组退化成空团队（都不许抛）', async () => {
  for (const bad of ['garbage', 42, null, undefined]) {
    const { routes } = await boot(mockCtl({ values: { title: 't', agentTeam: bad } }))
    const j = await cmd(routes, 'detail', { sessionId: 's-bad' })
    assert.equal(j.ok, true, '坏形状不许 500')
    assert.equal(j.result.team, null, '坏形状回 null: ' + String(bad))
  }
  const { routes } = await boot(mockCtl({ values: { title: 't', agentTeam: [1, 2] } }))
  const j = await cmd(routes, 'detail', { sessionId: 's-arr' })
  assert.equal(j.ok, true)
  assert.deepEqual(j.result.team, { members: [], tasks: [] }, '数组退化成空团队（仍是合法形状）')
})

test('#A7 role 归一：只认 lead，其它一律 teammate', async () => {
  const { routes } = await boot(mockCtl({ values: { title: 't', agentTeam: {
    members: [
      { id: 'a', name: 'a', role: 'Lead', phase: 'active' },
      { id: 'b', name: 'b', role: 'owner', phase: 'active' }
    ],
    tasks: []
  } } }))
  const j = await cmd(routes, 'detail', { sessionId: 's-role' })
  assert.equal(j.result.team.members[0].role, 'teammate', "大小写不同不认（'Lead' ≠ 'lead'）")
  assert.equal(j.result.team.members[1].role, 'teammate')
})

test('#A7 上限：成员 50 / 任务 200（手机端不被撑爆）', async () => {
  const members = []
  for (let i = 0; i < 60; i++) members.push({ id: 'm' + i, name: 'n' + i, role: 'teammate', phase: 'active' })
  const tasks = []
  for (let i = 0; i < 250; i++) tasks.push({ id: 't' + i, subject: 's', status: 'pending' })
  const { routes } = await boot(mockCtl({ values: { title: 't', agentTeam: { members, tasks } } }))
  const j = await cmd(routes, 'detail', { sessionId: 's-cap' })
  assert.equal(j.result.team.members.length, 50)
  assert.equal(j.result.team.tasks.length, 200)
})

test('#A7 blockedBy / writeScopes 也是白名单形状：非数组当空数组', async () => {
  const { routes } = await boot(mockCtl({ values: { title: 't', agentTeam: {
    members: [],
    tasks: [{ id: 't1', subject: 's', status: 'pending', blockedBy: 'task-2', writeScopes: null, writeScopeWarnings: 5 }]
  } } }))
  const j = await cmd(routes, 'detail', { sessionId: 's-arr2' })
  const t = j.result.team.tasks[0]
  assert.deepEqual(t.blockedBy, [])
  assert.deepEqual(t.writeScopes, [])
  assert.deepEqual(t.writeScopeWarnings, [])
})
