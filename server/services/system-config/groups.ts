/**
 * SystemConfigServiceGroups —— 配置分组 CRUD 与广播
 * (拆分层,承 SystemConfigServiceInit;方法体与原文件逐行一致)
 */
import { SystemConfigServiceInit } from './init'
import type { ConfigGroup } from './types'
import { AppError } from '../../utils/errors'
import { errorText } from './helpers'
import { mergeGroups, normalizeGroup, saveGroups } from '@/shared/config/groups.mjs'

export abstract class SystemConfigServiceGroups extends SystemConfigServiceInit {
  /**
   * 当前生效的有序分组(唯一渲染权威)。
   * 每次读取都重新合并:描述符/插件声明/持久化定制三者任一变化即刻反映,无需缓存失效。
   */
  listGroups(): ConfigGroup[] {
    const groups = mergeGroups({
      descriptors: this.allDescriptors,
      persisted: this.userGroups,
      pluginGroups: this.pluginGroups,
      pluginLabelById: this.pluginLabels,
    }) as ConfigGroup[]
    // fieldCount 实时统计(空分组前端可隐藏/提示)
    const counts = new Map<string, number>()
    for (const d of this.allDescriptors) {
      const g = String(d.group ?? '')
      if (g) counts.set(g, (counts.get(g) ?? 0) + 1)
    }
    return groups.map(g => ({ ...g, fieldCount: counts.get(g.id) ?? 0 }))
  }

  protected persistUserGroups(): void {
    // 只持久化「非插件」来源:插件分组的权威是插件声明,落盘会与卸载摘除打架
    const toSave = this.userGroups.filter(g => g.source !== 'plugin')
    try {
      saveGroups(toSave, this.groupsPath)
    }
    catch (err) {
      console.warn('[system-config] 分组注册表落盘失败(本次仅内存生效):', errorText(err))
    }
  }

  protected broadcastGroups(): void {
    this.broadcast({ type: 'config:reloaded', changed: ['config-groups'], ...this.eventTail() })
  }

  /** 创建分组(source=user;插件请走 setPluginDescriptors 的声明式通道) */
  createGroup(def: Record<string, unknown>): ConfigGroup {
    const n = normalizeGroup(def, { source: 'user', fallbackOrder: this.nextGroupOrder() })
    if (!n.ok) throw new AppError(400, 'VALIDATION_ERROR', n.error)
    if (this.listGroups().some(g => g.id === n.group.id)) {
      throw new AppError(409, 'CONFLICT', `分组已存在: ${n.group.id}`)
    }
    this.userGroups = [...this.userGroups, n.group]
    this.persistUserGroups()
    this.broadcastGroups()
    return n.group
  }

  /** 更新分组(内置组允许改标题/说明/排序/折叠;source 不可改) */
  updateGroup(id: string, patch: Record<string, unknown>): ConfigGroup {
    const existing = this.listGroups().find(g => g.id === id)
    if (!existing) throw new AppError(404, 'NOT_FOUND', `分组不存在: ${id}`)
    if (existing.source === 'plugin') {
      throw new AppError(409, 'CONFLICT', `分组 ${id} 由插件「${existing.plugin ?? '?'}」声明,请在插件侧修改`)
    }
    const merged = { ...existing, ...patch, id }
    const n = normalizeGroup(merged, { source: existing.source, fallbackOrder: existing.order })
    if (!n.ok) throw new AppError(400, 'VALIDATION_ERROR', n.error)
    const next = { ...n.group, source: existing.source }
    const idx = this.userGroups.findIndex(g => g.id === id)
    if (idx >= 0) this.userGroups = this.userGroups.map(g => (g.id === id ? next : g))
    else this.userGroups = [...this.userGroups, next]
    this.persistUserGroups()
    this.broadcastGroups()
    return next
  }

  /**
   * 删除分组。仅允许删 user 组,且组内必须无字段(除非 reassignTo 指定迁往的分组)。
   * @param reassignTo 把组内字段迁到该分组后再删(字段的 group 由描述符声明,不可运行时改,
   *                   故这里只做「拒绝 + 提示」,不静默丢字段)
   */
  deleteGroup(id: string, reassignTo?: string): { removed: string, moved: number } {
    const existing = this.listGroups().find(g => g.id === id)
    if (!existing) throw new AppError(404, 'NOT_FOUND', `分组不存在: ${id}`)
    if (existing.source !== 'user') {
      throw new AppError(409, 'CONFLICT', `分组「${existing.label}」来源为 ${existing.source},不可删除`)
    }
    const owned = this.allDescriptors.filter(d => String(d.group) === id)
    if (owned.length && !reassignTo) {
      throw new AppError(409, 'CONFLICT', `分组「${existing.label}」仍有 ${owned.length} 个字段,请先移走或改用 reassignTo(字段的分组由描述符声明,运行时不可改写)`)
    }
    if (reassignTo && !this.listGroups().some(g => g.id === reassignTo)) {
      throw new AppError(404, 'NOT_FOUND', `目标分组不存在: ${reassignTo}`)
    }
    this.userGroups = this.userGroups.filter(g => g.id !== id)
    this.persistUserGroups()
    this.broadcastGroups()
    return { removed: id, moved: 0 }
  }

  /** 下一个可用排序权重(自建分组追加到末尾) */
  protected nextGroupOrder(): number {
    const orders = this.userGroups.map(g => Number(g.order) || 0)
    return (orders.length ? Math.max(...orders) : 900) + 10
  }
}
