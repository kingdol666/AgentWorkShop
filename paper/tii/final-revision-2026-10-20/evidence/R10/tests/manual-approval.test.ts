import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-manual-approval-test-'))
delete process.env.AW_BENCH_MODE

const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
const { getToolApprovals } = await import('../server/services/workshop/agents/tool-approvals')
const { requestManualApproval } = await import('../server/services/workshop/agents/industrial/manual-approval')

// requestManualApproval 内部会 approvals.request 挂起等裁决;辅助:让它先登记,再代为裁决
async function settle(fn: () => Promise<unknown>, approved: boolean, comment: string): Promise<void> {
  const p = fn()
  await new Promise(r => setTimeout(r, 25))
  const approvals = getToolApprovals()
  const pend = approvals.listPending()
  assert.ok(pend.length > 0, '应有一条挂起审批')
  approvals.decide(pend[0]!.id, approved, comment)
  await p
}

// 审批/设置链持有未 unref 的模块级句柄:测试以 --test-force-exit 运行(test:unit 脚本)
// 强制收尾;勿在此用 process.exit —— 它会在 node:test 调度完后续用例前提前终止进程。

test('manual approval: pending dedup refuses a second request for the same node', async () => {
  const repo = getAgentNodeBindingRepo()
  const approvals = getToolApprovals()
  repo.bind('ag-a', 'dw-x', 'dcw', 'manual')
  approvals.request('ag-a', 'dw-x', 'dcw', '第一条')
  const r = await requestManualApproval({ agentId: 'ag-a', nodeId: 'dw-x', detail: '第二条' })
  assert.equal(r.ok, false)
  assert.equal((r as { isError?: boolean }).isError, true)
  assert.match((r as { text: string }).text, /待审批的下发指令/)
  approvals.decide(approvals.listPending('ag-a')[0]!.id, true, '')
})

test('manual approval: deny path returns non-error text with user comment', async () => {
  const repo = getAgentNodeBindingRepo()
  repo.bind('ag-b', 'dw-y', 'dcw', 'manual')
  let text = ''
  await settle(() => requestManualApproval({ agentId: 'ag-b', nodeId: 'dw-y', detail: '待裁决' }).then((r) => {
    text = (r as { ok: false, text: string }).text
    return r
  }), false, '不同意')
  assert.match(text, /指令未执行:用户拒绝了本次下发。用户备注:不同意/)
})

test('manual approval: approve then unbind = permission expired at grant time', async () => {
  const repo = getAgentNodeBindingRepo()
  repo.bind('ag-c', 'dw-z', 'dcw', 'manual')
  let text = ''
  await new Promise<void>((resolve) => {
    const p = requestManualApproval({ agentId: 'ag-c', nodeId: 'dw-z', detail: '待批准' })
    setTimeout(() => {
      const approvals = getToolApprovals()
      const pend = approvals.listPending()
      assert.ok(pend.length > 0)
      repo.removeAgentNode('ag-c', 'dw-z', 'dcw')
      approvals.decide(pend[0]!.id, true, '')
      void p.then((r) => {
        text = (r as { ok: false, text: string }).text
        resolve()
      })
    }, 25)
  })
  assert.match(text, /审批通过时你的该节点绑定已被解除/)
})

test('manual approval: approve path passes and rollback wording uses its own verbs', async () => {
  const repo = getAgentNodeBindingRepo()
  const approvals = getToolApprovals()
  repo.bind('ag-d', 'dw-w', 'dcw', 'manual')
  const ok = await (async () => {
    const p = requestManualApproval({ agentId: 'ag-d', nodeId: 'dw-w', detail: '待批准' })
    await new Promise(r => setTimeout(r, 25))
    approvals.decide(approvals.listPending()[0]!.id, true, '')
    return p
  })()
  assert.deepEqual(ok, { ok: true, comment: '' })

  // 回退口径:拒绝文案用「回退未执行/拒绝了本次回退」,去重文案用回退专属措辞
  repo.bind('ag-e', 'dw-v', 'dcw', 'manual')
  let denyText = ''
  await new Promise<void>((resolve) => {
    const p = requestManualApproval({ agentId: 'ag-e', nodeId: 'dw-v', detail: '待裁决', action: '回退' })
    setTimeout(() => {
      approvals.decide(approvals.listPending()[0]!.id, false, '先观察')
      void p.then((r) => {
        denyText = (r as { ok: false, text: string }).text
        resolve()
      })
    }, 25)
  })
  assert.match(denyText, /回退未执行:用户拒绝了本次回退。用户备注:先观察/)

  approvals.request('ag-e', 'dw-v', 'dcw', '挂起占位')
  const dedupDenied = await requestManualApproval({ agentId: 'ag-e', nodeId: 'dw-v', detail: 'x', action: '回退' })
  assert.match((dedupDenied as { text: string }).text, /待审批指令,请等待用户处理后再发新的回退请求/)
  approvals.decide(approvals.listPending('ag-e')[0]!.id, true, '')
})
