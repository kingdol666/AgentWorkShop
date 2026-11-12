/**
 * 项目审批摘要(第二轮 E10)。
 * 审批历史此前直接截取 payloadJson 前 140 字符,用户看到的是
 * `{"deliverables":[{"id":"13a3…","status":"approved"}]…`。
 * 这里按审批类型抽出人话;坏 JSON/未知类型返回空串,组件回退到类型名。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalSummary } from '../app/utils/project-approval'

test('计划审批:目标 + 交付物数', () => {
  const payload = JSON.stringify({
    goal: '验证项目页与执行 Channel 的运行期交互',
    deliverables: [{ name: '熔温趋势分析报告', channel: 'e2cb6b43' }],
  })
  const s = approvalSummary('plan_approval', payload)
  assert.match(s, /验证项目页与执行 Channel 的运行期交互/)
  assert.match(s, /1 项交付物/)
  assert.equal(s.includes('{'), false)
})

test('计划审批兼容 plan 嵌套体', () => {
  const payload = JSON.stringify({ version: 1, plan: { goal: '双层嵌套目标', deliverables: [] } })
  assert.match(approvalSummary('plan_approval', payload), /双层嵌套目标/)
})

test('交付物验收:名称优先,缺失时用短 id', () => {
  assert.match(
    approvalSummary('deliverable_acceptance', JSON.stringify({ deliverableId: '13a3699d-5dc5-4099', deliverableName: '熔温趋势分析报告', version: 1 })),
    /熔温趋势分析报告/,
  )
  const fallback = approvalSummary('deliverable_acceptance', JSON.stringify({ deliverableId: '13a3699d-5dc5-4099', version: 1 }))
  assert.match(fallback, /13a3699d/)
})

test('成果验收与项目完成', () => {
  assert.match(
    approvalSummary('result_acceptance', JSON.stringify({ resultId: '7c4fa389-b804-4a5c', resultTitle: '熔温趋势结论', version: 1 })),
    /熔温趋势结论/,
  )
  assert.match(
    approvalSummary('project_complete', JSON.stringify({ workItemCount: 3, completedWorkItems: 3 }), { deliverables: [], results: [] }),
    /3/,
  )
})

test('生产写授权取 tool 与参数摘要', () => {
  const p = JSON.stringify({ tool: 'dcw_write', args: { nodeId: 'dw-1f85b', value: 230 }, digest: 'abc123' })
  const s = approvalSummary('write_intent', p)
  assert.match(s, /dcw_write/)
  assert.match(s, /dw-1f85b/)
  assert.equal(s.includes('{'), false)
})

test('频道绑定取频道 id 短码', () => {
  const s = approvalSummary('channel_binding', JSON.stringify({ channelId: 'e2cb6b43-b1f5-4a7a' }))
  assert.match(s, /e2cb6b43/)
})

test('deliverable_acceptance 载荷指向 result 时按成果呈现', () => {
  const s = approvalSummary('deliverable_acceptance', JSON.stringify({ resultId: '7c4fa389-b804', version: 1 }))
  assert.match(s, /^成果:/)
})

test('坏 JSON/未知类型不外露原始载荷', () => {
  assert.equal(approvalSummary('plan_approval', '{broken'), '')
  assert.equal(approvalSummary('mystery', JSON.stringify({ secret: 'x' })), '')
  assert.equal(approvalSummary('plan_approval', undefined), '')
})
