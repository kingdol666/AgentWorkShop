/**
 * 配置持久化 —— data/config.json 原子写 + 进程内内存态。
 * 磁盘只存节点/信号配置;运行时状态(当前值/游标)不落盘,重启后按策略重演。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DeviceNode, SimConfig } from '../shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = path.resolve(__dirname, '../../data')
const CONFIG_PATH = path.join(DATA_DIR, 'config.json')

let config: SimConfig = { nodes: [] }
const listeners = new Set<() => void>()

export function loadConfig(): SimConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as SimConfig
      // 运行时状态不复活
      for (const n of raw.nodes ?? []) {
        n.runtime = undefined
        for (const s of n.signals ?? []) s.runtime = undefined
      }
      config = raw
    }
  }
  catch (err) {
    console.error('[store] config.json 解析失败,以空配置启动:', (err as Error).message)
    config = { nodes: [] }
  }
  return config
}

/** 原子写:tmp → rename,避免半写文件 */
export function saveConfig(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${CONFIG_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8')
  fs.renameSync(tmp, CONFIG_PATH)
  for (const fn of listeners) fn()
}

export function getConfig(): SimConfig {
  return config
}

export function findNode(id: string): DeviceNode | undefined {
  return config.nodes.find(n => n.id === id)
}

export function upsertNode(node: DeviceNode): void {
  const i = config.nodes.findIndex(n => n.id === node.id)
  if (i >= 0) config.nodes[i] = node
  else config.nodes.push(node)
  saveConfig()
}

export function removeNode(id: string): boolean {
  const before = config.nodes.length
  config.nodes = config.nodes.filter(n => n.id !== id)
  if (config.nodes.length !== before) { saveConfig(); return true }
  return false
}

export function onConfigChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** ID 生成:前缀 + 8 hex */
export function genId(prefix: string): string {
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}`
}
