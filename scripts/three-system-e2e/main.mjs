/**
 * 主流程:按序执行各阶段(0 → 0a2 → 0b → 0c → Stage 1 → 2 → 2.5 → 3 → 4)并汇总
 * (由 scripts/three-system-e2e.mjs 按职责拆出;语句逐行原文搬运,仅跨模块引用/状态访问机械改写)
 *
 * 阶段顺序、断言调用顺序与退出码语义与原脚本一致;阶段内异常**不吞**(不设阶段级 try/catch),
 * 与原顶层线性脚本「异常即终止」的语义一致 —— 由入口薄壳统一兜底打印并 exit(1)。
 */
import { FULL, counters } from './lib.mjs'
import { getRunId } from './state.mjs'
import { run as phase0UserToken } from './phases/phase-0-user-token.mjs'
import { run as phase0a2LineAutoselect } from './phases/phase-0a2-line-autoselect.mjs'
import { run as phase0bFixtureGrants } from './phases/phase-0b-fixture-grants.mjs'
import { run as phase0cPluginOutboundAuth } from './phases/phase-0c-plugin-outbound-auth.mjs'
import { run as stage1Health } from './phases/stage-1-health.mjs'
import { run as stage2TeamsToolsHitl } from './phases/stage-2-teams-tools-hitl.mjs'
import { run as stage2_5TeamPlugins } from './phases/stage-2-5-team-plugins.mjs'
import { run as stage3Diag } from './phases/stage-3-diag.mjs'
import { run as stage4PluginToggle } from './phases/stage-4-plugin-toggle.mjs'

export async function main() {
  await phase0UserToken()
  await phase0a2LineAutoselect()
  await phase0bFixtureGrants()
  await phase0cPluginOutboundAuth()
  await stage1Health()
  await stage2TeamsToolsHitl()
  await stage2_5TeamPlugins()
  await stage3Diag()
  await stage4PluginToggle()

  // ══ 汇总 ══════════════════════════════════════════════════════════════════
  const { pass, fail, failures } = counters()
  console.log(`\n══ 结果:${pass} 通过 / ${fail} 失败 ══`)
  if (failures.length) {
    console.error('失败项:')
    for (const f of failures) console.error(`  - ${f}`)
  }
  if (!FULL && getRunId()) console.log(`\n提示:本次发起的诊断 runId=${getRunId()},完成可加 --full 重跑或调 diag_status 观察。`)
  process.exit(fail > 0 ? 1 : 0)
}
