/**
 * R5 可拆性准备:daq 网关对中心平台宿主服务的反向依赖收敛为端口接口。
 *
 * 网关(daq-controller)此前直接 import device-twin.repo(遥测回写/失败自愈解绑)
 * 与 dcw/line-run + dcw-recipe.repo/dcw-line.repo(配方窗口门控),无法脱离中心平台
 * 独立部署。现把这两类依赖收敛为 telemetry / lineRun 两个端口:
 *  - 中心平台在路由装配点注入进程内默认实现(host-bindings.ts → bindDaqHost);
 *  - 未来 edge-agent 独立进程提供自己的实现(或经 MQTT 上行)即可,网关代码零改动。
 * 端口存 globalThis(HMR 存活,与 daq-controller 单例同一生命周期约定)。
 */

/** 时序库打标所需的批次快照(只暴露网关需要的字段,不泄漏 dcw 内部类型) */
export interface ActiveRunSnapshot {
  lineId: string
  runId: string
  recipeId: string
  productId: string
}

/** 遥测上报端口:绑定设备的值回写 + 孪生场景推送 + 绑定校验(中心实现 = device-twin.repo) */
export interface DaqTelemetryPort {
  /**
   * 遥测回写:telemetry 键值写入绑定设备的孪生,state 为同设备多节点汇聚的最严重态。
   * 目标设备不存在 → { ok:false }(调用方解绑自身,链路自愈);成功 → { ok:true, twinId }。
   */
  applyTelemetry(deviceId: string, telemetry: Record<string, number | string | boolean>, state: string): { ok: boolean, twinId: string | null }
  /** 孪生场景载荷(WS device.updated 帧;设备已删 → null) */
  scenePayload(twinId: string): unknown | null
  /** 绑定目标存在性校验 */
  deviceExists(deviceId: string): boolean
  /** 存量 kind='daq' 孪生清单(首访升格为 DaqNode;边缘模式返回 []) */
  listDaqTwins(): Array<{ id: string, kind: string, modelRef: string, name: string, posX?: number, posZ?: number }>
}

/** 产线批次端口:活动 LineRun 门控 + 配方 daq 窗口 + 打标计数(中心实现 = dcw/line-run + recipe/line repo) */
export interface DaqLineRunPort {
  /** 产线当前活动批次(严格语义:lineId 空 → null,不受其他产线运行影响) */
  activeRun(lineId: string | null): ActiveRunSnapshot | null
  /** 是否存在任意活动批次(sweep 总门控) */
  hasAnyActiveRun(): boolean
  /** 配方对指定节点的数采监控窗口(min/max,未设 → null) */
  recipeWindow(recipeId: string, nodeId: string): { min: number | null, max: number | null } | null
  /** 产线存在性校验(节点绑定 lineId 时) */
  lineExists(lineId: string): boolean
  /** 活动窗口内样本打标计数(产线进度;非活动产线 no-op) */
  bumpTaggedSamples(lineId: string): void
}

export interface DaqHostPorts {
  telemetry: DaqTelemetryPort
  lineRun: DaqLineRunPort
}

const g = globalThis as typeof globalThis & { __daqHostPorts?: DaqHostPorts }

/** 装配宿主端口(中心平台路由装配点调用;幂等覆盖) */
export function bindDaqHostPorts(ports: DaqHostPorts): void {
  g.__daqHostPorts = ports
}

/** 读取宿主端口(未装配 = 中心装配前/边缘独立运行 → null,调用方走降级语义) */
export function getDaqHostPorts(): DaqHostPorts | null {
  return g.__daqHostPorts ?? null
}
