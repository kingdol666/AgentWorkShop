// ============================================================
// 指令:version — 版本信息
// ============================================================
import { color } from '../core/logger.mjs'
import { packageVersion } from '../aw.mjs'

export const meta = {
  name: 'version',
  aliases: ['v'],
  group: '其他',
  summary: '显示版本信息',
  usage: 'aw version',
  needsProject: false,
}

export async function run(argv, ctx) {
  const version = packageVersion()
  if (ctx.json) {
    console.log(JSON.stringify({
      ok: true,
      name: 'agentworkshop',
      version,
      node: process.version,
      project: ctx.root ?? null,
    }))
    return 0
  }
  console.log(`${color.bold('agentworkshop')} ${version}`)
  console.log(`  node ${process.version} · ${ctx.root ? `项目: ${ctx.root}` : '未在项目中'}`)
  console.log(`  ${color.dim('配置: config.yml < data/runtime-settings.json < env')}`)
  return 0
}
