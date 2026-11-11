/**
 * HITL 桥应答映射纯函数契约(计划 H14,2026-11-11)。
 *
 * 背景:7 家 HITL 桥中 dsh/hermes(ACP 权限)是逐字重复的两段内联逻辑,codex(opencode)
 * 的决策/枚举映射内联在 respondHitl 里 —— 应答协议零 adapter 级测试,映射错误只会在
 * 真实引擎挂起时暴露。本文件把三族应答映射抽成纯函数并锁定:
 *  - resolveAcpPermissionReply:ACP 权限选项 → respond/respondError(fail-closed,
 *    取消绝不等于同意;无 allow 选项时 4012 不得回退成拒绝选项静默放行);
 *  - resolveCodexDecision:显式枚举 > 布尔,cancel 优先于一切;
 *  - assertOpenCodePermissionResponse / resolveOpenCodeNativeResponse:未知枚举不得
 *    回落 once(allow);缺省(无 response 无 confirmed)fail-closed 到 reject。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const {
  resolveAcpPermissionReply,
  resolveCodexDecision,
  assertOpenCodePermissionResponse,
  resolveOpenCodeNativeResponse,
} = await import('../server/services/workshop/agents/acp-hitl-mapping.ts')

const opts = (...kinds: string[]) => kinds.map((kind, i) => ({ optionId: `opt-${i}`, kind, name: kind }))

describe('resolveAcpPermissionReply(dsh/hermes 共享 ACP 权限映射)', () => {
  it('cancelled 优先于一切:绝不等价于同意/拒绝选项', () => {
    const r = resolveAcpPermissionReply(opts('allow_once', 'reject_once'), { cancelled: true })
    assert.deepEqual(r, { action: 'respond', payload: { outcome: { outcome: 'cancelled' } } })
  })
  it('confirmed:选第一个 allow 语义选项(kind 前缀)', () => {
    const r = resolveAcpPermissionReply(opts('reject_once', 'allow_once'), { confirmed: true })
    assert.deepEqual(r, { action: 'respond', payload: { outcome: { outcome: 'selected', optionId: 'opt-1' } } })
  })
  it('confirmed:kind 缺失时按 name 含 allow 匹配', () => {
    const r = resolveAcpPermissionReply([{ optionId: 'a', name: 'Allow once' }], { confirmed: true })
    assert.deepEqual(r, { action: 'respond', payload: { outcome: { outcome: 'selected', optionId: 'a' } } })
  })
  it('confirmed 但无 allow 选项:respondError -32602(绝不静默改派 reject)', () => {
    const r = resolveAcpPermissionReply(opts('reject_once'), { confirmed: true })
    assert.deepEqual(r, { action: 'respondError', code: -32602, message: '无可用 allow 选项' })
  })
  it('拒绝(非 confirmed 非 cancelled):选 reject/deny 语义选项', () => {
    const r = resolveAcpPermissionReply(opts('allow_once', 'deny'), {})
    assert.deepEqual(r, { action: 'respond', payload: { outcome: { outcome: 'selected', optionId: 'opt-1' } } })
  })
  it('拒绝但无 reject 选项:respondError -32602 已拒绝(不回退 allow)', () => {
    const r = resolveAcpPermissionReply(opts('allow_once'), {})
    assert.deepEqual(r, { action: 'respondError', code: -32602, message: '已拒绝' })
  })
})

describe('resolveCodexDecision(显式枚举 > 布尔;cancel 优先)', () => {
  it('cancel 响应/cancelled 布尔都 → cancel', () => {
    assert.equal(resolveCodexDecision({ cancelled: true }), 'cancel')
    assert.equal(resolveCodexDecision({ response: 'cancel', confirmed: true }), 'cancel')
  })
  it('显式 accept/decline 原样透传', () => {
    assert.equal(resolveCodexDecision({ response: 'accept' }), 'accept')
    assert.equal(resolveCodexDecision({ response: 'decline' }), 'decline')
  })
  it('无枚举时按 confirmed 布尔(缺省 decline,fail-closed)', () => {
    assert.equal(resolveCodexDecision({ confirmed: true }), 'accept')
    assert.equal(resolveCodexDecision({}), 'decline')
  })
})

describe('opencode permission 应答(未知枚举不回落 once)', () => {
  it('非空未知枚举抛错(在传导层兜一道,防决策服务被绕过)', () => {
    assert.throws(() => assertOpenCodePermissionResponse('always-until-restart' as never), /未知 permission 应答枚举/)
    assert.doesNotThrow(() => assertOpenCodePermissionResponse(undefined))
    assert.doesNotThrow(() => assertOpenCodePermissionResponse('once'))
    assert.doesNotThrow(() => assertOpenCodePermissionResponse('always'))
    assert.doesNotThrow(() => assertOpenCodePermissionResponse('reject'))
  })
  it('native 映射:cancelled/reject → reject;always → always;显式 once/confirmed → once', () => {
    assert.equal(resolveOpenCodeNativeResponse({ cancelled: true }), 'reject')
    assert.equal(resolveOpenCodeNativeResponse({ response: 'reject' }), 'reject')
    assert.equal(resolveOpenCodeNativeResponse({ response: 'always' }), 'always')
    assert.equal(resolveOpenCodeNativeResponse({ response: 'once' }), 'once')
    assert.equal(resolveOpenCodeNativeResponse({ confirmed: true }), 'once')
  })
  it('缺省 fail-closed:无 response 无 confirmed → reject(绝不缺省放行)', () => {
    assert.equal(resolveOpenCodeNativeResponse({}), 'reject')
    assert.equal(resolveOpenCodeNativeResponse({ cancelled: false }), 'reject')
  })
})
