/**
 * Prompt 外置化回归 — 验证 `.AgentWorkShop/prompts/` 加载与渲染完整性:
 *  R1. 全部必需 prompt 文件存在(12 md + host-tools.json)
 *  R2. renderPrompt 变量替换正确(值注入/缺省空串/空白容忍)
 *  R3. host-tools.json 可解析:20 个工具、字段完整、lead 专属集合覆盖
 *  R4. 渲染结果无残留 {{}} 占位(缺 var 检测)
 *  R5. 内容完整性:关键指令标记在各 prompt 中存在
 * 运行:pnpm exec tsx scripts/test-prompts-loader.ts
 */
import { renderPrompt, loadHostToolDefs, listPromptNames } from '../server/services/workshop/prompts/loader'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const REQUIRED = [
  'scenario-default', 'system-manual', 'worker-workflow', 'lead-supervise',
  'peer-message', 'peer-reply-required', 'peer-reply-optional', 'peer-lead-roster',
  'team-roster', 'mode-goal', 'mode-loop', 'mode-pipeline',
]

console.log('R1. 文件完整性')
const names = listPromptNames()
check('全部必需 md 存在', REQUIRED.every(r => names.includes(r)), `found=${names.length}: ${names.join(',')}`)

console.log('R2. 模板渲染')
const w = renderPrompt('worker-workflow', { agentName: 'w1', channelId: 'c1', taskId: 't1', taskText: '写发布说明' })
check('变量注入', w.includes('"w1"') && w.includes('c1') && w.includes('t1') && w.includes('写发布说明'))
check('无残留占位', !/\{\{/.test(w))
const partial = renderPrompt('peer-message', { fromId: 'x' })
check('缺省变量 → 空串(不残留)', !/\{\{/.test(partial) && partial.includes('from: x'))

console.log('R3. host-tools.json')
const tools = loadHostToolDefs()
check('20 个工具', tools.length === 20, `count=${tools.length}`)
check('字段完整', tools.every(t => t.name && t.description && t.parameters && typeof t.parameters === 'object'))
const LEAD_ONLY = ['dispatch_task', 'get_queue_overview', 'read_channel_mail', 'reassign_task', 'update_task', 'create_team_agent', 'update_team_agent', 'remove_team_agent']
check('lead 专属工具全部在列', LEAD_ONLY.every(n => tools.some(t => t.name === n)))

console.log('R4. 关键内容标记')
check('scenario-default 含通用作业规范', renderPrompt('scenario-default').includes('General operating rules'))
check('system-manual 含平台机制', renderPrompt('system-manual').includes('Task lifecycle') && renderPrompt('system-manual').includes('Anti-duplicate'))
check('lead-supervise 含协调纪律', renderPrompt('lead-supervise').includes('COORDINATOR'))
check('team-roster 名册含通信规范', renderPrompt('team-roster', { rosterLines: '- id: a1 | w1 | role=worker' }).includes('role=worker') && renderPrompt('team-roster', { rosterLines: 'x' }).includes('wait_seconds'))
check('mode-goal 含结语要求', renderPrompt('mode-goal', { criteria: 'X' }).includes('FINAL CONCLUSION') && renderPrompt('mode-goal', { criteria: 'X' }).includes('X'))
check('mode-loop 间隔注入', renderPrompt('mode-loop', { interval: 5 }).includes('every 5s'))

console.log(failures === 0 ? '\n★ prompt 外置化回归通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
