/**
 * 第 186 节 · task-B 单测：助手正文里的本地图片 ⇒ aimages。
 *
 * 【要治的病】用户 m00875：回复正文里的 markdown 本地图片 `![x](D:/a.png)`
 * 手机端看不到。根因 —— 宿主只给「真被当成附件」的 image 块，模型把路径写进
 * 正文时一个块都没有。这里按路径读盘、算 sha256 登记，id 与宿主同形
 * （sha256:<64hex>），手机端既有取图管线一个字都不用改。
 *
 * 覆盖面：
 *   ① 登记表：registerLocalBytes ⇒ id = 'sha256:'+sha256(字节)、infoOf 四键、
 *      readImageOf 直接回本地字节（**不碰**宿主 attachments.readImage）；
 *   ② 端到端：assistant/message 正文里的 `![x](绝对路径)` ⇒ turns[0].aimages
 *      出现那个 sha256 id（真的写了个临时文件，不依赖仓库外路径）；
 *   ③ 裸路径整行那种写法也认；
 *   ④ 反面：文件不存在 / 相对路径 / 非白名单扩展名 / 超 8MB 一律不登记；
 *   ⑤ 同一张图出现两次 ⇒ 只登记一条（按 sha256 去重），且正文不被改动。
 * 跑法：node --test lib/test/local-images.spec.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createAttachmentRegistry } from '../attachments.mjs'

const T = 1700000000000
function ev(type, data, time) {
  return { type: type, seq: 0, time: time || T, data: data || {} }
}

/** 宿主 page() 的回包：把本用例自己给的事件流原样吐出来（全文通道的数据源）。 */
function mockCtl(events) {
  return {
    projections: async () => ({ asOfSeq: 9, values: { title: 't', turnOutline: [] } }),
    page: async () => ({ records: events.map((e) => ({ type: 'event', event: e })) }),
    list: async () => ({ items: [] }),
    modelCatalog: async () => ({})
  }
}

function mockCtx(events) {
  const routes = {}
  const CTRL = mockCtl(events)
  const conn = { fetch: { register: (route) => { routes[route.path] = route; return () => {} } } }
  const ctx = {
    get: (n) => (n === 'connection' ? conn
      : n === 'sessionController' ? CTRL
        : n === 'attachments' ? { readImage: async () => { throw new Error('本地图片不该走宿主 readImage') } }
          : null),
    on: () => () => {},
    effect: () => () => {}
  }
  return { ctx, routes }
}

async function detailOfEvents(events) {
  const { ctx, routes } = mockCtx(events)
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  assert.ok(routes['/api/dsh-console/cmd'], 'cmd 路由没注册上')
  const r = await routes['/api/dsh-console/cmd'].fetch(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: 's-local' } })
  }))
  return r.json()
}

/** 一个真临时 PNG（8 字节 PNG magic + 一点内容），返回绝对路径。 */
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-local-img-'))
let tmpSeq = 0
function writeTempImage(ext, size) {
  const p = path.join(TMPDIR, 'shot' + (tmpSeq++) + '.' + ext)
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const body = Buffer.alloc(Math.max(0, (size || 32) - head.length), 0x41)
  fs.writeFileSync(p, Buffer.concat([head, body]))
  return p
}
const sha256 = (buf) => 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex')

