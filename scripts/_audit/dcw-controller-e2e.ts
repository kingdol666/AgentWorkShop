/**
 * 审计实验 5 —— 端到端:真实 DcwController + mock 驱动,验证
 *  ① 正常写:硬件写入 + 账本锚 + 写历史(正对照)
 *  ② PATCH decimals 越界 → 接口层 400 拒绝(0..6 校验已收敛,记账洞保持关闭);
 *     合法 decimals 变更后正常写:硬件/账本/写历史三者一致
 *  ③ 不存在节点 id 的语义(服务层 404)
 *
 * cwd 已切到 scripts/_audit/.tmp:所有仓库文件写到临时目录,绝不碰 server/data/*。
 * 运行:node --experimental-transform-types scripts/_audit/run.mjs scripts/_audit/dcw-controller-e2e.ts
 */
import { mkdirSync, rmSync } from 'node:fs'

// 审计需在同一节点上连续多次写(stepLimit/60s 间隔/保持窗会挡住秒级连写);
// 走基准同款旁路(AW_BENCH_MODE=1,仅豁免在线探索限频,四层限界联锁照常生效)。
process.env.AW_BENCH_MODE = '1'

// 清空本次实验的隔离数据目录(run.mjs 已把 AW_DATA_DIR 指向 scripts/_audit/.tmp/audit-data;
// 同目录其它实验残留的 20000 锚账本会污染断言,故先清空)
const ISOLATED = new URL('./.tmp/audit-data/', import.meta.url)
rmSync(ISOLATED, { recursive: true, force: true })
mkdirSync(ISOLATED, { recursive: true })
// 清空上次实验留下的临时库(benchmark 会写出 10MB+ 的 dcw-rollback.json)
rmSync(new URL('./.tmp/server/', import.meta.url), { recursive: true, force: true })
mkdirSync(new URL('./.tmp/server/data/', import.meta.url), { recursive: true })
process.chdir(new URL('./.tmp/', import.meta.url).pathname.replace(/^\//, ''))

const { getDcwController } = await import('../../server/services/workshop/dcw/dcw-controller')
const { getRecipeRollBackRepo } = await import('../../server/services/workshop/dcw/recipe-rollback.repo')
const { getDcwRecipeRepo } = await import('../../server/services/workshop/dcw/dcw-recipe.repo')

let failures = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  PASS  ${name}${extra ? ` (${extra})` : ''}`)
  }
  else {
    failures++
    console.log(`  FAIL  ${name}${extra ? ` (${extra})` : ''}`)
  }
}

const mockPlc = (globalThis as { __dcwMockPlc?: Map<string, number> }).__dcwMockPlc!
const plcValue = (): number | undefined => mockPlc.get('default')

const ctrl = getDcwController()
const ledger = getRecipeRollBackRepo()
const writes = getDcwRecipeRepo()

const node = ctrl.create({ templateRef: 'temp-sp', driver: 'mock', min: 150, max: 200, decimals: 1, enabled: true })
console.log(`  节点 ${node.id} 创建(mock 驱动,min150 max200 decimals1)`)

console.log('\n=== ① 正对照:正常写 ===')
{
  const anchorsBefore = ledger.stats().anchors
  const out = await ctrl.write(node.id, 160, null, { source: 'manual', actor: 'audit' })
  check('写入返回 ok', out.ok === true, out.message)
  check('mock PLC 记录写入值 160(硬件已写)', plcValue() === 160, `plc=${plcValue()}`)
  check('账本新增 1 条锚', ledger.stats().anchors === anchorsBefore + 1, `anchors=${ledger.stats().anchors}`)
  check('写历史新增 1 条', writes.historyList(5).length === 1, `n=${writes.historyList(5).length}`)
  check('节点 value=160', node.value === 160, `value=${node.value}`)
}

console.log('\n=== ② PATCH decimals 越界被拒;合法变更后三者一致 ===')
{
  let e400: unknown
  try {
    ctrl.patch(node.id, { decimals: 101 })
  }
  catch (e) {
    e400 = e
  }
  const status = (e400 as { status?: number })?.status
  check('PATCH decimals=101 被接口拒绝(400,0..6 校验)', status === 400, `status=${status}`)

  const patched = ctrl.patch(node.id, { decimals: 2 })
  check('合法 PATCH decimals=2 被接受', patched.decimals === 2, `decimals=${patched.decimals}`)

  const anchorsBefore = ledger.stats().anchors
  const historyBefore = writes.historyList(50).length
  const out = await ctrl.write(node.id, 170, null, { source: 'manual', actor: 'audit' })
  check('写 170 返回 ok', out.ok === true, out.message)
  check('mock PLC 已记录 170(硬件已写)', plcValue() === 170, `plc=${plcValue()}`)
  check('账本新增 1 条锚(可回退)', ledger.stats().anchors === anchorsBefore + 1, `anchors=${ledger.stats().anchors}`)
  check('写历史新增 1 条(审计不缺位)', writes.historyList(50).length === historyBefore + 1, `n=${writes.historyList(50).length}`)
  check('节点 value=170', node.value === 170, `value=${node.value}`)

  const stable = ledger.lastStableAnchor(node.id)
  console.log(`  账本最新稳定锚={prev:${stable?.prevValue}, new:${stable?.newValue}};硬件实际=${plcValue()};节点显示=${node.value}`)
  check('硬件(170)= 账本(170)= 节点(170):三者一致', plcValue() === 170 && stable?.newValue === 170 && node.value === 170)
}

console.log('\n=== ③ 不存在节点 id 的服务层语义 ===')
{
  let e404: unknown
  try {
    await ctrl.write('dw-nonexistent', 160, null, { source: 'manual', actor: 'audit' })
  }
  catch (e) {
    e404 = e
  }
  const status = (e404 as { status?: number })?.status
  check('不存在节点 → AppError 404(控制器层)', status === 404, `status=${status}`)
}

console.log(`\nresult: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
