/**
 * WP6 工具面预算与分页(纯函数,不联网):
 *  - 描述折叠确定性:同一绑定面两次编译逐字节相同(防 list_changed 抖动);
 *  - 预算生效:超预算折叠并附 industrial_resources 引导语;小面不折叠;
 *  - AW_DESC_BUDGET=0 关闭折叠(回滚);
 *  - industrial_resources 分页:筛选/排序确定性/边界(limit 钳制、offset 越界)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'

const { foldList, sortedById, descBudget, RESOURCES_GUIDE } = await import('../server/services/workshop/agents/host-tool-bridge/description-budget')
const { paginateResourceItems } = await import('../server/services/workshop/agents/industrial/resource-paging')

test('折叠确定性:同一输入两次输出逐字节相同(乱序输入排序后一致)', () => {
  const src = Array.from({ length: 40 }, (_, i) => ({ id: `dn-${String(i).padStart(3, '0')}`, s: `节点${i}(dn-${String(i).padStart(3, '0')})` }))
  const ordered = sortedById(src).map(x => x.s)
  const a = foldList('绑定:', ordered, RESOURCES_GUIDE, 200)
  const b = foldList('绑定:', [...ordered], RESOURCES_GUIDE, 200)
  assert.equal(a, b, '同序输入两次折叠必须逐字节相同')
  const shuffled = [...src].reverse()
  const c = foldList('绑定:', sortedById(shuffled).map(x => x.s), RESOURCES_GUIDE, 200)
  assert.equal(c, a, '乱序输入经排序后折叠结果必须与有序输入一致')
})

test('预算:小绑定面不折叠;超预算折叠为前 N 项 + 总数 + 查询引导', () => {
  const small = foldList('绑定:', ['a(dn-1)', 'b(dn-2)'], RESOURCES_GUIDE, 400)
  assert.ok(!small.includes('等 2 项'))
  assert.ok(!small.includes('industrial_resources'))

  const many = foldList('绑定:', Array.from({ length: 100 }, (_, i) => `节点${i}(dn-${i})`), RESOURCES_GUIDE, 200)
  assert.ok(many.length <= 200 + 40, `折叠后长度 ${many.length} 应接近预算`)
  assert.match(many, /等 100 项/)
  assert.match(many, /industrial_resources/)
})

test('折叠回滚开关:AW_DESC_BUDGET=0 → 全量输出', () => {
  const prev = process.env.AW_DESC_BUDGET
  process.env.AW_DESC_BUDGET = '0'
  try {
    assert.equal(descBudget(), 0)
    const out = foldList('绑定:', Array.from({ length: 100 }, (_, i) => `n${i}(dn-${i})`))
    assert.ok(!out.includes('industrial_resources'))
    assert.ok(out.includes('n99(dn-99)'))
  }
  finally {
    if (prev === undefined) delete process.env.AW_DESC_BUDGET
    else process.env.AW_DESC_BUDGET = prev
  }
})

test('单条超预算:首项必须保留(不得产出空「等 N 项」折叠)', () => {
  // 配方条目带完整参数面(名称+id+全部参数节点),单条即可超预算(2026-10-24 实测回归:
  // 单绑定 Agent 的配方描述被折叠成「等 1 项」,连 recipe id 都丢失)
  const longItem = `注塑工艺配方(rc-475bb95c,v2;参数:${Array.from({ length: 30 }, (_, i) => `参数${i}(dn-param-${i},bar)`).join('、')})`
  assert.ok(longItem.length > 400)
  const out = foldList('\n\n本 Agent 已绑定的配方(仅这些可写/下发):', [longItem], RESOURCES_GUIDE, 400)
  assert.ok(out.includes('rc-475bb95c'), '首项 id 必须保留在描述中')
  assert.ok(!out.includes('等 1 项'), '单条绑定不得折叠为空「等 1 项」')
  // 多条且首条超预算:首条保留,后续按预算收紧
  const multi = foldList('绑定:', [longItem, 'b(rc-2)', 'c(rc-3)'], RESOURCES_GUIDE, 400)
  assert.ok(multi.includes('rc-475bb95c'))
  assert.match(multi, /等 3 项/)
})

test('分页:确定性排序(kind→id)、query 过滤、limit 钳制、offset 越界', () => {
  const items = [
    { kind: 'recipe', id: 'r-2', name: '配方B' },
    { kind: 'daq', id: 'dn-2', name: '节点2' },
    { kind: 'daq', id: 'dn-1', name: '节点1', detail: '压力' },
  ]
  const p1 = paginateResourceItems(items, { limit: 2 })
  assert.deepStrictEqual(p1.page.map(x => x.id), ['dn-1', 'dn-2'])
  assert.equal(p1.total, 3)
  assert.equal(p1.hasMore, true)

  const p2 = paginateResourceItems(items, { offset: 2, limit: 2 })
  assert.deepStrictEqual(p2.page.map(x => x.id), ['r-2'])
  assert.equal(p2.hasMore, false)

  const q = paginateResourceItems(items, { query: '压力' })
  assert.deepStrictEqual(q.page.map(x => x.id), ['dn-1'])

  const clamped = paginateResourceItems(items, { limit: 9999 })
  assert.equal(clamped.limit, 200)
  const beyond = paginateResourceItems(items, { offset: 99 })
  assert.deepStrictEqual(beyond.page, [])
  assert.equal(beyond.hasMore, false)
})
