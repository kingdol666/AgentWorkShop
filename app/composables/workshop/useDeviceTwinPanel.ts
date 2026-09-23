/**
 * useDeviceTwinPanel —— 设备孪生面板的编排态(列表轮询刷新 / 行内删除两步确认 / 下发提示)。
 *
 * 自 DeviceTwinPanel.vue 抽出(纯搬移,行为逐字保持):
 *   - 数据源仍是 useDeviceTwins 单例(面板渲染与轮询共用同一份,不新建响应式副本);
 *   - 副作用(轮询定时器)在面板挂载时注册一次、卸载时清理;
 *   - 容器组件只做编排:把 twins/布防态/错误文案交给模板,不干预展示细节。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { apiErrorMessage } from '@/app/utils/api-error'
import { useDeviceTwins } from './useDeviceTwins'

export function useDeviceTwinPanel() {
  const twins = useDeviceTwins()

  // 节流轮询刷新(不打断拖拽/交互)
  let timer: ReturnType<typeof setInterval> | null = null
  onMounted(() => {
    void twins.load()
    timer = setInterval(() => void twins.load(), 2000)
  })
  onBeforeUnmount(() => {
    if (timer) clearInterval(timer)
  })

  const busyId = ref('')
  const ctrlMsg = ref('')
  /** 行内删除(两步确认:首击布防 3s,再击执行) */
  const armedId = ref('')
  let armedTimer: ReturnType<typeof setTimeout> | null = null
  async function removeTwin(t: { id: string, name: string }): Promise<void> {
    if (armedId.value !== t.id) {
      armedId.value = t.id
      if (armedTimer) clearTimeout(armedTimer)
      armedTimer = setTimeout(() => {
        armedId.value = ''
      }, 3000)
      return
    }
    if (armedTimer) clearTimeout(armedTimer)
    armedId.value = ''
    busyId.value = t.id
    ctrlMsg.value = ''
    try {
      await twins.remove(t.id)
    }
    catch (err) {
      ctrlMsg.value = apiErrorMessage(err)
    }
    finally {
      busyId.value = ''
    }
  }

  return { twins, busyId, ctrlMsg, armedId, removeTwin }
}
