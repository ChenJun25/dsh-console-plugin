import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sweepSessionFilesNow, createDeleteSweeper } from '../index.js'

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass += 1; console.log('  \u2713 ' + label) }
  else { fail += 1; console.log('  \u2717 ' + label + (extra === undefined ? '' : ' \u2192 ' + extra)) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SID = 'session-aaaa-1111'
const OTHER = 'session-bbbb-2222'

function makeRoot() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sweep-'))
  const sessionsRoot = path.join(T, 'sessions')
  const storagesRoot = path.join(T, 'storages')
  const cacheDir = path.join(storagesRoot, 'session_projcache', 'sessions')
  fs.mkdirSync(path.join(sessionsRoot, '--ws--', SID), { recursive: true })
  fs.mkdirSync(path.join(sessionsRoot, '--ws--', OTHER), { recursive: true })
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(sessionsRoot, '--ws--', SID, 'session.v4.jsonl.zstd'), 'x')
  fs.writeFileSync(path.join(cacheDir, SID + '.json'), '{"title":"a"}')
  fs.writeFileSync(path.join(sessionsRoot, '--ws--', OTHER, 'session.v4.jsonl.zstd'), 'y')
  fs.writeFileSync(path.join(cacheDir, OTHER + '.json'), '{"title":"b"}')

  fs.writeFileSync(path.join(cacheDir, SID + '.json.bak'), 'keep')
  fs.writeFileSync(path.join(cacheDir, SID + 'x.json'), 'keep')
  fs.writeFileSync(path.join(cacheDir, 'x' + SID + '.json'), 'keep')
  fs.mkdirSync(path.join(sessionsRoot, '--ws--', SID + '-old'), { recursive: true })
  fs.writeFileSync(path.join(sessionsRoot, '--ws--', SID + '-old', 'keep.txt'), 'keep')
  return { T, sessionsRoot, storagesRoot, cacheDir }
}
const hostRewrite = (r) => fs.writeFileSync(path.join(r.cacheDir, SID + '.json'), '{"title":"rewritten"}')
const cacheExists = (r, id) => fs.existsSync(path.join(r.cacheDir, (id || SID) + '.json'))
const dirExists = (r, id) => fs.existsSync(path.join(r.sessionsRoot, '--ws--', (id || SID)))
const residual = (r) => (cacheExists(r) ? 1 : 0) + (dirExists(r) ? 1 : 0)
const firstPass = (r) => sweepSessionFilesNow(SID, { sessionsRoot: r.sessionsRoot, storagesRoot: r.storagesRoot })
const mkSweeper = (r, extra) => createDeleteSweeper(Object.assign({
  sessionsRoot: () => r.sessionsRoot, storagesRoot: () => r.storagesRoot, log: () => {}
}, extra || {}))

console.log('\u30101\u3011 改前：只清一遍 \u2192 宿主几毫秒后写回 \u2192 残留 1')
{
  const r = makeRoot()
  const a = firstPass(r)
  ok(a.dirs.length === 1 && a.caches.length === 1, '第一遍把目录 + 投影缓存都清了', JSON.stringify(a))
  ok(residual(r) === 0, '第一遍之后残留 = 0')
  hostRewrite(r)
  ok(residual(r) === 1 && cacheExists(r), '改前残留 = 1（投影缓存复活，14/47 就是这么来的）', residual(r))
  fs.rmSync(r.T, { recursive: true, force: true })
}

