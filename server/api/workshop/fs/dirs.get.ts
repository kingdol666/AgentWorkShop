/**
 * GET /api/workshop/fs/dirs -- FileSelector 数据源:列出服务器上某目录的子目录。
 * - Bearer 用户 token(本地 harness 工具面;仅返回目录名,不读文件内容)
 * - path 缺省 = 项目根 process.cwd();非法/不存在 -> 400
 * - 返回 { cwd, parent, dirs: [{ name, path, hasChildren }] }(仅目录,排序:目录名 ASC)
 */
import { readdirSync } from 'node:fs'
import { resolve, dirname, isAbsolute, join } from 'node:path'
import { getQuery } from 'h3'
import { resolveUser } from '../caller'
import { AppError } from '../../../utils/errors'
import { defineApiHandler } from '../../../utils/response'
import { resolveRunMode } from '@/shared/config/home.mjs'
import { isPathInside } from '@/sdk/index.mjs'

/** 允许浏览的根:项目检出根 + 生效配置根 + 数据目录(文件选择器只服务这些工作区) */
function allowedRoots(): string[] {
  const rm = resolveRunMode({ cwd: process.cwd(), env: process.env })
  return [...new Set([process.cwd(), rm.configRoot, rm.dataDir].map(r => resolve(r)))]
}

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const q = getQuery(event)
  const raw = typeof q.path === 'string' ? q.path.trim() : ''
  const cwd = raw ? resolve(raw) : process.cwd()
  const roots = allowedRoots()
  // 越权防护:任意绝对路径列举整盘目录是公网部署下的信息泄露面,锁定到工作区白名单根内
  if (!roots.some(r => cwd === r || isPathInside(r, cwd))) {
    throw new AppError(403, 'FS_OUT_OF_ROOT', 'path 必须位于项目根或配置根内')
  }
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(cwd, { withFileTypes: true })
  }
  catch (err) {
    throw new AppError(400, 'FS_READ_FAILED', `目录不可读: ${cwd}(${err instanceof Error ? err.message : String(err)})`)
  }
  const dirs = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => {
      const full = join(cwd, e.name)
      let hasChildren = false
      try {
        hasChildren = readdirSync(full, { withFileTypes: true }).some(x => x.isDirectory())
      }
      catch { /* 无权限视为叶子 */ }
      return { name: e.name, path: full, hasChildren }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  // parent 链同样不许逃出白名单根(到根即断,防止逐级上探)
  const parent = (() => {
    const up = dirname(cwd)
    if (up === cwd) return null
    return roots.some(r => up === r || isPathInside(r, up)) ? up : null
  })()
  return { cwd, parent, isAbsoluteRoot: !isAbsolute(cwd), dirs }
})
