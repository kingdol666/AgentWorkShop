/**
 * 回归 + 性能测试 —— DCW 回滚账本索引化(P1-8/P1-9)
 * 验证:索引版与原「逆序全扫」版**结果完全一致**,且热路径显著更快。
 * 运行: node scripts/test-rollback-index.mjs
 *
 * 注:被导入的 recipe-rollback.repo.ts 经 '@/' 别名引用 shared/config/home.mjs,
 * 而 Node 原生 ESM 不认别名/省略扩展名 —— 必须先注册解析钩子,否则本脚本
 * 在 import 阶段就 ERR_MODULE_NOT_FOUND(与 test-log-flooding.mjs 同一机制)。
 */
import { register } from 'node:module'

register(new URL('./_audit/ts-resolve-hook.mjs', import.meta.url).href)

const { RecipeRollBackRepo } = await import('../server/services/workshop/dcw/recipe-rollback.repo.ts')

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

// ---- 参照实现:旧版线性全扫语义(结果必须与索引版逐条一致) ----
const ref = {
  lastAnchorOf(anchors, nodeId) {
    for (let i = anchors.length - 1; i >= 0; i--) {
      if (anchors[i].nodeId === nodeId) return anchors[i]
    }
    return undefined
  },
  lastStableAnchor(anchors, nodeId) {
    for (let i = anchors.length - 1; i >= 0; i--) {
      const a = anchors[i]
      if (a.nodeId === nodeId && a.prevValue != null && a.prevValue !== a.newValue) return a
    }
    return undefined
  },
  lastStableBefore(anchors, nodeId, atMs) {
    for (let i = anchors.length - 1; i >= 0; i--) {
      const a = anchors[i]
      if (a.nodeId !== nodeId || a.prevValue == null || a.prevValue === a.newValue) continue
      if (Date.parse(a.at) <= atMs) return a
    }
    return undefined
  },
  lastRollbackAnchor(anchors, nodeId) {
    for (let i = anchors.length - 1; i >= 0; i--) {
      const a = anchors[i]
      if (a.nodeId === nodeId && a.source === 'rollback') return a
    }
    return undefined
  },
}

const repo = new RecipeRollBackRepo()
const NODES = ['n-a', 'n-b', 'n-c']
const N = 3000
const t0 = Date.now()
for (let i = 0; i < N; i++) {
  const nodeId = NODES[i % NODES.length]
  const prev = i % 7 === 0 ? null : i - 1 // 制造 prevValue==null 的锚
  const same = i % 11 === 0 // 制造 prevValue==newValue 的锚
  repo.appendAnchor({
    nodeId,
    prevValue: prev,
    newValue: same ? prev : i,
    source: i % 13 === 0 ? 'rollback' : 'agent',
    lineId: 'line-1',
    at: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1000).toISOString(),
  })
}
console.log(`\n写入 ${N} 锚耗时 ${Date.now() - t0}ms`)

console.log('\n━━━ 1. 索引版与线性扫描语义一致 ━━━')
const all = repo.listAnchors({ limit: N + 10 }) // 正序取回全部(倒序后再 reverse)
const anchorsAsc = [...all].reverse()
for (const nodeId of NODES) {
  const a1 = repo.lastAnchorOf(nodeId), a2 = ref.lastAnchorOf(anchorsAsc, nodeId)
  check(`lastAnchorOf(${nodeId}) 一致`, a1?.id === a2?.id, `${a1?.id} vs ${a2?.id}`)
  const s1 = repo.lastStableAnchor(nodeId), s2 = ref.lastStableAnchor(anchorsAsc, nodeId)
  check(`lastStableAnchor(${nodeId}) 一致`, s1?.id === s2?.id, `${s1?.id} vs ${s2?.id}`)
  const r1 = repo.lastRollbackAnchor(nodeId), r2 = ref.lastRollbackAnchor(anchorsAsc, nodeId)
  check(`lastRollbackAnchor(${nodeId}) 一致`, r1?.id === r2?.id, `${r1?.id} vs ${r2?.id}`)
  // 取该节点锚中位时刻
  const nodeAnchors = anchorsAsc.filter(a => a.nodeId === nodeId)
  const midMs = Date.parse(nodeAnchors[Math.floor(nodeAnchors.length / 2)].at)
  const b1 = repo.lastStableBefore(nodeId, midMs), b2 = ref.lastStableBefore(anchorsAsc, nodeId, midMs)
  check(`lastStableBefore(${nodeId}, mid) 一致`, b1?.id === b2?.id, `${b1?.id} vs ${b2?.id}`)
}

