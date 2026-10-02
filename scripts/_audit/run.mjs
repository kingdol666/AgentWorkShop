/**
 * 审计实验运行器 —— 先隔离数据根(AW_DATA_DIR → scripts/_audit/.tmp/audit-data,
 * 绝不触碰真实 server/data),再动态导入目标实验脚本。
 * 用法:node --experimental-transform-types scripts/_audit/run.mjs scripts/_audit/<exp>.ts
 *      (tsx 亦可用:npx tsx scripts/_audit/run.mjs <exp>)
 */
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(process.cwd(), process.argv[2] ?? '')
const rel = relative(here, target)
if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
  console.error('[run] 目标必须是 scripts/_audit/ 下的实验脚本')
  process.exit(1)
}
const dataDir = resolve(here, '.tmp/audit-data')
mkdirSync(dataDir, { recursive: true })
process.env.AW_DATA_DIR = dataDir
await import(pathToFileURL(target).href)
