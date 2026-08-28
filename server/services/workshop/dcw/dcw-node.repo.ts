/**
 * DcwNode 持久化仓库 —— 对象快照落盘(server/data/dcws.json),与 DaqNodeRepo 同风格。
 * 配置类变更立即刷盘;写值变更随写事件同步落盘(写操作低频,无抖动风险)。
 */

import fs from 'node:fs'
import path from 'node:path'
import { DcwNode } from './dcw-node'

const DB_PATH = process.cwd().endsWith('server')
  ? 'data/dcws.json'
  : path.join(process.cwd(), 'server', 'data', 'dcws.json')

function load(): DcwNode[] {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(r => DcwNode.fromRow(r as Record<string, unknown>)) : []
  }
  catch {
    return []
  }
}

class DcwNodeRepo {
  private list: DcwNode[]

  constructor() {
    this.list = load()
  }

  all(): DcwNode[] {
    return this.list
  }

  byId(id: string): DcwNode | undefined {
    return this.list.find(n => n.id === id)
  }

  insert(node: DcwNode): void {
    this.list.push(node)
    this.flushNow()
  }

  remove(id: string): boolean {
    const before = this.list.length
    this.list = this.list.filter(n => n.id !== id)
    if (this.list.length !== before) {
      this.flushNow()
      return true
    }
    return false
  }

  flushNow(): void {
    try {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
      fs.writeFileSync(DB_PATH, JSON.stringify(this.list.map(n => n.toRow()), null, 2), 'utf-8')
    }
    catch (err) {
      console.error('[dcw] 快照落盘失败:', err)
    }
  }
}

let singleton: DcwNodeRepo | null = null

export function getDcwNodeRepo(): DcwNodeRepo {
  singleton ??= new DcwNodeRepo()
  return singleton
}
