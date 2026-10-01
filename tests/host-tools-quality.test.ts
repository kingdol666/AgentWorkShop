// host-tools 描述完备性测试:每个给 Agent 的工具必须有像样的调用说明;
// 需绑定/授权的工具必须讲清"谁能调、怎么调";权限模型 v2 的直写工具必须已摘除。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const defsPath = join(ROOT, '.AgentWorkShop', 'prompts', 'host-tools.json')

type ToolDef = { name: string, description?: string, parameters?: { type?: string, properties?: Record<string, unknown>, required?: string[] } }

function loadDefs(): ToolDef[] {
  const parsed = JSON.parse(readFileSync(defsPath, 'utf-8')) as ToolDef[] | { tools: ToolDef[] }
  return Array.isArray(parsed) ? parsed : parsed.tools
}

// 需绑定/授权前提的工具 → 描述必须点明绑定语义(否则 Agent 不知道自己能不能调、调了会怎样)
const BINDING_TOOLS = [
  'recipe_update', 'recipe_apply', 'recipe_trial', 'recipe_rollback',
  'mes_catalog', 'mes_fetch', 'daq_query',
  'my_industrial_nodes', 'line_context', 'team_grant_nodes',
]

// 权限模型 v2:直写工具必须从工具面摘除(防 Agent 再尝试节点级写控)
const FORBIDDEN_TOOLS = ['dcw_control', 'param_control', 'dcw_rollback']

test('host-tools:每个工具都有非空且足够具体的描述(≥40 字符)', () => {
  const defs = loadDefs()
  assert.ok(defs.length >= 70, `工具数 ${defs.length} 应 ≥70(装配面回归)`)
  const names = new Set<string>()
  for (const t of defs) {
    assert.ok(t.name, '工具缺 name')
    assert.ok(!names.has(t.name), `工具重名: ${t.name}`)
    names.add(t.name)
    const desc = t.description ?? ''
    assert.ok(desc.length >= 40, `工具 ${t.name} 描述过短(${desc.length} 字符):${desc.slice(0, 40)}`)
    assert.ok(t.parameters?.type === 'object', `工具 ${t.name} 缺 object 型 parameters`)
  }
})

test('host-tools:需绑定/授权工具的描述必须说明绑定前提', () => {
  const defs = loadDefs()
  for (const name of BINDING_TOOLS) {
    const t = defs.find(x => x.name === name)
    assert.ok(t, `缺工具 ${name}`)
    const desc = t.description ?? ''
    assert.ok(/绑定|授权|可见/.test(desc), `工具 ${name} 描述未说明绑定/授权前提:${desc.slice(0, 60)}`)
  }
})

test('host-tools:recipe 写族描述必须讲清 v2 三门(绑定/HITL 理由/运行门)', () => {
  const defs = loadDefs()
  for (const name of ['recipe_update', 'recipe_apply', 'recipe_trial', 'recipe_rollback']) {
    const t = defs.find(x => x.name === name)
    assert.ok(t, `缺工具 ${name}`)
    const desc = t.description ?? ''
    assert.ok(/绑定/.test(desc), `${name} 未说明 recipe 绑定前提`)
    assert.ok(/HITL|人工批准|人工裁决/.test(desc), `${name} 未说明 HITL`)
    assert.ok(/运行门|正在执行|未运行|在执行/.test(desc), `${name} 未说明运行门`)
    assert.ok(/reason|理由|依据/.test(desc), `${name} 未说明理由必填`)
  }
})

test('host-tools:权限模型 v2 直写工具已摘除', () => {
  const names = new Set(loadDefs().map(t => t.name))
  for (const name of FORBIDDEN_TOOLS) {
    assert.ok(!names.has(name), `直写工具 ${name} 仍在工具面(v2 应已摘除)`)
  }
})

test('模板语义完备:内置 dcw/daq 模板全部带非空 semantics(节点本体说明的兜底层)', async () => {
  const dcw = await import('../server/services/workshop/dcw/dcw-templates')
  const dcwList = dcw.listDcwTemplates() as Array<{ key: string, builtin?: boolean, semantics?: string }>
  assert.ok(dcwList.length > 0, 'dcw 模板目录为空(导出名对不上,需修测试)')
  for (const t of dcwList.filter(x => x.builtin)) {
    assert.ok((t.semantics ?? '').trim().length >= 20, `dcw 内置模板 ${t.key} 缺工艺语义(semantics)`)
  }
  const daq = await import('../shared/daq-protocol')
  const daqList = (daq as unknown as { DAQ_TEMPLATES?: Array<{ key: string, semantics?: string }> }).DAQ_TEMPLATES ?? []
  assert.ok(daqList.length > 0, 'daq 模板目录为空')
  for (const t of daqList) {
    assert.ok((t.semantics ?? '').trim().length >= 20, `daq 内置模板 ${t.key} 缺采集语义(semantics)`)
  }
})
