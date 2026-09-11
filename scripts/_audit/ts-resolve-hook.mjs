/**
 * Node ESM 解析钩子 —— 让**纯 node**(无 tsx、无打包)直接加载 server 侧 TS 源码。
 *
 * 为什么需要它:
 *  仓库内 server/**\/*.ts 使用两种 tsc/nuxt 约定,Node 原生 ESM 都不认:
 *    ① 省略扩展名的相对导入:`import { amlSettings } from '../settings'`
 *    ② 路径别名:`import { ensureDataDir } from '@/shared/config/home.mjs'`
 *  同类测试若改用 tsx,在某些沙箱里会因 spawn 被拒而不可用(见 run.mjs 注释),
 *  因此这些回归脚本走 `node --import/register 本钩子` 的路线。
 *
 * 做四件事:
 *  - `@/x`   → 仓库根
 *  - `#shared/x` → 仓库根 shared/(Nuxt 的 #shared 子路径别名,node 原生不认)
 *  - 相对/绝对路径缺扩展名 → 依次试 .ts/.mts/.js/.mjs/index.ts/index.mjs
 *  - nextResolve 抛 ERR_MODULE_NOT_FOUND 时再用同一套后缀兜底一次
 *
 * TS 语法本身由 Node 24 内建的类型擦除处理(strip-types),本钩子只解决"找得到文件"。
 */
import { existsSync } from 'node:fs'
import { dirname, resolve as pathResolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 仓库根(本文件位于 <repo>/scripts/_audit/) */
const REPO = pathResolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 别名前缀 → 仓库内的实际目录 */
const ALIASES = [
  ['@/', ''],
  ['#shared/', 'shared/'],
]

const SUFFIXES = ['', '.ts', '.mts', '.js', '.mjs', '.cjs', '/index.ts', '/index.mts', '/index.js', '/index.mjs']

/** 逐后缀试探,命中返回 file: URL,否则 null */
function probe(absBase) {
  for (const suffix of SUFFIXES) {
    const candidate = absBase + suffix
    try {
      if (existsSync(candidate)) return pathToFileURL(candidate).href
    }
    catch { /* 非法路径字符等忽略 */ }
  }
  return null
}

function isPathLike(spec) {
  return spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec)
}

export async function resolve(specifier, context, nextResolve) {
  // ① 别名:@/x → <repo>/x,#shared/x → <repo>/shared/x
  for (const [prefix, target] of ALIASES) {
    if (!specifier.startsWith(prefix)) continue
    const hit = probe(pathResolve(REPO, target + specifier.slice(prefix.length)))
    if (hit) return { url: hit, shortCircuit: true }
  }
  // ② 路径式且缺扩展名:先自己补
  if (isPathLike(specifier)) {
    const abs = specifier.startsWith('/') || /^[A-Za-z]:[\\/]/.test(specifier)
      ? specifier
      : pathResolve(context.parentURL ? dirname(fileURLToPath(context.parentURL)) : process.cwd(), specifier)
    if (!existsSync(abs)) {
      const hit = probe(abs)
      if (hit) return { url: hit, shortCircuit: true }
    }
  }
  try {
    return await nextResolve(specifier, context)
  }
  catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !isPathLike(specifier) || !context.parentURL) throw err
    const hit = probe(pathResolve(dirname(fileURLToPath(context.parentURL)), specifier))
    if (hit) return { url: hit, shortCircuit: true }
    throw err
  }
}
