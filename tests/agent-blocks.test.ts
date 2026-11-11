/**
 * AgentBlock v1 协议单测 —— 全 harness 文本签名归一矩阵 + Part 往返 + 防御。
 *
 * 背景:2026-11-08 生产审计指控6(工具调用无结构化块,跨 harness 文案互异无法统一渲染/审计)。
 * 修复 = shared/agent-blocks.ts(块 schema + 文本签名归一) + omp 原生 data Part 并行发射
 * + ws 层 `agent.block` AEP 帧派生(原生优先/归一兜底) + 前端 ClusterTool 结构优先。
 *
 * 发射面真值(2026-11-11 H5 对齐):**发射者 = omp 原生 + 11 家文本(opencode/codex/claude/
 * cursor/dsh/hermes/crush/copilot/gemini/goose/qwen)= 12 家**;pi 当前无工具行发射点
 * (其 fixture 仅锁定解析器兼容,不代表发射);mock 无工具面(设计)。
 * 发射面由 tests/harness-capability-contract.test.ts 源码契约锁定。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const {
  AGENT_BLOCK_VERSION,
  AGENT_BLOCK_MEDIA_TYPE,
  isAgentToolBlock,
  toolBlockDataPart,
  agentBlockFromPart,
  agentBlocksFromParts,
  normalizeToolLine,
} = await import('../shared/agent-blocks.ts')

/** 各 harness 的代表工具行(逐字对应各发射点模板;含 end/失败/完成变体) */
const FIXTURES: Array<{ harness: string, line: string, expect: Record<string, unknown> }[]> = [
  // omp:start 通用形;end 带 ✅/❌ 与冒号摘要(摘要 300 截断由源做,归一面只透传)
  { harness: 'omp', line: '🔧 daq_query({"node_id":"dn-1","last_minutes":5})', expect: { tool: 'daq_query', phase: 'start', argsPreview: '{"node_id":"dn-1","last_minutes":5}' } },
  { harness: 'omp', line: '🔧 daq_query ✅ 完成: 样本 12 行,均值 25.3', expect: { tool: 'daq_query', phase: 'end', status: 'ok', errorText: null } },
  { harness: 'omp', line: '🔧 recipe_trial ❌ 失败: PROJECT_WRITE_INTENT_REQUIRED: 需要审批', expect: { tool: 'recipe_trial', phase: 'end', status: 'error' } },
  // opencode:start 通用;end 只有失败帧(成功静默)
  { harness: 'opencode', line: '🔧 bash(ls -la)', expect: { tool: 'bash', phase: 'start' } },
  { harness: 'opencode', line: '🔧 bash 失败: exit 1 permission denied', expect: { tool: 'bash', phase: 'end', status: 'error' } },
  // claude:start 裸名无参数
  { harness: 'claude', line: '🔧 Read', expect: { tool: 'Read', phase: 'start', argsPreview: null } },
  // codex:start 的 label 可能是整条命令(commandExecution)
  { harness: 'codex', line: '🔧 git status --short(project workspace)', expect: { tool: 'git status --short', phase: 'start' } },
  // cursor:completed 带 ✓;进行中通用形
  { harness: 'cursor', line: '🔧 edit_file ✓', expect: { tool: 'edit_file', phase: 'end', status: 'ok' } },
  { harness: 'cursor', line: '🔧 edit_file({"path":"a.ts"})', expect: { tool: 'edit_file', phase: 'start' } },
  // dsh / hermes:start 通用;end 裸「失败」(无冒号摘要)
  { harness: 'dsh', line: '🔧 web_search(query)', expect: { tool: 'web_search', phase: 'start' } },
  { harness: 'dsh', line: '🔧 web_search 失败', expect: { tool: 'web_search', phase: 'end', status: 'error' } },
  { harness: 'hermes', line: '🔧 kb_store(payload)', expect: { tool: 'kb_store', phase: 'start' } },
  { harness: 'hermes', line: '🔧 kb_store 失败', expect: { tool: 'kb_store', phase: 'end', status: 'error' } },
  // crush / copilot / gemini / goose / qwen:通用 start 形
  { harness: 'crush', line: '🔧 run_command({"cmd":"make"})', expect: { tool: 'run_command', phase: 'start' } },
  { harness: 'copilot', line: '🔧 repo_search(q)', expect: { tool: 'repo_search', phase: 'start' } },
  { harness: 'gemini', line: '🔧 web_fetch(url)', expect: { tool: 'web_fetch', phase: 'start' } },
  { harness: 'goose', line: '🔧 fs_write(path)', expect: { tool: 'fs_write', phase: 'start' } },
  { harness: 'qwen', line: '🔧 acp_tool(input)', expect: { tool: 'acp_tool', phase: 'start' } },
]

