/**
 * AgentNodeBindingRepo —— Agent ↔ 工业节点绑定持久化(agent-node-bindings.json)。
 *
 * 一个绑定 = 某 Channel 内的 Agent 对某个数采(daq)/数控(dcw)节点的授权:
 *   - kind: 'dcw' = 可下发控制; 'daq' = 可查询采集数据
 *   - mode: 'auto' = 工具调用自动执行; 'manual' = 每次执行需用户批准(可附备注)
 * 工具层(daq_query/dcw_control)据此鉴权;未绑定节点一律拒绝。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AppError, ErrorCodes } from '../../../utils/errors'

export type AgentNodeBindingKind = 'dcw' | 'daq'
export type AgentNodeBindingMode = 'auto' | 'manual'

export interface AgentNodeBinding {
  id: string
  agentId: string
  nodeId: string
  kind: AgentNodeBindingKind
  mode: AgentNodeBindingMode
  createdAt: string
}

const DB_PATH = process.cwd().endsWith('server')
  ? 'data/agent-node-bindings.json'
  : path.join(process.cwd(), 'server', 'data', 'agent-node-bindings.json')

function load(): AgentNodeBinding[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'))
    return Array.isArray(parsed) ? parsed as AgentNodeBinding[] : []
  }
  catch {
    return []
  }
}

export class AgentNodeBindingRepo {
  private list: AgentNodeBinding[] = load()

  all(): AgentNodeBinding[] {
    return this.list
  }

  byAgent(agentId: string): AgentNodeBinding[] {
    return this.list.filter(b => b.agentId === agentId)
  }

  find(agentId: string, nodeId: string, kind: AgentNodeBindingKind): AgentNodeBinding | undefined {
    return this.list.find(b => b.agentId === agentId && b.nodeId === nodeId && b.kind === kind)
  }

  bind(agentId: string, nodeId: string, kind: AgentNodeBindingKind, mode: AgentNodeBindingMode): AgentNodeBinding {
    if (!agentId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'agentId 必填')
    if (!nodeId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'nodeId 必填')
    if (kind !== 'dcw' && kind !== 'daq') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `未知节点类型: ${kind}`)
    if (mode !== 'auto' && mode !== 'manual') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `未知控制模式: ${mode}`)
    const prev = this.find(agentId, nodeId, kind)
    if (prev) {
      prev.mode = mode
      this.flush()
      return prev
    }
    const binding: AgentNodeBinding = {
      id: `nb-${randomUUID().slice(0, 8)}`,
      agentId,
      nodeId,
      kind,
      mode,
      createdAt: new Date().toISOString(),
    }
    this.list.push(binding)
    this.flush()
    return binding
  }

  setMode(id: string, mode: AgentNodeBindingMode): AgentNodeBinding {
    const b = this.list.find(x => x.id === id)
    if (!b) throw new AppError(404, ErrorCodes.NOT_FOUND, `绑定不存在: ${id}`)
    if (mode !== 'auto' && mode !== 'manual') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `未知控制模式: ${mode}`)
    b.mode = mode
    this.flush()
    return b
  }

  unbind(id: string): boolean {
    const before = this.list.length
    this.list = this.list.filter(b => b.id !== id)
    if (this.list.length !== before) {
      this.flush()
      return true
    }
    return false
  }

  /** Agent 删除级联清理 */
  removeAgent(agentId: string): void {
    this.list = this.list.filter(b => b.agentId !== agentId)
    this.flush()
  }

  private flush(): void {
    try {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
      fs.writeFileSync(DB_PATH, JSON.stringify(this.list, null, 2), 'utf-8')
    }
    catch (err) {
      console.error('[agent-node-bindings] 落盘失败:', err)
    }
  }
}

const g = globalThis as typeof globalThis & { __agentNodeBindingRepo?: AgentNodeBindingRepo }

export function getAgentNodeBindingRepo(): AgentNodeBindingRepo {
  g.__agentNodeBindingRepo ??= new AgentNodeBindingRepo()
  return g.__agentNodeBindingRepo
}
