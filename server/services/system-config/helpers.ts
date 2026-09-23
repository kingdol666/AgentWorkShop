/**
 * SystemConfigService 的模块级纯工具/常量(原 server/services/system-config.ts 类外声明,含类体之后与类无关的部分)。
 */
import type { RuntimeConfigView } from './types'
import type { SystemConfigService } from './facade'

export const PUBLIC_FIELDS: Record<string, string> = {
  'server.host': 'serverHost',
  'server.dev.port': 'devPort',
  'server.prod.port': 'prodPort',
  'app.title': 'appTitle',
  'app.description': 'description',
  'api.baseURL': 'apiBase',
  'api.timeout': 'apiTimeout',
  'theme.primaryColor': 'primaryColor',
  'theme.mode': 'themeMode',
  'i18n.defaultLocale': 'defaultLocale',
}
export const ROOT_FIELDS: Record<string, string> = {
  'api.pageSize': 'apiPageSize',
  'api.maxPageSize': 'apiMaxPageSize',
  'security.approvalGate': 'approvalGate',
}
export const DAQ_PREFIX = 'daq.'

export function errorText(err: unknown): string {
  return String((err as { message?: unknown } | null | undefined)?.message ?? err)
}

/** 以可写记录视图取 runtimeConfig.daq:缺失/非对象时就地落一个空对象(与原先的兜底赋值等价) */
export function daqView(rc: RuntimeConfigView): Record<string, unknown> {
  const current = rc.daq
  if (current && typeof current === 'object') return current as Record<string, unknown>
  const created: Record<string, unknown> = {}
  rc.daq = created
  return created
}

declare global {
  var __systemConfig: SystemConfigService | undefined
}
