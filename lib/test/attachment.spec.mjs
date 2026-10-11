/**
 * task-22 单测：附件登记表 + /dsh-console/attachment 路由。
 *
 * 不碰真实宿主：登记表的 store 是可注入的替身；路由用真起一个 lan-server 打真 HTTP。
 */
import { createAttachmentRegistry } from '../attachments.mjs'
import { startLanServer } from '../lan-server.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass += 1; console.log('  \u2713 ' + label) }
  else { fail += 1; console.log('  \u2717 ' + label + (extra === undefined ? '' : ' \u2192 ' + extra)) }
}
const eq = (a, b, label) => ok(a === b, label, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b))

const HEX = 'a'.repeat(64)
const REF = { attachmentId: 'sha256:' + HEX, mediaType: 'image/png', bytes: 8, width: 2, height: 2, name: 'shot.png' }
const BUF = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

console.log('\u30101\u3011 \u767b\u8bb0\u8868\uff1a\u5bf9\u5916\u5f62\u72b6\u4e25\u683c\u662f {id,name,mime,bytes}')
{
  const reg = createAttachmentRegistry({ store: () => ({ readImage: async () => ({ ref: REF, data: BUF }) }) })
  const id = reg.register(REF)
  eq(id, 'sha256:' + HEX, 'register 返回宿主 attachmentId 原样（内容寻址稳定 id）')
  const info = reg.infoOf(id)
  eq(Object.keys(info).sort().join(','), 'bytes,id,mime,name', 'infoOf 只有 4 个键（无 ref / 无路径）')
  eq(info.id, 'sha256:' + HEX, 'id')
  eq(info.name, 'shot.png', 'name 取宿主 ref.name')
  eq(info.mime, 'image/png', 'mime 取宿主 ref.mediaType')
  eq(info.bytes, 8, 'bytes 取宿主 ref.bytes')
  ok(JSON.stringify(info).indexOf('objects') < 0, '形状里绝不出现磁盘路径片段')
  eq(reg.register({ attachmentId: '' }), '', '空 ref 返回空串、不登记')
  eq(reg.size, 1, 'size=1')
  eq(reg.infoOf('sha256:' + 'b'.repeat(64)), null, '没登记过的 id → null')
}
{
  const reg = createAttachmentRegistry({ maxEntries: 2 })
  const mk = (c) => ({ attachmentId: 'sha256:' + c.repeat(64), mediaType: 'image/png', bytes: 1 })
  reg.register(mk('1')); reg.register(mk('2')); reg.register(mk('3'))
  eq(reg.size, 2, '超上限丢最旧（元数据 LRU，不动文件）')
  eq(reg.has('sha256:' + '1'.repeat(64)), false, '最旧的被淘汰')
  eq(reg.has('sha256:' + '3'.repeat(64)), true, '最新的还在')
}

console.log('\u30102\u3011 \u8bfb\u5b57\u8282\uff1a\u8d70\u5bbf\u4e3b\u670d\u52a1\uff0c\u5931\u8d25\u8fd4 null \u4e0d\u629b')
{
  const seen = []
  const reg = createAttachmentRegistry({ store: () => ({ readImage: async (r) => { seen.push(r); return { ref: r, data: BUF } } }) })
  reg.register(REF)
  const buf = await reg.readImageOf('sha256:' + HEX)
  ok(Buffer.isBuffer(buf) && buf.equals(BUF), 'readImageOf 回原始字节')
  eq(seen.length, 1, '把宿主 ref 原样交给 readImage（不自拼路径）')
  ok(seen[0] && seen[0].attachmentId === 'sha256:' + HEX, '透传的就是宿主 ImageAttachmentRef')
  eq(await reg.readImageOf('sha256:' + 'c'.repeat(64)), null, '没登记的 id → null')
}
{
  const reg = createAttachmentRegistry({ store: () => ({}) })
  reg.register(REF)
  eq(await reg.readImageOf('sha256:' + HEX), null, '宿主没有 readImage → null（不抛）')
}
{
  const reg = createAttachmentRegistry({ store: () => ({ readImage: async () => { throw new Error('ATTACHMENT_NOT_FOUND') } }) })
  reg.register(REF)
  eq(await reg.readImageOf('sha256:' + HEX), null, '宿主抛错 → null（不抛给上层）')
}
{
  const reg = createAttachmentRegistry({ store: () => { throw new Error('no ctx') } })
  reg.register(REF)
  eq(await reg.readImageOf('sha256:' + HEX), null, '取服务就炸 → null（不抛）')
}
{
  const reg = createAttachmentRegistry({ store: () => ({ readImage: async () => ({ ref: REF, data: new Uint8Array(0) }) }) })
  reg.register(REF)
  eq(await reg.readImageOf('sha256:' + HEX), null, '空字节 → null（当没有）')
}

