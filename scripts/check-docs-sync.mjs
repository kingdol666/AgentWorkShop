/**
 * check-docs-sync.mjs —— 文档一致性守卫(离线,不依赖服务器)
 * ------------------------------------------------------------
 * 起因:CI(.github/workflows/deploy-docs.yml)会把 docs/{cli,plugins,sdk}.md 与它们的
 * .en.md 孪生文件复制进站点。源文件与站点内已提交副本一旦分叉,下一次部署就会静默
 * 回退站点的修正(本项目真实发生过:站点 cli/index.md 比 docs/cli.md 新)。
 * 本脚本把「同源」「中英同构」「已知陈旧断言」三件事变成可失败断言。
 *
 * 用法:node scripts/check-docs-sync.mjs
 * 退出:0 全过 / 1 有失败
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

let pass = 0
let fail = 0

const ok = (msg) => {
  pass++
  console.log(`  \u2714 ${msg}`)
}
const bad = (msg) => {
  fail++
  console.log(`  \u2716 ${msg}`)
}
const section = t => console.log(`\n${t}`)

const read = (rel) => {
  const p = join(ROOT, rel)
  if (!existsSync(p)) return null
  // 统一换行,避免 CRLF/LF 差异造成假失败
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
}

/** CI 复制对:源 → 站点副本(必须逐字节一致) */
const SYNC_PAIRS = [
  ['docs/cli.md', 'docs/site/cli/index.md'],
  ['docs/cli.en.md', 'docs/site/en/cli/index.md'],
  ['docs/plugins.md', 'docs/site/plugins/guide.md'],
  ['docs/plugins.en.md', 'docs/site/en/plugins/guide.md'],
  ['docs/sdk.md', 'docs/site/sdk/guide.md'],
  ['docs/sdk.en.md', 'docs/site/en/sdk/guide.md'],
]

/** 中英页面配对(标题结构必须同构) */
const LANG_PAIRS = [
  ['docs/site/cli/index.md', 'docs/site/en/cli/index.md'],
  ['docs/site/plugins/guide.md', 'docs/site/en/plugins/guide.md'],
  ['docs/site/plugins/index.md', 'docs/site/en/plugins/index.md'],
  ['docs/site/plugins/lifecycle.md', 'docs/site/en/plugins/lifecycle.md'],
  ['docs/site/plugins/example.md', 'docs/site/en/plugins/example.md'],
  ['docs/site/sdk/guide.md', 'docs/site/en/sdk/guide.md'],
  ['docs/site/sdk/index.md', 'docs/site/en/sdk/index.md'],
  ['docs/site/sdk/context.md', 'docs/site/en/sdk/context.md'],
  ['docs/site/sdk/lifecycle.md', 'docs/site/en/sdk/lifecycle.md'],
  ['docs/site/sdk/client.md', 'docs/site/en/sdk/client.md'],
  ['docs/site/sdk/api-client.md', 'docs/site/en/sdk/api-client.md'],
  ['docs/site/guide/getting-started.md', 'docs/site/en/guide/getting-started.md'],
  ['docs/site/guide/configuration.md', 'docs/site/en/guide/configuration.md'],
  ['docs/site/guide/daq-protocols.md', 'docs/site/en/guide/daq-protocols.md'],
  ['docs/site/guide/dcw-read-write.md', 'docs/site/en/guide/dcw-read-write.md'],
  ['docs/site/guide/hitl.md', 'docs/site/en/guide/hitl.md'],
  ['docs/site/guide/recipe-versions.md', 'docs/site/en/guide/recipe-versions.md'],
  ['docs/site/guide/multi-harness.md', 'docs/site/en/guide/multi-harness.md'],
  ['docs/site/guide/aml.md', 'docs/site/en/guide/aml.md'],
  ['docs/site/guide/line-permissions.md', 'docs/site/en/guide/line-permissions.md'],
  ['docs/site/guide/first-session.md', 'docs/site/en/guide/first-session.md'],
  ['docs/site/guide/license.md', 'docs/site/en/guide/license.md'],
]

