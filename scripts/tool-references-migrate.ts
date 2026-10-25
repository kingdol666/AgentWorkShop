/**
 * WP5 迁移:把引用校验的旧代码表上收进 host-tools.json 的声明字段。
 *
 * 幂等:重复执行结果一致(按工具名覆盖 references/noRefs/riskClass,不动其他字段)。
 * 用法:npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/tool-references-migrate.ts [--dry]
 *
 * 产出对账:JSON 中不存在的旧表条目(dcw_control 等 v2 禁用桩)被显式列出——
 * 这些工具没有定义就没有注入面,迁移后自然无校验对象。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LEGACY_VERIFY_SPECS } from '../server/services/workshop/agents/industrial/tool-verify-legacy-specs'
import type { ToolVerifySpec } from '../server/services/workshop/agents/tool-reference-spec'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = join(REPO, '.AgentWorkShop', 'prompts', 'host-tools.json')
const DRY = process.argv.includes('--dry')

/** 写族:会改变设备/配方/模型/训练状态的工具(refs[].mode=write 的权威来源) */
const WRITE_TOOLS = new Set([
  'dcw_control', 'param_control', 'dcw_rollback',
  'recipe_create', 'recipe_update', 'recipe_rollback', 'recipe_trial', 'recipe_apply', 'recipe_propose',
  'line_start', 'line_stop',
  'aml_dataset_build', 'aml_job_submit', 'aml_job_cancel', 'aml_model_promote',
  'aml_training_plan_create', 'aml_training_plan_train',
  'twin_scene_compile', 'twin_scene_freeze', 'twin_calibration_request',
  'twin_trial_run', 'mpc_optimize', 'twin_bayes_optimize', 'optimization_explore',
  'optimizer_solve', 'analysis_save',
])

type Tool = {
  name: string
  references?: ToolVerifySpec
  noRefs?: boolean
  riskClass?: 'read' | 'write' | 'admin'
  [k: string]: unknown
}

const tools = JSON.parse(readFileSync(FILE, 'utf-8')) as Tool[]
const byName = new Map(tools.map(t => [t.name, t]))
const applied: string[] = []
const missingInJson: string[] = []
let noRefsCount = 0

for (const [name, spec] of Object.entries(LEGACY_VERIFY_SPECS)) {
  const tool = byName.get(name)
  if (!tool) {
    missingInJson.push(name)
    continue
  }
  const empty = Object.keys(spec).length === 0
  if (empty) {
    tool.noRefs = true
    delete tool.references
    noRefsCount++
  }
  else {
    tool.references = spec
    delete tool.noRefs
  }
  tool.riskClass = WRITE_TOOLS.has(name) ? 'write' : 'read'
  applied.push(name)
}

// 其余工具(无引用参数)一律显式 noRefs —— 登记制:不接受「默认无引用」
let otherNoRefs = 0
const writeSet = WRITE_TOOLS
for (const tool of tools) {
  if (applied.includes(tool.name)) continue
  if (tool.references) continue
  tool.noRefs = true
  otherNoRefs++
  if (!tool.riskClass) tool.riskClass = writeSet.has(tool.name) ? 'write' : 'read'
}

if (!DRY) writeFileSync(FILE, `${JSON.stringify(tools, null, 2)}\n`)

console.log(`[migrate] host-tools.json: total=${tools.length} references=${applied.length - noRefsCount} noRefs(legacy-empty)=${noRefsCount} noRefs(other)=${otherNoRefs}`)
console.log(`[migrate] 旧表中不在 JSON 的工具(无定义即无注入面):${missingInJson.length > 0 ? missingInJson.join(', ') : '(无)'}`)
const writeCount = tools.filter(t => t.riskClass === 'write').length
console.log(`[migrate] riskClass: write=${writeCount} read=${tools.length - writeCount}${DRY ? ' (dry-run 未写入)' : ''}`)