/** 解析器兼容矩阵:非发射引擎(如 pi)的文本形态若出现仍可归一(容错,不代表该引擎在发射) */
const PARSER_COMPAT_FIXTURES: Array<{ harness: string, line: string, expect: Record<string, unknown> }[]> = [
  { harness: 'pi', line: '🔧 pi_tool(args)', expect: { tool: 'pi_tool', phase: 'start' } },
]

describe('AgentBlock v1 · 文本签名归一矩阵(omp 原生 + 11 文本发射者)', () => {
  for (const fx of FIXTURES) {
    it(`${fx.harness}: ${fx.line.slice(0, 42)}`, () => {
      const b = normalizeToolLine(fx.line, fx.harness)
      assert.ok(b, '应识别为工具行')
      assert.equal(b.harness, fx.harness)
      assert.equal(b.v, AGENT_BLOCK_VERSION)
      assert.equal(b.text, fx.line)
      for (const [k, v] of Object.entries(fx.expect)) assert.deepStrictEqual(b[k as keyof typeof b], v, `字段 ${k}`)
    })
  }
})

describe('AgentBlock v1 · 解析器兼容矩阵(非发射引擎)', () => {
  for (const fx of PARSER_COMPAT_FIXTURES) {
    it(`${fx.harness}(容错;当前无发射点): ${fx.line.slice(0, 42)}`, () => {
      const b = normalizeToolLine(fx.line, fx.harness)
      assert.ok(b, '应识别为工具行')
      assert.equal(b.harness, fx.harness)
      for (const [k, v] of Object.entries(fx.expect)) assert.deepStrictEqual(b[k as keyof typeof b], v, `字段 ${k}`)
    })
  }
})

describe('AgentBlock v1 · 防御与边界', () => {
  it('非工具行返回 null(纯文本/空串/非 🔧 emoji)', () => {
    assert.equal(normalizeToolLine('普通状态文本'), null)
    assert.equal(normalizeToolLine(''), null)
    assert.equal(normalizeToolLine('⚙️ 别的 emoji'), null)
  })
  it('🔧 前缀但无签名命中:保底归 start 不丢审计', () => {
    const b = normalizeToolLine('🔧 ???怪异形态')
    assert.ok(b)
    assert.equal(b.phase, 'start')
    assert.equal(b.status, 'unknown')
    assert.notEqual(b.tool, 'tool', '至少提取到非默认名')
  })
  it('mock 不发工具行(无 fixture;normalize 对 mock 无输入面)', () => {
    // mock 引擎不产生 🔧 文本(设计):归一面对空输入返回 null 即其"适配"形态
    assert.equal(normalizeToolLine('', 'mock'), null)
  })
  it('参数预览 200 截断', () => {
    const long = 'x'.repeat(500)
    const b = normalizeToolLine(`🔧 t(${long})`)
    assert.ok(b && (b.argsPreview?.length ?? 0) <= 200)
  })
})

describe('AgentBlock v1 · Part 往返与防御', () => {
  it('toolBlockDataPart → agentBlockFromPart 往返一致', () => {
    const src = normalizeToolLine('🔧 omp_tool ✅ 完成: ok', 'omp')!
    const part = toolBlockDataPart(src)
    assert.equal(part.mediaType, AGENT_BLOCK_MEDIA_TYPE)
    const back = agentBlockFromPart(part)
    assert.deepEqual(back, src)
  })
  it('agentBlocksFromParts:混合数组只取块、顺序保持', () => {
    const b1 = normalizeToolLine('🔧 a(x)', 'omp')!
    const b2 = normalizeToolLine('🔧 b ✓', 'cursor')!
    const parts = [{ text: '前置文本' }, toolBlockDataPart(b1), { url: 'https://x' }, toolBlockDataPart(b2)]
    const out = agentBlocksFromParts(parts)
    assert.equal(out.length, 2)
    assert.equal(out[0].tool, 'a')
    assert.equal(out[1].tool, 'b')
  })
  it('isAgentToolBlock 拒绝坏载荷(缺字段/错版本/错 phase)', () => {
    assert.equal(isAgentToolBlock(null), false)
    assert.equal(isAgentToolBlock({ kind: 'agent.tool' }), false)
    assert.equal(isAgentToolBlock({ kind: 'agent.tool', v: 2, harness: 'x', tool: 't', phase: 'start', text: 'x' }), false)
    assert.equal(isAgentToolBlock({ kind: 'agent.tool', v: 1, harness: 'x', tool: 't', phase: 'sideways', text: 'x' }), false)
    assert.equal(agentBlockFromPart({ data: { garbage: true } }), null)
    assert.equal(agentBlockFromPart('not-an-object'), null)
  })
})
