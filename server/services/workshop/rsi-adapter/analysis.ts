import type { AnalysisReportRow } from '../analysis/analysis.repo'
import {
  createReadOnlyAdapter,
  type RsiReadAdapter,
  type RsiReaderFunction,
  type RsiSourceReader,
  type RsiSourceRecord,
} from './contracts'

export type AnalysisMetadataPayload = Pick<AnalysisReportRow, 'id' | 'title' | 'category' | 'summary' | 'conclusions' | 'metrics' | 'recipeId' | 'recipeVersion' | 'windowFrom' | 'windowTo' | 'dataSources' | 'channelId' | 'channelName' | 'actor' | 'actorName' | 'createdAt' | 'updatedAt'>
export type AnalysisSource = AnalysisMetadataPayload
export type AnalysisReader = RsiSourceReader<RsiSourceRecord<AnalysisSource>> | RsiReaderFunction<RsiSourceRecord<AnalysisSource>>

export function createAnalysisReadAdapter(options: {
  reader: AnalysisReader
  version?: string
}): RsiReadAdapter<AnalysisSource, AnalysisMetadataPayload> {
  return createReadOnlyAdapter({
    sourceType: 'analysis',
    version: options.version ?? '1.0.0',
    reader: options.reader,
    mapPayload: source => ({
      id: source.id,
      title: source.title,
      category: source.category,
      summary: source.summary,
      conclusions: source.conclusions,
      metrics: source.metrics,
      recipeId: source.recipeId,
      recipeVersion: source.recipeVersion,
      windowFrom: source.windowFrom,
      windowTo: source.windowTo,
      dataSources: source.dataSources,
      channelId: source.channelId,
      channelName: source.channelName,
      actor: source.actor,
      actorName: source.actorName,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    }),
  })
}