test('① 登记表：registerLocalBytes ⇒ 内容寻址 id + 四键 + 本地字节直接回', async () => {
  const BUF = fs.readFileSync(writeTempImage('png', 64))
  const reg = createAttachmentRegistry({ store: () => { throw new Error('不该取宿主服务') } })
  const id = reg.registerLocalBytes(BUF, { name: '图a.png' })
  assert.equal(id, sha256(BUF), 'id = sha256: + sha256(文件字节)（与宿主 ID_PATTERN 同形）')
  assert.ok(/^sha256:[a-f0-9]{64}$/.test(id), 'id 形状是 sha256:<64hex>')
  const info = reg.infoOf(id)
  assert.deepEqual(Object.keys(info).sort(), ['bytes', 'id', 'mime', 'name'], 'infoOf 还是 4 个键')
  assert.equal(info.name, '图a.png', 'name 用调用方给的')
  assert.equal(info.mime, 'image/png', 'mime 按扩展名兜（调用方没给）')
  assert.equal(info.bytes, BUF.length, 'bytes = 真实字节数')
  const back = await reg.readImageOf(id)
  assert.ok(Buffer.isBuffer(back) && back.equals(BUF), 'readImageOf 先看本地字节，直接回（不碰宿主）')
  assert.equal(reg.registerLocalBytes(Buffer.alloc(0)), '', '空字节 ⇒ 空串（不登记）')
  // 同一份字节登记两次 ⇒ 同一个 id，不涨条目
  assert.equal(reg.registerLocalBytes(BUF, { name: '别的名.png' }), id, '内容相同 ⇒ id 相同（按内容去重）')
  assert.equal(reg.size, 1, '同内容只占一条')
})

test('② 端到端：正文里的 ![x](绝对路径) ⇒ turns[0].aimages 带 sha256 id', async () => {
  const png = writeTempImage('png', 128)
  const id = sha256(fs.readFileSync(png))
  const text = '改好了，看这张：\n\n![' + 'a' + '](' + png + ')\n'
  const j = await detailOfEvents([
    ev('turn/start', { turn: 1 }),
    ev('user/message', { turn: 1, source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '改一下' }] }),
    ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: text }] } }),
    ev('turn/end', { turn: 1 })
  ])
  assert.equal(j.ok, true)
  const t = j.result.turns[0]
  assert.ok(t, '折出了这一轮')
  assert.equal(t.aimages.length, 1, '正文里的本地图登记进 aimages（与助手图同一数组）')
  assert.equal(t.aimages[0].id, id, 'id = sha256: + sha256(文件字节)')
  assert.ok(t.aimages[0].id.indexOf('sha256:') === 0, 'id 以 sha256: 开头')
  assert.deepEqual(Object.keys(t.aimages[0]).sort(), ['bytes', 'id', 'mime', 'name'],
    'aimages 形状仍是冻结的 {id,name,mime,bytes}')
  assert.equal(t.aimages[0].name, path.basename(png), 'name = 文件名')
  assert.equal(t.aimages[0].mime, 'image/png', 'mime 按扩展名给')
  assert.equal(t.aimages[0].bytes, fs.statSync(png).size, 'bytes = 真实文件大小')
  /* 注意：磁盘路径本来就写在助手**正文**里（模型自己写的），正文原样下发是应有之义；
     要保证的是**图片元数据**里绝不出现路径 —— 出去的只有内容寻址的 id。 */
  assert.ok(JSON.stringify(t.aimages).indexOf('dsh-local-img-') < 0, '图片元数据里绝不出现磁盘路径')
  assert.equal(t.aimages[0].id.indexOf('sha256:'), 0, '元数据里只有 sha256 id')
  assert.ok(t.response.indexOf('![') >= 0, '正文本身不被改动（markdown 片段原样留着）')
})

test('③ 裸路径写法（整行 trim 后就是一条存在的图片文件）也认', async () => {
  const png = writeTempImage('JPG', 96)     // 顺带验扩展名大小写不敏感
  const id = sha256(fs.readFileSync(png))
  const j = await detailOfEvents([
    ev('turn/start', { turn: 1 }),
    ev('user/message', { turn: 1, source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '哪张？' }] }),
    ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '这张：\n' + png + '\n就这样' }] } }),
    ev('turn/end', { turn: 1 })
  ])
  const t = j.result.turns[0]
  assert.equal(t.aimages.length, 1, '裸路径那一行被认出来了')
  assert.equal(t.aimages[0].id, id, 'id 一致')
  assert.equal(t.aimages[0].mime, 'image/jpeg', 'JPG 大小写不敏感 ⇒ image/jpeg')
})