/** 已知陈旧/错误断言(曾在文档里真实出现过,禁止回归) */
const BANNED = [
  { re: /73\s*(个)?\s*(设置项|settings)/i, why: '设置项数早已是 98(config.yml 有 79 个键,73 对不上任何东西)' },
  { re: /18\s*个设置项/, why: 'aw config list 实际打印 98 行' },
  { re: /6\s*(个)?\s*(执行引擎|engines?)/i, why: '执行引擎是 14 个,不是 6 个' },
  { re: /kv\.reset\s*\(/, why: 'ctx.kv 没有 reset()(只有 get/set/all/bump),示例会 TypeError' },
  { re: /npx\s+-p\s+agentworkshop\s+doctor/, why: 'package.json 只有 aw / agentworkshop 两个 bin,没有 doctor' },
  { re: /nuxt prepare/, why: 'package.json 没有 nuxt prepare 脚本' },
  { re: /不落全局/, why: 'npx/aw start 都会 bootstrap ~/.AgentWorkShop,并非零残留' },
  { re: /-webkit-backdrop-filter/, why: '手写该前缀会让压缩器只输出前缀版;Chromium 152 已不支持 → 玻璃整体失效' },
  { re: /AW_MESSAGES_RETENTION_D/, why: '不是已声明的 env 别名,envOverridesFromEnv 读不到' },
  // 以下四条由独立对抗式复核(逐条对照代码抽样)发现,补进黑名单防回归
  { re: /driverAvailability(?!\()/, why: 'GET /api/workshop/daq 的响应键是 driverAvailable(driverAvailability 只是 controller 方法名)' },
  { re: /0\.7\.9/, why: 'config.yml 的 app.version 已随版本更新;且它本就不是权威值(package.json 才是)' },
  { re: /(修改|改动|编辑)插件(代码|源码|文件)[^。\n]{0,24}热重载/, why: '宿主只监视 plugins-state.json,没有插件目录 watcher —— 改源码本身不触发热重载' },
  { re: /Array\.isArray\(\s*await\s+[\w.]*lines\.list\(\)/, why: 'GET /api/workshop/dcw/lines 返回 { lines, states },不是数组,该判断恒为 false' },
]

section('[1/6] 同源复制对(源 vs 站点内已提交副本)')
for (const [src, dst] of SYNC_PAIRS) {
  const a = read(src)
  const b = read(dst)
  if (a === null) {
    bad(`${src} 不存在`)
    continue
  }
  if (b === null) {
    bad(`${dst} 不存在(CI 需要它的已提交副本作回退)`)
    continue
  }
  if (a === b) {
    ok(`${dst} 与 ${src} 一致(${a.length} 字符)`)
    continue
  }
  // 定位首个差异行,便于直接修
  const la = a.split('\n')
  const lb = b.split('\n')
  let i = 0
  while (i < Math.min(la.length, lb.length) && la[i] === lb[i]) i++
  bad(`${dst} 与 ${src} 分叉(源 ${a.length} 字符 / 副本 ${b.length} 字符;首差在第 ${i + 1} 行)`)
  console.log(`      源: ${JSON.stringify((la[i] ?? '').slice(0, 90))}`)
  console.log(`      副: ${JSON.stringify((lb[i] ?? '').slice(0, 90))}`)
}

section('[2/6] 中英页面同构(标题层级序列 + 代码块数)')
const headings = md => (md.match(/^#{1,4} .+$/gm) ?? []).map(h => h.match(/^#+/)[0].length)
const fences = md => Math.floor((md.match(/^```/gm) ?? []).length / 2)
for (const [zh, en] of LANG_PAIRS) {
  const a = read(zh)
  const b = read(en)
  if (a === null || b === null) {
    bad(`${zh} 或 ${en} 缺失`)
    continue
  }
  const ha = headings(a)
  const hb = headings(b)
  const fa = fences(a)
  const fb = fences(b)
  const problems = []
  if (ha.length !== hb.length) problems.push(`标题数 ${ha.length} vs ${hb.length}`)
  else if (ha.join(',') !== hb.join(',')) problems.push(`标题层级序列不同 [${ha.join(',')}] vs [${hb.join(',')}]`)
  if (fa !== fb) problems.push(`代码块数 ${fa} vs ${fb}`)
  if (problems.length) bad(`${en} 与中文页不同构:${problems.join(';')}`)
  else ok(`${en} 与中文页同构(${ha.length} 个标题 / ${fa} 个代码块)`)
}

section('[3/6] 已知陈旧/错误断言不得回归')
const scanFiles = []
const walk = (rel) => {
  const md = read(rel)
  if (md !== null) scanFiles.push([rel, md])
}
for (const [src] of SYNC_PAIRS) walk(src)
for (const [zh, en] of LANG_PAIRS) {
  walk(zh)
  walk(en)
}
walk('README.md')
walk('README-zh.md')
walk('docs/site/index.md')
walk('docs/site/en/index.md')
walk('docs/site/.vitepress/theme/custom.css')
walk('docs/aml.md')
walk('docs/tui.md')

for (const { re, why } of BANNED) {
  const hits = []
  for (const [file, rawText] of scanFiles) {
    // CSS 注释里会**解释**这些禁用写法(例如说明为什么不能手写 webkit 前缀),
    // 那是文档而非用法,先剥掉再扫,否则守卫会被自己的说明文字触发。
    const text = file.endsWith('.css') ? rawText.replace(/\/\*[\s\S]*?\*\//g, '') : rawText
    text.split('\n').forEach((line, i) => {
      if (re.test(line)) hits.push(`${file}:${i + 1}`)
    })
  }
  if (hits.length) bad(`${re} 仍出现 ${hits.length} 处 —— ${why}\n      ${hits.slice(0, 4).join('  ')}`)
  else ok(`无 ${re}`)
}

section('[3b/6] 站点配置与新增页面存在性')
for (const f of ['docs/site/guide/aml.md', 'docs/site/en/guide/aml.md']) {
  if (existsSync(join(ROOT, f))) ok(`${f} 存在`)
  else bad(`${f} 缺失(导航已指向它)`)
}
const cfg = read('docs/site/.vitepress/config.mts') ?? ''
for (const [needle, why] of [['/guide/aml', '中文侧栏缺少 AML 条目'], ['/en/guide/aml', '英文侧栏缺少 AML 条目']]) {
  if (cfg.includes(needle)) ok(`config.mts 含 ${needle}`)
  else bad(`config.mts 缺 ${needle} —— ${why}`)
}
const wf = read('.github/workflows/deploy-docs.yml') ?? ''
for (const f of ['docs/cli.en.md', 'docs/plugins.en.md', 'docs/sdk.en.md']) {
  if (wf.includes(f)) ok(`部署工作流同步 ${f}`)
  else bad(`部署工作流未同步 ${f} —— 英文单页指南会与事实源漂移`)
}

section('[4/6] 文档里宣称的版本号必须等于 package.json')
// 文档里写死的"当前版本"是最容易腐烂的一类断言:发版时没人记得改,
// 读者据此判断自己装的是不是最新版。这里把四处声明与 package.json 对齐。
// ⚠️ 间距上限必须放宽:zh 的 CLI 手册是表格行("| 当前版本 | `0.7.36` |"),
// 「当前版本」与数字之间隔着 ` | \`` 这类字符;SDK 指南的间距约 31–50 字符。
// 早先的 12 字符上限让 4 条断言里有 3 条**空过**(报"未硬编码"却其实写着版本号)——
// 守卫给假信心,由对抗式复核发现。
{
  const pkgVersion = JSON.parse(read('package.json') ?? '{}').version
  const GAP = '[^0-9]{0,60}'
  const VERSION_CLAIMS = [
    ['docs/cli.md', new RegExp(`当前版本${GAP}([0-9]+\\.[0-9]+\\.[0-9]+)`)],
    ['docs/cli.en.md', new RegExp(`current version${GAP}([0-9]+\\.[0-9]+\\.[0-9]+)`, 'i')],
    ['docs/sdk.md', new RegExp(`npm\\s*包版本${GAP}([0-9]+\\.[0-9]+\\.[0-9]+)`)],
    ['docs/sdk.en.md', new RegExp(`npm package version${GAP}([0-9]+\\.[0-9]+\\.[0-9]+)`, 'i')],
  ]
  for (const [file, re] of VERSION_CLAIMS) {
    const text = read(file)
    if (text === null) {
      bad(`${file} 不存在`)
      continue
    }
    const m = re.exec(text)
    if (!m) {
      // 匹配不到必须算失败:否则措辞一改断言就静默空过(这正是先前的问题)
      bad(`${file} 未匹配到「当前版本 + 版本号」—— 声明被删就该同步改本守卫,措辞改了更不该放过`)
      continue
    }
    if (m[1] === pkgVersion) ok(`${file} 版本声明 = ${m[1]} = package.json`)
    else bad(`${file} 版本声明为 ${m[1]},而 package.json 是 ${pkgVersion} —— 发版时漏改`)
  }

  // 版本锁定示例也必须指向**已发布**的版本:0.7.35 只在 git 里存在、从未推到 npm,
  // 文档却给过 `npx agentworkshop@0.7.35 start` —— 那条命令执行时必然 "No matching version"。
  for (const [file] of VERSION_CLAIMS) {
    const text = read(file)
    if (text === null) continue
    const pins = [...text.matchAll(/agentworkshop@([0-9]+\.[0-9]+\.[0-9]+)/g)].map(x => x[1])
    const stale = [...new Set(pins.filter(v => v !== pkgVersion))]
    if (!pins.length) ok(`${file} 无 npx 版本锁定示例`)
    else if (stale.length) bad(`${file} 的 npx 锁定示例指向 ${stale.join(',')},而当前包版本是 ${pkgVersion}(未发布的版本号会让命令直接失败)`)
    else ok(`${file} 的 npx 锁定示例指向当前版本`)
  }
}

section('[5/6] VitePress 模板安全:正文裸尖括号不得被当成未闭合标签')
// VitePress 把每个 .md 编译成 Vue SFC 模板。正文里写 <home>/plugins-state.json 这类
// 占位符,Vue 会把它当成自定义元素并因缺少 </home> 直接**构建失败**
// (实际发生过:plugins/guide.md 曾导致 `vitepress build` 报 Element is missing end tag)。
// 行内代码/围栏代码里的尖括号会被 markdown-it 转义,是安全的 —— 先剥掉再扫。
const SAFE_TAGS = new Set(['div', 'img', 'br', 'b', 'i', 'strong', 'em', 'a', 'span', 'code', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sub', 'sup', 'p', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'kbd', 'details', 'summary', 'picture', 'source', 'video', 'hr', 'small', 'figure', 'figcaption', 'section', 'input'])
const stripCode = md => md
  .replace(/^```[\s\S]*?^```/gm, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/`[^`\n]*`/g, '')

const templateFiles = []
const walkTemplate = (rel) => {
  const md = read(rel)
  if (md !== null) templateFiles.push([rel, md])
}
for (const [src] of SYNC_PAIRS) walkTemplate(src)
for (const [zh, en] of LANG_PAIRS) {
  walkTemplate(zh)
  walkTemplate(en)
}
walkTemplate('docs/site/index.md')
walkTemplate('docs/site/en/index.md')

{
  const offenders = []
  for (const [file, md] of templateFiles) {
    const lines = stripCode(md).split('\n')
    lines.forEach((line, i) => {
      const re = /<([a-zA-Z][\w-]*)(\s[^>]*)?\/?>/g
      let m
      while ((m = re.exec(line)) !== null) {
        const tag = m[1]
        // 连字符标签(Vue 自定义元素)与已知 HTML 标签是安全的
        if (SAFE_TAGS.has(tag) || tag.includes('-')) continue
        offenders.push(`${file}:${i + 1}  <${tag}>  ← ${line.trim().slice(0, 70)}`)
      }
    })
  }
  if (offenders.length) {
    bad(`正文有 ${offenders.length} 处裸尖括号会被 Vue 当作未闭合标签(构建会失败)`)
    for (const o of offenders.slice(0, 12)) console.log(`      ${o}`)
    if (offenders.length > 12) console.log(`      …另外 ${offenders.length - 12} 处`)
  }
  else ok('正文裸尖括号检查通过(占位符都在行内代码里)')
}

section('[6b/6] 文档里宣称的设置项数量必须等于 schema.json')
// 数字型断言最容易腐烂:新增/删除一个设置项,README、首页、CLI 手册、配置指南里的
// "N 个设置项"会同时过期,而散落在 10 个文件里手工同步必漏(本次加 workshop.stall_ms
// 就从 98 变 99,当场验证了这一点)。这里把总数、组数、live/restart 拆分一起钉住。
{
  const schema = JSON.parse(read('shared/config/schema.json') ?? '{"settings":[]}')
  const all = Array.isArray(schema.settings) ? schema.settings : Object.values(schema.settings ?? {})
  const total = all.length
  const groups = new Set(all.map(s => s.group)).size
  const live = all.filter(s => (s.applies ?? 'live') === 'live').length
  const restart = all.filter(s => s.applies === 'restart').length
  // 只在"带语义词"的位置断言,避免误伤端口号/版本号
  const CLAIMS = []
  for (const [src] of SYNC_PAIRS) CLAIMS.push(src)
  CLAIMS.push('README.md', 'README-zh.md', 'docs/site/index.md', 'docs/site/en/index.md',
    'docs/site/guide/configuration.md', 'docs/site/en/guide/configuration.md')
  // 只匹配**表示总数**的写法。踩过的坑:宽松的 `(\d+)\s*settings` 会把
  // "16 settings in the `aml` group"(AML 分组的设置数)误判成总数断言。
  const TOTAL_SHAPES = [
    /(\d+)\s*个设置项/g,
    /(\d+)\s*个运行时设置项/g,
    /(\d+)\s*setting descriptors/g,
    /(\d+)\s*settings across\s+\d+\s+groups/g,
    /(\d+)\s*settings\s*\(\d+\s+groups?\)/g,
    /prints exactly\s+(\d+)\s+rows/g,
  ]
  for (const file of [...new Set(CLAIMS)]) {
    const text = read(file)
    if (text === null) continue
    const nums = []
    for (const re of TOTAL_SHAPES) {
      for (const m of text.matchAll(re)) nums.push(Number(m[1]))
    }
    const mismatched = nums.filter(n => n !== total)
    if (!nums.length) ok(`${file} 未硬编码设置项总数`)
    else if (mismatched.length) bad(`${file} 宣称 ${[...new Set(mismatched)].join('/')} 个设置项,而 schema.json 是 ${total}`)
    else ok(`${file} 设置项总数 = ${total}(${nums.length} 处断言)`)
  }
  for (const file of ['README.md', 'README-zh.md', 'docs/site/index.md', 'docs/site/en/index.md', 'docs/site/guide/configuration.md', 'docs/site/en/guide/configuration.md']) {
    const text = read(file)
    if (text === null) continue
    const m = /(\d+)\s*live\s*[/·]\s*(\d+)\s*restart/.exec(text)
    if (!m) continue
    if (Number(m[1]) === live && Number(m[2]) === restart) ok(`${file} live/restart = ${live}/${restart}`)
    else bad(`${file} 宣称 ${m[1]} live / ${m[2]} restart,而 schema.json 是 ${live}/${restart}`)
  }
  ok(`schema.json 基准:${total} 项 / ${groups} 组 / live ${live} · restart ${restart}`)
}

section('[6/6] 表格单元格内联代码不得含未转义竖线')
// 表格里的 `a|b` 会**先**被 markdown-it 按单元格切开,行内代码失效;
// 之后 <type> 这类占位符就裸露成 HTML,再次触发上面的 Vue 模板错误。
// 真实踩坑:`| \`event:<type>\` |` 让 en/plugins/guide.md 整个构建失败。
{
  const hits = []
  for (const [file, md] of templateFiles) {
    let inFence = false
    md.split('\n').forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return
      }
      if (inFence) return
      if (!/^\s*\|/.test(line)) return
      const spans = line.match(/`[^`\n]*`/g) ?? []
      for (const s of spans) {
        // \| 是合法转义,放行
        if (s.slice(1, -1).replace(/\\\|/g, '').includes('|')) hits.push(`${file}:${i + 1}  ${s}`)
      }
    })
  }
  if (hits.length) {
    bad(`有 ${hits.length} 处表格内联代码含未转义 |(会被切成两格,并可能连带 Vue 构建失败)`)
    for (const h of hits.slice(0, 12)) console.log(`      ${h}`)
    if (hits.length > 12) console.log(`      …另外 ${hits.length - 12} 处`)
  }
  else ok('表格内联代码中的竖线均已转义(或不存在)')
}

console.log(`\n${fail ? '\u2716' : '\u2705'} 文档一致性:${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
