/**
 * AEP agent.block 管线中层单测(计划 H1-H4,2026-11-11)。
 *
 * 覆盖:
 *  1) 协议面:AepEvent 联合/AEP_GROUPS 必须收录 agent.block(此前仅靠 envelope string 通行);
 *  2) selectStatusFrame 纯函数:原生块优先 / 无原生块时 🔧 文本归一兜底(带 harness 归因) /
 *     空白文本不派生 / 坏原生载荷回落归一;
 *  3) durationMs 死字段移除后的协议面(块对象不得携带无人填充的键)。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const { normalizeToolLine, toolBlockDataPart, AGENT_BLOCK_MEDIA_TYPE } = await import('../shared/agent-blocks.ts')
const { AEP_GROUPS } = await import('../shared/workshop-protocol.ts')
const { selectStatusFrame } = await import('../shared/agent-blocks.ts')

describe('AEP 协议面 · agent.block 入册', () => {
  it('AEP_GROUPS.tools 收录 agent.block(与文本孪生帧同组)', () => {
    assert.ok(AEP_GROUPS.tools.includes('agent.block'), `tools 分组实际=${JSON.stringify(AEP_GROUPS.tools)}`)
  })
  it('AEP_GROUPS.messages 的文本孪生帧与结构块保持同组可见(messages 档不丢工具帧)', () => {
    // 派生面契约:agent.status.message 在 messages 组,则其结构孪生 agent.block 也在
    if (AEP_GROUPS.messages.includes('agent.status.message')) {
      assert.ok(AEP_GROUPS.messages.includes('agent.block'), '结构块必须与文本孪生同组,否则「消息」过滤下工具帧消失')
    }
  })
})

describe('selectStatusFrame · 原生优先/归一兜底', () => {
  it('原生 data Part 优先:blocks 提取,不派生', () => {
    const native = normalizeToolLine('🔧 daq_query({"node_id":"dn-1"})', 'omp')!
    const frame = selectStatusFrame([{ text: '前置' }, toolBlockDataPart(native)], 'omp')
    assert.equal(frame.blocks.length, 1)
    assert.equal(frame.blocks[0].tool, 'daq_query')
    assert.equal(frame.blocks[0].harness, 'omp')
    assert.equal(frame.derived, null, '已有原生块时不得再派生')
    assert.ok(frame.text.includes('前置'))
  })

  it('无原生块:🔧 文本归一兜底,且 harness 归因透传(H2 修复面)', () => {
    const frame = selectStatusFrame([{ text: '🔧 bash(ls -la)' }], 'codex')
    assert.equal(frame.blocks.length, 0)
    assert.ok(frame.derived, '应派生块')
    assert.equal(frame.derived.harness, 'codex', `派生块 harness 应为 codex,实际 '${frame.derived.harness}'`)
    assert.equal(frame.derived.tool, 'bash')
    assert.equal(frame.derived.phase, 'start')
  })

  it('harness 未知(空串)时派生块仍成立(兼容旧调用)', () => {
    const frame = selectStatusFrame([{ text: '🔧 web_search(query)' }], '')
    assert.ok(frame.derived)
    assert.equal(frame.derived.harness, '')
    assert.equal(frame.derived.tool, 'web_search')
  })

  it('坏原生载荷:agentBlocksFromParts 丢弃后回落文本归一(不丢审计)', () => {
    const frame = selectStatusFrame([
      { text: '🔧 fs_write(path)', data: { garbage: true } },
    ], 'goose')
    assert.equal(frame.blocks.length, 0, '垃圾 data 不是合法块')
    assert.ok(frame.derived, '应从文本行派生')
    assert.equal(frame.derived.harness, 'goose')
  })

  it('纯空白文本不派生(与 ws 层不下发空白帧同语义)', () => {
    const frame = selectStatusFrame([{ text: '  \n  ' }], 'omp')
    assert.equal(frame.blocks.length, 0)
    assert.equal(frame.derived, null)
    assert.equal(frame.text.trim(), '')
  })

  it('多条工具行只派生首条(单消息单工具行不变式)', () => {
    const frame = selectStatusFrame([{ text: '🔧 a(x)\n🔧 b(y)' }], 'omp')
    assert.ok(frame.derived)
    assert.equal(frame.derived.tool, 'a')
  })
})

describe('协议面卫生 · 无死字段', () => {
  it('AgentToolBlock 不携带 durationMs(H3:声明无人填充=协议噪声)', () => {
    const b = normalizeToolLine('🔧 t(x)', 'omp')!
    assert.equal('durationMs' in b, false, 'durationMs 已移除,块对象不得再携带')
    const part = toolBlockDataPart(b)
    assert.equal(part.mediaType, AGENT_BLOCK_MEDIA_TYPE)
    assert.equal('durationMs' in (part.data as Record<string, unknown>), false)
  })
})
