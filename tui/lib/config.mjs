// ============================================================
// TUI 认证/连接配置 —— 落配置根 .AgentWorkShop/tui-auth.json(0600)。
// 解析口径与服务端一致:cwd 向上找 config.yml → <repo>/.AgentWorkShop,
// 找不到(全局安装任意 cwd)→ ~/.AgentWorkShop。
// ============================================================
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

/** 向上查找文件(repo 模式判定) */
function findUp(startDir, filename) {
  let dir = resolve(startDir)
  for (;;) {
    const candidate = join(dir, filename)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** 配置根(与服务端同策略):仅当用户自建了 <检出根>/.AgentWorkShop 时优先使用;
 *  否则一律回落 ~/.AgentWorkShop(绝不在 pwd 下自动创建)。 */
export function configRoot(cwd = process.cwd()) {
  const marker = findUp(cwd, 'config.yml')
  if (marker) {
    const candidate = join(dirname(marker), '.AgentWorkShop')
    if (existsSync(candidate)) return candidate
  }
  return join(homedir(), '.AgentWorkShop')
}

const authPath = cwd => join(configRoot(cwd), 'tui-auth.json')

/** 读取已存凭据({ baseUrl, token, email? } 或 null) */
export function loadAuth(cwd = process.cwd()) {
  try {
    const raw = JSON.parse(readFileSync(authPath(cwd), 'utf8'))
    if (raw && typeof raw.token === 'string' && typeof raw.baseUrl === 'string') return raw
  }
  catch { /* 无凭据/损坏 → 重新登录 */ }
  return null
}

/** 持久化凭据(0600;路径加入 .gitignore) */
export function saveAuth(auth, cwd = process.cwd()) {
  const file = authPath(cwd)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(auth, null, 2)}\n`, 'utf8')
  try {
    chmodSync(file, 0o600)
  }
  catch { /* Windows FAT 卷 chmod 无效,忽略 */ }
}

/** 清除凭据(登出) */
export function clearAuth(cwd = process.cwd()) {
  try {
    existsSync(authPath(cwd)) && (writeFileSync(authPath(cwd), '{}\n', 'utf8'), true)
  }
  catch { /* 尽力而为 */ }
}
