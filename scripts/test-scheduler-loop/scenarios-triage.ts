/**
 * 场景 1–2:默认 simple/complex triage —— lead 直答收口,complex 派 worker 后用真实 artifact 验收。
 */
import { check, RecordingMockLeadImpl, setup, submitTask, teardown, waitUntil } from './lib'

export async function testSimpleTriage(): Promise<void> {
  console.log('\n--- 1. 默认 simple triage 由 MockAgentImpl lead 完成并产出 artifact ---')
  const leadImpl = new RecordingMockLeadImpl({ delayMs: 0 })
  const s = setup({ tickMs: 10, leadImpl })
  s.loop.start()
  const parent = submitTask(s, '简单主任务', '[mock:simple] answer directly without delegation')

  const completed = await waitUntil(() => s.engine.get(parent.id)?.state === 'COMPLETED')
  const finalTask = s.engine.get(parent.id)
  const record = leadImpl.records.find(item => item.snapshot.tasks.some(task => task.id === parent.id))
  check('MockAgentImpl.supervise 收到默认模式 root task', !!record)
  check(
    'lead 显式 complete 并产出 lead-direct-answer',
    record?.decisions?.some(decision => decision.kind === 'complete'
      && decision.taskId === parent.id
      && decision.artifacts?.some(artifact => artifact.name === 'lead-direct-answer')) === true,
  )
  check('simple task 完成并保留 lead artifact', completed && finalTask?.artifacts.some(a => a.name === 'lead-direct-answer'))
  check('simple task 不创建 child', !s.engine.list(s.channelId).some(task => task.parentId === parent.id))

  await teardown(s)
}

export async function testComplexTriageRequiresLeadCloseout(): Promise<void> {
  console.log('\n--- 2. 默认 complex triage 最多派两个 worker,lead 用真实 artifact 验收 ---')
  const leadImpl = new RecordingMockLeadImpl({ delayMs: 0 })
  const s = setup({ tickMs: 10, workerCount: 2, leadImpl })
  s.loop.start()
  const parent = submitTask(s, '复杂主任务', '[mock:complex] delegate independent analysis and verification')

  const childrenCreated = await waitUntil(() =>
    s.engine.list(s.channelId).filter(task => task.parentId === parent.id).length === 2,
  )
  const children = s.engine.list(s.channelId).filter(task => task.parentId === parent.id)
  const dispatchRecord = leadImpl.records.find(record =>
    record.snapshot.tasks.some(task => task.id === parent.id && task.state === 'SUBMITTED')
    && record.decisions?.some(decision => decision.kind === 'dispatch' && decision.parentTaskId === parent.id),
  )
  const dispatched = dispatchRecord?.decisions?.filter(decision =>
    decision.kind === 'dispatch' && decision.parentTaskId === parent.id,
  ) ?? []
  check('默认 complex root 由 MockAgentImpl.supervise triage', !!dispatchRecord)
  check(
    'lead 派给最多两个可用 worker',
    childrenCreated && dispatched.length === 2
    && new Set(dispatched.map(decision => decision.kind === 'dispatch' ? decision.assigneeId : '')).size === 2
    && dispatched.every(decision => decision.kind === 'dispatch' && s.workers.some(worker => worker.agentId === decision.assigneeId)),
    `children=${children.length} dispatches=${dispatched.length}`,
  )

  const childrenCompleted = await waitUntil(() => children.length === 2
    && children.every(child => s.engine.get(child.id)?.state === 'COMPLETED'))
  const reviewRecordReady = await waitUntil(() => leadImpl.records.some((record) => {
    const tasks = record.snapshot.tasks
    const allChildrenCompleted = children.length === 2 && children.every(child =>
      tasks.some(task => task.id === child.id && task.state === 'COMPLETED'),
    )
    return allChildrenCompleted && record.decisions?.some(decision =>
      decision.kind === 'complete' && decision.taskId === parent.id
      && decision.artifacts?.some(artifact => artifact.name === 'lead-acceptance-summary'),
    ) === true
  }))
  const reviewRecord = leadImpl.records.find((record) => {
    const tasks = record.snapshot.tasks
    return children.length === 2
      && children.every(child => tasks.some(task => task.id === child.id && task.state === 'COMPLETED'))
      && record.decisions?.some(decision => decision.kind === 'complete' && decision.taskId === parent.id) === true
  })
  const reviewTasks = reviewRecord?.snapshot.tasks ?? []
  const artifactsVisible = children.length === 2 && children.every((child) => {
    const actual = s.engine.get(child.id)
    const observed = reviewTasks.find(task => task.id === child.id)
    return actual?.artifacts.some(artifact => artifact.name !== 'input'
      && observed?.artifacts.some(snapshotArtifact => snapshotArtifact.artifactId === artifact.artifactId)) === true
  })
  const parentAtReview = reviewTasks.find(task => task.id === parent.id)
  const acceptance = reviewRecord?.decisions?.find(decision =>
    decision.kind === 'complete' && decision.taskId === parent.id,
  )
  const acceptedSummary = acceptance?.kind === 'complete'
    ? acceptance.artifacts?.find(artifact => artifact.name === 'lead-acceptance-summary')
    : undefined

  check('所有 child 均实际完成并有交付物', childrenCompleted && children.every(child => !!s.engine.get(child.id)?.artifacts.length))
  check('child 完成时 parent 仍待 lead 验收', !!parentAtReview && !['COMPLETED', 'FAILED', 'CANCELED'].includes(parentAtReview.state), `state=${parentAtReview?.state}`)
  check('后续 supervise snapshot 可见真实 child artifact', reviewRecordReady && artifactsVisible)
  check('lead 显式返回 lead-acceptance-summary 再 complete', !!acceptedSummary)
  check(
    'lead 验收摘要落到已完成 parent',
    s.engine.get(parent.id)?.state === 'COMPLETED'
    && !!acceptedSummary
    && s.engine.get(parent.id)?.artifacts.some(artifact => artifact.artifactId === acceptedSummary.artifactId),
    `state=${s.engine.get(parent.id)?.state}`,
  )

  await teardown(s)
}
