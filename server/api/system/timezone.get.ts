/**
 * GET /api/system/timezone —— 当前系统时区只读信息。
 * 普通登录用户可读取，用于浏览器显式时区格式化；修改仍走管理员系统设置 PATCH。
 */
import { resolveUser } from '../workshop/caller'
import { defineApiHandler } from '../../utils/response'
import { configuredTimeZoneOffset, getConfiguredTimeZone, supportedTimeZones } from '@/shared/local-time.mjs'

export default defineApiHandler((event) => {
  resolveUser(event)
  const timeZone = getConfiguredTimeZone()
  const offsetMinutes = configuredTimeZoneOffset(new Date(), timeZone)
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  return {
    timeZone,
    supportedTimeZones: supportedTimeZones(),
    offset: `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`,
  }
})
