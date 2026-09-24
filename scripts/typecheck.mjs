/**
 * 类型检查入口(替代裸 `nuxt typecheck`)。
 *
 * 为什么需要它:Nuxt 4.5 的 pages 模块在 `prepare:types` 里**无条件**把
 * `vue-router/volar/sfc-route-blocks` 写进生成 tsconfig 的 `vueCompilerOptions.plugins`,
 * 而 vue-router 4.6 起 package.json 的 exports 已不再暴露该子路径 →
 * `vue-tsc` 在**加载 tsconfig 阶段**就抛 ERR_PACKAGE_PATH_NOT_EXPORTED,
 * 类型检查等于一次都没跑(命令失败但原因与源码无关,极易被当成"项目有类型错")。
 *
 * 本脚本做三件事,顺序固定:
 *   ① nuxi prepare            重新生成 .nuxt 类型(与 nuxt typecheck 行为一致)
 *   ② 剔除那条已不存在的插件   只删这一个字符串条目;其余 vueCompilerOptions 原样保留
 *   ③ vue-tsc -b --noEmit     与 nuxt typecheck 内部调用完全一致的参数
 *
 * 本项目<b>不使用</b> <route> SFC 块(全仓 0 处),去掉该插件无功能损失。
 * 若将来要用 typed route blocks:把 vue-router 对齐到仍导出该子路径的版本,
 * 然后删除本脚本的 ② 步(或整个脚本)即可。
 *
 * 用法:`pnpm typecheck`(或 `node scripts/typecheck.mjs [--skip-prepare]`)
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PHANTOM = 'vue-router/volar/sfc-route-blocks'
const skipPrepare = process.argv.includes('--skip-prepare')

const run = (cmd, args) => spawnSync(cmd, args, { cwd: repo, stdio: 'inherit' })

/** 直接用 node 跑本地 bin:不经 shell(npx.cmd 需要 shell),避免参数拼接与 deprecation 噪声 */
const NUXT_BIN = join(repo, 'node_modules', 'nuxt', 'bin', 'nuxt.mjs')
const VUE_TSC_BIN = join(repo, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js')

if (!skipPrepare) {
  console.log('[typecheck] ① nuxi prepare(重新生成 .nuxt 类型)')
  const prep = run(process.execPath, [NUXT_BIN, 'prepare'])
  if (prep.status !== 0) {
    console.error('[typecheck] prepare 失败')
    process.exit(prep.status ?? 1)
  }
}

console.log(`[typecheck] ② 剔除生成配置里已不存在的 volar 插件条目:${PHANTOM}`)
const nuxtDir = join(repo, '.nuxt')
let patched = 0
for (const file of readdirSync(nuxtDir).filter(f => /^tsconfig.*\.json$/.test(f))) {
  const p = join(nuxtDir, file)
  const src = readFileSync(p, 'utf8')
  let json
  try {
    json = JSON.parse(src)
  }
  catch {
    continue // 非纯 JSON(带注释)→ 跳过,由 ③ 自行报错
  }
  const vco = json.vueCompilerOptions
  if (!vco || !Array.isArray(vco.plugins)) continue
  const kept = vco.plugins.filter(p0 => !(typeof p0 === 'string' && p0 === PHANTOM))
  if (kept.length === vco.plugins.length) continue
  vco.plugins = kept
  writeFileSync(p, `${JSON.stringify(json, null, 2)}\n`)
  patched += 1
  console.log(`           · ${file}: plugins ${vco.plugins.length + 1} → ${kept.length}`)
}
if (patched === 0) console.log('           · 无需改动(生成配置已不含该条目)')

console.log('[typecheck] ③ vue-tsc -b --noEmit')
const tsc = run(process.execPath, [VUE_TSC_BIN, '-b', '--noEmit'])
if (tsc.status !== 0) {
  console.error('[typecheck] 类型检查未通过')
  process.exit(tsc.status ?? 1)
}
console.log('[typecheck] ✔ 类型检查通过')
