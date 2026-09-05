/**
 * BackupRegistry —— 活库主连接注册表(备份插件专用)。
 *
 * 为什么存在:Windows + node:sqlite 下,对**正在被主连接使用**的库文件开第二连接
 * 做 serialize/close,会使主连接的 prepared statements 全部失效("statement has
 * been finalized"),写峰期进而触发 unhandledRejection(稳定性守卫判死进程)。
 * 因此备份必须跑在主连接上:各库打开处 register(),插件 serialize 后不关闭任何句柄。
 *
 * key 为 resolve 后的绝对路径;openWorkshopDb 等打开点调用 register 自检录。
 */
import type { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'

const g = globalThis as typeof globalThis & {
  __awBackupRegistry?: Map<string, DatabaseSync>
}

function registry(): Map<string, DatabaseSync> {
  return g.__awBackupRegistry ??= new Map()
}

export const backupRegistry = {
  /** 打开点登记主连接(key = resolve 后的库文件路径) */
  register(path: string, db: DatabaseSync): void {
    registry().set(resolve(path), db)
  },
  has(path: string): boolean {
    return registry().has(resolve(path))
  },
  get(path: string): DatabaseSync | undefined {
    return registry().get(resolve(path))
  },
}
