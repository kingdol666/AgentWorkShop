/**
 * Phase 5/6 前端契约：图谱/注入/健康视图与 API 面存在，关键 testid 不漂移。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

test('memory page exposes four views and graph components', () => {
  const page = read('app/pages/memory/index.vue')
  assert.ok(page.includes('memory-view-switch'))
  assert.ok(page.includes('<MemoryGraphView'))
  assert.ok(page.includes('<MemoryInjectionTracePanel'))
  assert.ok(page.includes('<MemoryHealthPanel'))
  assert.ok(page.includes('views.injections'))
  assert.ok(page.includes('views.health'))
  assert.ok(!page.includes('--aw-text-3'), '不应残留 ghost token')
})

test('graph components carry testids and drawers are editable', () => {
  const canvas = read('app/components/memory/MemoryGraphCanvas.vue')
  assert.ok(canvas.includes('data-testid="memory-graph"'))
  assert.ok(canvas.includes('GraphChart'))
  const entity = read('app/components/memory/MemoryGraphEntityDrawer.vue')
  assert.ok(entity.includes('data-testid="memory-graph-entity-drawer"'))
  assert.ok(entity.includes('data-testid="memory-graph-entity-save"'))
  assert.ok(entity.includes('memoryGraphApi.mergeEntity'))
  const edge = read('app/components/memory/MemoryGraphEdgeDrawer.vue')
  assert.ok(edge.includes('data-testid="memory-graph-edge-drawer"'))
  assert.ok(edge.includes('data-testid="memory-graph-edge-save"'))
  assert.ok(edge.includes('memoryGraphApi.rejectEdge'))
  const view = read('app/components/memory/MemoryGraphView.vue')
  assert.ok(view.includes('data-testid="memory-graph-run"'))
  assert.ok(view.includes('data-testid="memory-graph-rebuild"'))
  assert.ok(view.includes('data-testid="memory-graph-table"'))
})

test('graph REST routes and global trace/repair routes exist', () => {
  const base = 'server/api/workshop/channels/[id]/memory-graph'
  for (const p of [
    'index.get.ts',
    'entities/index.get.ts',
    'entities/index.post.ts',
    'entities/[entityId].patch.ts',
    'entities/[entityId]/merge.post.ts',
    'edges/index.post.ts',
    'edges/[edgeId].patch.ts',
    'merge-candidates/index.get.ts',
    'communities/index.get.ts',
    'runs/index.post.ts',
    'settings/index.patch.ts',
  ]) assert.ok(existsSync(join(root, base, p)), `缺少路由 ${p}`)
  assert.ok(existsSync(join(root, 'server/api/workshop/memory/injections/index.get.ts')))
  assert.ok(existsSync(join(root, 'server/api/workshop/memory/repair/index.post.ts')))
})

test('tool catalog contains memory_graph_query and i18n views exist in both locales', () => {
  const tools = read('.AgentWorkShop/prompts/host-tools.json')
  assert.ok(tools.includes('"memory_graph_query"'))
  const zh = read('i18n/locales/zh-CN.ts')
  const en = read('i18n/locales/en.ts')
  for (const locale of [zh, en]) {
    assert.ok(locale.includes('injections:'), '缺少注入追踪视图 key')
    assert.ok(locale.includes('health:'), '缺少健康视图 key')
  }
})
