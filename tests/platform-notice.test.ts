/**
 * PlatformNotice 模块契约:接线/未接线双态、claim 先到先得、deliver 去重。
 * 真实投递(落库+唤醒)由 team-core-e2e 的 T11/T13 腿端到端覆盖。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  setPlatformNoticeSink,
  sendToolResult,
  claimToolResult,
  sendHitlNote,
  platformNoticeWired,
  platformNoticeKey,
  type PlatformNotice,
} from '../server/services/workshop/runtime/platform-notice'

describe('platform-notice 模块契约', () => {
  it('未接线:全部 no-op 返回 false,不抛错', () => {
    setPlatformNoticeSink(undefined as never)
    assert.equal(platformNoticeWired(), false)
    assert.equal(sendToolResult({ tool: 'aml_job', jobId: 'j1', agentId: 'a1', ok: true, title: 't', summary: 's' }), false)
    assert.equal(claimToolResult('aml_job', 'j1'), false)
    assert.equal(sendHitlNote({ agentId: 'a1', title: 't', summary: 's' }), false)
  })

  it('接线后:deliver 原子去重,claim 先到先得', () => {
    const delivered: PlatformNotice[] = []
    const claimed = new Set<string>()
    setPlatformNoticeSink({
      deliver(notice) {
        const key = platformNoticeKey(notice)
        if (claimed.has(key)) return false
        claimed.add(key)
        delivered.push(notice)
        return true
      },
      claim(tool, jobId) {
        const key = `${tool}:${jobId}`
        if (claimed.has(key)) return false
        claimed.add(key)
        return true
      },
    })
    assert.equal(platformNoticeWired(), true)
    // 首投成功;同键二投拒绝(去重)
    assert.equal(sendToolResult({ tool: 'aml_job', jobId: 'j9', agentId: 'a1', ok: true, title: '训练完成', summary: '门禁通过' }), true)
    assert.equal(sendToolResult({ tool: 'aml_job', jobId: 'j9', agentId: 'a1', ok: true, title: '训练完成', summary: '门禁通过' }), false)
    assert.equal(delivered.length, 1)
    // 轮询方先认领 → 事后 deliver 拒绝(不补发)
    assert.equal(claimToolResult('aml_job', 'j10'), true)
    assert.equal(sendToolResult({ tool: 'aml_job', jobId: 'j10', agentId: 'a1', ok: false, title: '失败', summary: 'e' }), false)
    // deliver 先占 → 轮询方 claim 返回 false(结果已由回执送达,轮询方只是正常展示)
    assert.equal(sendToolResult({ tool: 'aml_job', jobId: 'j11', agentId: 'a1', ok: true, title: '完成', summary: 's' }), true)
    assert.equal(claimToolResult('aml_job', 'j11'), false)
    // hitl-note 无 claim 语义,直接投递
    assert.equal(sendHitlNote({ agentId: 'a2', title: '重启对账', summary: '2 条失效' }), true)
    assert.equal(delivered.at(-1)?.kind, 'hitl-note')
  })

  it('sink 抛错被吞掉:调用方(作业收口路径)零负担', () => {
    setPlatformNoticeSink({
      deliver() {
        throw new Error('boom')
      },
      claim() {
        throw new Error('boom')
      },
    })
    assert.equal(sendToolResult({ tool: 't', jobId: 'j', agentId: 'a', ok: true, title: 't', summary: 's' }), false)
    assert.equal(claimToolResult('t', 'j'), false)
  })
})
