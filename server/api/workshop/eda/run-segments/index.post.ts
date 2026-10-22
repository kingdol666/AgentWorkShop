/**
 * POST /api/workshop/eda/run-segments —— 定义 run 内相位段(见 index.get.ts;方法分文件)。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { edaDb } from '@/server/services/workshop/eda/eda-db'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{ recipe_id?: string, seq?: number, name?: string, phase_from?: number, phase_to?: number }>(event) ?? {}
  const recipeId = String(body.recipe_id ?? '')
  const recipe = getDcwController().listRecipes().find(r => r.id === recipeId)
  if (!recipe) throw new AppError(404, 'NOT_FOUND' as never, `配方不存在: ${recipeId}`)
  requireLineMode(user, recipe.lineId, 'readonly')
  const from = Number(body.phase_from)
  const to = Number(body.phase_to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > 1 || from >= to) {
    throw new AppError(400, 'VALIDATION_ERROR' as never, 'phase_from/phase_to 必须满足 0 ≤ from < to ≤ 1。')
  }
  const seq = Math.max(Math.round(Number(body.seq)) || 1, 1)
  edaDb().prepare(`INSERT INTO run_segments (id, recipe_id, seq, name, phase_from, phase_to)
    VALUES ('rseg-' || lower(hex(randomblob(4))), ?, ?, ?, ?, ?)
    ON CONFLICT(recipe_id, seq) DO UPDATE SET name = excluded.name, phase_from = excluded.phase_from, phase_to = excluded.phase_to`)
    .run(recipeId, seq, String(body.name ?? `seg${seq}`), from, to)
  return { segments: edaDb().prepare('SELECT * FROM run_segments WHERE recipe_id = ? ORDER BY seq ASC').all(recipeId) }
})
