/**
 * 宿主端口进程内默认装配(R5 可拆性准备)。
 *
 * 这里是 daq 网关与中心平台服务(device-twin.repo / dcw line-run、recipe、line repo)
 * 唯一的耦合点:daq-controller 只依赖 host-ports.ts 的接口,具体实现集中在本文件。
 * 未来 edge-agent 独立进程不 import 本文件,改为注入 MQTT 上行实现即可。
 *
 * bindDaqHost(fn) = bindDaqBroadcast(fn) + bindDaqHostPorts(进程内实现),
 * daq REST 路由装配点统一改为调用它(端口先于控制器任何使用就位)。
 */
import { deviceScenePayload, getDeviceTwinRepo } from '../assets/device-twin.repo'
import { bumpTaggedSamples, getActiveLineRun, getAllActiveLineRuns } from '../dcw/line-run'
import { getDcwLineRepo } from '../dcw/dcw-line.repo'
import { getDcwRecipeRepo } from '../dcw/dcw-recipe.repo'
import { bindDaqBroadcast } from './daq-controller'
import { bindDaqHostPorts, type ActiveRunSnapshot, type DaqHostPorts } from './host-ports'

const telemetryImpl: DaqHostPorts['telemetry'] = {
  applyTelemetry(deviceId, telemetry, state) {
    try {
      const twin = getDeviceTwinRepo().applyTelemetry(deviceId, telemetry, state)
      return { ok: true, twinId: twin?.id ?? null }
    }
    catch {
      // 与原实现同语义:目标设备不存在等异常 → 调用方解绑自愈
      return { ok: false, twinId: null }
    }
  },
  scenePayload(twinId) {
    const twin = getDeviceTwinRepo().findById(twinId)
    return twin ? deviceScenePayload(twin) : null
  },
  deviceExists(deviceId) {
    return getDeviceTwinRepo().findById(deviceId) != null
  },
  listDaqTwins() {
    return getDeviceTwinRepo()
      .listAll()
      .filter(t => t.kind === 'daq' || (t.modelRef ?? '').startsWith('daq-'))
      .map(t => ({ id: t.id, kind: t.kind, modelRef: t.modelRef, name: t.name, posX: t.posX, posZ: t.posZ }))
  },
}

const lineRunImpl: DaqHostPorts['lineRun'] = {
  activeRun(lineId): ActiveRunSnapshot | null {
    const run = getActiveLineRun(lineId ?? undefined)
    return run ? { lineId: run.lineId, runId: run.runId, recipeId: run.recipeId, productId: run.productId } : null
  },
  hasAnyActiveRun() {
    return getAllActiveLineRuns().length > 0
  },
  recipeWindow(recipeId, nodeId) {
    const w = getDcwRecipeRepo().byId(recipeId)?.daqWindows?.find(x => x.nodeId === nodeId)
    return w ? { min: w.min ?? null, max: w.max ?? null } : null
  },
  lineExists(lineId) {
    return getDcwLineRepo().byId(lineId) != null
  },
  bumpTaggedSamples(lineId) {
    bumpTaggedSamples(lineId)
  },
}

/**
 * daq REST 路由装配点统一入口:广播出口 + 宿主端口一次装配(幂等)。
 * fn 传 null 仅刷新端口绑定(广播出口清空)。
 */
export function bindDaqHost(fn: ((type: string, payload: unknown) => void) | null): void {
  bindDaqHostPorts({ telemetry: telemetryImpl, lineRun: lineRunImpl })
  bindDaqBroadcast(fn)
}
