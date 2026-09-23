import { computed, ref, type ComputedRef } from 'vue'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import type { LineCard } from '../types'

/**
 * 产线清单筛选 —— 总览页的两条导航工具:
 *  · 状态分段(全部 / 运行中 / 待机;运行数由逐线运行态派生)
 *  · 名称/描述搜索(与状态 AND 复合)
 * 94 条历史线的管理页:导航先于遍历。
 */
export function useDcwFilter(cards: ComputedRef<LineCard[]>) {
  const dcw = useDcwStream()

  const filterState = ref<'all' | 'running' | 'idle'>('all')
  const searchText = ref('')

  const runningCount = computed(() => cards.value.filter(c => dcw.lineStateOf(c.line.id).active).length)

  const shownCards = computed(() => cards.value.filter((c) => {
    const active = dcw.lineStateOf(c.line.id).active
    if (filterState.value === 'running' && !active) return false
    if (filterState.value === 'idle' && active) return false
    const q = searchText.value.trim().toLowerCase()
    if (q && !c.line.name.toLowerCase().includes(q) && !(c.line.description ?? '').toLowerCase().includes(q)) return false
    return true
  }))

  return { filterState, searchText, runningCount, shownCards }
}
