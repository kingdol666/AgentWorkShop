// ============================================================
// 指令:build — 生产构建（nuxt build → .output/）
// ============================================================
import { color } from '../core/logger.mjs'
import { localBypassEnv } from '../core/context.mjs'
import { runChild } from '../core/child-lifecycle.mjs'
import { postBuildArtifacts } from '../core/post-build.mjs'

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
  // 统一生命周期:转发 SIGINT/SIGTERM(子进程不再变孤儿) + 等待退出 + 超时强杀
  // + 退出码传播(被信号杀死 → 128+N,不再 code ?? 0 误报成功)
  const code = await runChild(process.execPath, [nuxtBin, 'build'], {
    cwd: root,
    stdio: 'inherit',
    env: localBypassEnv(),
    onSpawnError: err => console.log(`${color.red('✖')} 构建失败: ${err.message}`),
  })
  if (code !== 0) return code

  // 构建产物后处理:import-meta 补丁 + 外置资产分发。
  // 不能只靠 nuxt.config 的 compiled 钩子 —— 它与 chunk 落盘有竞态,静默失效会让
  // 产物启动即抛 ERR_INVALID_FILE_URL_PATH。这里在构建**返回后**重做并校验。
  try {
    const r = postBuildArtifacts(root)
    if (r.patched.length > 0) console.log(`${color.cyan('›')} import-meta 补丁:${r.patched.join(', ')}`)
    if (r.assets.length > 0) console.log(`${color.cyan('›')} 外置资产随产物分发:${r.assets.join(', ')}`)
    if (r.missing.length > 0) console.log(`${color.yellow('!')} 未生成(跳过):${r.missing.join(', ')}`)
  }
  catch (err) {
    console.log(`${color.red('✖')} ${err?.message ?? err}`)
    return 1
  }
  return 0
}
