/**
 * 恢复提示一致性测试(权限模型 v2,不联网):
 *  ① Agent 可见提示零残留:ops-tools / recipe-propose-tools / aml-job-tools / seed
 *     全文(含注释)不得出现 dcw_control / dcw_read 字样
 *     (v2 下 dcw_control 是恒拒桩、dcw_read 从不存在,教 Agent 直发=教死路);
 *  ② 单一事实源:fallback-hints.ts 代码体不含被禁工具名,头注释保留"禁止 dcw_control/dcw_read"
 *     反向声明;导出常量不含被禁工具名,且含 recipe_rollback / daq_query / dcw_journal /
 *     recipe_versions / optimization_explore 指引;
 *  ③ 防线未撤:dcw-tools.ts 的 v2 恒拒桩文案仍在(handler 侧拒绝面未被顺手删掉)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.AGENTWORKSHOP_TEST = '1'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INDUSTRIAL = join(REPO, 'server', 'services', 'workshop', 'agents', 'industrial')
const read = (p: string) => readFileSync(p, 'utf-8')

const opsSrc = read(join(INDUSTRIAL, 'ops-tools.ts'))
const proposeSrc = read(join(INDUSTRIAL, 'recipe-propose-tools.ts'))
const amlSrc = read(join(INDUSTRIAL, 'aml-job-tools.ts'))
const hintsSrc = read(join(INDUSTRIAL, 'fallback-hints.ts'))
const dcwSrc = read(join(INDUSTRIAL, 'dcw-tools.ts'))
const seedSrc = read(join(REPO, 'server', 'services', 'workshop', 'db', 'database', 'seed.ts'))

const BANNED = ['dcw_control', 'dcw_read']

test('Agent 可见提示零残留:四个工具源文件与 seed.ts 全文不出现 dcw_control/dcw_read', () => {
  const files: Array<[string, string]> = [
    ['ops-tools.ts', opsSrc],
    ['recipe-propose-tools.ts', proposeSrc],
    ['aml-job-tools.ts', amlSrc],
    ['seed.ts', seedSrc],
  ]
  for (const [name, src] of files) {
    for (const token of BANNED) {
      assert.ok(!src.includes(token), `${name} 仍含 ${token}(Agent 可见文案或注释残留)`)
    }
  }
})

test('单一事实源:fallback-hints.ts 头注释保留反向声明,代码体不含被禁工具名', () => {
  // 反向声明必须在文件头注释中(守门规则的自我声明)
  const headEnd = hintsSrc.indexOf('*/')
  assert.ok(headEnd > 0, 'fallback-hints.ts 缺文件头注释')
  const head = hintsSrc.slice(0, headEnd)
  assert.match(head, /禁止出现 dcw_control \/ dcw_read/, '头注释须声明"禁止出现 dcw_control / dcw_read"')
  assert.match(head, /单一事实源/, '头注释须声明单一事实源定位')
  // 去注释后的代码体不得出现被禁字样(本文件字符串常量不含 "//",行注释剥离安全)
  const codeOnly = hintsSrc.slice(headEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  for (const token of BANNED) {
    assert.ok(!codeOnly.includes(token), `fallback-hints.ts 代码体不得出现 ${token}`)
  }
})

test('单一事实源:导出常量均为字符串、不含被禁工具名,且含合法恢复路径指引', async () => {
  const hints = await import('../server/services/workshop/agents/industrial/fallback-hints') as Record<string, unknown>
  for (const name of ['RECOVERY_RETRY_HINT', 'RECOVERY_VERIFY_HINT', 'RECOVERY_TRACE_HINT', 'GOVERNED_DISPATCH_HINT', 'OPT_EXPLORE_HINT']) {
    assert.equal(typeof hints[name], 'string', `缺少字符串常量 ${name}`)
  }
  const values = Object.values(hints).map(v => String(v))
  for (const v of values) {
    for (const token of BANNED) {
      assert.ok(!v.includes(token), `常量值含被禁工具名 ${token}:${v.slice(0, 40)}…`)
    }
  }
  const joined = values.join('\n')
  assert.ok(String(hints.RECOVERY_RETRY_HINT).includes('recipe_rollback(dispatch=true)'), 'RECOVERY_RETRY_HINT 须指引 recipe_rollback(dispatch=true) 整批重下发')
  assert.ok(String(hints.RECOVERY_VERIFY_HINT).includes('daq_query'), 'RECOVERY_VERIFY_HINT 须指引 daq_query 复测')
  assert.match(String(hints.RECOVERY_VERIFY_HINT), /人工现场确认/, 'RECOVERY_VERIFY_HINT 须含 DAQ 无法验证 → 人工现场确认升级')
  assert.ok(String(hints.RECOVERY_TRACE_HINT).includes('dcw_journal') && String(hints.RECOVERY_TRACE_HINT).includes('recipe_versions'), 'RECOVERY_TRACE_HINT 须指引 dcw_journal/recipe_versions 溯源')
  assert.ok(String(hints.OPT_EXPLORE_HINT).includes('optimization_explore'), 'OPT_EXPLORE_HINT 须声明 optimization_explore 仅限工艺优化档')
  assert.ok(joined.includes('recipe_rollback') && joined.includes('daq_query'), '常量集须覆盖 recipe_rollback 与 daq_query 指引')
})

test('防线未撤:dcw-tools.ts 的 v2 恒拒桩文案仍在(handler 侧拒绝面未删)', () => {
  assert.ok(dcwSrc.includes('直接节点写控已禁用(权限模型 v2)'), '恒拒桩文案缺失')
  assert.match(dcwSrc, /直接节点写控已禁用[^\n]*recipe_update[^\n]*recipe_apply/, '恒拒桩须指引配方链路替代路径')
  assert.ok(dcwSrc.includes('isError: true'), '恒拒桩必须 isError')
})
