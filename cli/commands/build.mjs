// ============================================================
// 指令:build — 生产构建（nuxt build → .output/）
// ============================================================
import { spawn } from 'node:child_process'
import { color } from '../core/logger.mjs'
import { localBypassEnv } from '../core/context.mjs'

export const meta = {
  name: 'build',
  aliases: ['b', 'compile'],
  group: '运行',
  summary: '生产构建（nuxt build → .output/）',
  usage: 'aw build',
  needsProject: true,
}

export async function run(argv, ctx) {
  const { root } = ctx
  const nuxtBin = ctx.resolveNuxtBin()
  if (!nuxtBin) {
    console.log(`${color.red('✖')} 未找到 nuxt CLI（项目 node_modules 缺失?）`)
    return 1
  }
  console.log(`${color.cyan('›')} 构建生产产物 .output/ ...`)
  const child = spawn(process.execPath, [nuxtBin, 'build'], { cwd: root, stdio: 'inherit', env: localBypassEnv() })
  return await new Promise((resolve2) => {
    child.on('close', code => resolve2(code ?? 0))
    child.on('error', (err) => {
      console.log(`${color.red('✖')} 构建失败: ${err.message}`)
      resolve2(1)
    })
  })
}