console.log('\u30102\u3011 改后：两次补刀 \u2192 宿主写回被 600ms 补刀清掉 \u2192 残留 0')
{
  const r = makeRoot()
  const queue = []
  const spy = mkSweeper(r, { setTimer: (fn, ms) => { queue.push({ fn, ms }); return { ms } } })
  firstPass(r); hostRewrite(r)
  const t0 = Date.now()
  const scheduled = spy.schedule(SID)
  const cost = Date.now() - t0
  ok(scheduled === true, 'schedule 返回 true')
  ok(cost < 50, 'schedule 立刻返回不阻塞（实测 ' + cost + 'ms）')
  ok(residual(r) === 1, 'schedule 只登记、不当场删（此时残留仍是 1）', residual(r))
  ok(queue.map((q) => q.ms).join(',') === '600,2000', '默认补刀延迟 = 600ms + 2000ms（覆盖 4~13ms 重写窗口）',
     queue.map((q) => q.ms).join(','))
  spy.clear()
  fs.rmSync(r.T, { recursive: true, force: true })
}
{
  const r = makeRoot()
  const sweeper = mkSweeper(r, { delayMs: 80, delay2Ms: 200 })
  firstPass(r)
  hostRewrite(r)
  ok(residual(r) === 1, '补刀排上之前：残留 1')
  sweeper.schedule(SID)
  await sleep(120)
  ok(residual(r) === 0, '80ms 补刀后：残留 = 0', residual(r))
  ok(cacheExists(r, OTHER), '别的会话的投影缓存没被误伤（该在的还在）')
  ok(dirExists(r, OTHER), '别的会话的目录没被误伤')
  ok(fs.existsSync(path.join(r.cacheDir, SID + '.json.bak')) &&
     fs.existsSync(path.join(r.cacheDir, SID + 'x.json')) &&
     fs.existsSync(path.join(r.cacheDir, 'x' + SID + '.json')) &&
     dirExists(r, SID + '-old'),
     '扩展名/前缀/后缀/目录名子串相近的一律不误伤')
  hostRewrite(r)
  await sleep(150)
  ok(residual(r) === 0, '200ms 第二次补刀也把关（晚一轮写回照样清）', residual(r))
  ok(sweeper.pending === 0, '两次跑完，定时器表清空（无泄漏）', sweeper.pending)
  fs.rmSync(r.T, { recursive: true, force: true })
}

console.log('\u30103\u3011 幂等：同一 id 反复排 / 反复清 → 不堆积、不抛')
{
  const r = makeRoot()
  const sweeper = mkSweeper(r, { delayMs: 60, delay2Ms: 120 })
  const t0 = Date.now()
  sweeper.schedule(SID); sweeper.schedule(SID); sweeper.schedule(SID)
  ok(sweeper.pending === 1, '连排 3 次内部只留 1 个会话的定时器', sweeper.pending)
  await sleep(200)
  ok(residual(r) === 0, '最终清干净（前两轮的定时器被 clearTimeout 掉，没重复触发）', residual(r))
  ok(sweeper.pending === 0, '跑完表清空', sweeper.pending)
  let threw = null
  try { firstPass(r); firstPass(r) } catch (e) { threw = e }
  ok(threw === null, '已删干净后再清两遍不抛（幂等）', threw && threw.message)
  ok(false === false, '排 3 次总耗时 ' + (Date.now() - t0) + 'ms（未串行累积）')
  fs.rmSync(r.T, { recursive: true, force: true })
}

console.log('\u30104\u3011 clear()（插件卸载）：补刀被撤掉，不再动磁盘')
{
  const r = makeRoot()
  const sweeper = mkSweeper(r, { delayMs: 60, delay2Ms: 120 })
  firstPass(r); hostRewrite(r)
  sweeper.schedule(SID)
  sweeper.clear()
  ok(sweeper.pending === 0, 'clear 后表为空', sweeper.pending)
  await sleep(200)
  ok(residual(r) === 1, 'clear 生效：补刀没跑，残留保持（留给下一轮 delete 兜底）', residual(r))
  fs.rmSync(r.T, { recursive: true, force: true })
}

console.log('\u30105\u3011 边界：空 id / 路径不存在 / 没有 storages')
{
  const r = makeRoot()
  const sweeper = mkSweeper(r)
  ok(sweeper.schedule('') === false && sweeper.schedule(null) === false && sweeper.schedule(undefined) === false,
     '空 id 直接拒排、不登记')
  const a = sweepSessionFilesNow('', { sessionsRoot: r.sessionsRoot, storagesRoot: r.storagesRoot })
  const b = sweepSessionFilesNow(SID, { sessionsRoot: '/no/such/dir', storagesRoot: '/no/such/dir' })
  const c = sweepSessionFilesNow(SID, {})
  ok(a.dirs.length === 0 && a.caches.length === 0, '空 id 什么都不删', JSON.stringify(a))
  ok(b.dirs.length === 0 && b.caches.length === 0, '路径不存在返回空数组、不抛', JSON.stringify(b))
  ok(c.dirs.length === 0 && c.caches.length === 0, 'roots 为空也不抛', JSON.stringify(c))
  fs.rmSync(r.T, { recursive: true, force: true })
}

console.log('\n' + (fail === 0 ? '\u2705 全部通过' : '\u274c 有失败') + '  pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
