/**
 * AgentBlock 前端纯函数契约(计划 H10/H11,2026-11-11)。
 *
 * 锁定:结构块与文本孪生在前端两条纯函数路径(归类/注意力档位)行为一致 ——
 * 同一工具调用以 agent.block 或 agent.status.message 两种帧形态到达时,
 * 聚类类别必须同为 'tool',注意力档位必须同为 'silent'。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const { classifyEvent } = await import('../app/composables/workshop/event-blocks/classify.ts')
const { envelopeTier } = await import('../app/composables/workshop/event-blocks/attention.ts')
const { normalizeToolLine, toolBlockDataPart } = await import('../shared/agent-blocks.ts')

const base = { v: 1, seq: 7, at: '2026-11-11T00:00:00Z', channelId: 'ch' }
const blockFrame = {
  ...base,
  type: 'agent.block' as const,
  agentId: 'agent-1',
  payload: { block: normalizeToolLine('🔧 daq_query({"node_id":"dn-1"})', 'omp')! },
}
const textFrame = {
  ...base,
  type: 'agent.status.message' as const,
  agentId: 'agent-1',
  payload: { text: '🔧 daq_query({"node_id":"dn-1"})' },
}

describe('前端块管线 · 归类/注意力一致性', () => {
  it('agent.block 与文本孪生归类同为 tool', () => {
    assert.equal(classifyEvent(blockFrame), 'tool')
    assert.equal(classifyEvent(textFrame), 'tool')
  })
  it('注意力档位一致:agent.block = agent.status.message = silent(H11)', () => {
    assert.equal(envelopeTier(blockFrame), 'silent', `实际=${envelopeTier(blockFrame)}`)
    assert.equal(envelopeTier(textFrame), 'silent')
  })
  it('坏载荷块帧归类仍为 tool(渲染层由 ClusterTool 防御,分类面不依赖载荷内容)', () => {
    assert.equal(classifyEvent({ ...base, type: 'agent.block', payload: { block: { garbage: true } } }), 'tool')
  })
  it('块 data Part 往返:归一产物经 toolBlockDataPart 可还原(渲染输入契约)', () => {
    const b = normalizeToolLine('🔧 web_search(q)', 'dsh')!
    const back = toolBlockDataPart(b)
    assert.equal(back.mediaType, 'application/x-agent-block+json')
    assert.equal(back.data.tool, 'web_search')
  })
})
