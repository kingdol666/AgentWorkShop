import type { LineView } from '#shared/dcw-protocol'

/** 产线卡片(产线本体 + 旗下节点/产品/配方计数,总览页的最小展示单元) */
export interface LineCard {
  line: LineView
  nodes: number
  products: number
  recipes: number
}
