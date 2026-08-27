/**
 * GET /api/workshop/daq/infra —— 基础设施状态(MQTT/Timescale 在线与否、降级警告)。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { daqInfraStatus } from '@/server/services/workshop/daq/infra'

export default defineApiHandler((event) => {
  resolveUser(event)
  return { infra: daqInfraStatus() }
})
