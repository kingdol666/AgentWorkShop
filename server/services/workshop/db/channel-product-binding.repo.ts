import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'
import { withTransaction } from './transaction'

export interface ChannelProductBindingRow {
  productId: string
}

export function createChannelProductBindingRepo(db: DatabaseSync) {
  const channelExists = db.prepare('SELECT 1 AS present FROM channels WHERE id = ?')
  const revisionForChannel = db.prepare(
    'SELECT COALESCE(MAX(revision), 0) AS revision FROM channel_product_bindings WHERE channel_id = ?',
  )
  const removeBindings = db.prepare('DELETE FROM channel_product_bindings WHERE channel_id = ?')
  const insertBinding = db.prepare(
    'INSERT INTO channel_product_bindings (channel_id, product_id, revision) VALUES (?, ?, ?)',
  )
  const bindingsForChannel = db.prepare(
    'SELECT product_id AS productId FROM channel_product_bindings WHERE channel_id = ? AND product_id IS NOT NULL ORDER BY product_id ASC',
  )

  return {
    replaceForChannel(channelId: string, productIds: readonly string[], expectedRevision: number): { revision: number } {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new AppError(400, 'BAD_REQUEST', 'expectedRevision must be a non-negative safe integer')
      }

      return withTransaction(db, () => {
        if (!channelExists.get(channelId)) {
          throw new AppError(404, 'NOT_FOUND', 'Channel not found')
        }

        const current = revisionForChannel.get(channelId) as { revision?: number } | undefined
        const currentRevision = Number(current?.revision ?? 0)
        if (currentRevision !== expectedRevision) {
          throw new AppError(409, 'CHANNEL_PRODUCT_BINDING_STALE', 'Channel product bindings have changed; reload and retry')
        }

        const revision = currentRevision + 1
        const normalizedProductIds = [...new Set(productIds)].sort()
        removeBindings.run(channelId)
        if (normalizedProductIds.length === 0) {
          insertBinding.run(channelId, null, revision)
        }
        else {
          for (const productId of normalizedProductIds) insertBinding.run(channelId, productId, revision)
        }
        return { revision }
      })
    },

    getRevision(channelId: string): number {
      const row = revisionForChannel.get(channelId) as { revision?: number } | undefined
      return Number(row?.revision ?? 0)
    },

    listByChannel(channelId: string): ChannelProductBindingRow[] {
      return bindingsForChannel.all(channelId) as unknown as ChannelProductBindingRow[]
    },
  }
}

export type ChannelProductBindingRepo = ReturnType<typeof createChannelProductBindingRepo>
