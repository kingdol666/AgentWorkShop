/**
 * 产线节点清单契约(第二轮 E3/E4)。
 * 11 列表格在 1440 把「控制中」挤成竖排、390 下读数与写入口完全滚出屏外;
 * 契约保证清单回到“响应式节点卡”,同时所有控制动作与写输入绑定仍在。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = readFileSync(join(ROOT, 'app/components/dcw/DcwNodesTable.vue'), 'utf-8')

test('节点清单不再使用横向宽表', () => {
  assert.equal(/<table[\s>]/.test(SOURCE), false)
  assert.match(SOURCE, /data-testid="dcw-node-card"/)
  assert.match(SOURCE, /class="node-grid"/)
})

test('节点卡保留全部控制动作与写输入绑定', () => {
  for (const event of ['toggle', 'read', 'write', 'patch-step-limit', 'artifacts', 'remove']) {
    assert.ok(SOURCE.includes(`'${event}'`), `missing emit ${event}`)
  }
  assert.match(SOURCE, /setInputs\[n\.id\]/)
  assert.match(SOURCE, /stepDrafts\[n\.id\]/)
  assert.match(SOURCE, /removeNodeConfirm/)
})

test('390 档节点卡单列且不再依赖横向卷轴', () => {
  assert.match(SOURCE, /@media \(max-width: 900px\)[\s\S]*?\.node-grid \{ grid-template-columns: 1fr; \}/)
  assert.equal(/nodes-table \{ min-width/.test(SOURCE), false)
})
