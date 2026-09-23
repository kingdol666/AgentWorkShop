/**
 * SQLite 事务工具 —— 全进程统一的"可重入事务"入口。
 *
 * 为什么需要独立模块(而不是各自 `BEGIN`/`COMMIT`):
 *  1. **SQLite 不支持嵌套 `BEGIN`**(实测抛 `cannot start a transaction within a transaction`,
 *     且抛出后**外层事务仍处于打开状态** —— 后续写入会被静默并入外层,极难排查)。
 *     群聊写入路径会互相调用(发送消息 → 投递台账 → 通知 → outbox),批量发送还可能
 *     把多个 `sendChatMessage` 包进一个事务,所以"绝不嵌套"是一条无法靠约定守住的约束,
 *     必须由代码保证。
 *  2. 同一连接上的**非事务写入**会被并入当前事务(WS 的 400ms 事件落库缓冲就是这种写入)。
 *     事务回滚会连带丢弃那些 `channel_events`,因此写入方需要能查询"当前是否在事务里",
 *     据此推迟到事务结束后再落库 —— 这就是 `isTransactionOpen()` 的用途。
 *
 * 语义:
 *  - 最外层:`BEGIN IMMEDIATE` … `COMMIT` / `ROLLBACK`(写锁前置,避免读→写升级死锁);
 *  - 嵌套层:`SAVEPOINT` … `RELEASE` / `ROLLBACK TO`(内层失败只回滚内层,由调用方决定是否继续);
 *  - 任何一层抛出都会向上传播(内层回滚后外层仍可选择回滚)。
 *
 * 约定:事务体内**只做同步写** —— 不要 await、不要跑 LLM/子进程/网络 IO。
 * 持有 `BEGIN IMMEDIATE` 期间会阻塞其它连接写入(busy_timeout 5s)。
 */
import type { DatabaseSync } from 'node:sqlite'

/** 当前事务深度(>0 = 有未提交事务)。进程内单实例:workshop 只有一条主连接。 */
let txDepth = 0

/** 当前是否处于未提交事务内(WS 落库缓冲等"顺带写入"据此推迟) */
export function isTransactionOpen(): boolean {
  return txDepth > 0
}

/** 当前事务嵌套深度(排障/断言用) */
export function transactionDepth(): number {
  return txDepth
}

/**
 * 在事务中执行 `fn`(可重入)。
 *
 * @throws 原样抛出 `fn` 的错误(已尽力回滚/回滚到保存点)
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  const nested = txDepth > 0
  const savepoint = `aw_sp_${txDepth}`
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
  txDepth += 1
  try {
    const out = fn()
    db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT')
    return out
  }
  catch (err) {
    try {
      db.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK')
    }
    catch {
      // 事务/保存点已失效(例如连接被关闭):原始错误更重要,继续向上抛
    }
    throw err
  }
  finally {
    txDepth -= 1
  }
}

/**
 * 测试专用:强制复位深度计数。
 * 仅在脚手架断言"事务已正确闭合"时使用 —— 生产中调用它等于掩盖未回滚的事务。
 */
export function resetTransactionDepthForTest(): void {
  txDepth = 0
}
