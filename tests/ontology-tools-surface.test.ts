/**
 * 本体工具面登记(结构断言):host-tools.json 10 条 + 引用面声明 + 治理面接线。
 * 不 import 分发门面(避免 nitro #imports);改读源文件做结构断言。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const TOOLS = JSON.parse(readFileSync('.AgentWorkShop/prompts/host-tools.json', 'utf8')) as Array<Record<string, unknown>>

const EXPECTED = [
  'ontology_scene_inspect', 'ontology_node_neighbors', 'ontology_draft_create', 'ontology_draft_update',
  'ontology_draft_validate', 'ontology_draft_autofix', 'ontology_rule_explain', 'ontology_compile_preview',
  'ontology_publish_propose', 'ontology_version_compare',
]

test('host-tools.json 含 10 条本体工具(全名唯一)且总数为 104', () => {
  const names = TOOLS.map(t => String(t.name))
  for (const name of EXPECTED) assert.ok(names.includes(name), `缺少工具 ${name}`)
  assert.equal(new Set(names).size, names.length, '工具名必须唯一')
  assert.deepEqual(names.filter(n => n.startsWith('ontology_')).sort(), [...EXPECTED].sort(), '本体工具集合必须精确等于预期')
  assert.equal(TOOLS.length, 104, '宿主工具总数应为 104')
})

test('每条本体工具:描述 ≥40 字、参数为 object、声明 references 或 noRefs、带 riskClass', () => {
  for (const name of EXPECTED) {
    const tool = TOOLS.find(t => t.name === name)!
    assert.ok(String(tool.description).length >= 40, `${name} 描述过短`)
    const params = tool.parameters as { type?: string }
    assert.equal(params.type, 'object', `${name} 参数必须是 object`)
    assert.ok(tool.references || tool.noRefs === true, `${name} 必须声明 references 或 noRefs`)
    assert.ok(['read', 'write'].includes(String(tool.riskClass)), `${name} 必须声明 riskClass`)
  }
})

test('写工具清单:起草/写入/发布提议为 write;读工具为 read(写面不能误标)', () => {
  const byName = new Map(TOOLS.map(t => [String(t.name), t]))
  for (const name of ['ontology_draft_create', 'ontology_draft_update', 'ontology_draft_autofix', 'ontology_publish_propose']) {
    assert.equal(byName.get(name)!.riskClass, 'write', `${name} 必须是 write`)
  }
  for (const name of ['ontology_scene_inspect', 'ontology_node_neighbors', 'ontology_draft_validate', 'ontology_rule_explain', 'ontology_compile_preview', 'ontology_version_compare']) {
    assert.equal(byName.get(name)!.riskClass, 'read', `${name} 必须是 read`)
  }
})

test('发布提议只能声明链式草稿引用(不能声明"无引用"绕过归属校验)', () => {
  const tool = TOOLS.find(t => t.name === 'ontology_publish_propose')!
  const refs = tool.references as { chained?: Array<{ param: string, kind: string }> }
  assert.ok(refs.chained?.some(c => c.param === 'draft_id' && c.kind === 'ontology_draft'))
})

test('grant-guard 写族含本体四件,且能解析 draft_id → 产线(ONT-13 缺口修复)', () => {
  const src = readFileSync('server/services/workshop/agents/industrial/grant-guard.ts', 'utf8')
  for (const name of ['ontology_draft_create', 'ontology_draft_update', 'ontology_draft_autofix', 'ontology_publish_propose']) {
    assert.ok(src.includes(`'${name}'`), `WRITE_TOOLS 缺 ${name}`)
  }
  assert.ok(src.includes('args.draft_id'), 'resolveTargetLines 必须识别 draft_id')
  assert.ok(src.includes('ontology_versions'), 'draft 无锚时须回退版本产线')
})

test('tool-verify 链式类别含 ontology_draft/ontology_version,并有解析分支', () => {
  const spec = readFileSync('server/services/workshop/agents/tool-reference-spec.ts', 'utf8')
  assert.ok(spec.includes('\'ontology_draft\'') && spec.includes('\'ontology_version\''))
  const verify = readFileSync('server/services/workshop/agents/industrial/tool-verify.ts', 'utf8')
  assert.ok(verify.includes('kind === \'ontology_draft\''))
  assert.ok(verify.includes('kind === \'ontology_version\''))
})

test('INDUSTRIAL_HANDLERS 登记 10 条(钩子存在性,避免"注入但不可执行")', () => {
  const src = readFileSync('server/services/workshop/agents/host-tool-bridge/tools/industrial.ts', 'utf8')
  for (const name of EXPECTED) assert.ok(src.includes(`['${name}',`), `INDUSTRIAL_HANDLERS 缺 ${name}`)
})

test('外置 MCP 只暴露 4 个只读本体工具,写面绝不外泄', () => {
  const src = readFileSync('mcp/aw-mcp-server.mjs', 'utf8')
  for (const name of ['ontology_scene_inspect', 'ontology_node_neighbors', 'ontology_rule_explain', 'ontology_version_compare']) {
    assert.ok(src.includes(`name: '${name}'`), `外置 MCP 缺只读工具 ${name}`)
  }
  for (const name of ['ontology_draft_create', 'ontology_draft_update', 'ontology_draft_validate', 'ontology_draft_autofix', 'ontology_compile_preview', 'ontology_publish_propose']) {
    assert.equal(src.includes(`name: '${name}'`), false, `外置 MCP 不得暴露写/状态工具 ${name}`)
  }
})

test('本体只读工具不得进入 grant-guard 写族', () => {
  const src = readFileSync('server/services/workshop/agents/industrial/grant-guard.ts', 'utf8')
  assert.equal(src.includes(`'ontology_node_neighbors'`), false, '只读工具不应出现在 grant-guard(写族/WVO)')
})
