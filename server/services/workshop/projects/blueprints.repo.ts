/**
 * ProjectBlueprintRepo —— 项目蓝图（模板）持久化（project-blueprints.json 文档存储）。
 *
 * P1-1（plan 2026-11-06 §3）：「构建好一个 project 模板，新开会话一键复用」。
 * 文档优先（plan 风险条款：blueprint 先以 JSON 文档落地，跑通真实场景后再定 schema）：
 *   blueprint = {
 *     name, objective, description?,
 *     routingPolicy?: 'legacy'|'technical' (默认 technical，P0-7 口径),
 *     planApprovalRequired?: boolean (默认 true),
 *     autoDispatch?: boolean (默认 false),
 *     mode?: 'observe'|'supervised'|'auto',
 *     channels: [{ key, name?, charter?, leadHarness? }],        // key 唯一
 *     plan: { deliverables: [{key,name,channelKey?,...}], work_items: [{key,title,deliverableKey,channelKey?,dependsOn?,...}] }
 *   }
 * 实例化时 channelKey → 新建频道 id 解析（service.instantiateBlueprint）。
 * 存储：owner 隔离（与 Channel 模板 v10 可见性口径一致：私有仅本人；admin 全量）。
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { AppError, ErrorCodes } from '../../../utils/errors'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'
import { createLogger } from '../logger'

const log = createLogger('workshop.project-blueprints')

export interface ProjectBlueprintChannelDef {
  key: string
  name?: string
  charter?: string
  leadHarness?: string
  leadConfig?: Record<string, unknown>
}

export interface ProjectBlueprint {
  name: string
  objective: string
  description?: string
  routingPolicy?: 'legacy' | 'technical'
  planApprovalRequired?: boolean
  autoDispatch?: boolean
  mode?: 'observe' | 'supervised' | 'auto'
  /** 项目总工 harness（默认 mock；'omp'=真实 LLM leader，可对话/消费队列） */
  leaderHarness?: string
  /** leaderHarness='omp' 时的模型直选 */
  leaderProvider?: string
  leaderModel?: string
  channels: ProjectBlueprintChannelDef[]
  plan: {
    deliverables: Array<Record<string, unknown>>
    work_items: Array<Record<string, unknown>>
  }
}

export interface ProjectBlueprintRow {
  id: string
  name: string
  ownerUserId: string
  blueprint: ProjectBlueprint
  createdAt: string
  updatedAt: string
}

interface BlueprintStore {
  version: 1
  blueprints: ProjectBlueprintRow[]
}

const EMPTY: BlueprintStore = { version: 1, blueprints: [] }

function fileOf(): string {
  return join(ensureDataDir(), 'project-blueprints.json')
}

function load(): BlueprintStore {
  const raw = loadJsonFile(fileOf(), EMPTY) as BlueprintStore | null
  if (!raw || !Array.isArray(raw.blueprints)) return { ...EMPTY }
  return raw
}

function flush(store: BlueprintStore): void {
  saveJsonFileAtomic(fileOf(), store)
}

/** 蓝图结构校验（fail-closed：channels 必须非空且 key 唯一；plan 双数组必须存在）。 */
export function validateBlueprint(bp: ProjectBlueprint): void {
  const name = String(bp.name ?? '').trim()
  const objective = String(bp.objective ?? '').trim()
  if (!name) throw new AppError(400, 'BLUEPRINT_INVALID', '蓝图缺 name')
  if (!objective) throw new AppError(400, 'BLUEPRINT_INVALID', '蓝图缺 objective')
  const channels = Array.isArray(bp.channels) ? bp.channels : []
  if (channels.length === 0) throw new AppError(400, 'BLUEPRINT_INVALID', '蓝图至少需要一个频道定义')
  if (channels.length > 12) throw new AppError(400, 'BLUEPRINT_INVALID', '频道数超上限 12')
  const keys = new Set<string>()
  for (const c of channels) {
    const key = String(c.key ?? '').trim()
    if (!key) throw new AppError(400, 'BLUEPRINT_INVALID', '频道定义缺 key')
    if (keys.has(key)) throw new AppError(400, 'BLUEPRINT_INVALID', `频道 key 重复: ${key}`)
    keys.add(key)
  }
  const plan = bp.plan ?? ({} as ProjectBlueprint['plan'])
  if (!Array.isArray(plan.deliverables) || plan.deliverables.length === 0) {
    throw new AppError(400, 'BLUEPRINT_INVALID', '蓝图 plan.deliverables 不能为空')
  }
  if (!Array.isArray(plan.work_items)) throw new AppError(400, 'BLUEPRINT_INVALID', '蓝图 plan.work_items 缺失')
  if (bp.routingPolicy !== undefined && !['legacy', 'technical'].includes(bp.routingPolicy)) {
    throw new AppError(400, 'BLUEPRINT_INVALID', 'routingPolicy 只能是 legacy 或 technical')
  }
}

export function createProjectBlueprintRepo() {
  return {
    /** 命名保存/覆盖（同名同 owner 覆盖；admin 可覆盖任意）。 */
    save(name: string, ownerUserId: string, blueprint: ProjectBlueprint, actorRole?: string): ProjectBlueprintRow {
      validateBlueprint(blueprint)
      const store = load()
      const clean = String(name ?? '').trim()
      if (!clean) throw new AppError(400, 'BAD_REQUEST', '模板名不能为空')
      const existing = store.blueprints.find(b => b.name === clean && (b.ownerUserId === ownerUserId || actorRole === 'admin'))
      const now = new Date().toISOString()
      if (existing) {
        existing.blueprint = blueprint
        existing.updatedAt = now
        flush(store)
        log.info(`blueprint updated: ${clean}`)
        return existing
      }
      const row: ProjectBlueprintRow = {
        id: `pb-${randomUUID().slice(0, 8)}`,
        name: clean,
        ownerUserId,
        blueprint,
        createdAt: now,
        updatedAt: now,
      }
      store.blueprints.push(row)
      flush(store)
      log.info(`blueprint saved: ${clean}`)
      return row
    },

    findById(id: string): ProjectBlueprintRow | undefined {
      return load().blueprints.find(b => b.id === id)
    },

    findByName(name: string, ownerUserId: string, actorRole?: string): ProjectBlueprintRow | undefined {
      const clean = String(name ?? '').trim()
      return load().blueprints.find(b => b.name === clean && (b.ownerUserId === ownerUserId || actorRole === 'admin'))
    },

    /** 读可见面 = owner 本人 或 admin（成员/他人模板不外泄，v1 口径）。 */
    list(ownerUserId: string, actorRole?: string): ProjectBlueprintRow[] {
      return load().blueprints.filter(b => b.ownerUserId === ownerUserId || actorRole === 'admin')
    },

    remove(id: string, ownerUserId: string, actorRole?: string): boolean {
      const store = load()
      const row = store.blueprints.find(b => b.id === id)
      if (!row) return false
      if (row.ownerUserId !== ownerUserId && actorRole !== 'admin') {
        throw new AppError(403, 'FORBIDDEN', '仅模板属主/admin 可删除')
      }
      store.blueprints = store.blueprints.filter(b => b.id !== id)
      flush(store)
      return true
    },
  }
}

export type ProjectBlueprintRepo = ReturnType<typeof createProjectBlueprintRepo>
