/**
 * WS-4 S1:写族联合判定 —— 静态名单 ∪ 已注册插件 riskClass='write' 工具。
 * 缺口背景:插件写工具此前不在 POLICY_WRITE_TOOL_NAMES → 策略/目录不可读时不享受
 * fail-closed(物理安全类工具不在其中,但知识库/诊断写面同样需要安全默认)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPolicyWriteTool } from '../server/services/workshop/tools/policy'
import { registerPluginTool, unregisterPluginTools } from '../server/services/workshop/agents/plugin-tools'

function reg(plugin: string, name: string, riskClass?: 'read' | 'write' | 'admin') {
  registerPluginTool(plugin, {
    name,
    description: `${name} test`,
    parameters: { type: 'object', properties: {} },
    riskClass,
    handler: async () => ({ text: 'ok' }),
  })
}

test('静态名单写工具仍判定为写族(line_start/line_stop)', () => {
  assert.equal(isPolicyWriteTool('line_start'), true)
  assert.equal(isPolicyWriteTool('line_stop'), true)
})

test('插件 riskClass=write → 写族;riskClass=read → 非写族', () => {
  reg('ws4-test', 'ws4_doc_create', 'write')
  reg('ws4-test', 'ws4_doc_search', 'read')
  assert.equal(isPolicyWriteTool('ws4_doc_create'), true)
  assert.equal(isPolicyWriteTool('ws4_doc_search'), false)
  unregisterPluginTools('ws4-test')
})

test('未注册工具/无 riskClass 插件 → 非写族(不误伤)', () => {
  reg('ws4-test2', 'ws4_legacy_tool')
  assert.equal(isPolicyWriteTool('ws4_legacy_tool'), false)
  assert.equal(isPolicyWriteTool('not_a_tool'), false)
  unregisterPluginTools('ws4-test2')
})

test('插件卸载后联合判定同步失效(无缓存窗口)', () => {
  reg('ws4-test3', 'ws4_deposit_probe', 'write')
  assert.equal(isPolicyWriteTool('ws4_deposit_probe'), true)
  unregisterPluginTools('ws4-test3')
  assert.equal(isPolicyWriteTool('ws4_deposit_probe'), false)
})
