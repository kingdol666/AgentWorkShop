/**
 * fix-settings-count.mjs —— 按 schema.json 的实时统计改写文档里的设置项数量断言
 * 起因:新增一个设置项(workshop.stall_ms)后,README / 首页 / CLI 手册里的"98 个设置项"
 * 全部过期 —— 这类数字散落在 10 个文件里,手工同步必漏。这里统一改,并由
 * scripts/check-docs-sync.mjs 的 [7/7] 段做回归守卫。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const schema = JSON.parse(readFileSync(join(ROOT, 'shared/config/schema.json'), 'utf8'))
const all = Array.isArray(schema.settings) ? schema.settings : Object.values(schema.settings)
const TOTAL = all.length
const GROUPS = new Set(all.map(s => s.group)).size
const LIVE = all.filter(s => (s.applies ?? 'live') === 'live').length
const RESTART = all.filter(s => s.applies === 'restart').length
console.log(`schema.json:${TOTAL} 项 / ${GROUPS} 组 / live ${LIVE} / restart ${RESTART}`)

const FILES = [
  'README.md', 'README-zh.md',
  'docs/site/index.md', 'docs/site/en/index.md',
  'docs/site/guide/configuration.md', 'docs/site/en/guide/configuration.md',
  'docs/cli.md', 'docs/cli.en.md',
  'docs/site/cli/index.md', 'docs/site/en/cli/index.md',
  'docs/plugins.md', 'docs/plugins.en.md',
  'docs/sdk.md', 'docs/sdk.en.md',
  'docs/site/sdk/guide.md', 'docs/site/en/sdk/guide.md',
  'docs/site/plugins/guide.md', 'docs/site/en/plugins/guide.md',
]

/** 旧数字 → 新数字:只替换"紧跟设置项/组语义词"的数字,避免误伤版本号与端口 */
const RULES = [
  [/\b98\b(?=[^\n]{0,12}(个设置项|个运行时设置项|settings|descriptors|设置项))/g, String(TOTAL)],
  [/32 live\s*\/\s*66 restart/g, `${LIVE} live / ${RESTART} restart`],
  [/32 live\s*·\s*66 restart/g, `${LIVE} live · ${RESTART} restart`],
  [/\b16 组\b/g, `${GROUPS} 组`],
  [/\b16 groups\b/g, `${GROUPS} groups`],
]

let changed = 0
for (const rel of FILES) {
  const p = join(ROOT, rel)
  if (!existsSync(p)) continue
  const before = readFileSync(p, 'utf8')
  let after = before
  for (const [re, rep] of RULES) after = after.replace(re, rep)
  // 只把"98"这一处旧值也覆盖掉(首个规则已处理带语义词的;这里兜底处理 98 个设置项 的中文形态)
  after = after.replace(new RegExp(`\\b98\\b(?=[^\\n]{0,12}(个设置项|个运行时设置项))`, 'g'), String(TOTAL))
  if (after !== before) {
    writeFileSync(p, after)
    changed++
    console.log(`  ✔ ${rel}`)
  }
}
console.log(`\n共修改 ${changed} 个文件`)
