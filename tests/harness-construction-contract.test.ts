/**
 * 引擎构造契约测试（P0-1 闸门，2026-11-08 生产审计）
 *
 * 教训：one-shot 家族 6 引擎（gemini/copilot/cursor/crush/goose/pi）在 2026-10-31 回归后
 * 构造即 TypeError（基类构造器读子类 getter harnessId，而子类字段 spec 在 super() 之后才赋值），
 * 潜伏 8 天无人发现 —— 因为**没有任何测试覆盖「每个 harness 至少能实例化」**。
 *
 * 本测试锁死这条最基础的契约：registry 全集逐个构造，任何引擎抛错即红。
 * CI 必跑（package.json test:unit → tests/*.test.ts）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'

const { HARNESS_REGISTRY, harnessMetas } = await import('../server/services/workshop/agents/registry.ts')
const { createAgentImpl } = await import('../server/services/workshop/agents/factory.ts')
const { checkAllHarnessAvailability } = await import('../server/services/workshop/agents/harness-availability.ts')

/** HARNESS_REGISTRY 是 Record<id, HarnessDef>(非数组) */
const ALL = Object.keys(HARNESS_REGISTRY)

/** 最小可构造配置(各引擎只读取所需键;缺省值都有回退) */
const baseConfig = (harness: string) => ({
  id: `t-${harness}`,
  agentId: `agent-${harness}`,
  channelId: 'ch-test',
  name: `contract-${harness}`,
  role: 'worker' as const,
  harness,
})

describe('引擎构造契约 · registry 全集', () => {
  it('registry 至少 14 个引擎(回归护栏:删/漏注册即红)', () => {
    assert.ok(ALL.length >= 14, `registry 仅 ${ALL.length} 个: ${ALL.join(',')}`)
  })

  for (const harness of ALL) {
    it(`${harness} 可实例化(不抛错)`, () => {
      // 契约:构造不得依赖外部进程/网络/凭据(lazy spawn);只验证装配面
      const impl = createAgentImpl(baseConfig(harness) as never)
      assert.ok(impl, '应返回实现实例')
      assert.equal(typeof impl.run, 'function', '必须实现 run()')
    })
  }

  it('one-shot 家族 6 引擎构造后 harnessId 已补齐(P0-1 专项回归)', async () => {
    // 这 6 个走 OneShotCliAgentImpl：spec 就绪后必须再 refreshIdentity 一次，
    // 否则 identity.harness 永久为空(审计/路由面丢失引擎标识)。
    const ONE_SHOT = ['gemini', 'copilot', 'cursor', 'crush', 'goose', 'pi']
    for (const harness of ONE_SHOT.filter(h => ALL.includes(h))) {
      const impl = createAgentImpl(baseConfig(harness) as never) as unknown as {
        bridgeCtx?: { identity?: { harness?: string } }
      }
      // 反射读取 protected 字段(测试专用;生产调用方不需要)
      const id = impl.bridgeCtx?.identity?.harness
      assert.equal(id, harness, `${harness}: identity.harness 应为 '${harness}',实际 '${id ?? ''}'`)
    }
  })

  it('能力声明 ↔ 方法存在性(2026-11-10 D4:徽标不得承诺平台做不到的事)', () => {
    // 单向断言:声明 true 就必须有实现。反向不断言 —— 保守声明(有 stub 但声明 false)
    // 是允许的,例如 dsh/hermes 的 steer 恒返回 deferred。
    for (const harness of ALL) {
      const caps = HARNESS_REGISTRY[harness]!.capabilities
      const impl = createAgentImpl(baseConfig(harness) as never) as unknown as Record<string, unknown>
      if (caps.steer) assert.equal(typeof impl.steer, 'function', `${harness}: 声明 steer:true 却没有 steer()`)
      if (caps.compact) assert.equal(typeof impl.onTurnSettled, 'function', `${harness}: 声明 compact:true 却没有 onTurnSettled()`)
      if (caps.contextStats) assert.equal(typeof impl.getContextStats, 'function', `${harness}: 声明 contextStats:true 却没有 getContextStats()`)
    }
  })

  it('D5:工具面需手工接入的引擎被如实标注(并给出配置指引)', () => {
    const metas = harnessMetas()
    const manual = metas.filter(m => m.toolSurface === 'manual').map(m => m.id).sort()
    assert.deepEqual(manual, ['crush', 'dsh', 'hermes'], '手工接入引擎必须显式标注,否则"没有平台工具"无从判断')
    assert.equal(metas.find(m => m.id === 'omp')!.toolSurface, 'bridge')
    assert.equal(metas.find(m => m.id === 'mock')!.toolSurface, 'none')

    const rows = checkAllHarnessAvailability()
    for (const id of manual) {
      const row = rows.find(r => r.id === id)!
      assert.equal(row.toolSurface, 'manual')
      assert.ok(row.toolSurfaceHint, `${id} 必须给出配置指引`)
    }
  })
})
