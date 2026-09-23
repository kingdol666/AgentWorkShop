/**
 * 主流程:按序执行各阶段并汇总
 * (由 scripts/e2e-full-closedloop.mjs 按职责拆出;内容逐行原文搬运)
 */
import { BASE, countFail, counters } from './lib.mjs'
import { TAG } from './state.mjs'
import { cleanup } from './cleanup.mjs'
import { s10_plugins, s11_data_root } from './scenarios-plugins.mjs'
import { s1_accounts, s2_model, s3_drivers } from './scenarios-accounts.mjs'
import { s4_daq, s5_frames, s6_dcw, s7_rollback } from './scenarios-daq-dcw.mjs'
import { s8_agent_authz, s9_bridge_authz } from './scenarios-authz.mjs'

// ════════════════════════════════════════════════════════════════
export async function main() {
  console.log(`\n════ AgentWorkShop 全链路 E2E @ ${BASE} (tag=${TAG}) ════`)
  // 就绪探测:用只读的 setup-status,不写任何数据(早先用 register 探测会抢走
  // "首个用户 = admin" 名额,导致后续 S1 拿到普通角色而全线 403)
  const health = await fetch(`${BASE}/api/users/setup-status`).catch(() => null)
  if (!health || !health.ok) {
    console.error(`✖ 目标服务不可达或未就绪: ${BASE}\n  请先启动: node scripts/start.mjs --port ${new URL(BASE).port}`)
    process.exit(1)
  }
  const st = await health.json().catch(() => ({}))
  console.log(`  · 服务就绪(needsSetup=${st?.data?.needsSetup ?? st?.needsSetup})`)

  const stages = [
    ['S1', s1_accounts],
    ['S2', s2_model],
    ['S3', s3_drivers],
    ['S4', s4_daq],
    ['S5', s5_frames],
    ['S6', s6_dcw],
    ['S7', s7_rollback],
    ['S8', s8_agent_authz],
    ['S9', s9_bridge_authz],
    ['S10', s10_plugins],
    ['S11', s11_data_root],
  ]
  for (const [id, fn] of stages) {
    try {
      await fn()
    }
    catch (err) {
      // 计数器在 lib.mjs 内私有(跨模块导出可变绑定会被 import/no-mutable-exports 拒绝)
      countFail(`${id} 阶段异常`)
      console.error(`  ✘ ${id} 阶段异常: ${err?.message ?? err}`)
    }
  }

  await cleanup()

  const { pass, fail, failures } = counters()
  console.log(`\n════ 结果: ${pass} PASS / ${fail} FAIL ════`)
  if (failures.length) {
    console.log('失败项:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(fail === 0 ? 0 : 1)
}
