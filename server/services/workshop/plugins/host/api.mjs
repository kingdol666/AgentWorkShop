/**
 * 对外 API:事件发射 / 客户端脚本 / 清单 / 关停
 * (由 server/services/workshop/plugins/host.mjs 按职责拆出;内容逐行原文搬运)
 */
import { existsSync, readFileSync } from 'node:fs'
import { g } from './config.mjs'
import { isPathInside } from '@/sdk/index.mjs'

export function getPluginHost() {
  return g.__awPluginHost ?? null
}

/** scene-events 桥:全部无频道实时事件 → 插件 event:<type> */
export function emitPluginEvent(type, payload) {
  void g.__awPluginHost?.bus.emit(`event:${type}`, payload)
}

/** DAQ 下发级采样钩子(与 WS daq.reading 同点、同节拍语义) */
export function emitDaqSample(payload) {
  void g.__awPluginHost?.bus.emit('daq:sample', payload)
}

/** 帧观察钩子(v2 多形态信号;载荷只含元数据/指标/预览,不含 blob) */
export function emitDaqFrame(payload) {
  void g.__awPluginHost?.bus.emit('daq:frame', payload)
}

/** 写控 ACK 后观察钩子 */
export function emitDcwWrite(payload) {
  void g.__awPluginHost?.bus.emit('dcw:write', payload)
}

/** 产线启停钩子 */
export function emitLineLifecycle(kind, payload) {
  void g.__awPluginHost?.bus.emit(kind, payload)
}

/** 客户端脚本读取(免鉴权只读端点用;越界路径拒绝) */
export function readClientScript(name) {
  const host = getPluginHost()
  const rec = host?.plugins.get(name)
  if (!host || !rec) return { status: 404 }
  if (!rec.clientPath || !existsSync(rec.clientPath)) return { status: 404 }
  // 必须用 isPathInside:startsWith 会把兄弟同前缀目录(…/foo-evil)判为在内,可被 ../ 逃逸
  if (!isPathInside(rec.dir, rec.clientPath)) return { status: 400 }
  return { status: 200, code: readFileSync(rec.clientPath, 'utf8'), contentType: 'text/javascript; charset=utf-8' }
}

/** 清单(非敏感只读;含启停状态与路由)。builtin = 随项目检出提供的内置示例插件 */
export function pluginManifest() {
  const host = getPluginHost()
  if (!host) return []
  return [...host.plugins.values()].map(r => ({
    name: r.name,
    version: r.version,
    description: r.description,
    scope: r.scope,
    builtin: r.scope === 'project' || r.scope === 'builtin',
    enabled: r.enabled !== false,
    hasClient: Boolean(r.clientPath),
    hasI18n: Boolean(r.i18nPath),
    settingsCount: Array.isArray(r.settings) ? r.settings.length : 0,
    /** 本插件声明的配置分组(设置页独立分区;id 已收敛进 plugin-<name> 命名空间) */
    configGroups: (Array.isArray(r.groups) ? r.groups : []).map(g => ({
      id: g.id,
      label: g.label,
      fieldCount: (r.settings ?? []).filter(d => d.group === g.id).length,
    })),
    routes: host.routes.byPlugin(r.name),
    error: r.error,
  }))
}

/** 关机钩子(nitro close 时调用):先逐插件回收订阅/定时器,再广播 server:close */
export async function shutdownPluginHost() {
  const host = getPluginHost()
  if (!host) return
  for (const [name, list] of host.disposables ?? []) {
    for (const fn of list.splice(0)) {
      try {
        await fn()
      }
      catch (err) {
        host.logger.warn(`[${name}] onDispose 失败:`, err?.message)
      }
    }
  }
  await host.bus.emit('server:close', { at: new Date().toISOString() })
  host.logger.info('插件清理完成,已发出 server:close')
}
