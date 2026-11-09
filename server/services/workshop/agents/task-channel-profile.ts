/**
 * 任务实例的 AML Profile 继承（WP-D5）。
 *
 * 背景：任务实例 Channel 此前完全不继承母频道 profile（=legacy），导致经验最丰富的
 * 优化频道无法把能力随任务实例带出去（审计 G3）。
 *
 * 纪律（ADR-6）：
 *  - 继承 profile/capability/scene/objective/optimizationMode/provider 谱系；
 *  - **写权限降档**：`bounded_auto` 一律降为 `hitl_governed`（实例是任务域临时实体,
 *    写权限不得高于母频道常态）；`recommendation_only` 原样；
 *  - **不继承模型绑定**（boundModelId/boundAt）：实例是短命实体，绑定需重新过
 *    `assertModelBindableToChannel` 门禁，禁止隐式携带；
 *  - 母频道为 legacy → 不写实例 profile（保持缺省零行为）。
 */
import type { HybridChannelProfile } from '../aml/twin/channel-profile'
import { getChannelTwinProfile, setHybridChannelProfile } from '../aml/twin/channel-profile'

/** 母 profile → 实例可继承的字段（降档后的纯函数,便于单测） */
export function instanceProfileOf(parent: HybridChannelProfile): Omit<HybridChannelProfile, 'channelId'> | null {
  if (!parent || parent.profile === 'legacy') return null
  return {
    profile: parent.profile,
    capability: parent.capability ?? {},
    ...(parent.sceneId ? { sceneId: parent.sceneId } : {}),
    ...(parent.sceneVersion ? { sceneVersion: parent.sceneVersion } : {}),
    ...(parent.sceneContract ? { sceneContract: parent.sceneContract } : {}),
    ...(parent.objective ? { objective: parent.objective } : {}),
    // 写权限降档：bounded_auto → hitl_governed；其余原样
    controlPolicy: parent.controlPolicy === 'bounded_auto' ? 'hitl_governed' : parent.controlPolicy,
    ...(parent.providerId ? { providerId: parent.providerId } : {}),
    ...(parent.providerVersion ? { providerVersion: parent.providerVersion } : {}),
    ...(parent.providerHash ? { providerHash: parent.providerHash } : {}),
    ...(parent.scenePackId ? { scenePackId: parent.scenePackId } : {}),
    ...(parent.providerGeneration !== undefined ? { providerGeneration: parent.providerGeneration } : {}),
    ...(parent.optimizationMode ? { optimizationMode: parent.optimizationMode } : {}),
    ...(parent.executionMode ? { executionMode: parent.executionMode } : {}),
  }
}

/**
 * 把母频道的 profile 复制到任务实例（降档 + 不继承模型绑定）。
 * 失败只记日志：实例装配绝不因 profile 继承失败而中断。
 */
export function inheritChannelProfile(parentChannelId: string, instanceChannelId: string): boolean {
  try {
    const parent = getChannelTwinProfile(parentChannelId)
    const inherited = instanceProfileOf(parent)
    if (!inherited) return false
    setHybridChannelProfile({ ...inherited, channelId: instanceChannelId, createdBy: 'system:task-instance' })
    return true
  }
  catch {
    return false
  }
}
