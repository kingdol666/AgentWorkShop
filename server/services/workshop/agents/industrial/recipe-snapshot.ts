import { canonicalHash } from '@/shared/context/hash'

/** Canonical recipe content covered by an integrated Session's immutable snapshot. */
export function recipeDefinitionHash(recipe: { params: unknown, daqWindows?: unknown }): string {
  return canonicalHash({ params: recipe.params, daqWindows: recipe.daqWindows ?? [] })
}
