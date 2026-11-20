/**
 * 主张簇相容性(Task 3)。
 *
 * 合并只能把**同一假设**的多份独立证据聚在一起。产品、变量、量纲、方向、工况与
 * 配方版本任一不一致都不能合并计数;Beta 派生物与 legacy-unverified 旧版本
 * 永远不可进入晋升簇(ADR 边界 + 无来源数据)。
 */
import type { ClaimClusterProposal, ExperienceVersion } from './types'

export function proposeClaimCluster(versions: readonly ExperienceVersion[]): ClaimClusterProposal {
  const ids = versions.map(v => v.versionId)
  if (versions.length < 2) return { compatible: false, reasons: ['至少 2 个版本才能构成主张簇'], versionIds: ids }
  const reasons: string[] = []
  if (versions.some(v => v.betaAncestors.length > 0)) reasons.push('BETA_ANCESTOR_PRESENT: Beta 派生物不得晋升')
  if (versions.some(v => v.lifecycle === 'legacy-unverified')) reasons.push('LEGACY_UNVERIFIED: 无来源的旧版本不得参与晋升')
  const [base, ...rest] = versions
  for (const v of rest) {
    if (v.claim.productId !== base!.claim.productId) reasons.push('PRODUCT_MISMATCH: 主张分属不同产品')
    if (v.claim.variable !== base!.claim.variable) reasons.push('VARIABLE_MISMATCH: 主张针对不同工艺变量')
    if (v.claim.unit !== base!.claim.unit) reasons.push('UNIT_MISMATCH: 量纲不一致')
    if (v.claim.direction !== base!.claim.direction) reasons.push('DIRECTION_MISMATCH: 方向不一致')
    if (v.claim.polarity !== base!.claim.polarity) reasons.push('POLARITY_MISMATCH: 支持/反证极性不一致')
    if (base!.claim.recipeRevision && v.claim.recipeRevision && v.claim.recipeRevision !== base!.claim.recipeRevision) {
      reasons.push('RECIPE_MISMATCH: 配方版本不一致')
    }
  }
  return { compatible: reasons.length === 0, reasons: [...new Set(reasons)], versionIds: ids }
}
