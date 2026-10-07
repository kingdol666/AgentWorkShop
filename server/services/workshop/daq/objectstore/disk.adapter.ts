/**
 * DiskObjectAdapter —— 对象存储的本地磁盘降级实现(data/daq-objects/)。
 * MinIO 不可达时帧管线自动切换到此适配器(采集不中断;meta.infra 报告 disk:degraded)。
 */
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ensureDataDir } from '@/shared/config/home.mjs'
import type { DaqObjectDayDir, DaqObjectStore } from './objectstore-port'

const ROOT = resolve(join(ensureDataDir(), 'daq-objects'))

export class DiskObjectAdapter implements DaqObjectStore {
  readonly backend = 'disk'

  async init(): Promise<void> {
    await mkdir(ROOT, { recursive: true })
  }

  /** key 归一(防路径逃逸:只允许 [A-Za-z0-9/._-];非法字符拒绝) */
  private pathOf(key: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(key)) throw new Error(`非法对象键: ${key}`)
    return join(ROOT, key)
  }

  async put(key: string, data: Buffer): Promise<void> {
    const p = this.pathOf(key)
    await mkdir(join(p, '..'), { recursive: true })
    await writeFile(p, data)
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathOf(key))
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true })
  }

  /**
   * 天目录枚举(P0-2 GC):严格四段数字形状 daq/<nodeId>/<yyyy>/<mm>/<dd>,
   * 按 UTC 解析日界(与 daqObjectKey 的 UTC 取日一致);形状不符的路径永不返回。
   */
  async listDayDirs(): Promise<DaqObjectDayDir[]> {
    const out: DaqObjectDayDir[] = []
    const rootSeg = await readdir(ROOT, { withFileTypes: true }).catch(() => [])
    for (const top of rootSeg) {
      if (top.name !== 'daq' || !top.isDirectory()) continue
      const nodeIds = await readdir(join(ROOT, 'daq'), { withFileTypes: true }).catch(() => [])
      for (const n of nodeIds) {
        if (!n.isDirectory() || !/^[A-Za-z0-9._-]+$/.test(n.name)) continue
        const nodeDir = join(ROOT, 'daq', n.name)
        const years = await readdir(nodeDir, { withFileTypes: true }).catch(() => [])
        for (const y of years) {
          if (!/^\d{4}$/.test(y.name) || !y.isDirectory()) continue
          const months = await readdir(join(nodeDir, y.name), { withFileTypes: true }).catch(() => [])
          for (const m of months) {
            if (!/^\d{2}$/.test(m.name) || !m.isDirectory()) continue
            const days = await readdir(join(nodeDir, y.name, m.name), { withFileTypes: true }).catch(() => [])
            for (const d of days) {
              if (!/^\d{2}$/.test(d.name) || !d.isDirectory()) continue
              const dayStart = Date.UTC(Number(y.name), Number(m.name) - 1, Number(d.name))
              out.push({ prefix: `daq/${n.name}/${y.name}/${m.name}/${d.name}`, dayStartMs: dayStart, dayEndMs: dayStart + 86_400_000 })
            }
          }
        }
      }
    }
    return out
  }

  /** 前缀删除(递归;返回 -1 = 删除数未知)。连带清空父级 <mm>/<yyyy>(仅当已空)。 */
  async removePrefix(prefix: string): Promise<number> {
    const p = this.pathOf(prefix.replace(/\/+$/, ''))
    await rm(p, { recursive: true, force: true })
    // 出清后父级空目录收尾(best-effort;rmdir 非空即失败,忽略)
    const parts = prefix.replace(/\/+$/, '').split('/')
    for (const depth of [parts.length - 1, parts.length - 2]) {
      const parent = parts.slice(0, depth).join('/')
      if (!parent) break
      await rmdir(this.pathOf(parent)).catch(() => {})
    }
    return -1
  }
}
