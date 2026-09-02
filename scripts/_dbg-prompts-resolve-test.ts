/**
 * prompts 目录解析断言(夹具由 bash 预置,本脚本只做解析与输出)。
 * 用法:npx tsx scripts/_dbg-prompts-resolve-test.ts <proj-with-prompts> <explicit-dir>
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const proj = process.argv[2]!
const explicit = process.argv[3]!
const home = mkdtempSync(join(tmpdir(), 'aw-prompt-home-'))
process.env.AW_HOME = home

const { promptsDir } = await import('../server/services/workshop/prompts/loader')

// 场景1:空目录启动 → 兜底 ~/.AgentWorkShop/prompts 且自动播种
process.chdir(home)
const d1 = promptsDir()
console.log('场景1 兜底播种:', d1 === join(home, 'prompts') ? 'PASS' : 'FAIL', '| 初始文件:', existsSync(join(d1, 'host-tools.json')) && existsSync(join(d1, 'mode-goal.md')) ? 'PASS' : 'FAIL')

// 场景2:项目内 .AgentWorkShop/prompts 存在 → 项目内优先
process.chdir(proj)
const d2 = promptsDir()
console.log('场景2 项目内优先:', d2 === join(proj, '.AgentWorkShop', 'prompts') ? 'PASS' : 'FAIL')

// 场景3:home 已播种内容不被覆盖(用户改写后再次解析不回写)
process.chdir(home)
const goalFile = join(d1, 'mode-goal.md')
writeFileSync(goalFile, '# user-customized-for-test')
const d3 = promptsDir()
console.log('场景3 定制不被覆盖:', readFileSync(goalFile, 'utf8') === '# user-customized-for-test' && d3 === d1 ? 'PASS' : 'FAIL')

// 场景4:AW_PROMPTS_DIR 显式覆盖最高
process.env.AW_PROMPTS_DIR = explicit
process.chdir(proj)
const d4 = promptsDir()
console.log('场景4 显式覆盖:', join(d4, 'host-tools.json') === join(explicit, 'host-tools.json') ? 'PASS' : 'FAIL')

console.log('临时 home(可人工核对):', home)
