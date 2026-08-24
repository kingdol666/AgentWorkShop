/**
 * DeviceTwin 注册表 —— 数字孪生设备/实体模型(JSON 文件持久化)。
 *
 * 记录数字孪生设备:id/name/modelRef(绑定的实体模型 assetId)/boundAgentId(控制该设备的 Agent)/
 * telemetry(实时数据采集)/desired(期望状态)/state(实际运行状态)/controls(可下发指令)。
 * 模拟域:无真实设备时用 telemetry 模拟驱动(采样函数);接入真实设备时由 MCP 或采集器写入。
 *
 * 应用级单例,写入 server/data/device-twins.json,进程内缓存,启动读盘。
 */

import fs from 'node:fs'
import path from 'node:path'

export interface DeviceTwin {
  id: string
  /** 作用域:空字符串 = 全局;否则该 workspace 私有 */
  workspaceId: string
  name: string
  /** 绑定的实体模型 assetId(拖入场景的 prop/设备模型) */
  modelRef: string
  /** 控制该设备的 Agent(数字人);经 MCP device.* 控制 */
  boundAgentId: string | null
  kind: 'device' | 'environment' | 'asset'
  /** 实时数据采集(数字孪生字段集合) */
  telemetry: Record<string, number | string | boolean>
  /** 期望状态(Agent 下发) */
  desired: Record<string, number | string | boolean>
  /** 实际运行状态 */
  state: 'idle' | 'running' | 'offline' | 'alarm'
  /** 可下发指令集(供 Agent 经 MCP 调用) */
  controls: string[]
  /** 场景落点(3D 小镇 x/z 世界坐标;undefined = 未放入场景,仅注册表记录) */
  posX?: number
  posZ?: number
  /** 场景朝向(绕 y 轴角度,度;缺省 0) */
  rotationY?: number
  /** 场景内缩放倍率(缺省 1 = 默认归一化尺寸) */
  scale?: number
  /** 最近更新时间(数据采集心跳) */
  updatedAt: string
  createdAt: string
}

const DB_PATH = process.cwd().endsWith('server') ? 'data/device-twins.json' : path.join(process.cwd(), 'server', 'data', 'device-twins.json')

function load(): DeviceTwin[] {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}
function save(list: DeviceTwin[]): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  fs.writeFileSync(DB_PATH, JSON.stringify(list, null, 2), 'utf-8')
}

class DeviceTwinRepo {
  private list: DeviceTwin[] = load()

  listAll(workspaceId?: string): DeviceTwin[] {
    if (!workspaceId) return this.list
    return this.list.filter(d => d.workspaceId === workspaceId || d.workspaceId === '')
  }

  findById(id: string): DeviceTwin | undefined {
    return this.list.find(d => d.id === id)
  }

  create(input: Omit<DeviceTwin, 'id' | 'createdAt' | 'updatedAt' | 'state' | 'boundAgentId' | 'desired'> & { state?: DeviceTwin['state'], boundAgentId?: string | null, desired?: DeviceTwin['desired'] }): DeviceTwin {
    const full: DeviceTwin = {
      id: `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      workspaceId: input.workspaceId,
      name: input.name,
      modelRef: input.modelRef,
      boundAgentId: input.boundAgentId ?? null,
      kind: input.kind,
      telemetry: input.telemetry ?? {},
      desired: input.desired ?? {},
      state: input.state ?? 'idle',
      controls: input.controls ?? [],
      posX: input.posX,
      posZ: input.posZ,
      rotationY: input.rotationY,
      scale: input.scale,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }
    this.list.push(full)
    save(this.list)
    return full
  }

  update(id: string, patch: Partial<Pick<DeviceTwin, 'name' | 'modelRef' | 'boundAgentId' | 'controls' | 'desired' | 'posX' | 'posZ' | 'rotationY' | 'scale'>>): DeviceTwin | undefined {
    const d = this.findById(id)
    if (!d) return undefined
    if (patch.name !== undefined) d.name = patch.name
    if (patch.modelRef !== undefined) d.modelRef = patch.modelRef
    if (patch.boundAgentId !== undefined) d.boundAgentId = patch.boundAgentId
    if (patch.controls !== undefined) d.controls = patch.controls
    if (patch.desired !== undefined) d.desired = { ...d.desired, ...patch.desired }
    if (patch.posX !== undefined) d.posX = patch.posX
    if (patch.posZ !== undefined) d.posZ = patch.posZ
    if (patch.rotationY !== undefined) d.rotationY = patch.rotationY
    if (patch.scale !== undefined) d.scale = patch.scale
    d.updatedAt = new Date().toISOString()
    save(this.list)
    return d
  }

  /** 采集:更新 telemetry + 派生 state(含模拟规则) */
  applyTelemetry(id: string, patch: Record<string, number | string | boolean>): DeviceTwin | undefined {
    const d = this.findById(id)
    if (!d) return undefined
    d.telemetry = { ...d.telemetry, ...patch }
    // 派生 state:温度/压力越限 → alarm;否则 running/idle
    const temp = Number(d.telemetry.temperature ?? 0)
    const pressure = Number(d.telemetry.pressure ?? 0)
    if ((temp > 0 && temp > 85) || (pressure > 0 && pressure > 2.0)) d.state = 'alarm'
    else if (d.state === 'alarm') d.state = 'running'
    else if (d.state !== 'running' && d.desired.on !== false) d.state = 'running'
    d.updatedAt = new Date().toISOString()
    save(this.list)
    return d
  }

  /** 下发指令:写 desired + 触发 state 变化指令 */
  applyControl(id: string, cmd: string, args: Record<string, unknown>): DeviceTwin | undefined {
    const d = this.findById(id)
    if (!d) return undefined
    if (cmd === 'power_on') d.desired.on = true
    if (cmd === 'power_off') d.desired.on = false
    if (cmd === 'set_speed' && typeof args.value === 'number') d.desired.speed = args.value
    if (cmd === 'set_temperature' && typeof args.value === 'number') d.desired.temperature = args.value
    if (cmd === 'stop') d.desired.on = false
    d.state = d.desired.on === false ? 'idle' : 'running'
    d.updatedAt = new Date().toISOString()
    save(this.list)
    return d
  }

  remove(id: string): boolean {
    const before = this.list.length
    this.list = this.list.filter(d => d.id !== id)
    if (this.list.length !== before) {
      save(this.list)
      return true
    }
    return false
  }
}

let singleton: DeviceTwinRepo | null = null
export function getDeviceTwinRepo(): DeviceTwinRepo {
  if (!singleton) singleton = new DeviceTwinRepo()
  return singleton
}

/**
 * 场景事件载荷(设备孪生 → device.created/updated/deleted 广播)。
 * 与前端 DeviceTwinView 同构,供其他小镇客户端即时同步场景节点。
 */
export function deviceScenePayload(d: DeviceTwin): Record<string, unknown> {
  return {
    id: d.id,
    name: d.name,
    modelRef: d.modelRef,
    kind: d.kind,
    state: d.state,
    posX: d.posX,
    posZ: d.posZ,
    rotationY: d.rotationY,
    scale: d.scale,
    workspaceId: d.workspaceId,
    boundAgentId: d.boundAgentId,
    telemetry: d.telemetry,
    updatedAt: d.updatedAt,
  }
}
