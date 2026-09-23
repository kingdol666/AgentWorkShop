import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'
import { daqKeyFromRef, type DaqNodeState } from '#shared/daq-protocol'

/**
 * 单节点控制台(/daq/[id])的路由身份层 —— 路由 id、节点实体、模板语义与展示标签。
 * 三个 store 都是模块级单例:本 composable 只持有一份派生视图,不复制任何响应式源。
 * WS 喂帧与首屏加载的时序与原页面逐字一致(连接层即注册 scene peer)。
 */
export function useDaqDetailNode() {
  const { t } = useI18n()

  const route = useRoute()
  const nodeId = computed(() => String(route.params.id ?? ''))
  const daq = useDaqStream()
  const dcw = useDcwStream()
  void dcw.load()
  const deviceTwins = useDeviceTwins()

  const node = computed(() => daq.nodeById(nodeId.value) ?? null)
  // server 模板目录为唯一事实源:模板被删除时降级显示 key 原文,不再回退到
  // 打包内置常量(那会渲染过期语义)
  const tpl = computed(() => {
    const key = node.value ? daqKeyFromRef(node.value.templateRef) : ''
    return daq.templates.find(t => t.key === key) ?? null
  })
  const signalKind = computed(() => tpl.value?.signalKind ?? 'scalar')
  const isFrameNode = computed(() => signalKind.value !== 'scalar')
  const stateLabel = computed<Record<DaqNodeState, string>>(() => ({ ok: t('daqDetail.k41k5c026'), warn: t('daqDetail.k49z8v027'), alarm: t('daqDetail.k3xmid028'), offline: t('daqDetail.k44c2n029') }))
  const effectiveState = (): DaqNodeState => {
    const n = node.value
    if (!n) return 'offline'
    if (!daq.controller.running || !n.enabled) return 'offline'
    return n.state
  }
  /** 驱动是否为预留协议(meta status=planned) */
  function driverPlanned(kind: string): boolean {
    return daq.meta.drivers.find(d => d.kind === kind)?.status === 'planned'
  }

  let unsub: (() => void) | null = null
  onMounted(() => {
    unsub = daq.ensureWsFeed()
    void daq.load()
    void deviceTwins.load()
  })
  onBeforeUnmount(() => unsub?.())

  return { daq, dcw, deviceTwins, nodeId, node, tpl, signalKind, isFrameNode, stateLabel, effectiveState, driverPlanned }
}
