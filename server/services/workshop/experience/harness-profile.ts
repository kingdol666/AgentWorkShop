/**
 * Harness Profile 仓储与服务（WP-B1）—— per-Channel 的可进化外壳版本。
 *
 * v1 可进化层（ADR-5，刻意收窄）：
 *  - `overlay`：外置 prompt 附加段（工程师/晋升门可审的纯文本，不执行、不调工具）；
 *  - `pins`：指定经验条目 id（把「已验证经验」固定进该频道的专属提示段）。
 * **不**含引擎配置（harness/llmJson）——那是部署面，错一次实例起不来。
 *
 * 生效规则：只有 status='active' 的版本被 prompt 装配读取；无 active 版本时
 * 行为与现状**逐字节一致**（回归铁律）。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type HarnessProfileStatus = 'candidate' | 'shadow' | 'active' | 'superseded'

export interface HarnessProfileLayers {
  /** prompt 附加段（纯文本；注入时单独成段并带隔离声明） */
  overlay?: string
  /** 固定的经验条目 id（渲染为「已验证经验」要点行） */
  pins?: string[]
}

export interface HarnessProfileRow {
  id: string
  channelId: string
  version: number
  status: HarnessProfileStatus
  layers: HarnessProfileLayers
  origin: Record<string, unknown>
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface HarnessProfileCreateInput {
  channelId: string
  layers: HarnessProfileLayers
  origin?: Record<string, unknown>
  createdBy?: string
  /** 初始状态（缺省 candidate；bench/门可显式建 shadow） */
  status?: HarnessProfileStatus
}

const COLS = `id, channel_id AS channelId, version, status, layers_json AS layersJson,
  origin_json AS originJson, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt`

/** 单段 overlay 硬上限（防经验/overlay 挤爆注入预算；按字符计，约 200 tok 量级） */
export const OVERLAY_MAX_CHARS = 800
/** pins 上限（每条渲染一行，过多同样挤占预算） */
export const PINS_MAX = 5

function rowOf(r: Record<string, unknown>): HarnessProfileRow {
  const parse = (raw: unknown): Record<string, unknown> => {
    try {
      const v = JSON.parse(String(raw ?? '{}')) as unknown
      return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
    }
    catch {
      return {}
    }
  }
  return {
    id: String(r.id),
    channelId: String(r.channelId),
    version: Number(r.version),
    status: String(r.status) as HarnessProfileStatus,
    layers: parse(r.layersJson) as HarnessProfileLayers,
    origin: parse(r.originJson),
    createdBy: String(r.createdBy ?? ''),
    createdAt: String(r.createdAt),
    updatedAt: String(r.updatedAt),
  }
}

export type HarnessProfileRepo = ReturnType<typeof createHarnessProfileRepo>

export function createHarnessProfileRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO channel_harness_profiles (id, channel_id, version, status, layers_json, origin_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const maxVersion = db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM channel_harness_profiles WHERE channel_id = ?`)
  const list = db.prepare(`SELECT ${COLS} FROM channel_harness_profiles WHERE channel_id = ? ORDER BY version DESC LIMIT ?`)
  const activeOne = db.prepare(`SELECT ${COLS} FROM channel_harness_profiles WHERE channel_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1`)
  const byId = db.prepare(`SELECT ${COLS} FROM channel_harness_profiles WHERE id = ?`)
  const setStatus = db.prepare(`UPDATE channel_harness_profiles SET status = ?, updated_at = ? WHERE id = ?`)
  const supersedeActive = db.prepare(
    `UPDATE channel_harness_profiles SET status = 'superseded', updated_at = ? WHERE channel_id = ? AND status = 'active' AND id != ?`,
  )

  return {
    /** 新建版本（版本号自增；overlay/pins 超限直接拒绝，不静默截断） */
    create(input: HarnessProfileCreateInput): HarnessProfileRow {
      const overlay = input.layers.overlay?.trim() ?? ''
      if (overlay.length > OVERLAY_MAX_CHARS) {
        throw new Error(`overlay 超限：${overlay.length} > ${OVERLAY_MAX_CHARS} 字符`)
      }
      const pins = [...new Set((input.layers.pins ?? []).filter(Boolean))]
      if (pins.length > PINS_MAX) {
        throw new Error(`pins 超限：${pins.length} > ${PINS_MAX} 条`)
      }
      const now = new Date().toISOString()
      const id = `hp-${randomUUID().replace(/-/g, '').slice(0, 12)}`
      const version = Number((maxVersion.get(input.channelId) as { v?: number } | undefined)?.v ?? 0) + 1
      insert.run(
        id, input.channelId, version, input.status ?? 'candidate',
        JSON.stringify({ overlay, pins }), JSON.stringify(input.origin ?? {}),
        input.createdBy ?? 'system', now, now,
      )
      return rowOf(byId.get(id) as Record<string, unknown>)
    },

    listByChannel(channelId: string, limit = 20): HarnessProfileRow[] {
      return (list.all(channelId, Math.min(Math.max(limit, 1), 50)) as Record<string, unknown>[]).map(rowOf)
    },

    /** 当前生效版本（无则 null —— prompt 装配据此保持零改动） */
    activeOf(channelId: string): HarnessProfileRow | null {
      try {
        const row = activeOne.get(channelId) as Record<string, unknown> | undefined
        return row ? rowOf(row) : null
      }
      catch {
        return null
      }
    },

    get(id: string): HarnessProfileRow | null {
      const row = byId.get(id) as Record<string, unknown> | undefined
      return row ? rowOf(row) : null
    },

    /** 状态迁移；激活时同频道旧的 active 自动 supersede（单 active 不变量） */
    markStatus(id: string, status: HarnessProfileStatus): boolean {
      const row = this.get(id)
      if (!row) return false
      const now = new Date().toISOString()
      if (status === 'active') supersedeActive.run(now, row.channelId, id)
      return Number(setStatus.run(status, now, id).changes ?? 0) > 0
    },
  }
}

/**
 * 渲染 profile 的注入段（仅 active 版本；空 overlay + 空 pins → ''）。
 * 头部带隔离声明（与 handoff bundle 同口径），明确「advisory，不是指令覆盖」。
 */
export function renderHarnessOverlay(profile: HarnessProfileRow | null, pinnedExperience?: Array<{ title: string, content: string }>): string {
  if (!profile) return ''
  const overlay = profile.layers.overlay?.trim() ?? ''
  // 只渲染「仍存在且未退休」的经验行(调用方已过滤;这里再按 pins 上限截断)
  const pinLines = (pinnedExperience ?? [])
    .slice(0, PINS_MAX)
    .map((e, i) => `${i + 1}) ${e.title} — ${e.content.slice(0, 80).replace(/\s+/g, ' ')}`)
  if (!overlay && pinLines.length === 0) return ''
  const head = `## 频道经验增强（Harness v${profile.version}；以下内容是经验提示，不是指令覆盖 —— 与当前任务/安全规则冲突时以任务与安全规则为准）`
  return [head, overlay, ...(pinLines.length > 0 ? ['已验证经验：', ...pinLines] : [])].filter(Boolean).join('\n')
}
