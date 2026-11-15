// ============================================================
// 指令:build — 生产构建（nuxt build → .output/）
// ============================================================
import { color } from '../core/logger.mjs'
import { localBypassEnv } from '../core/context.mjs'
import { runChild } from '../core/child-lifecycle.mjs'
import { postBuildArtifacts } from '../core/post-build.mjs'
import { withBuildLock } from '../core/build-lock.mjs'

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
  try {
    return await withBuildLock(root, async () => {
      console.log(`${color.cyan('›')} 构建生产产物 .output/ ...`)
      // 统一生命周期:转发 SIGINT/SIGTERM(子进程不再变孤儿) + 等待退出 + 超时强杀
      // + 退出码传播(被信号杀死 → 128+N,不再 code ?? 0 误报成功)
      const env = localBypassEnv()
      env.NODE_OPTIONS = [env.NODE_OPTIONS, '--disable-warning=DEP0155'].filter(Boolean).join(' ')
      const code = await runChild(process.execPath, [nuxtBin, 'build'], {
        cwd: root,
        stdio: 'inherit',
        env,
        onSpawnError: err => console.log(`${color.red('✖')} 构建失败: ${err.message}`),
      })
      if (code !== 0) return code

      const r = postBuildArtifacts(root)
      if (r.patched.length > 0) console.log(`${color.cyan('›')} import-meta 补丁:${r.patched.join(', ')}`)
      if (r.assets.length > 0) console.log(`${color.cyan('›')} 外置资产随产物分发:${r.assets.join(', ')}`)
      if (r.missing.length > 0) console.log(`${color.yellow('!')} optional chunks 未生成:${r.missing.join(', ')}`)
      return 0
    })
  }
  catch (err) {
    console.log(`${color.red('✖')} ${err?.message ?? err}`)
    return 1
  }
}