console.log('\n━━━ 2. open 记录索引 ━━━')
const rec = repo.insertRecord({ nodeId: 'n-a', status: 'open', policy: 'auto_rollback', setAt: new Date().toISOString(), params: [], lineId: 'line-1' })
check('openRecordOf 命中', repo.openRecordOf('n-a')?.id === rec.id)
check('listOpenRecords 含该条', repo.listOpenRecords().some(r => r.id === rec.id))
repo.updateRecord(rec.id, { status: 'judged' })
check('状态转 judged 后 openRecordOf 失效', repo.openRecordOf('n-a') === undefined)
check('listOpenRecords 不含已关闭记录', !repo.listOpenRecords().some(r => r.id === rec.id))
const rec2 = repo.insertRecord({ nodeId: 'n-b', status: 'open', policy: 'auto_rollback', setAt: new Date().toISOString(), params: [], lineId: 'line-1' })
check('新 open 可再次命中', repo.openRecordOf('n-b')?.id === rec2.id)
const s = repo.stats()
check('stats.open 与索引一致', s.open === repo.listOpenRecords().length, `${s.open} vs ${repo.listOpenRecords().length}`)

console.log('\n━━━ 3. 热路径性能(索引 vs 线性) ━━━')
// 测量场景的选择很关键:用「尾部有锚」的节点测,**线性实现逆序第 3 步就命中**,
// 两者都在亚毫秒级,ms 分辨率下测到的只是噪声(实测过 1ms vs 0ms 的假阴性)。
// 索引真正解决的是**冷查询**:查询的节点在表中没有锚(或锚在很靠前),
// 线性实现必须逆序扫完全表,索引实现是 O(1)。这才是应该被断言的性质。
const COLD = 'n-absent'
check('冷查询结果一致(索引 vs 线性)', repo.lastStableAnchor(COLD) === ref.lastStableAnchor(anchorsAsc, COLD))

/** 单调高精度计时(ms,小数) */
const nowMs = () => Number(process.hrtime.bigint()) / 1e6
const ITER = 20000
// 预热(V8 JIT + 索引首次构建),否则首轮把编译开销算进结果
for (let i = 0; i < 2000; i++) {
  repo.lastStableAnchor(COLD)
  ref.lastStableAnchor(anchorsAsc, COLD)
}

let t = nowMs()
for (let i = 0; i < ITER; i++) repo.lastStableAnchor(COLD)
const indexedMs = nowMs() - t
t = nowMs()
for (let i = 0; i < ITER; i++) ref.lastStableAnchor(anchorsAsc, COLD)
const linearMs = nowMs() - t
console.log(`  冷查询 ×${ITER}:索引 ${indexedMs.toFixed(2)}ms  vs  线性 ${linearMs.toFixed(2)}ms  (快 ${(linearMs / Math.max(indexedMs, 0.001)).toFixed(0)}x)`)
// 断言留 1.5x 余量:索引是 O(1)、线性是 O(表长),在 20000×3000 规模下差距是数量级,
// 不应用浮点相等去卡死(CI 机器抖动会误报)
check('冷查询索引版显著快于线性版(≥1.5x)', indexedMs * 1.5 <= linearMs,
  `索引 ${indexedMs.toFixed(2)}ms vs 线性 ${linearMs.toFixed(2)}ms`)

console.log(`\n━━━ 结果:${pass} passed, ${fail} failed ━━━\n`)
process.exit(fail === 0 ? 0 : 1)
