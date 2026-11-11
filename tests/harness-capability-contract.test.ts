/**
 * Harness 能力声明契约(计划 H5-H8,2026-11-11)。
 *
 * 锁定三条真值线:
 *  1) registry 能力徽标 ↔ 实现/使用一致(mock 有 supervise 剧本且被调度使用,不得声明 false);
 *  2) toolSurface 标注 ↔ 平台真实装配行为一致(crush 缺省时平台自动整份写 .crushrc,属 bridge);
 *  3) hitl-capabilities evidence 锚点可机检(path:line keyword;适配器目录化重构后必须回填,
 *     防止"证据指向不存在的文件"再次发生);omp 的条件能力(rpcMode)必须显式标注 configNote。
 * 另:pi/mock 的工具行发射面以源码契约锁定(防"发射者清单"虚标)。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.AGENTWORKSHOP_TEST = '1'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

const { HARNESS_REGISTRY, harnessMetas } = await import('../server/services/workshop/agents/registry.ts')
const { createAgentImpl } = await import('../server/services/workshop/agents/factory.ts')
const { DECLARATIONS, hitlCapabilityOf } = await import('../server/services/workshop/agents/hitl-capabilities.ts')

describe('registry 能力 ↔ 实现一致', () => {
  it('mock supervise 声明为 true(mock-agent 实现剧本且被 lead 调度真实消费)', () => {
    assert.equal(HARNESS_REGISTRY.mock!.capabilities.supervise, true, 'mock 有 supervise 实现(runtime 剧本),声明 false 即徽标失真')
    const impl = createAgentImpl({ id: 't-mock', agentId: 'agent-mock', channelId: 'ch', name: 'm', role: 'lead', harness: 'mock' } as never) as unknown as Record<string, unknown>
    assert.equal(typeof impl.supervise, 'function')
  })
})

describe('toolSurface 标注 ↔ 平台装配行为一致', () => {
  it('crush 标注 bridge(ensureCrushConfig 会在 .crushrc 缺失时自动整份写入 aw 桥)', () => {
    const meta = harnessMetas().find(m => m.id === 'crush')!
    assert.equal(meta.toolSurface, 'bridge', '平台自动装配桥的引擎不得标 manual(与 hint 文案互相矛盾的根源)')
    assert.equal(read('server/services/workshop/agents/crush-agent.ts').includes('export function ensureCrushConfig'), true, '自动写入实现必须在位')
  })
  it('pi / mock 发射面源码契约:pi 无 🔧 工具行发射点;mock 无工具面', () => {
    assert.ok(!/sink\.status/.test(read('server/services/workshop/agents/pi-agent.ts')), 'pi 当前无工具行发射点;接入时必须同步 tests/agent-blocks.test.ts 发射矩阵')
    assert.ok(!read('server/services/workshop/agents/mock-agent.ts').includes('🔧'), 'mock 不发工具行(设计)')
  })
})

describe('hitl-capabilities evidence 漂移守卫', () => {
  const EXPR = /^(.+?\.ts):(\d+)\s+(.+)$/
  for (const [harness, decl] of Object.entries(DECLARATIONS)) {
    it(`${harness}: evidence 锚点文件存在且关键字在位`, () => {
      assert.ok(decl.evidence.length > 0, `${harness} 至少给出一条静态证据`)
      for (const ev of decl.evidence) {
        const m = EXPR.exec(ev)
        assert.ok(m, `${harness} evidence 必须是 'path:line keyword' 形: ${ev}`)
        const [, rel, lineStr, keyword] = m as unknown as [string, string, string, string]
        const abs = join(ROOT, rel)
        assert.ok(existsSync(abs), `${harness} evidence 文件不存在: ${rel}`)
        const lines = readFileSync(abs, 'utf-8').split(/\r?\n/)
        const lineNo = Number(lineStr)
        const window = lines.slice(Math.max(0, lineNo - 26), lineNo + 25)
        assert.ok(
          window.some(l => l.includes(keyword)),
          `${harness} evidence 关键字 '${keyword}' 不在 ${rel}:${lineNo} ±25 行内`,
        )
      }
    })
  }
  it('omp 条件能力显式标注 configNote(rpcMode=rpc 时无对话框 HITL)', () => {
    const rec = hitlCapabilityOf('omp', { refresh: false })
    assert.ok(rec.configNote && rec.configNote.includes('rpcMode'), 'omp 必须标注 HITL/terminal 的 rpcMode 条件')
  })
})
