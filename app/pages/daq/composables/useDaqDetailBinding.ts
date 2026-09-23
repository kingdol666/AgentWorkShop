import { computed, ref, type ComputedRef } from 'vue'
import { useDaqStream, type DaqNodeLive } from '@/app/composables/workshop/useDaqStream'
import { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'

/**
 * 设备绑定 —— 已绑定设备展示名 + 换绑/解绑入口 + 可选设备清单。
 * 绑定关系以节点的 deviceIds/deviceBindingId 为唯一事实源(server 权威),
 * 本 composable 不持有副本;下拉选择是纯 UI 态。
 */
export function useDaqDetailBinding(nodeId: ComputedRef<string>, node: ComputedRef<DaqNodeLive | null>) {
  const daq = useDaqStream()
  const deviceTwins = useDeviceTwins()

  const bindDeviceId = ref('')
  const boundDeviceName = computed(() => {
    const ids = node.value?.deviceIds ?? (node.value?.deviceBindingId ? [node.value.deviceBindingId] : [])
    return ids
      .map(id => deviceTwins.twins.find(t => t.id === id)?.name ?? `${id.slice(0, 8)}…`)
      .join(' / ')
  })
  function onBindToggle(): void {
    void daq.bindNode(nodeId.value, node.value?.deviceBindingId ? null : (bindDeviceId.value || null))
  }
  const availableDevices = computed(() =>
    deviceTwins.twins.filter(t => t.kind !== 'daq' && t.id !== node.value?.id),
  )

  return { bindDeviceId, boundDeviceName, onBindToggle, availableDevices }
}
