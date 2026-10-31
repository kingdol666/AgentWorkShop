/**
 * GET /api/workshop/daq/storage —— 时序存储运维面(只读):
 * 布局(原始/聚合/逐产线保留期)、聚合水位、共享表体积。
 *
 * 用于回答"数据到底保留多久、聚合追到哪、哪条产线被单独调过保留期"。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { tsdbLayoutInfo, tsdbRetentionInfo } from '@/server/services/workshop/daq/storage'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  return {
    retention: tsdbRetentionInfo(),
    layout: await tsdbLayoutInfo(),
  }
})
