import type { ProjectRow, ProjectResultRow, ProjectWorkItemRow } from '../db/project.repo'
import {
  createReadOnlyAdapter,
  type RsiReadAdapter,
  type RsiReaderFunction,
  type RsiSourceReader,
  type RsiSourceRecord,
} from './contracts'

export type ProjectReadPayload = Pick<ProjectRow, 'id' | 'name' | 'description' | 'objective' | 'status' | 'mode' | 'ownerUserId' | 'planVersion' | 'createdAt' | 'updatedAt'> & {
  results?: readonly ProjectResultRow[]
  workItems?: readonly ProjectWorkItemRow[]
}
export type ProjectSource = ProjectReadPayload
export type ProjectReader = RsiSourceReader<RsiSourceRecord<ProjectSource>> | RsiReaderFunction<RsiSourceRecord<ProjectSource>>

export function createProjectReadAdapter(options: {
  reader: ProjectReader
  version?: string
}): RsiReadAdapter<ProjectSource, ProjectReadPayload> {
  return createReadOnlyAdapter({
    sourceType: 'project',
    version: options.version ?? '1.0.0',
    reader: options.reader,
    mapPayload: source => ({
      id: source.id,
      name: source.name,
      description: source.description,
      objective: source.objective,
      status: source.status,
      mode: source.mode,
      ownerUserId: source.ownerUserId,
      planVersion: source.planVersion,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      ...(source.results === undefined ? {} : { results: source.results }),
      ...(source.workItems === undefined ? {} : { workItems: source.workItems }),
    }),
  })
}