test('④ 反面：文件不存在 / 相对路径 / 非白名单扩展名 / 超 8MB 都不登记', async () => {
  const real = writeTempImage('png', 64)
  const missing = path.join(TMPDIR, 'nope-不存在.png')
  const rel = 'lib/test/local-images.spec.mjs'                      // 存在，但不是绝对路径
  const txt = writeTempImage('txt', 64)                             // 存在，但扩展名不在白名单
  const big = writeTempImage('png', 8 * 1024 * 1024 + 64)           // 超 8MB
  const text = ['![a](' + missing + ')', '![b](' + rel + ')', '![c](' + txt + ')', '![d](' + big + ')', '![e](' + real + ')'].join('\n')
  const j = await detailOfEvents([
    ev('turn/start', { turn: 1 }),
    ev('user/message', { turn: 1, source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '看图' }] }),
    ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: text }] } }),
    ev('turn/end', { turn: 1 })
  ])
  const t = j.result.turns[0]
  assert.equal(t.aimages.length, 1, '四条不合格的都没登记，只有真实存在的那张进')
  assert.equal(t.aimages[0].id, sha256(fs.readFileSync(real)), '进的正是那张合格的')
})

test('⑤ 同一张图出现两次 ⇒ 只登记一条（按 sha256 去重），正文不动', async () => {
  const png = writeTempImage('webp', 80)
  const id = sha256(fs.readFileSync(png))
  const j = await detailOfEvents([
    ev('turn/start', { turn: 1 }),
    ev('user/message', { turn: 1, source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '两张？' }] }),
    ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '![a](' + png + ')\n![b](' + png + ')' }] } }),
    ev('turn/end', { turn: 1 })
  ])
  const t = j.result.turns[0]
  assert.equal(t.aimages.length, 1, '同一张只登记一条')
  assert.equal(t.aimages[0].id, id, 'id 是内容寻址 ⇒ 天然的跨轮去重键')
  assert.ok(t.response.indexOf('![a]') >= 0 && t.response.indexOf('![b]') >= 0, '正文里的两处 markdown 都还在')
})

/* ============================================================
 * 🔴 task-1（0.5.18）新增：正文图片 id 回填 rmd + "/C:/..." 前导斜杠兼容
 *
 * 【要治的病】App 正文渲染按 markdown 图片的 dest 取图，正文里写的是磁盘路径
 * ![x](D:/a.png)，App 端读不到盘 ⇒ 图空着。插件这边已经登记了 sha256 id，
 * 于是回填一个 **改写版正文** t.rmd / live.rmd：把成功登记的
 * ![alt](dest) 整段换成 ![alt](dshimg:<attachmentId>)，alt 保留、dest 整段
 * （含 <> 包裹）替换。t.response 一律不动（老客户端靠原文）。
 * ============================================================ */

test('⑥ 折轮：成功登记的 markdown 本地图 ⇒ t.rmd 回填 dshimg:<id>，t.response 仍是原文', async () => {
  const png = writeTempImage('png', 160)
  const id = sha256(fs.readFileSync(png))
  const text = '看图：\n\n![r16](' + png + ')\n\n上面这张。'
  const j = await detailOfEvents([
    ev('turn/start', { turn: 1 }),
    ev('user/message', { turn: 1, source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '看图' }] }),
    ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: text }] } }),
    ev('turn/end', { turn: 1 })
  ])
  const t = j.result.turns[0]
  assert.equal(typeof t.rmd, 'string', '有改动 ⇒ 下发 rmd')
  assert.ok(t.rmd.indexOf('![r16](dshimg:' + id + ')') >= 0, 'alt 保留、dest 整段换成 dshimg:<id>')
  assert.ok(t.rmd.indexOf('dsh-local-img-') < 0, 'rmd 里不再有磁盘路径')
  assert.ok(t.rmd.indexOf('看图：') === 0 && t.rmd.indexOf('上面这张。') >= 0, '图片之外的正文原样保留')
  assert.ok(t.response.indexOf(png) >= 0, 't.response 一律不动（仍是磁盘路径原文）')
  assert.ok(t.response.indexOf('dshimg:') < 0, 't.response 里绝不出现 dshimg')
})

