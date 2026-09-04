/**
 * TUI 归约器单元测试(node 直跑,无服务依赖):
 *   node scripts/test-tui-reducers.mjs
 *
 * 覆盖 AEP 帧 → 会话状态:delta 聚合定稿去重/消息归属/task 状态/hitl 增删/
 * 跨频道标记/终端帧归约(monitor 行)。
 */
import { createState, withLog } from '../tui/lib/state.mjs'
import { reduceEnvelope, reduceTermFrame } from '../tui/lib/reducers.mjs'

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` (${extra})` : ''}`)
  if (!cond) failures++
}

function fresh() {
  const store = createState()
  const state = withLog(store.state)
  state.agents = [{ id: 'agt-1', name: '调度长', role: 'lead', harness: 'omp', enabled: 1 }]
  return { store, state }
}

const env = (type, payload, extra = {}) => ({ v: 1, type, seq: 1, at: '', channelId: 'ch-1', ...extra, payload })

// ── agent.delta 聚合 + agent.message 定稿 ──
console.log('[1] 流式聚合')
let { state } = fresh()
reduceEnvelope(state, env('agent.delta', { delta: '你' }, { agentId: 'agt-1', taskId: 't1' }))
reduceEnvelope(state, env('agent.delta', { delta: '好' }, { agentId: 'agt-1', taskId: 't1' }))
check('delta 聚合进同一流式块', state.log.filter(r => r.kind === 'stream').length === 1 && state.log.at(-1).text === '你好')
reduceEnvelope(state, env('agent.delta', { delta: '!' }, { agentId: 'agt-2', taskId: 't1' }))
check('不同 agent 不粘连(独立块)', state.log.filter(r => r.kind === 'stream').length === 2)
reduceEnvelope(state, env('agent.message', { parts: [{ text: '你好,完整消息' }], metadata: {} }, { agentId: 'agt-1', taskId: 't1' }))
check('message 定稿升级为 agent 行', state.log.filter(r => r.kind === 'agent').length === 1 && state.log.filter(r => r.kind === 'stream').length === 1)
check('定稿文本为全文', state.log.find(r => r.kind === 'agent' && r.agentId === 'agt-1').text === '你好,完整消息')

// ── a2a.message:人类回显/跨频道 ──
console.log('[2] 消息投递')
;({ state } = fresh())
reduceEnvelope(state, env('a2a.message', { parts: [{ text: '帮我查产线状态' }], metadata: { 'x-aw-from-label': '张伟' } }))
check('人类消息渲染 user 行', state.log.at(-1).kind === 'user' && state.log.at(-1).text.includes('产线状态'))
reduceEnvelope(state, env('a2a.message', { parts: [{ text: '外部指令' }], metadata: { 'x-aw-cross-channel': 'true', 'x-aw-from-label': '母舰' } }))
check('跨频道消息带标记', state.log.at(-1).text.startsWith('[跨频道]'))

// ── task/hitl ──
console.log('[3] 任务与 HITL')
;({ state } = fresh())
reduceEnvelope(state, env('task.status', { taskId: 'tk-1', state: 'WORKING', title: '调参', progress: 30 }))
check('task.status 入列表且渲染任务行', state.tasks.length === 1 && state.log.at(-1).kind === 'task')
reduceEnvelope(state, env('task.progress', { taskId: 'tk-1', progress: 80 }))
check('task.progress 更新同条', state.tasks[0].progress === 80)
reduceEnvelope(state, env('hitl.request', { kind: 'omp-dialog', id: 'd1', channelId: 'ch-1', agentId: 'agt-1', agentName: '调度长', method: 'confirm', title: '确认下发?' }))
check('hitl.request 入待办并渲染提醒行', state.hitl.length === 1 && state.log.at(-1).kind === 'hitl')
reduceEnvelope(state, env('hitl.request', { kind: 'omp-dialog', id: 'd1', channelId: 'ch-1', agentId: 'agt-1', agentName: '调度长', method: 'confirm', title: '确认下发?(更新)' }))
check('hitl 幂等 upsert', state.hitl.length === 1 && state.hitl[0].title.includes('更新'))
reduceEnvelope(state, env('hitl.resolved', { kind: 'omp-dialog', id: 'd1', channelId: 'ch-1', agentId: 'agt-1', outcome: 'answered' }))
check('hitl.resolved 清空待办', state.hitl.length === 0 && state.log.at(-1).kind === 'hitl-resolved')

// ── 终端帧归约 ──
console.log('[4] 终端帧(monitor 行)')
const r1 = reduceTermFrame({ type: 'tool_execution_start', toolName: 'dcw_control', args: { node_id: 'n1', value: 182 } })
check('工具开始帧 → info 行', r1.lines.length === 1 && r1.lines[0].tone === 'info')
const r2 = reduceTermFrame({ type: 'extension_ui_request', method: 'select', title: '选择方案' })
check('HITL 帧 → warn 行', r2.lines[0].tone === 'warn' && r2.lines[0].text.includes('/hitl'))
const r3 = reduceTermFrame({ type: 'extension_ui_request', method: 'cancel', targetId: 'x' })
check('cancel 帧不产生行', r3.lines.length === 0)
const r4 = reduceTermFrame({ type: '__terminal_notice', level: 'warning', message: '观看者离开' })
check('notice 帧 → warn 行', r4.lines[0].tone === 'warn')

console.log(failures === 0 ? '\n[reducers] 全部通过' : `\n[reducers] ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
