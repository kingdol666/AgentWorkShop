/**
 * 审计实验 2 —— RecipeRollBackRepo 账本算法/落盘成本(只读审计)。
 *
 * 关键:cwd 切到 scripts/_audit/.tmp,使 repo 的 DATA_DIR 指向临时目录,
 * **绝不触碰 server/data/dcw-rollback.json**(真实数据文件)。
 *
 * 运行:node --experimental-transform-types scripts/_audit/run.mjs scripts/_audit/dcw-rollback-ledger.ts
 */
import { mkdirSync } from 'node:fs'

const TMP = new URL('./.tmp/', import.meta.url)
mkdirSync(new URL('server/data/', TMP), { recursive: true })
process.chdir(new URL('.tmp/', new URL('.', import.meta.url)).pathname.replace(/^\//, ''))

const { RecipeRollBackRepo } = await import('../../server/services/workshop/dcw/recipe-rollback.repo')

const CAP_ANCHORS = 20000
const CAP_RECORDS = 2000

function anchorOf(i: number, nodeId = `n-${i % 50}`) {
  return {
    lineId: 'ln-audit',
    nodeId,
    prevValue: i,
    newValue: i + 1,
    source: 'manual' as const,
    actor: 'user',
    recipeRunId: null,
  }
}

/** 贴近真实形状的 windowAgg(实测 server/data/dcw-rollback.json:平均记录 1267 B) */
function aggOf(nodeId: string) {
  return {
    at: new Date().toISOString(),
    fromMs: Date.now() - 600_000,
    toMs: Date.now(),
    channels: Array.from({ length: 8 }, (_, k) => ({
      daqNodeId: `dq-${k}`,
      ch: `CH${k}`,
      unit: 'C',
      latest: 123.45,
      avg: 121.11,
      min: 100.5,
      max: 140.25,
      cnt: 120,
      breaches: 0,
      nodeIdFallback: nodeId,
    })),
  }
}

function ms(fn: () => void): number {
  const t0 = performance.now()
  fn()
  return performance.now() - t0
}
function report(label: string, totalMs: number, iters: number): void {
  console.log(`  ${label}: total=${totalMs.toFixed(1)}ms  per-op=${(totalMs / iters).toFixed(3)}ms  (iters=${iters})`)
}

console.log('=== A. anchors 到达上限后的每次 appendAnchor 成本 ===')
{
  const repo = new RecipeRollBackRepo()
  for (let i = 0; i < CAP_ANCHORS; i++) repo.appendAnchor(anchorOf(i))
  console.log(`  填充后 anchors=${repo.stats().anchors}(cap=${CAP_ANCHORS})`)
  const iters = 200
  const t = ms(() => {
    for (let i = 0; i < iters; i++) repo.appendAnchor(anchorOf(CAP_ANCHORS + i))
  }, iters)
  report('appendAnchor(在上限稳态,每次触发 splice+new Set)', t, iters)
  console.log(`  追加后 anchors=${repo.stats().anchors}(仍为 cap,说明每写都触发淘汰路径)`)

  console.log('\n=== B. 查询方法成本(20000 锚 / 50 节点) ===')
  const nodeId = 'n-0'
  let t1 = ms(() => { for (let i = 0; i < 1000; i++) repo.lastStableAnchor(nodeId) }, 1000)
  report('lastStableAnchor (O(1) 索引)', t1, 1000)
  t1 = ms(() => { for (let i = 0; i < 1000; i++) repo.lastRollbackAnchor(nodeId) }, 1000)
  report('lastRollbackAnchor (节点子序列倒扫)', t1, 1000)
  t1 = ms(() => { for (let i = 0; i < 200; i++) repo.anchorById('anc-nonexistent') }, 200)
  report('anchorById (全量 find,未命中=最坏)', t1, 200)
  t1 = ms(() => { for (let i = 0; i < 200; i++) repo.listAnchors({ lineId: 'ln-nope', limit: 100 }) }, 200)
  report('listAnchors({lineId}) 无命中 → 全量 20000 倒扫', t1, 200)
  t1 = ms(() => { for (let i = 0; i < 200; i++) repo.listAnchors({ nodeId, limit: 30 }) }, 200)
  report('listAnchors({nodeId, limit:30}) 走索引', t1, 200)
}

console.log('\n=== C. records(2000 上限)+ open 索引 ===')
{
  const repo = new RecipeRollBackRepo()
  for (let i = 0; i < CAP_RECORDS; i++) {
    repo.insertRecord({
      lineId: 'ln-audit',
      nodeId: `n-${i % 50}`,
      nodeName: `node-${i % 50}`,
      recipeId: null,
      hypothesis: 'h',
      params: [{ nodeId: `n-${i % 50}`, templateRef: 'cw-temp', from: i, to: i + 1 }],
      setAt: new Date().toISOString(),
      status: 'open',
      judge: null,
      anchorId: `anc-${i}`,
      policy: 'auto_rollback',
    })
  }
  console.log(`  records=${repo.stats().records} open=${repo.stats().open}(每节点仅索引最后一条)`)
  const t = ms(() => { for (let i = 0; i < 200; i++) repo.listOpenRecords() }, 200)
  report('listOpenRecords (O(open))', t, 200)
  const t2 = ms(() => { for (let i = 0; i < 200; i++) repo.chainRollbackCount('n-0') }, 200)
  report('chainRollbackCount (全量 2000 filter)', t2, 200)
  const t3 = ms(() => { for (let i = 0; i < 2000; i++) repo.byId('opt-nonexistent') }, 2000)
  report('byId (全量 find,未命中=最坏)', t3, 2000)
}

console.log('\n=== D. 同节点第二条 open 记录 → 索引可见性 ===')
{
  const repo = new RecipeRollBackRepo()
  const r1 = repo.insertRecord({ nodeId: 'n-x', status: 'open', policy: 'auto_rollback', setAt: new Date().toISOString(), params: [], lineId: 'l' } as never)
  const r2 = repo.insertRecord({ nodeId: 'n-x', status: 'open', policy: 'auto_rollback', setAt: new Date().toISOString(), params: [], lineId: 'l' } as never)
  const open = repo.listOpenRecords()
  const listed = repo.listRecords({ nodeId: 'n-x', status: 'open', limit: 50 })
  console.log(`  insertRecord #1=${r1.id} #2=${r2.id}`)
  console.log(`  listOpenRecords() 返回 ${open.length} 条;listRecords(status=open) 返回 ${listed.length} 条`)
  console.log(`  → 未被索引的 open 记录是否可达:${open.some(r => r.id === r1.id) ? '可达' : '不可达(永不被 sweep 评估)'}`)
}

console.log('\n=== E. flushNow(全量序列化)成本 ===')
{
  const repo = new RecipeRollBackRepo()
  for (let i = 0; i < CAP_ANCHORS; i++) repo.appendAnchor(anchorOf(i))
  for (let i = 0; i < CAP_RECORDS; i++) {
    repo.insertRecord({
      lineId: 'ln-audit',
      nodeId: `n-${i % 50}`,
      nodeName: `node-${i % 50}`,
      recipeId: null,
      hypothesis: 'h',
      params: [{ nodeId: `n-${i % 50}`, templateRef: 'cw-temp', from: i, to: i + 1 }],
      setAt: new Date().toISOString(),
      status: 'closed-line-stop',
      judge: null,
      anchorId: `anc-${i}`,
      policy: 'auto_rollback',
      windowAgg: aggOf(`n-${i % 50}`),
    } as never)
  }
  const iters = 20
  const t = ms(() => { for (let i = 0; i < iters; i++) repo.flushNow() }, iters)
  report(`flushNow(anchors=${CAP_ANCHORS} + records=${CAP_RECORDS} 含聚合)`, t, iters)
  const { statSync } = await import('node:fs')
  const size = statSync(process.cwd() + '/server/data/dcw-rollback.json').size
  console.log(`  落盘文件大小=${(size / 1024 / 1024).toFixed(2)} MB(每次 agent/rollback 写后同步全量重写)`)
}
