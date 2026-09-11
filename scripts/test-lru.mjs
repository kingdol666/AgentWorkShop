/** 回归测试 —— 有界 LRU(shared/lru.mjs)。运行: node scripts/test-lru.mjs */
import { LruMap } from '../shared/lru.mjs'

let pass = 0, fail = 0
const check = (n, ok, d = '') => {
  if (ok) {
    pass++
    console.log('  PASS  ' + n)
    return
  }
  fail++
  console.log('  FAIL  ' + n + (d ? '  — ' + d : ''))
}

console.log('\n━━━ 1. 容量与逐出 ━━━')
{
  const l = new LruMap(3)
  l.set('a', 1)
  l.set('b', 2)
  l.set('c', 3)
  check('未超限 size=3', l.size === 3)
  l.set('d', 4)
  check('超限后 size 仍为 3', l.size === 3, 'size=' + l.size)
  check('最旧的 a 被逐出', !l.has('a'))
  check('最新的 d 在', l.has('d'))
  check('逐出计数=1', l.evictions === 1)
}

console.log('\n━━━ 2. 访问提升(LRU 语义核心) ━━━')
{
  const l = new LruMap(3)
  l.set('a', 1)
  l.set('b', 2)
  l.set('c', 3)
  l.get('a') // a 变最新
  l.set('d', 4) // 应逐出 b(而非 a)
  check('被访问过的 a 存活', l.has('a'))
  check('未访问的 b 被逐出', !l.has('b'))
  check('新写入的 d 在', l.has('d'))
}

console.log('\n━━━ 3. getOrSet 单入口 ━━━')
{
  const l = new LruMap(2)
  let computed = 0
  const v1 = l.getOrSet('k', () => {
    computed++
    return 'V'
  })
  const v2 = l.getOrSet('k', () => {
    computed++
    return 'V'
  })
  check('值正确', v1 === 'V' && v2 === 'V')
  check('只计算一次(二次命中缓存)', computed === 1, 'computed=' + computed)
  check('命中数=1', l.hits === 1, 'hits=' + l.hits)
}

console.log('\n━━━ 4. 无界增长已被消除(对比旧写法) ━━━')
{
  const l = new LruMap(100)
  for (let i = 0; i < 100000; i++) l.set('k' + i, i)
  check('插入 10 万后 size 恒为 100', l.size === 100, 'size=' + l.size)
  check('逐出总数 = 99900', l.evictions === 99900, 'evictions=' + l.evictions)
  check('最后写入的仍在', l.get('k99999') === 99999)
}

console.log('\n━━━ 5. 对比 clear() 抖动:LRU 不应造成全量穿透 ━━━')
{
  const l = new LruMap(500)
  for (let i = 0; i < 500; i++) l.set('k' + i, i)
  // 旧实现:第 501 次写入触发 clear(),之后 500 个条目全部回源
  l.set('k500', 500) // 触发一次逐出:k0 出局
  let survived = 0
  for (let i = 0; i < 500; i++) if (l.has('k' + i)) survived++
  // 500 条候选中恰好逐出 1 条 → 存活 499(旧 clear() 实现此处存活 0)
  check('仅逐出 1 条,其余 499 条仍在(旧 clear() 会剩 0)', survived === 499, 'survived=' + survived)
}

console.log('\n━━━ 6. 边界与回调 ━━━')
{
  let evictedKeys = []
  const l = new LruMap(2, k => evictedKeys.push(k))
  l.set('a', 1)
  l.set('b', 2)
  l.set('c', 3)
  check('onEvict 收到逐出键', evictedKeys.join(',') === 'a', evictedKeys.join(','))
  check('delete 可用', l.delete('b') === true && !l.has('b'))
  check('clear 后为空', (l.clear(), l.size === 0))
  let threw = false
  try {
    new LruMap(0)
  }
  catch { threw = true }
  check('max<1 抛错', threw)
  const s = l.stats()
  check('stats 形状正确', typeof s.hitRate === 'number' && s.max === 2)
}

console.log(`\n━━━ 结果:${pass} passed, ${fail} failed ━━━\n`)
process.exit(fail === 0 ? 0 : 1)
