import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HIGH_RISK_TOOL_NAMES,
  MANAGEMENT_TOOL_NAMES,
  checkToolAgainstScope,
} from '../server/services/workshop/runtime/permission-scope'
import { HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES } from '../server/services/workshop/agents/tool-classes'

test('high-risk tool set keeps the full expected membership (conscious-change guard)', () => {
  assert.deepEqual(
    [...HIGH_RISK_TOOL_NAMES].sort(),
    [
      'aml_dataset_build',
      'aml_job_cancel',
      'aml_job_submit',
      'aml_model_promote',
      'dcw_control',
      'dcw_rollback',
      'param_control',
      'recipe_apply',
      'recipe_rollback',
      'recipe_trial',
      'recipe_update',
    ],
  )
})

test('every hybrid-twin direct-write tool is scope-gated as high risk (single declaration source)', () => {
  for (const tool of HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES) {
    assert.ok(HIGH_RISK_TOOL_NAMES.has(tool), `直接写工具 ${tool} 未纳入高危清单`)
  }
})

test('scope gate: high-risk tools need explicit grant; no scope or grant passes', () => {
  const scope = { requesterUserId: 'u1' } as Parameters<typeof checkToolAgainstScope>[0]
  const v = checkToolAgainstScope(scope, 'param_control')
  assert.equal(v.allowed, false)
  if (!v.allowed) assert.equal(v.reason, 'HIGH_RISK_TOOL_DENIED')
  assert.equal(checkToolAgainstScope(null, 'param_control').allowed, true)
  assert.equal(
    checkToolAgainstScope({ requesterUserId: 'u1', canUseHighRiskTools: true } as Parameters<typeof checkToolAgainstScope>[0], 'param_control').allowed,
    true,
  )
})

test('scope gate: management tools follow the lead-only set', () => {
  for (const tool of MANAGEMENT_TOOL_NAMES) {
    const v = checkToolAgainstScope({ requesterUserId: 'u1' } as Parameters<typeof checkToolAgainstScope>[0], tool)
    assert.equal(v.allowed, false)
  }
})
