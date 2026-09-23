/**
 * 固定场景顺序入口:12 个场景按原顺序串行 await,最后打印 ALL PASS / N FAILED 并决定退出码。
 */
import { failureCount } from './lib'
import { testComplexTriageRequiresLeadCloseout, testSimpleTriage } from './scenarios-triage'
import {
  testBusyStallWatchdogDoesNotCancel,
  testLeadRetriesAfterEmptyDecision,
  testRetryKeepsParentAlive,
  testSuperviseEmptyDoesNotFallback,
  testSuperviseThrowDoesNotFallback,
  testWakeTriggersRound,
} from './scenarios-supervise'
import { testGoalModeRemainsLeadJudged, testLoopIntervalAndMaxIterations, testPipelineModeRemainsOrdered } from './scenarios-modes'
import { testFactory, testStopStopsScheduling } from './scenarios-runtime'

export async function main(): Promise<void> {
  await testSimpleTriage()
  await testComplexTriageRequiresLeadCloseout()
  await testWakeTriggersRound()
  await testSuperviseEmptyDoesNotFallback()
  await testLeadRetriesAfterEmptyDecision()
  await testSuperviseThrowDoesNotFallback()
  await testRetryKeepsParentAlive()
  await testBusyStallWatchdogDoesNotCancel()
  await testGoalModeRemainsLeadJudged()
  await testPipelineModeRemainsOrdered()
  await testStopStopsScheduling()
  await testLoopIntervalAndMaxIterations()
  testFactory()

  const failures = failureCount()
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
