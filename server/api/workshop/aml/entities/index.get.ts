/**
 * GET /api/workshop/aml/entities —— 元数据 ↔ 实体 对账(只读)。
 * 返回两侧计数与差异清单(entity_missing / orphan_dir / contract_missing)。
 * 用途:数据集/模型"列表里在、实际打不开"这类问题的定位入口。
 */
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { inventory } from '@/server/services/workshop/aml/entity'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  return inventory()
})
