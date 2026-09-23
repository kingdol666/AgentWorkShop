import { reactive, ref } from 'vue'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import type { LineCard } from '../types'

/**
 * 卡片上的快捷启停 —— 待机卡选配方即开跑 / 运行卡一键停线。
 * 逐线配方选择与在飞/错误状态由本 composable 持有,卡片只负责呈现。
 */
export function useDcwQuickActions(t: (key: string) => string) {
  const dcw = useDcwStream()

  const quickBusy = ref('')
  const quickErr = ref('')
  const quickPick = reactive<Record<string, string>>({})

  async function quickStart(card: LineCard): Promise<void> {
    quickBusy.value = card.line.id
    quickErr.value = ''
    try {
      const rid = quickPick[card.line.id] ?? ''
      if (!rid) throw new Error(t('dcw.k188cswn039'))
      await dcw.startLine(card.line.id, rid)
    }
    catch (err) {
      quickErr.value = apiErrorMessage(err)
    }
    finally {
      quickBusy.value = ''
    }
  }

  async function quickStop(card: LineCard): Promise<void> {
    quickBusy.value = card.line.id
    quickErr.value = ''
    try {
      await dcw.stopLine(card.line.id)
    }
    catch (err) {
      quickErr.value = apiErrorMessage(err)
    }
    finally {
      quickBusy.value = ''
    }
  }

  return { quickBusy, quickErr, quickPick, quickStart, quickStop }
}
