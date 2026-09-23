/**
 * 群聊/权限/HITL 单测编排入口:按原文顺序依次 await 各分节场景,再做汇总与收尾。
 *
 * 由 scripts/test-group-chat-unit.ts 拆分而来(原文第 739–749 行为汇总/收尾段)。
 * 各段之间通过 ctx 共享 manager / db / 用户 id,顺序即原文顶层顺序,不得调换。
 */
import { assertion, createGroupChatTestContext } from './lib'
import { runSectionA } from './section-a-migration'
import { runSectionB } from './section-b-permission-matrix'
import { runSectionC } from './section-c-member-lifecycle'
import { runSectionD } from './section-d-mention-resolution'
import { runSectionE } from './section-e-chat-facts'
import { runSectionF } from './section-f-user-notifications'
import { runSectionG } from './section-g-member-projection'
import { runSectionH } from './section-h-outbox-consistency'
import { runSectionI } from './section-i-read-idempotency'
import { runSectionJ } from './section-j-permission-scope'

export async function runGroupChatUnitSuite(): Promise<void> {
  const ctx = createGroupChatTestContext()

  await runSectionA(ctx)
  await runSectionB(ctx)
  await runSectionC(ctx)
  await runSectionD(ctx)
  await runSectionE(ctx)
  await runSectionF(ctx)
  await runSectionG(ctx)
  await runSectionH(ctx)
  await runSectionI(ctx)
  await runSectionJ(ctx)

  // ============================================================================
  console.log(`\n${'='.repeat(64)}`)
  console.log(`群聊/权限单测结果:  PASS=${assertion.passed}  FAIL=${assertion.failures.length}`)
  if (assertion.failures.length > 0) {
    console.log('失败项:')
    for (const f of assertion.failures) console.log(`  - ${f}`)
  }
  console.log('='.repeat(64))
  const { manager, db } = ctx
  await manager.shutdown()
  db.close()
  process.exit(assertion.failures.length > 0 ? 1 : 0)
}
