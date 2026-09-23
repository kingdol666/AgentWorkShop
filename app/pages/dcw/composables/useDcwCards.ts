import { computed } from 'vue'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import type { LineCard } from '../types'

/** 产线卡片数据源:产线本体 + 旗下节点/产品/配方计数,以及未归属(未挂产线)计数 */
export function useDcwCards() {
  const dcw = useDcwStream()

  const cards = computed<LineCard[]>(() =>
    dcw.lines.map(line => ({
      line,
      nodes: dcw.nodes.filter(n => n.lineId === line.id).length,
      products: dcw.products.filter(p => p.lineId === line.id).length,
      recipes: dcw.recipes.filter(r => r.lineId === line.id).length,
    })),
  )
  const unassignedCount = computed(() =>
    dcw.nodes.filter(n => !n.lineId).length + dcw.products.filter(p => !p.lineId).length,
  )

  /** 卡片配方下拉:本产线配方(继承自产品) */
  function recipesOf(lineId: string) {
    return dcw.recipes.filter(r => r.lineId === lineId)
  }

  return { cards, unassignedCount, recipesOf }
}
