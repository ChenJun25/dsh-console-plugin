import test from 'node:test'
import assert from 'node:assert/strict'

const IMG_SHELL = '<path>D:/dsh-console-hm/_shots-baseline/real_base.jpeg</path>\n' +
  '<type>image</type>\n<content>\nimage/jpeg image, 1320x2848 px, 213235 bytes\n</content>'
const REMINDER = '<system-reminder>\nThe following workspace instructions are loaded.\n' +
  'Instructions from: ~/.dsh/AGENTS.md\n\n# 小助理 · 通用人设\n</system-reminder>'
const LONG = 'x'.repeat(3000)

function mockCtlOutline() {
  return {
    projections: async () => ({ asOfSeq: 6, values: { title: 't', turnOutline: [
      { turn: 1, seq: 2, prompt: IMG_SHELL, response: '收到图，开始处理' },
      { turn: 2, seq: 4, prompt: REMINDER, response: ' Root cause 已定位' },
      { turn: 3, seq: 6, prompt: '把按钮改成鸿蒙材质', response: '已改' }
    ] } }),
    page: async () => ({ records: [] }),
    list: async () => ({ items: [] }),
    modelCatalog: async () => ({})
  }
}

function mockCtlFull() {
  const events = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { turn: 1, content: [
      { type: 'text', text: '把按钮改成鸿蒙材质' },

      { type: 'text', text: IMG_SHELL }
    ] } },

    { type: 'user/message', seq: 3, time: 3, data: { turn: 1, content: [
      { type: 'text', text: REMINDER }
    ] } },
    { type: 'tool/call', seq: 4, time: 4, data: { turn: 1, step: 1, name: 'pwsh',
      arguments: JSON.stringify({ command: LONG }) } },
    { type: 'tool/result', seq: 5, time: 5, data: { turn: 1, message: { content: [
      { type: 'text', text: LONG }
    ] } } },
    { type: 'assistant/message', seq: 6, time: 6, data: { turn: 1, step: 1,
      message: { content: [{ type: 'text', text: '已改' }] } } },
    { type: 'turn/end', seq: 7, time: 7, data: { turn: 1 } }
  ]
  return {
    projections: async () => ({ asOfSeq: 7, values: { title: 't', turnOutline: [
      { turn: 1, seq: 2, prompt: '把按钮改成鸿蒙材质', response: '已改' }
    ] } }),
    page: async () => ({ records: events.map((e) => ({ type: 'event', event: e })) }),
    list: async () => ({ items: [] }),
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
  const { ctx, routes, handlers } = mockCtx(ctl)
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  assert.ok(routes['/api/dsh-console/cmd'], 'cmd 路由没注册上')
  return { routes, handlers }
}

async function detail(routes, payload) {
  const r = await routes['/api/dsh-console/cmd'].fetch(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ op: 'detail', payload })
  }))
  return r.json()
}

test('#73 概要投影：附件描述块与 <system-reminder> 不进 prompt（真提问不受影响）', async () => {
  const { routes } = await boot(mockCtlOutline())
  const j = await detail(routes, { sessionId: 's-out' })
  assert.equal(j.ok, true)
  assert.notEqual(j.result.full, true, '空页 ⇒ 走的正是概要投影分支')
  assert.equal(j.result.turns[0].prompt, '', '图片壳被剥 ⇒ prompt 空（客户端 trim 后不画蓝框）')
  assert.equal(j.result.turns[1].prompt, '', 'system-reminder 整条注入置空（不删轮）')

  assert.equal(j.result.turns[1].response.trim(), 'Root cause 已定位', 'response 的 ACP 仍被剥')
  assert.equal(j.result.turns[2].prompt, '把按钮改成鸿蒙材质', '真实提问原样保留（不误杀）')
  const all = JSON.stringify(j.result)
  assert.ok(all.indexOf('<path>') < 0, '整个载荷里没有 <path>')
  assert.ok(all.indexOf('system-reminder') < 0, '整个载荷里没有 system-reminder')
})

test('#73 全文通道：contentText 块拼接后剥壳，正文不被工具块污染', async () => {
  const { routes } = await boot(mockCtlFull())
  const j = await detail(routes, { sessionId: 's-full' })
  assert.equal(j.result.full, true, '有事件 ⇒ 走全文通道')
  const t = j.result.turns[0]

  assert.equal(t.prompt.trim(), '把按钮改成鸿蒙材质', '同一条消息里的附件描述块被丢掉，正文留下')
  assert.ok(t.prompt.indexOf('_shots-baseline') < 0, '正文不含附件磁盘路径')
  assert.ok(JSON.stringify(j.result.trace || []).indexOf('system-reminder') < 0,
    '轨迹里也没有 system-reminder')
})

test('#79 生成中（live）工具详情：局域网口径下不截断（全文落地、无「已截断」标记）', async () => {
  const { routes, handlers } = await boot(mockCtlOutline())
  const sess = { id: 's-live' }
  handlers['session/event'](sess, { type: 'turn/start', seq: 1, time: 1, data: {} })

  handlers['session/event'](sess, { type: 'assistant/message', seq: 2, time: 1, data: {
    turn: 1, step: 1, stream: [{ type: 'text-chunks', texts: ['分析中'] }],
    message: { content: [{ type: 'text', text: '分析中' }] }
  } })
  handlers['session/event'](sess, { type: 'tool/call', seq: 3, time: 2, data: {
    turn: 1, step: 1, name: 'pwsh', arguments: JSON.stringify({ command: LONG })
  } })
  handlers['session/event'](sess, { type: 'tool/result', seq: 4, time: 3, data: {
    turn: 1, message: { content: [{ type: 'text', text: LONG }] }
  } })
  const j = await detail(routes, { sessionId: 's-live' })
  const tl = j.result.live && j.result.live.tools && j.result.live.tools[0]
  assert.ok(tl, 'live 工具卡在')
  assert.ok(tl.detail.length > 0 && tl.result.length > 0, '详情/结果非空')
  assert.ok(tl.detail.indexOf('已截断') < 0, 'detail 不出现「已截断」（用户看到的正是这里）')
  assert.ok(tl.result.indexOf('已截断') < 0, 'result 不出现「已截断」')

  assert.ok(tl.result === LONG, '局域网 live 结果应全文落地，实际长度 ' + tl.result.length)
  assert.ok(tl.detail.indexOf(LONG) >= 0, 'live 参数原文应完整保留')
})

test('#79 对照护栏：公网口径下历史全文通道的「已截断」标记必须保留', async () => {
  const { routes } = await boot(mockCtlFull())

  const j = await detail(routes, { sessionId: 's-full', __wan: true })
  const t = j.result.turns[0]
  assert.ok(t.tools && t.tools[0], '全文通道有工具卡')
  assert.ok(t.tools[0].detail.indexOf('已截断') >= 0, '历史路径照旧带标记（payload.spec ③ 钉住）')
  assert.ok(t.tools[0].result.indexOf('已截断') >= 0, '历史结果同上')
})

test('#73 不误杀：孤立的 <content>/<type> 普通文本不被剥', async () => {
  const keep = '接口回的 JSON 是 {"type":"image"}，文档里写 <content> 标签要转义'
  const ctl = mockCtlOutline()
  const orig = ctl.projections
  ctl.projections = async () => {
    const r = await orig()
    r.values.turnOutline = [{ turn: 1, seq: 2, prompt: keep, response: '好' }]
    return r
  }
  const { routes } = await boot(ctl)
  const j = await detail(routes, { sessionId: 's-keep' })
  assert.equal(j.result.turns[0].prompt, keep, '没有 image/ 或 px, 的 <content> 不剥')
})
