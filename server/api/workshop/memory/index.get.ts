/**
 * GET /api/workshop/memory —— 记忆中心列表 / 分面（`?facets=1`）。
 * 读可见性：admin 全部；其他用户仅 owner_user_id = 自己 的行。
 */
import { getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { listMemory, memoryFacets } from '@/server/services/workshop/memory/memory-admin'
import { memoryOwnerFilter, requireMemoryUser } from '@/server/services/workshop/memory/memory-access'
import type { MemoryKind, MemoryScopeKind, MemoryStatus } from '@/server/services/workshop/db/database'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  const q = getQuery(event)
  const db = getAmlRuntime().db
  const owner = memoryOwnerFilter(user)
  if (q.facets === '1') return memoryFacets(db, owner)
  return listMemory(db, {
    ...owner,
    scopeKind: typeof q.scopeKind === 'string' && q.scopeKind ? q.scopeKind as MemoryScopeKind : undefined,
    status: typeof q.status === 'string' && q.status ? q.status as MemoryStatus : undefined,
    kind: typeof q.kind === 'string' && q.kind ? q.kind as MemoryKind : undefined,
    authorKind: q.authorKind === 'human' || q.authorKind === 'agent' || q.authorKind === 'system' ? q.authorKind : undefined,
    q: typeof q.q === 'string' && q.q.trim() ? q.q.trim() : undefined,
    includeDeleted: q.includeDeleted === '1',
    limit: Number(q.limit ?? 50),
    offset: Number(q.offset ?? 0),
  })
})
