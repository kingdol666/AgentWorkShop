/**
 * HITL 全局待办层单元测试(tsx 直跑):
 *   npx tsx scripts/test-hitl-registry.ts
 *
 * 覆盖:
 *  - hitl-registry:登记/快照/幂等/落定/per-channel 订阅/parkDeadline/resolver 补全
 *  - harness-terminal park 语义:零订阅 park(不再秒取消)/订阅暂停/退订重新计时/
 *    应答落定 answered/TTL 到期落定 expired 并写 cancelled 到 omp stdin
 *
 * TTL 经 AW_SECURITY_HITL_TIMEOUT_MS=250 注入(须在首次 settings 读取前设置)。
 */
import type { OmpRpcClient } from '../server/services/workshop/agents/adapters/omp-rpc-client'
import { securityHitlTimeoutMs } from '../server/services/workshop/settings'
import { getHitlRegistry } from '../server/services/workshop/agents/hitl-registry'
import {
  attachTerminalTap,
  respondTerminalUi,
  subscribeTerminal,
} from '../server/services/workshop/agents/harness-terminal'

process.env.AW_SECURITY_HITL_TIMEOUT_MS = '250'

let failures = 0
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` (${extra})` : ''}`)
  if (!cond) failures++
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

console.log('[hitl] park TTL =', securityHitlTimeoutMs(), 'ms')
const reg = getHitlRegistry()

// ===== 1. registry 基础 =====
console.log('[1] hitl-registry 基础语义')
const events: Array<{ type: string, channelId?: string }> = []
const unsub = reg.subscribe('ch-1', (e) => {
  events.push({ type: e.type, channelId: (e.payload as { channelId?: string }).channelId })
})
reg.register({ kind: 'omp-dialog', id: 'd1', agentId: 'a1', channelId: 'ch-1', agentName: 'lead', method: 'confirm', title: '确认下发?' })
check('登记后 snapshot 可见', reg.snapshot().length === 1 && reg.snapshot()[0]!.id === 'd1')
check('channel 订阅者收到 hitl.request', events.length === 1 && events[0]!.type === 'hitl.request')
reg.register({ kind: 'omp-dialog', id: 'd1', agentId: 'a1', channelId: 'ch-1', title: '重复登记' })
check('同 kind+id 幂等(不重复)', reg.snapshot().length === 1)
reg.register({ kind: 'dcw-approval', id: 'ap-x', agentId: 'a2', channelId: 'ch-2', title: 'DCW 下发审批' })
check('channelId 过滤生效', reg.snapshot('ch-2').length === 1 && reg.snapshot('ch-1').length === 1)
check('find 取回单条', reg.find('dcw-approval', 'ap-x')?.title === 'DCW 下发审批')
reg.setParkDeadline('omp-dialog', 'd1', '2026-01-01T00:00:00.000Z')
check('setParkDeadline 更新 expiresAt', reg.find('omp-dialog', 'd1')?.expiresAt === '2026-01-01T00:00:00.000Z')
check('resolve 落定并广播 hitl.resolved', reg.resolve('omp-dialog', 'd1', 'answered', 'user-1') && events[1]!.type === 'hitl.resolved')
check('落定后 snapshot 清空该条', reg.snapshot('ch-1').length === 0 && reg.find('omp-dialog', 'd1') === null)
check('重复 resolve 幂等返回 false', reg.resolve('omp-dialog', 'd1', 'answered') === false)
unsub()

// ===== 2. resolver 补全 =====
console.log('[2] resolver 补全 channelId/agentName')
reg.configureResolver(agentId => agentId === 'inst-9' ? { channelId: 'ch-9', agentName: '温控工' } : null)
reg.register({ kind: 'dcw-approval', id: 'ap-r', agentId: 'inst-9', title: 'DCW 下发审批' })
check('resolver 补全 channelId', reg.find('dcw-approval', 'ap-r')?.channelId === 'ch-9')
check('resolver 补全 agentName', reg.find('dcw-approval', 'ap-r')?.agentName === '温控工')
reg.resolve('dcw-approval', 'ap-r', 'cancelled')

// ===== 3. harness-terminal park 语义(假 omp 客户端) =====
console.log('[3] harness-terminal park 语义')
const written: Array<Record<string, unknown>> = []
const fakeClient = {
  onRawFrame(fn: (f: Record<string, unknown>) => void) {
    ;(fakeClient as unknown as { __emit: (f: Record<string, unknown>) => void }).__emit = fn
    return () => {}
  },
  async send() {},
  writeRaw(frame: Record<string, unknown>) { written.push(frame) },
} as unknown as OmpRpcClient

attachTerminalTap(fakeClient, { pid: 4242, harness: 'omp', agentId: 'agt-1', channelId: 'ch-1', name: '调度长', role: 'lead' })
const emit = (f: Record<string, unknown>) => (fakeClient as unknown as { __emit: (f: Record<string, unknown>) => void }).__emit(f)

emit({ type: 'extension_ui_request', id: 'dlg-1', method: 'confirm', title: '允许写入设定值?' })
await sleep(20)
check('零订阅到达 → park 而非秒取消(未写 cancelled 到 stdin)', !written.some(w => w.type === 'extension_ui_response'))
const parked = reg.find('omp-dialog', 'dlg-1')
check('登记进全局待办且带 park 截止', parked !== null && typeof parked?.expiresAt === 'string')

const unsubTerm = subscribeTerminal(4242, () => {})
await sleep(10)
check('订阅者接入 → 计时暂停(expiresAt=null)', reg.find('omp-dialog', 'dlg-1')?.expiresAt === null)

unsubTerm()
await sleep(10)
check('订阅者全部离开 → 重新计时(expiresAt 恢复未来时刻)', typeof reg.find('omp-dialog', 'dlg-1')?.expiresAt === 'string')

respondTerminalUi(4242, { id: 'dlg-1', confirmed: true })
await sleep(10)
check('应答写入 omp stdin(extension_ui_response confirmed)', written.some(w => w.type === 'extension_ui_response' && w.id === 'dlg-1' && w.confirmed === true))
check('应答后全局待办落定', reg.find('omp-dialog', 'dlg-1') === null)

// TTL 到期 → expired
emit({ type: 'extension_ui_request', id: 'dlg-2', method: 'select', title: '选择方案', options: ['A', 'B'] })
await sleep(20)
check('第二个对话框已 park', reg.find('omp-dialog', 'dlg-2') !== null)
await sleep(400)
check('park 超时 → 落定 expired 且全局待办清空', reg.find('omp-dialog', 'dlg-2') === null)
check('超时向 omp stdin 写 cancelled', written.some(w => w.type === 'extension_ui_response' && w.id === 'dlg-2' && w.cancelled === true))

// omp 主动撤销(method=cancel)→ 落定 cancelled
emit({ type: 'extension_ui_request', id: 'dlg-3', method: 'input', title: '补充说明' })
await sleep(20)
emit({ type: 'extension_ui_request', method: 'cancel', targetId: 'dlg-3' })
await sleep(20)
check('omp 撤销对话框 → 待办落定清空', reg.find('omp-dialog', 'dlg-3') === null)

console.log(failures === 0 ? '\n[hitl] 全部通过' : `\n[hitl] ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
