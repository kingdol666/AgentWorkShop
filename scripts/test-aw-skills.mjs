#!/usr/bin/env node
/**
 * scripts/test-aw-skills.mjs —— skills/ 目录 skill 设计规范校验。
 *
 * 校验面(符合 agent skill 通用规范 + 本项目约定):
 *   1. 结构:SKILL.md 存在、frontmatter(name/description)完整
 *   2. 命名:目录名 = frontmatter name,kebab-case
 *   3. 描述:第三人称可用性描述,长度 20~1024
 *   4. 正文:有分节(## ),无 TODO/FIXME/TBD 占位
 *   5. 工具引用:正文引用的 aw_* 工具必须真实存在于 mcp/aw-mcp-server.mjs 工具面
 *   6. 文件引用:正文提到的仓库文件(docs/sdk/scripts/插件样例)必须真实存在
 *
 * 用法:node scripts/test-aw-skills.mjs   (FAIL 则退出码 1)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_DIR = join(REPO, 'skills')

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) pass++
  else fails.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return null
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return { meta, body: text.slice(m[0].length) }
}

// ── 收集 skill ──
ok('skills/ 目录存在', existsSync(SKILLS_DIR), SKILLS_DIR)
if (!existsSync(SKILLS_DIR)) {
  console.error(`✖ ${SKILLS_DIR} 不存在`)
  process.exit(1)
}
const dirs = readdirSync(SKILLS_DIR).filter(d => statSync(join(SKILLS_DIR, d)).isDirectory())
ok('skill 数量 ≥ 3', dirs.length >= 3, `实际 ${dirs.length}`)

// ── 工具面对照表(从 MCP server 导入真实注册表)──
const { buildToolDefs } = await import(pathToFileURL(join(REPO, 'mcp', 'aw-mcp-server.mjs')).href)
const toolNames = new Set(buildToolDefs().map(t => t.name))

for (const dir of dirs) {
  const label = `skills/${dir}`
  const file = join(SKILLS_DIR, dir, 'SKILL.md')
  ok(`${label}: SKILL.md 存在`, existsSync(file))
  if (!existsSync(file)) continue
  const text = readFileSync(file, 'utf8')

  const parsed = parseFrontmatter(text)
  ok(`${label}: frontmatter 存在`, parsed != null)
  if (!parsed) continue
  const { meta, body } = parsed

  ok(`${label}: name = 目录名`, meta.name === dir, `frontmatter=${meta.name}`)
  ok(`${label}: name kebab-case`, /^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.name ?? ''), meta.name)
  ok(`${label}: description 存在`, Boolean(meta.description))
  ok(`${label}: description 长度 20~1024`, (meta.description ?? '').length >= 20 && (meta.description ?? '').length <= 1024, `len=${(meta.description ?? '').length}`)
  ok(`${label}: description 含使用时机(当/when/需要)`, /当|需要|when|use/i.test(meta.description ?? ''))

  ok(`${label}: 正文 ≥2 个 ## 分节`, (body.match(/^## /gm) ?? []).length >= 2)
  ok(`${label}: 无 TODO/FIXME/TBD 占位`, !/\b(TODO|FIXME|TBD)\b/.test(body))

  // 工具引用真实性
  const referencedTools = [...new Set(body.match(/\baw_[a-z_]+\b/g) ?? [])]
  ok(`${label}: 至少引用 3 个 MCP 工具`, referencedTools.length >= 3, `引用 ${referencedTools.length} 个`)
  const ghost = referencedTools.filter(t => !toolNames.has(t))
  ok(`${label}: 引用工具全部存在于 MCP 工具面`, ghost.length === 0, `幽灵工具: ${ghost.join(', ')}`)

  // ── 设计质量 rubric(agent 可执行性)──
  ok(`${label}: 编号步骤(### N.)≥4`, (body.match(/^### \d+\./gm) ?? []).length >= 4, `实际 ${(body.match(/^### \d+\./gm) ?? []).length}`)
  ok(`${label}: 含验收清单/验证段`, /验收清单|## 验证|硬性|回环验收/i.test(body))
  ok(`${label}: 含治理红线`, /红线|禁止|不要|绝不|fail-closed/i.test(body))
  ok(`${label}: 含 MCP 开关前置(系统设置/AW_MCP_ENABLED)`, /系统设置 → MCP 集成|AW_MCP_ENABLED|mcpEnabled/.test(body))
  ok(`${label}: 步骤含失败处置指引(400/被拒/超时语义)`, /400|被拒|超时|被拒/i.test(body))
  // 工业操作类 skill(节点/闭环)工具面覆盖要求更高;插件开发以 CLI+文件编辑为主,阈值 3
  const opHeavy = /节点|优化|Channel/.test(meta.description ?? '')
  ok(`${label}: 工具引用丰富(${opHeavy ? '≥6' : '≥3'})`, referencedTools.length >= (opHeavy ? 6 : 3), `引用 ${referencedTools.length} 个`)
  ok(`${label}: 行数 ≤ 220(规范:正文精炼)`, body.split(/\r?\n/).length <= 220, `${body.split(/\r?\n/).length} 行`)

  // 仓库文件引用真实性(`docs/...` `sdk/...` `scripts/...` 反引号路径)
  const refMatches = [...body.matchAll(/`((?:docs|sdk|scripts|tests|server|\.AgentWorkShop)\/[^`\s]+)`/g)].map(m => m[1])
  for (const ref of [...new Set(refMatches)]) {
    ok(`${label}: 引用文件存在 ${ref}`, existsSync(join(REPO, ref)))
  }
}

console.log('')
console.log(`═══ skill 规范校验:${pass} PASS / ${fails.length} FAIL(skills: ${dirs.join(', ')}) ═══`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('')
process.exit(fails.length ? 1 : 0)
