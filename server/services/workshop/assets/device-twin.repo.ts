/**
 * DeviceTwin 注册表 —— 数字孪生设备/实体模型(JSON 文件持久化)。
 *
 * 记录数字孪生设备:id/name/modelRef(绑定的实体模型 assetId)/boundAgentId(控制该设备的 Agent)/
 * telemetry(实时数据采集)/desired(期望状态)/state(实际运行状态)/controls(可下发指令)。
 * 模拟域:无真实设备时用 telemetry 模拟驱动(采样函数);接入真实设备时由 MCP 或采集器写入。
 *
 * 应用级单例,写入 server/data/device-twins.json,进程内缓存,启动读盘。
 */

import { join } from 'node:path'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { AppError } from '../../../utils/errors'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'

export interface DeviceTwin {
  id: string
  /** 作用域:空字符串 = 全局;否则该 workspace 私有 */
  workspaceId: string
  name: string
  /** 绑定的实体模型 assetId(拖入场景的 prop/设备模型) */
  modelRef: string
  /** 控制该设备的 Agent(数字人);经 MCP device.* 控制 */
  boundAgentId: string | null
  /** 实体类别:device 设备 / environment 环境 / asset 资产 / daq 数采节点(程序化传感网格) */
  kind: 'device' | 'environment' | 'asset' | 'daq'
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

// 配置根 .AgentWorkShop/data（ensureDataDir 自动迁移旧 cwd/server/data 位置）
const DB_PATH = join(ensureDataDir(), 'device-twins.json')

function load(): DeviceTwin[] {
  try {
    const parsed = loadJsonFile(DB_PATH, null)
    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}
function save(list: DeviceTwin[]): void {
  saveJsonFileAtomic(DB_PATH, list)
}

export class DeviceTwinRepo {
  private list: DeviceTwin[] = load()
  private flushTimer: NodeJS.Timeout | null = null

  /** 遥测写盘防抖(采样回写每帧触发,逐次全文件序列化会 fsync 抖动;2s 合并) */
  private flushDebounced(ms = 2000): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushNow()
    }, ms)
    this.flushTimer.unref?.()
  }

  private flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    save(this.list)
  }

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

  /**
   * 采集:更新 telemetry + 派生 state;写盘走防抖(热路径)。
   * state 派生两级:
   *  - nodeState 透传(DAQ 回写路径):节点态由用户设置的量程/预警带数据派生,
   *    设备信任量测侧结论(数据驱动,零硬编码);多节点绑定已在 DAQ 侧聚合最严重态;
   *  - 无 nodeState(REST/MCP 直写遥测):保留既有阈值规则兜底(向后兼容)。
   */
  applyTelemetry(id: string, patch: Record<string, number | string | boolean>, nodeState?: 'alarm' | 'warn' | 'ok'): DeviceTwin | undefined {
    const d = this.findById(id)
    if (!d) return undefined
    d.telemetry = { ...d.telemetry, ...patch }
    if (nodeState) {
      if (nodeState === 'alarm') d.state = 'alarm'
      else if (d.state === 'alarm') d.state = d.desired.on === false ? 'idle' : 'running'
    }
    else {
      // legacy 派生:温度/压力越限 → alarm;否则 running/idle
      const temp = Number(d.telemetry.temperature ?? 0)
      const pressure = Number(d.telemetry.pressure ?? 0)
      if ((temp > 0 && temp > 85) || (pressure > 0 && pressure > 2.0)) d.state = 'alarm'
      else if (d.state === 'alarm') d.state = 'running'
      else if (d.state !== 'running' && d.desired.on !== false) d.state = 'running'
    }
    d.updatedAt = new Date().toISOString()
    this.flushDebounced()
    return d
  }

  /** 下发指令:白名单校验(twin.controls 非空时)→ 写 desired + state 变化,拒绝静默成功 */
  applyControl(id: string, cmd: string, args: Record<string, unknown>): DeviceTwin | undefined {
    const d = this.findById(id)
    if (!d) return undefined
    if (d.controls.length > 0 && !d.controls.includes(cmd)) {
      throw new AppError(400, 'BAD_REQUEST', `未知指令 "${cmd}"(设备支持:${d.controls.join(', ') || '无'})`)
    }
    switch (cmd) {
      case 'power_on':
        d.desired.on = true
        break
      case 'power_off':
        d.desired.on = false
        break
      case 'stop':
        d.desired.on = false
        break
      case 'set_speed':
        if (typeof args.value !== 'number') throw new AppError(400, 'BAD_REQUEST', 'set_speed 需要 number 型 args.value')
        d.desired.speed = args.value
        break
      case 'set_temperature':
        if (typeof args.value !== 'number') throw new AppError(400, 'BAD_REQUEST', 'set_temperature 需要 number 型 args.value')
        d.desired.temperature = args.value
        break
      default:
        throw new AppError(400, 'BAD_REQUEST', `未知指令 "${cmd}"`)
    }
    d.state = d.desired.on === false ? 'idle' : 'running'
    d.updatedAt = new Date().toISOString()
    this.flushNow()
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
