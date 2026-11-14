import type { OntologyEntity, OntologyRelation, OntologyRule } from '../ontology/contracts'
import type { BindingRow, EvidenceRow, VersionRow } from '../ontology/repo'
import {
  createReadOnlyAdapter,
  type RsiReadAdapter,
  type RsiReaderFunction,
  type RsiSourceReader,
  type RsiSourceRecord,
} from './contracts'

export interface OntologyReadPayload {
  version: Pick<VersionRow, 'id' | 'version' | 'name' | 'lineId' | 'parentVersion' | 'contentHash' | 'status' | 'createdAt' | 'updatedAt'>
  entities: readonly OntologyEntity[]
  relations: readonly OntologyRelation[]
  rules: readonly OntologyRule[]
  bindings: readonly BindingRow[]
  evidence: readonly EvidenceRow[]
}
export type OntologySource = OntologyReadPayload
export type OntologyReader = RsiSourceReader<RsiSourceRecord<OntologySource>> | RsiReaderFunction<RsiSourceRecord<OntologySource>>

export function createOntologyReadAdapter(options: {
  reader: OntologyReader
  version?: string
}): RsiReadAdapter<OntologySource, OntologyReadPayload> {
  return createReadOnlyAdapter({
    sourceType: 'ontology',
    version: options.version ?? '1.0.0',
    reader: options.reader,
    mapPayload: source => ({
      version: source.version,
      entities: source.entities,
      relations: source.relations,
      rules: source.rules,
      bindings: source.bindings,
      evidence: source.evidence,
    }),
  })
}
