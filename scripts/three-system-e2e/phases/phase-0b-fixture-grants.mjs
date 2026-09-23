/**
 * 0b. 夹具种子:e2e 用户对目标产线 operate 授权(users.sqlite 直插,测试专用)—— 原 L144–171
 * (由 scripts/three-system-e2e.mjs 按职责拆出;语句逐行原文搬运,仅跨模块引用/状态访问机械改写)
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../lib.mjs'
import { getLINE, getUserId } from '../state.mjs'

export async function run() {
  try {
    const dbPath = join(ROOT, '.AgentWorkShop', 'data', 'users.sqlite')
    if (!existsSync(dbPath)) throw new Error(`users.sqlite 不存在: ${dbPath}`)
    let uid = getUserId()
    if (!uid) {
      const db = new DatabaseSync(dbPath)
      db.exec('PRAGMA busy_timeout=4000')
      const cand = db.prepare('SELECT id FROM users ORDER BY created_at DESC LIMIT 200').all()
        .find(() => true) // 兜底:下面按 token 哈希反查不可行,直接用最新 e2e 用户
      uid = cand?.id ?? ''
      db.close()
    }
    if (uid) {
      const db2 = new DatabaseSync(dbPath)
      db2.exec('PRAGMA busy_timeout=4000')
      db2.prepare(`INSERT OR REPLACE INTO user_line_grants (user_id, line_id, mode, granted_by, granted_at) VALUES (?, ?, 'operate', 'three-system-e2e', ?)`)
        .run(uid, getLINE(), new Date().toISOString())
      db2.close()
      console.log(`  · 已为用户 ${uid} 种入产线 ${getLINE()} operate 授权(测试夹具)`)
    }
    else {
      console.log('  ! 未能取得 user id,产线授权未种(相关断言可能失败)')
    }
  }
  catch (err) {
    console.log(`  ! 授权夹具异常(继续): ${err?.message ?? err}`)
  }
}
