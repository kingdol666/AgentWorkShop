/**
 * WP5 声明化单测(不联网):
 *  ① 迁移等价:旧代码表(LEGACY_VERIFY_SPECS)中在 host-tools.json 存在的工具,
 *     其 `references` 必须逐项相等(声明是单源,旧表只是回滚源);
 *  ② 登记制:全部工具要么 references 要么 noRefs;写族不得裸奔;
 *  ③ 声明查表:registerToolReferenceDeclarations → declaredReferenceSpec(noRefs/未声明区分);
 *  ④ 执行期:verifyIndustrialToolCall 走声明(新工具未在旧表也能校验),noRefs 直接放行;
 *  ⑤ declarationVerdict:写族未声明=拒登记,读族未声明=告警放行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.AGENTWORKSHOP_TEST = '1'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { LEGACY_VERIFY_SPECS } = await import('../server/services/workshop/agents/industrial/tool-verify-legacy-specs')
const { registerToolReferenceDeclarations, declaredReferenceSpec, declarationVerdict, specHasRules } = await import('../server/services/workshop/agents/tool-reference-spec')
const { verifyIndustrialToolCall } = await import('../server/services/workshop/agents/industrial/tool-verify')

interface ToolDef {
  name: string
  references?: Record<string, unknown>
  noRefs?: boolean
  riskClass?: string
}
const tools = JSON.parse(readFileSync(join(REPO, '.AgentWorkShop', 'prompts', 'host-tools.json'), 'utf-8')) as ToolDef[]

test('迁移等价:旧代码表在 JSON 中的条目与 references 逐项相等(单源无漂移)', () => {
  const byName = new Map(tools.map(t => [t.name, t]))
  const missing: string[] = []
  const drifted: string[] = []
  for (const [name, legacySpec] of Object.entries(LEGACY_VERIFY_SPECS)) {
    const tool = byName.get(name)
    if (!tool) {
      missing.push(name) // v2 禁用桩(dcw_control 等):无定义=无注入面,无需声明
      continue
    }
    const empty = Object.keys(legacySpec).length === 0
    if (empty) {
      if (tool.noRefs !== true || tool.references) drifted.push(`${name}(应为 noRefs)`)
      continue
    }
    assert.ok(tool.references, `${name} 缺 references 声明`)
    assert.deepStrictEqual(tool.references, legacySpec, `${name} 声明与旧表不等价`)
  }
  assert.deepStrictEqual(missing.sort(), ['dcw_control', 'dcw_rollback', 'param_control'])
  assert.deepStrictEqual(drifted, [])
})

test('登记制:全部 92 个工具都显式声明(references 或 noRefs),无裸奔', () => {
  assert.ok(tools.length >= 92, `工具数 ${tools.length}`)
  const undeclared = tools.filter(t => !t.references && !t.noRefs).map(t => t.name)
  assert.deepStrictEqual(undeclared, [])
  // 有规则的必须带 mode(read/write),为 MCP annotations 映射预留
  for (const t of tools) {
    for (const ref of (t.references?.refs as Array<{ mode?: string }> | undefined) ?? []) {
      assert.ok(ref.mode === 'read' || ref.mode === 'write', `${t.name} refs[].mode 缺失`)
    }
  }
})

test('登记制判定:写族未声明→拒;读族未声明→告警放行;已声明→ok', () => {
  assert.equal(declarationVerdict({}, true), 'undeclared-write')
  assert.equal(declarationVerdict({}, false), 'undeclared-read')
  assert.equal(declarationVerdict({ noRefs: true }, true), 'ok')
  assert.equal(declarationVerdict({ references: { refs: [{ param: 'node_id', kind: 'node' }] } }, true), 'ok')
})

test('声明查表:noRefs 与未声明可区分;specHasRules 判定规则内容', () => {
  registerToolReferenceDeclarations([
    { name: 'tool_with_refs', references: { refs: [{ param: 'node_id', kind: 'node', mode: 'read' }] } },
    { name: 'tool_no_refs', noRefs: true },
  ])
  assert.equal(declaredReferenceSpec('tool_with_refs').declared, true)
  assert.equal(specHasRules(declaredReferenceSpec('tool_with_refs').spec), true)
  assert.equal(declaredReferenceSpec('tool_no_refs').declared, true)
  assert.equal(declaredReferenceSpec('tool_no_refs').spec, null)
  assert.equal(declaredReferenceSpec('tool_never_declared').declared, false)
})

test('执行期走声明:新工具(不在旧表)按声明拒绝;noRefs 直接放行', () => {
  registerToolReferenceDeclarations([
    { name: 'fake_ref_tool', references: { atLeastOne: [{ params: ['record_id'], hint: 'record_id 必填(声明式)' }] } },
    { name: 'fake_norefs_tool', noRefs: true },
  ])
  const denied = verifyIndustrialToolCall('agent-x', 'fake_ref_tool', {})
  assert.ok(denied?.isError, '声明式 atLeastOne 应拒绝')
  assert.match(String(denied?.text), /record_id 必填/)
  assert.equal(verifyIndustrialToolCall('agent-x', 'fake_norefs_tool', {}), null)
})

test('非法声明形状(type 非字符串)在声明路径同样拒绝(与旧表行为等价)', () => {
  registerToolReferenceDeclarations([
    { name: 'fake_shape_tool', references: { refs: [{ param: 'line_id', kind: 'line', mode: 'read' }] } },
  ])
  const denied = verifyIndustrialToolCall('agent-x', 'fake_shape_tool', { line_id: ['l1'] })
  assert.ok(denied?.isError)
  assert.match(String(denied?.text), /必须是字符串 ID/)
})
