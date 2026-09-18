/**
 * 把工作坊组件里 8–9px 的微字统一抬到 10px(桌面档的"铭牌地板")。
 *
 * 为什么要机械扫而不是逐个改:这些值散落在 13 个组件里、且只有**渲染到**才会被
 * 审计抓到(所以"没被报出来"不等于"不存在" —— 频道会话台根本不在审计矩阵里)。
 * 8–9px 在任何视距下都读不了,统一到 10px 既过门槛,又不改变布局
 * (它们全是行内标签,容器本来就允许换行)。
 *
 * 用法: node scripts/ui/bump-microfont.mjs [--dry]
 */
import fs from 'node:fs'
import path from 'node:path'

const dry = process.argv.includes('--dry')
const root = 'app/components/workshop'
const files = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(vue|ts)$/.test(e.name)) files.push(p)
  }
}
walk(root)

let total = 0
for (const f of files) {
  const before = fs.readFileSync(f, 'utf8')
  const after = before
    .replace(/font-size: 8px/g, 'font-size: 10px')
    .replace(/font-size: 9px/g, 'font-size: 10px')
  if (after !== before) {
    const n = (before.match(/font-size: (8|9)px/g) || []).length
    total += n
    if (!dry) fs.writeFileSync(f, after)
    console.log((dry ? '[dry] ' : '') + f.replace(/\\/g, '/') + ' -> ' + n)
  }
}
console.log((dry ? '[dry] would bump ' : 'bumped ') + total + ' rules')
