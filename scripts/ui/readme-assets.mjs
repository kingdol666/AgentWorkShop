/**
 * README / 文档站素材一键重建。
 *
 * 顺序不能换:截图 → GIF → hero。hero.html 里内嵌的是同目录的 town.png / daq.png,
 * 所以 hero 必须最后渲,否则首屏会用到上一轮的界面截图(实测踩过)。
 *
 *   node scripts/ui/readme-assets.mjs [--skip-gif]
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const skipGif = process.argv.includes('--skip-gif')
const run = (script, args = []) => {
  console.log('\n▶ node ' + script + ' ' + args.join(' '))
  execFileSync(process.execPath, [script, ...args], { stdio: 'inherit' })
}

run('scripts/ui/readme-shots.mjs')

if (!skipGif) {
  for (const story of ['agents', 'daq', 'dcw', 'town', 'dashboard', 'responsive']) {
    const num = { agents: '01-closedloop', daq: '02-daq', dcw: '03-dcw', town: '04-town', dashboard: '05-dashboard', responsive: '06-responsive' }[story]
    // record.mjs 按剧本名输出 <story>.gif,这里落成 README 里的 fig-NN-*.gif 编号名
    run('scripts/ui/record.mjs', [story, '--out', 'docs/readme-assets', '--gifw', '1000'])
    fs.renameSync('docs/readme-assets/' + story + '.gif', 'docs/readme-assets/fig-' + num + '.gif')
  }
}

run('scripts/ui/shot-hero.mjs')
console.log('\n✔ README 素材重建完成')
