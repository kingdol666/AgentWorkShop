/**
 * 契约回归（2026-11-28 实机缺陷）：生产侧构造 AgentMemory **不得**传 `embedder` 快照。
 *
 * 背景：`AgentMemoryState.embedder` 的语义是「显式注入优先，否则按配置动态解析」。
 * manager 常驻实例如果构造时把 `this.memoryEmbedder`（当时的 provider）传进去，就把它
 * 钉死在实例生命周期上 —— 记忆中心切换本地模型后，写路径仍用旧模型编码：`vecInit(新维度)`
 * 与真实表不符 → `vectorizeMemory` 静默跳过 → 新记忆永远没有向量（直到进程重启）。
 * 实机复现：512→384 切换并回填后，新写入 pending=1；切回 512 又“正常”，极具迷惑性。
 *
 * 因此生产构造点保持缺省（动态解析）；只有测试/特殊实例才显式注入。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const FILES = [
  'runtime/manager/runtime-wiring.ts',
  'runtime/manager/admin-agents.ts',
  'runtime/manager/state.ts',
]

test('生产构造点不传 embedder（保持 provider 动态解析）', () => {
  for (const rel of FILES) {
    const src = readFileSync(new URL(`../server/services/workshop/${rel}`, import.meta.url), 'utf8')
    const sites = [...src.matchAll(/new AgentMemory\([^\n]*/g)].map(m => m[0])
    assert.ok(sites.length > 0, `${rel} 应至少有一处构造（夹具失效?）`)
    for (const site of sites) {
      assert.equal(/embedder\s*:/.test(site), false, `${rel} 传了 embedder 快照: ${site.slice(0, 160)}`)
    }
  }
})
