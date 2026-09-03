/**
 * DiskObjectAdapter —— 对象存储的本地磁盘降级实现(data/daq-objects/)。
 * MinIO 不可达时帧管线自动切换到此适配器(采集不中断;meta.infra 报告 disk:degraded)。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ensureDataDir } from '@/shared/config/home.mjs'
import type { DaqObjectStore } from './objectstore-port'

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
}
