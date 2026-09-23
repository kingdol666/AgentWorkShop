/**
 * 归属维度(产线 → 产品 → Recipe)的级联口径与名称回填。
 *
 * 三处消费同一套语义:筛选区选项、人工记录弹窗选项、结果表的归属 chip 文案。
 * 数据源是 DCW 流单例(产线/产品/Recipe 目录),页面只在 onMounted 里触发一次 load,
 * 因此这里的派生读到的始终是同一份权威列表。
 * 名称缺失一律回落空串 —— 是否显示占位符('—')由调用方的展示语义决定。
 */
import { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import type { ProductView, RecipeView } from '#shared/dcw-protocol'

export function useLogsScope() {
  const dcw = useDcwStream()

  /** 产品选项:按产线收窄(空产线 = 全量) */
  function productsOfLine(lineId: string): ProductView[] {
    return dcw.products.filter(p => !lineId || p.lineId === lineId)
  }

  /** Recipe 选项:按产线 + 产品收窄(空维度 = 该维度不设限) */
  function recipesOfScope(lineId: string, productId: string): RecipeView[] {
    return dcw.recipes.filter(r =>
      (!lineId || r.lineId === lineId) && (!productId || r.productId === productId))
  }

  function lineName(id: string): string {
    return dcw.lines.find(l => l.id === id)?.name ?? ''
  }

  function productName(id: string): string {
    return dcw.products.find(p => p.id === id)?.name ?? ''
  }

  function recipeName(id: string): string {
    return dcw.recipes.find(r => r.id === id)?.name ?? ''
  }

  return { lines: dcw.lines, productsOfLine, recipesOfScope, lineName, productName, recipeName }
}