test('⑦ <> 包裹的 dest 也整段替换', async () => {
  const png = writeTempImage('jpeg', 192)
  const id = sha256(fs.readFileSync(png))
  const j = await detailOfEvents([
    ev('turn/start', { turn: 1 }),
    ev('user/message', { turn: 1, source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '图' }] }),
    ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '![r16](<' + png + '>)' }] } }),
    ev('turn/end', { turn: 1 })
  ])
  const t = j.result.turns[0]
  assert.equal(t.rmd, '![r16](dshimg:' + id + ')', '<> 一并去掉，只剩 dshimg 目标')
  assert.equal(t.aimages.length, 1, '仍然登记进 aimages')
})

test('⑧ 没改动（正文里没有可登记的本地图）⇒ 不写 rmd（不白占 payload）', async () => {
  const j = await detailOfEvents([
    ev('turn/start', { turn: 1 }),
    ev('user/message', { turn: 1, source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '说句话' }] }),
    ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '好的，没问题。' }] } }),
    ev('turn/end', { turn: 1 })
  ])
  const t = j.result.turns[0]
  assert.equal(t.response, '好的，没问题。')
  assert.equal('rmd' in t, false, '没改动 ⇒ 键都不出现（老客户端零感知）')
})

test('⑨ 前导斜杠 + 盘符形态（/C:/Users/...）也能登记，并回填 rmd', async () => {
  const png = writeTempImage('png', 128)
  const id = sha256(fs.readFileSync(png))
  const slashy = '/' + png.split(path.sep).join('/')
  assert.ok(slashy.charAt(0) === '/' && slashy.charAt(2) === ':', '构造出来的正是前导斜杠 + 盘符形态')
  const j = await detailOfEvents([
    ev('turn/start', { turn: 1 }),
    ev('user/message', { turn: 1, source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '看' }] }),
    ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '![p](' + slashy + ')' }] } }),
    ev('turn/end', { turn: 1 })
  ])
  const t = j.result.turns[0]
  assert.equal(t.aimages.length, 1, '前导斜杠形态被认出来了（修复前会被静默丢掉）')
  assert.equal(t.aimages[0].id, id, 'id 按内容算出，与正常写法一致')
  assert.equal(t.rmd, '![p](dshimg:' + id + ')', 'rmd 同样回填')
})

test('⑩ live 通路（session/event 总线）：live.rmd 是回填版，live.text 不动', async () => {
  const png = writeTempImage('png', 144)
  const id = sha256(fs.readFileSync(png))
  const routes = {}
  const handlers = {}
  const CTRL = mockCtl([])
  const conn = { fetch: { register: (route) => { routes[route.path] = route; return () => {} } } }
  const ctx = {
    get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? CTRL : n === 'attachments' ? { readImage: async () => { throw new Error('不该走宿主') } } : null),
    on: (evt, fn) => { handlers[evt] = fn; return () => {} },
    effect: () => () => {}
  }
  const { apply } = await import('../index.js')
  apply(ctx, { port: 0 })
  assert.equal(typeof handlers['session/event'], 'function', '事件总线挂上了')
  const sess = { id: 's-live-rmd' }
  const text = '看这张：![v1](' + png + ')'
  handlers['session/event'](sess, { type: 'turn/start', seq: 1, time: T, data: {} })
  handlers['session/event'](sess, { type: 'assistant/message', seq: 2, time: T + 1, data: {
    turn: 1, step: 1, stream: [{ type: 'text-chunks', texts: [text] }], message: { content: [{ type: 'text', text: text }] }
  } })
  const r = await routes['/api/dsh-console/cmd'].fetch(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: sess.id } })
  }))
  const j = await r.json()
  assert.ok(j.result.live, '有 live 块')
  assert.ok(j.result.live.text.indexOf(png) >= 0, 'live.text 仍是原文（不动）')
  assert.equal(j.result.live.rmd, '看这张：![v1](dshimg:' + id + ')', 'live.rmd 是回填版')
  assert.equal(j.result.live.aimages.length, 1, 'live.aimages 照样登记')
})

test.after(() => { try { fs.rmSync(TMPDIR, { recursive: true, force: true }) } catch (e) {} })
