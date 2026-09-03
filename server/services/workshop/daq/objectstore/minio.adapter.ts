/**
 * MinioObjectAdapter —— S3 兼容对象存储实现(compose daq-minio)。
 *
 * minio 官方客户端经 createRequire 加载(nitro Windows 动态 import external 的
 * 'd:' scheme 坑,与 pg/mqtt 同款规避);bucket 不存在时 init 幂等创建。
 */
import { createRequire } from 'node:module'
import type { DaqObjectStore } from './objectstore-port'

const reqOs = createRequire(import.meta.url)

export interface MinioConnectOpts {
  endPoint: string
  port: number
  accessKey: string
  secretKey: string
  bucket: string
}

export class MinioObjectAdapter implements DaqObjectStore {
  readonly backend = 'minio'
  private client: import('minio').Client | null = null

  constructor(private readonly opts: MinioConnectOpts) {}

  async init(): Promise<void> {
    const mod = reqOs('minio') as unknown as { Client: new (o: Record<string, unknown>) => import('minio').Client }
    this.client = new mod.Client({
      endPoint: this.opts.endPoint,
      port: this.opts.port,
      useSSL: false,
      accessKey: this.opts.accessKey,
      secretKey: this.opts.secretKey,
    })
    const exists = await this.client.bucketExists(this.opts.bucket).catch(() => false)
    if (!exists) await this.client.makeBucket(this.opts.bucket, 'us-east-1')
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    if (!this.client) throw new Error('minio 未初始化')
    await this.client.putObject(this.opts.bucket, key, data, data.length, { 'Content-Type': contentType })
  }

  async get(key: string): Promise<Buffer> {
    if (!this.client) throw new Error('minio 未初始化')
    const stream = await this.client.getObject(this.opts.bucket, key)
    const chunks: Buffer[] = []
    for await (const c of stream) chunks.push(c as Buffer)
    return Buffer.concat(chunks)
  }

  async remove(key: string): Promise<void> {
    if (!this.client) return
    await this.client.removeObject(this.opts.bucket, key)
  }

  async close(): Promise<void> {
    this.client = null
  }
}