console.log('\u30103\u3011 \u8def\u7531\uff1aGET /dsh-console/attachment \u7684 200 / 401 / 404')
{
  const TOKEN = 'tok-test-123'
  const PORT = 18777
  const lan = startLanServer({
    port: PORT, allowShift: false,
    getToken: () => TOKEN,
    getInfo: () => ({ name: 't', nodeId: 'n', host: 'h', dshOk: true }),
    listSessions: async () => [],
    runCommand: async () => ({}),
    log: () => {},
    attachmentOf: async (id) => {
      if (id === 'sha256:' + HEX) return { mime: 'image/png', name: 'shot.png', data: BUF, bytes: BUF.length }
      return null
    }
  })
  const started = await lan.start()
  ok(!!(started && started.port), '服务起来了 port=' + (started && started.port))
  const base = 'http://127.0.0.1:' + PORT + '/dsh-console/attachment?id=sha256:' + HEX
  const withTok = (u) => fetch(u, { headers: { 'x-dafeiyu-token': TOKEN } })

  const r1 = await withTok(base)
  eq(r1.status, 200, '带 x-dafeiyu-token 能取到（旧包头也认）')
  eq(r1.headers.get('content-type'), 'image/png', 'Content-Type 用登记表的 mime')
  const got = Buffer.from(await r1.arrayBuffer())
  ok(got.equals(BUF), '回的就是原始字节')
  eq(Number(r1.headers.get('content-length')), BUF.length, 'Content-Length 正确')
  ok((r1.headers.get('cache-control') || '').indexOf('private') === 0, '长缓存但 private')

  const r2 = await fetch(base, { headers: { 'x-dsh-console-token': TOKEN } })
  eq(r2.status, 200, 'x-dsh-console-token 同样能取')

  const r3 = await withTok('http://127.0.0.1:' + PORT + '/dsh-console/attachment?id=sha256:' + 'd'.repeat(64))
  eq(r3.status, 404, '没见过的 id → 404')
  const j3 = await r3.json()
  ok(j3.ok === false && j3.error === 'no-such-attachment', '404 body 恰好 {ok:false,error:"no-such-attachment"}', JSON.stringify(j3))

  const r4 = await withTok('http://127.0.0.1:' + PORT + '/dsh-console/attachment')
  eq(r4.status, 404, '没带 id → 404')
  eq((await r4.json()).error, 'no-such-attachment', '没带 id 的错误码一致')

  const r5 = await fetch(base)
  eq(r5.status, 401, '没 token → 401（与其它路由同闸）')
  const r6 = await fetch(base, { headers: { 'x-dafeiyu-token': 'wrong' } })
  eq(r6.status, 401, '错 token → 401')

  const r7 = await fetch('http://127.0.0.1:' + PORT + '/dsh-console/attachment?id=x', { method: 'POST', headers: { 'x-dafeiyu-token': TOKEN } })
  ok(r7.status === 404, 'POST 不走这条（落到未知路径 404）', r7.status)

  lan.stop()                                  // stop() 无回调（sync）
  await new Promise((r) => setTimeout(r, 80)) // 等 server 真的关掉（unref 也不影响）
}

console.log('\n' + (fail === 0 ? '\u2705 全部通过' : '\u274c 有失败') + '  pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
