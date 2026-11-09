/**
 * 工具面三面一致性测试(声明 × 分发 × 权限模型 v2 意图) —— WP7。
 *
 * 为什么需要:2026-11-08 审查时把「dcw_control 有实现无声明」误判为缺口,实际是
 * 权限模型 v2 的**有意禁用桩**(分发保留只为让直连 invoke 拿到指引文案,而非"未知工具")。
 * 该误判的根因是三者无一致性断言可查。本测试把「声明面 / 分发面 / 意图面」钉在一起:
 *  ① 分发面 ⊆ 声明面 ∪ 禁用桩白名单 —— 新增工具处理器而未声明(且不是桩)会立刻红;
 *  ② 禁用桩必须在分发表内、必须**不在**声明面(不注入=不烧 token),且实现必须真的拒写
 *     (调用返回 isError 且文案含「权限模型 v2」)—— 防"顺手把桩改成真写"绕过 v2 决策;
 *  ③ 白名单本身必须显式列出并附理由,新增桩须同时更新本测试与 fallback-hints 文档口径。
 *
 * 纯静态 + 进程内调用(不联网、不连库、不起子进程)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { INDUSTRIAL_TOOL_NAMES, dispatchIndustrialTool } from '../server/services/workshop/agents/host-tool-bridge/tools/industrial'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFS_PATH = join(ROOT, '.AgentWorkShop', 'prompts', 'host-tools.json')

function declaredToolNames(): Set<string> {
  const parsed = JSON.parse(readFileSync(DEFS_PATH, 'utf-8')) as Array<{ name: string }> | { tools: Array<{ name: string }> }
  const list = Array.isArray(parsed) ? parsed : parsed.tools
  return new Set(list.map(t => t.name))
}

/**
 * 权限模型 v2 的有意禁用桩(单一事实源:本表 + fallback-hints.ts 头注释)。
 * 约束:必须留在分发面(给直连 invoke 返回指引),必须**不**在声明面(不注入给 Agent)。
 * 新增/删除桩时必须同步 tests/recovery-hints.test.ts 的口径。
 */
const V2_DISABLED_STUBS: Readonly<Record<string, string>> = {
  dcw_control: '节点级数控下发 → 收敛到 recipe_update/recipe_apply/recipe_trial',
  param_control: '工艺参数直写 → 收敛到配方面(param 由 recipe 承载)',
  dcw_rollback: '节点级回退 → 收敛到 recipe_rollback(dispatch=true 整批恢复)',
}

test('分发面 ⊆ 声明面 ∪ v2 禁用桩(无未声明的真实工具)', () => {
  const declared = declaredToolNames()
  const undeclared = [...INDUSTRIAL_TOOL_NAMES]
    .filter(name => !declared.has(name))
    .sort()
  const unexpected = undeclared.filter(name => !(name in V2_DISABLED_STUBS))
  assert.deepEqual(
    unexpected,
    [],
    `以下工具在分发表内、未进 host-tools.json 声明,也不在 v2 禁用桩白名单:${unexpected.join(', ')}`
    + `\n修复二选一:①补声明(.AgentWorkShop/prompts/host-tools.json);②确认为 v2 禁用桩则加入 V2_DISABLED_STUBS 并同步文档。`,
  )
  // 白名单里残留但已不在分发表的项 = 表腐化(桩被删但白名单未清)
  const stale = Object.keys(V2_DISABLED_STUBS).filter(name => !INDUSTRIAL_TOOL_NAMES.has(name))
  assert.deepEqual(stale, [], `v2 禁用桩白名单含已不存在的分发项:${stale.join(', ')}`)
})

test('v2 禁用桩:不注入(不在声明面)', () => {
  const declared = declaredToolNames()
  for (const name of Object.keys(V2_DISABLED_STUBS)) {
    assert.ok(
      !declared.has(name),
      `${name} 是权限模型 v2 的禁用桩,不得写入 host-tools.json(注入恒错工具会白烧 token 并误导 Agent)`,
    )
  }
})

test('v2 禁用桩:实现必须真的拒写(含权限模型 v2 指引)', async () => {
  for (const [name, rationale] of Object.entries(V2_DISABLED_STUBS)) {
    const result = await dispatchIndustrialTool('test-agent', name, {})
    assert.equal(
      result.isError,
      true,
      `${name} 是 v2 禁用桩(${rationale}),但当前实现未返回 isError —— 桩可能被改成了真实写路径,请复核权限模型 v2 决策`,
    )
    assert.match(
      String(result.text ?? ''),
      /权限模型 v2/,
      `${name} 的拒写文案必须引用权限模型 v2 并给出替代路径(${rationale})`,
    )
  }
})

test('声明面无重复名(JSON 内 name 唯一)', () => {
  const parsed = JSON.parse(readFileSync(DEFS_PATH, 'utf-8')) as Array<{ name: string }> | { tools: Array<{ name: string }> }
  const list = Array.isArray(parsed) ? parsed : parsed.tools
  const seen = new Set<string>()
  const dupes: string[] = []
  for (const t of list) {
    if (seen.has(t.name)) dupes.push(t.name)
    seen.add(t.name)
  }
  assert.deepEqual(dupes, [], `host-tools.json 存在重复工具名:${[...new Set(dupes)].join(', ')}`)
})
