// 发版版本号同步:把"当前版本"类声明改到 package.json 的版本
// 只改 live 声明,不动历史记录(run 报告日期、能力交付表等)
import { readFileSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'

const ROOT = process.cwd()
const NEXT = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const PREV = process.argv[2] ?? '0.7.36'

const JOBS = [
  // [文件, 正则, 替换文本]
  ['README-zh.md', /当前版本：\*\*v0\.7\.\d+\*\*/g, () => `当前版本：**v${NEXT}**`],
  ['README.md', /Current version: \*\*v0\.7\.\d+\*\*/g, () => `Current version: **v${NEXT}**`],
  ['docs/cli.md', /agentworkshop@0\.7\.\d+/g, () => `agentworkshop@${NEXT}`],
  ['docs/cli.md', /\| 当前版本 \| `0\.7\.\d+`/, () => `| 当前版本 | \`${NEXT}\``],
  ['docs/cli.en.md', /agentworkshop@0\.7\.\d+/g, () => `agentworkshop@${NEXT}`],
  ['docs/cli.en.md', /\| Current version \| `0\.7\.\d+`/, () => `| Current version | \`${NEXT}\``],
  ['docs/sdk.md', /`version`,当前 0\.7\.\d+\)/, () => `\`version\`,当前 ${NEXT})`],
  ['docs/sdk.en.md', /`package\.json`, currently 0\.7\.\d+\)/, () => `\`package.json\`, currently ${NEXT})`],
  ['docs/plugins.md', /对应当前版本 \*\*v0\.7\.\d+\*\*/, () => `对应当前版本 **v${NEXT}**`],
  ['docs/plugins.en.md', /describes \*\*v0\.7\.\d+\*\*/, () => `describes **v${NEXT}**`],
  ['docs/full-test-plan.md', /撰写时基线 v0\.7\.\d+/, () => `撰写时基线 v${PREV}`],
]

// 站点孪生文件必须与单一事实源逐字节一致:同步复制
const TWINS = [
  ['docs/cli.md', 'docs/site/cli/index.md'],
  ['docs/cli.en.md', 'docs/site/en/cli/index.md'],
  ['docs/plugins.md', 'docs/site/plugins/guide.md'],
  ['docs/plugins.en.md', 'docs/site/en/plugins/guide.md'],
  ['docs/sdk.md', 'docs/site/sdk/guide.md'],
  ['docs/sdk.en.md', 'docs/site/en/sdk/guide.md'],
]

let changed = 0
for (const [file, re, to] of JOBS) {
  const p = join(ROOT, file.split('/').join(sep))
  let text
  try { text = readFileSync(p, 'utf8') } catch { console.log(`  跳过(不存在) ${file}`); continue }
  const before = text
  text = text.replace(re, to)
  if (text !== before) { writeFileSync(p, text, 'utf8'); changed++; console.log(`  ✔ ${file}`) }
}
for (const [src, dst] of TWINS) {
  const a = readFileSync(join(ROOT, src.split('/').join(sep)), 'utf8')
  const p = join(ROOT, dst.split('/').join(sep))
  const b = readFileSync(p, 'utf8')
  if (a !== b) { writeFileSync(p, a, 'utf8'); changed++; console.log(`  ⇄ 孪生同步 ${dst}`) }
}

console.log(`\n版本 → ${NEXT}(原 live 声明 ${PREV});改动 ${changed} 处`)
