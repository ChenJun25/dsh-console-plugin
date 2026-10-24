
import assert from 'node:assert/strict'
import { omitToolBodies } from '../lib/index.js'

let n = 0
const ok = (t) => { n++; console.log('  ok - ' + t) }

function card(name, detail, result, brief) {
  return { name, state: 'done', detail, result, brief }
}

function turns5() {

  const mk = (t) => ({
    turn: t,
    tools: [
      card('Bash', 'd'.repeat(1000), 'r'.repeat(1000), 'brief-' + t + '-0'),
      card('Read', 'x'.repeat(1000), 'y'.repeat(1000), 'brief-' + t + '-1')
    ]
  })
  return [1, 2, 3, 4, 5].map(mk)
}

console.log('\n工具体按需 · 置空规则')

{
  const turns = turns5()
  const saved = omitToolBodies(turns, 2)
  assert.ok(saved > 0, '应当省下字节: ' + saved)
  assert.equal(saved, 3000 * 4, '前 3 轮 × 2 张卡 × 2 个字段 × 1000 字节 = 12000')
  ok('省下的字节数 = 前 3 轮卡正文总和（12000）')

  const last2 = turns.slice(3)
  for (const t of last2) for (const c of t.tools) {
    assert.notEqual(c.bodyOmitted, true, '最后 2 轮不该被打标')
    assert.ok(c.detail.length > 0 && c.result.length > 0, '最后 2 轮正文必须完整')
  }
  ok('最后 2 轮（第 4、5 轮）正文完整、无 bodyOmitted')

  for (const t of turns.slice(0, 3)) for (const c of t.tools) {
    assert.equal(c.bodyOmitted, true, '更早的卡必须打标')
    assert.equal(c.detail, '', 'detail 必须清空')
    assert.equal(c.result, '', 'result 必须清空')
    assert.ok(c.brief && c.brief.length > 0, 'brief 必须保留')
    assert.equal(c.name.length > 0, true, 'name 必须保留')
    assert.equal(c.state, 'done', 'state 必须保留')
  }
  ok('前 3 轮：detail/result 清空 + bodyOmitted=true，brief/name/state 保留')

  const again = omitToolBodies(turns, 2)
  assert.equal(again, 0, '幂等：已清空的再跑省 0')
  ok('幂等（第二次调用省 0 字节）')
}

console.log('\n边界')

{
  assert.equal(omitToolBodies([], 2), 0)
  assert.equal(omitToolBodies(null, 2), 0)
  ok('空 / null 输入返回 0，不抛')

  const short = turns5().slice(0, 2)
  assert.equal(omitToolBodies(short, 2), 0)
  assert.equal(short[0].tools[0].detail.length, 1000)
  ok('轮数 ≤ keepTurns 时一个字节都不动')

  const noTools = [{ turn: 1 }, { turn: 2 }, { turn: 3, tools: null }]
  assert.equal(omitToolBodies(noTools, 1), 0)
  ok('缺 tools / tools 为 null 的轮跳过，不抛')

  const one = turns5()
  assert.equal(omitToolBodies(one, 0), 20000)
  for (const t of one) for (const c of t.tools) assert.equal(c.bodyOmitted, true)
  ok('keepTurns=0 时 5 轮全部置空（省 5 × 2 × 2 × 1000 = 20000 字节）')
}

console.log('\n' + n + ' 项通过')
