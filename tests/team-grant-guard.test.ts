/**
 * F3 团队节点委派 grant 复核(单测):
 *  - 两个委派工具纳入复核集合,写族要求 operate、撤权只要求 readonly;
 *  - 权限矩阵:operate 全通过,readonly 仅满足只读动作,none 全拒;
 *  - 遗留无主 channel(owner NULL)豁免;非工业/豁免工具不拦截。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'

const { guardIndustrialToolGrant, grantNeedOf, grantAllowed, grantOwnerExempt, delegatedNodeIdsOf, TEAM_DELEGATION_TOOL_NAMES } = await import('../server/services/workshop/agents/industrial/grant-guard')

const identity = { agentId: 'ag-guard', channelId: 'ch-guard' }

after(() => {
  delete (globalThis as typeof globalThis & { __workshopManager?: unknown }).__workshopManager
})

describe('团队节点委派 grant 复核', () => {
  it('两个委派工具纳入复核,且 grant=operate / revoke=readonly', () => {
    assert.equal(TEAM_DELEGATION_TOOL_NAMES.has('team_grant_nodes'), true)
    assert.equal(TEAM_DELEGATION_TOOL_NAMES.has('team_revoke_nodes'), true)
    assert.equal(TEAM_DELEGATION_TOOL_NAMES.has('dispatch_task'), true)
    assert.equal(grantNeedOf('team_grant_nodes'), 'operate')
    assert.equal(grantNeedOf('team_revoke_nodes'), 'readonly')
  })

  it('委派参数解析:node_ids/nodeIds/grant_node_ids(数组或逗号串)', () => {
    assert.deepEqual(delegatedNodeIdsOf({ node_ids: ['dn-1', 'dn-2'] }), ['dn-1', 'dn-2'])
    assert.deepEqual(delegatedNodeIdsOf({ nodeIds: 'dn-1, dn-2' }), ['dn-1', 'dn-2'])
    assert.deepEqual(delegatedNodeIdsOf({ grant_node_ids: ['dn-3'] }), ['dn-3'])
    assert.deepEqual(delegatedNodeIdsOf({}), [])
  })

  it('node_ids 与 grant_node_ids 同时出现 → 并集(不得用 node_ids 遮蔽授权目标)', () => {
    assert.deepEqual(
      delegatedNodeIdsOf({ node_ids: ['dn-allowed'], grant_node_ids: ['dn-revoked'] }).sort(),
      ['dn-allowed', 'dn-revoked'],
    )
    assert.deepEqual(delegatedNodeIdsOf({ node_ids: [], grant_node_ids: ['dn-revoked'] }), ['dn-revoked'])
    // 非字符串标量也归一到字符串(handler 端会 String() 后授权,guard 不能漏解析)
    assert.deepEqual(delegatedNodeIdsOf({ grantNodeIds: 123 }), ['123'])
  })

  it('权限矩阵:operate 全通过;readonly 仅只读;none 全拒', () => {
    assert.equal(grantAllowed('operate', 'operate'), true)
    assert.equal(grantAllowed('operate', 'readonly'), true)
    assert.equal(grantAllowed('readonly', 'operate'), false)
    assert.equal(grantAllowed('readonly', 'readonly'), true)
    assert.equal(grantAllowed('none', 'operate'), false)
    assert.equal(grantAllowed('none', 'readonly'), false)
  })

  it('撤权后 grant 被拒 / revoke 不受影响(决策层)', () => {
    // 撤权 = lineMode 返回 none
    assert.equal(grantAllowed('none', grantNeedOf('team_grant_nodes')), false)
    assert.equal(grantAllowed('none', grantNeedOf('team_revoke_nodes')), false) // 无任何权限时撤权也拒(fail-closed)
    // only-readonly 场景:建授权表拒,撤权放行
    assert.equal(grantAllowed('readonly', grantNeedOf('team_grant_nodes')), false)
    assert.equal(grantAllowed('readonly', grantNeedOf('team_revoke_nodes')), true)
  })

  it('遗留无主 channel(owner NULL)→ 豁免不变', () => {
    assert.equal(grantOwnerExempt(null), true)
    assert.equal(grantOwnerExempt(undefined), true)
    assert.equal(grantOwnerExempt(''), true)
    assert.equal(grantOwnerExempt('u-owner'), false)
  })

  it('豁免工具/非工业工具 → 不进复核', async () => {
    assert.equal(await guardIndustrialToolGrant(identity, 'aml_activity', {}), null)
    assert.equal(await guardIndustrialToolGrant(identity, 'exp_collect', {}), null)
    assert.equal(await guardIndustrialToolGrant(identity, 'send_message_to_agent', {}), null)
  })
})
