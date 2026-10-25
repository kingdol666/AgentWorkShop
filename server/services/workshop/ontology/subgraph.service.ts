/**
 * 本体子图服务层 —— 把仓储/草稿文档适配成纯核心需要的输入。
 *
 * 两条数据路径,语义必须分清:
 *  - subgraphAroundForLine:只读**已发布**活跃版本(与 sceneSubgraph 同口径,供 Agent/MCP)
 *  - subgraphAroundDoc:读**草稿**(供 /ontology 页面,画图与抽屉必须与表格同源)
 */
import { AppError } from '../../../utils/errors'
import type { OntologyDraftDoc } from './contracts'
import { getOntologyRepo } from './repo'
import { resolveActiveOntology } from './ontology.service'
import {
  buildSubgraphAround, type SubgraphAround, type SubgraphGraphData, type SubgraphOptions,
} from './subgraph.core'

export interface OntologyVersionRef {
  id: string
  version: number
  lineId: string
}

function versionRefOf(active: NonNullable<ReturnType<typeof resolveActiveOntology>>, lineId: string): OntologyVersionRef {
  return { id: active.version.id, version: active.version.version, lineId }
}

/** 从已发布版本快照读取图数据 */
export function loadVersionGraph(ref: OntologyVersionRef): SubgraphGraphData {
  const repo = getOntologyRepo()
  const entities = repo.listEntities(ref.id, ref.version)
  const relations = repo.listRelations(ref.id, ref.version)
  const bindings = repo.listBindings(ref.id, ref.version)
  return {
    entities: entities.map(e => ({
      key: e.key, kind: e.kind, name: e.name, description: e.description, unit: e.unit, role: e.role,
    })),
    relations: relations.map(r => ({
      id: r.id, kind: r.kind, srcKey: r.srcKey, dstKey: r.dstKey, evidenceTier: r.properties.evidenceTier,
    })),
    bindings: bindings.map(b => ({
      entityKey: b.entityKey,
      platformKind: b.platformKind,
      platformId: b.platformId,
      targetSub: b.targetSub,
      direction: b.direction,
      status: b.status,
      unitDeclared: b.unitDeclared,
      unitTarget: b.unitTarget,
      scale: b.scale,
      offset: b.offset,
    })),
  }
}

/** 指定已发布版本(调用方需自行校验归属) */
export function subgraphAroundForVersion(
  ref: OntologyVersionRef,
  entityKey: string,
  opts: SubgraphOptions = {},
): SubgraphAround {
  const meta = { ontologyId: ref.id, version: ref.version, lineId: ref.lineId }
  return buildSubgraphAround(entityKey, loadVersionGraph(ref), meta, opts)
}

/**
 * 产线活跃已发布版本的邻接子图;该产线无已发布本体 → null(与 scene 的 active:false 同语义)。
 */
export function subgraphAroundForLine(
  lineId: string,
  entityKey: string,
  opts: SubgraphOptions = {},
): SubgraphAround | null {
  const active = resolveActiveOntology(lineId)
  if (!active) return null
  return subgraphAroundForVersion(versionRefOf(active, lineId), entityKey, opts)
}

/** 草稿文档的邻接子图(供 UI:图与抽屉同源) */
export function subgraphAroundDoc(
  doc: OntologyDraftDoc,
  entityKey: string,
  opts: SubgraphOptions = {},
): SubgraphAround {
  const ontologyId = typeof (doc as { ontologyId?: unknown }).ontologyId === 'string'
    ? String((doc as { ontologyId?: unknown }).ontologyId)
    : doc.name
  const data: SubgraphGraphData = {
    entities: doc.entities.map(e => ({
      key: e.key, kind: e.kind, name: e.name, description: e.description, unit: e.unit, role: e.role,
    })),
    relations: doc.relations.map(r => ({
      id: r.id, kind: r.kind, srcKey: r.srcKey, dstKey: r.dstKey, evidenceTier: r.properties.evidenceTier,
    })),
    bindings: doc.bindings.map(b => ({
      entityKey: b.entityKey,
      platformKind: b.platformKind,
      platformId: b.platformId,
      targetSub: b.targetSub,
      direction: b.direction,
      unitDeclared: b.unitDeclared,
      unitTarget: b.unitTarget,
      scale: b.scale,
      offset: b.offset,
    })),
  }
  return buildSubgraphAround(entityKey, data, { ontologyId, version: 0, lineId: doc.lineId }, opts)
}

/** 供路由复用的实体必填校验 */
export function requireEntityKey(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) throw new AppError(422, 'ONTOLOGY_ENTITY_REQUIRED', 'entity 必填(实体 key,如 mv.hold_pressure)')
  return value
}
