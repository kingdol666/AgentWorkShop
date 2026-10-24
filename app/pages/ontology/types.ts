/** 本体管理台类型(与服务端 contracts 对齐的最小子集)。 */

export interface OntologySummary {
  id: string
  lineId: string
  versions: number
  latest: number
  status: string
}

export interface DraftSummary {
  id: string
  ontologyId: string
  baseVersion: number | null
  rev: number
  ownerUserId: string
  updatedAt: string
}

export interface OntologyEntityDto {
  key: string
  kind: string
  name: string
  description: string
  unit: string
  dimension: string
  role?: string
}

export interface OntologyRelationDto {
  id: string
  kind: string
  srcKey: string
  dstKey: string
  status: string
  properties: { evidenceTier: string, sign?: string, lagMs?: number }
}

export interface OntologyRuleDto {
  id: string
  key: string
  kind: string
  dsl: Record<string, unknown>
  constraintLevel: string
  severity: string
  status: string
  description: string
  evidence: Array<{ level: string, source: { type: string } }>
}

export interface BindingDto {
  id: string
  entityKey: string
  platformKind: string
  platformId: string
  targetSub: string
  direction: string
  unitDeclared: string
  unitTarget: string
}

export interface OntologyDocDto {
  schemaVersion: number
  name: string
  lineId: string
  entities: OntologyEntityDto[]
  relations: OntologyRelationDto[]
  rules: OntologyRuleDto[]
  bindings: BindingDto[]
  note: string
}

export interface IssueDto { code: string, path: string, message: string, severity: string, ruleId?: string, hint?: string }

export interface DraftDetailDto {
  draft: DraftSummary
  doc: OntologyDocDto
  validation: { ok: boolean, issues: IssueDto[], stats: Record<string, unknown> }
  bindings: { ok: boolean, failures: Array<{ bindingId: string, code: string, message: string }> }
}

export interface CompileDto {
  status: string
  contentHash: string
  packHash: string
  rulePackHash: string
  counts: { compiled: number, guard: number, explained: number, rejected: number }
  artifacts: {
    problemIr: { mvBounds: Record<string, unknown>, cvBounds: Record<string, unknown>, softRegularization: unknown[] }
    controlGuard: { guards: Array<{ id: string, ruleId: string, onViolate: string, message: string }> }
    processModel: { featureCandidates: unknown[], delayPriors: unknown[] }
    sceneContract: { variables: unknown[], constraints: unknown[], inferredRelations: unknown[] }
  }
  traces: Array<{ ruleId: string, decision: string, decisionCode: string, message: string, evidenceLevel: string }>
  issues: IssueDto[]
}

export interface VersionDto {
  version: number
  status: string
  name: string
  lineId: string
  parentVersion: number | null
  contentHash: string
  publishedBy: string
  createdAt: string
  compiled?: { packHash?: string, counts?: { compiled?: number, guard?: number, rejected?: number } }
}

export interface VersionDiffDto {
  from: number
  to: number
  entities: { added: string[], removed: string[], changed: string[] }
  relations: { added: string[], removed: string[], changed: string[] }
  rules: { added: string[], removed: string[], changed: string[] }
  bindings: { added: string[], removed: string[], changed: string[] }
}

export interface OverviewDto {
  ontologies: OntologySummary[]
  drafts: DraftSummary[]
}
