// ============================================================
// CLI 包元信息(叶子模块 —— 不 import 任何 CLI 内部模块)
// ------------------------------------------------------------
// 为什么单独一个文件:packageVersion/packageRoot 原本定义在 cli/aw.mjs,
// 而 cli/commands/*.mjs 又要用它们 → 命令模块反向 import '../aw.mjs'。
// 于是当 **cli/aw.mjs 自己作为入口**(node cli/aw.mjs ...)时形成循环依赖死锁:
//   aw.mjs 顶层 await main() → main() await registry.scanDirs()
//   → 动态 import 命令模块 → 命令模块 import '../aw.mjs'
//   → 而 aw.mjs 尚未求值完成(卡在自己的顶层 await 上)
//   → 模块图永远等不到对方 → Node 报 unsettled top-level await 并以**退出码 13**
//     收场,且 stdout 已排队的写入未 flush → `aw --help` 变成"无输出 + 13"。
// 经 bin/aw.mjs 入口时 aw.mjs 是副作用-free 的被导入方,循环不显形 ——
// 所以这个缺陷只在直接跑 cli/aw.mjs(以及任何把自己当入口的调用)时暴露。
//
// 规矩:本文件只依赖 node 内建,任何人(含命令模块)都可以安全 import。
// ============================================================
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本包版本(cli/core/meta.mjs → ../../package.json) */
export function packageVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  }
  catch {
    return '0.0.0'
  }
}

/** 本包根目录(全局安装副本同样成立;必须走 fileURLToPath,Windows 下
 *  URL pathname 是 '/D:/...' 形态,直接 path.resolve 会得到 'D:\D:\...' 垃圾路径,
 *  导致内建指令目录扫描全部静默失败 —— 指令注册失效的根因) */
export function packageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export default { packageVersion, packageRoot }
