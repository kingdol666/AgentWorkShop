/**
 * TUI 无头 e2e(虚拟终端驱动真实 TUI ↔ 真实 dev server):
 *   node scripts/tui-smoke.mjs [--base http://127.0.0.1:3000]
 *
 * 覆盖:认证引导(--token)→ 频道自动接入 → /channels → /channel new(创建+切换)
 * → /agents → 普通文本发送(服务端回显) → /hitl → 清理 → /quit。
 * 建的 tui-smoke-* 频道在退出前清理(?purge=1 级联删除)。
 */
import { createApi } from '../tui/lib/api.mjs'

const base = (() => {
  const i = process.argv.indexOf('--base')
  return i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:3000'
})()

const api = createApi({ baseUrl: base })
let token = process.env.AW_E2E_TOKEN
if (!token) {
  const { AW_TUI_EMAIL: email, AW_TUI_PASSWORD: password } = process.env
  if (!email || !password) throw new Error('Supply AW_E2E_TOKEN or AW_TUI_EMAIL and AW_TUI_PASSWORD for the isolated instance')
  token = (await api.login(email, password)).token
}
if (!token) throw new Error('TUI smoke authentication failed')
api.setToken(token)

let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`)
  if (!cond) failures++
}

// ── 启动 TUI(headless;--token 免交互;--channel 空 = 自动选第一个频道) ──
const { main } = await import('../tui/aw-tui.mjs')
const { closed } = await main(['--headless', '--url', base, '--token', token, '--channel', ''])
const vt = globalThis.__tuiSmokeTerminal
check('虚拟终端句柄就绪', Boolean(vt))

const waitText = async (needle, timeoutMs = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (vt.text().includes(needle)) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}
const type = async (text) => {
  for (const ch of text) vt.emitInput(ch)
  await new Promise(r => setTimeout(r, 40))
  vt.emitInput('\r')
  await new Promise(r => setTimeout(r, 500))
}

check('TUI 启动就绪横幅', await waitText('TUI 已就绪'))
// 启动频道选择器(新交互):有频道 → Esc 自动进第一个;空账户 → 提示创建
if (await waitText('选择要进入的频道', 8000)) {
  vt.emitInput('\x1b')
  check('启动自动接入首个频道', await waitText('已切换到频道「', 12_000))
}
else {
  check('空账户提示创建频道', await waitText('尚无频道', 12_000))
}

await type('/channels')
check('/channels 列出频道(计数行)', await waitText('个:'))

const name = `tui-smoke-${Date.now().toString(36)}`
// 带 --lead 创建:普通文本缺省路由 lead(messages 端点要求 toAgentId)
await type(`/channel new ${name} --lead smoke-调度长 smoke测试频道`)
check('/channel new 创建回执', await waitText('✔ 频道已创建'))
check('/channel new 自动切换', await waitText(`已切换到频道「${name}」`))

await type('/agents')
check('/agents 成员面渲染(lead 成员行)', await waitText('smoke-调度长(lead)'))

await type('你好,这是一条 smoke 测试任务')
check('普通文本 = 发布正式任务(回执)', await waitText('✔ 任务已发布', 12_000))

await type('/hitl')
check('/hitl 无待办提示', await waitText('没有待人工处理'))

// 监控面板:开启后右侧渲染面板头;omp 未 spawn 时还会出现等待提示
// (真实 lead 可能已被上面的消息触发 spawn,故只断言确定事实)
await type('/monitor smoke-调度长')
check('/monitor 面板开启回执', await waitText('监控已开启:smoke-调度长'))
check('/monitor 右侧面板渲染', await waitText('┌─ 监控 smoke-调度长', 12_000))
await type('/monitor off')
check('/monitor off 关闭回执', await waitText('监控面板已关闭'))

// 清理 smoke 频道与 lead 模板。
try {
  const ch = (await api.listChannels()).find(c => c.name === name)
  if (ch) await api.request(`/api/workshop/channels/${ch.id}?purge=1`, { method: 'DELETE' })
  const tpl = (await api.listTemplates()).find(t => t.name === 'smoke-调度长')
  if (tpl) await api.request(`/api/workshop/agents/${tpl.id}`, { method: 'DELETE' })
}
catch { /* 清理失败不判失败 */ }

// 等待真实关闭；不让强制 process.exit 掩盖退出回归。
await type('/quit')
let quitTimer
try {
  const timeout = new Promise((resolve) => {
    quitTimer = setTimeout(resolve, 5000, 'timeout')
  })
  check('/quit 关闭终端', await Promise.race([closed, timeout]) !== 'timeout')
}
finally {
  clearTimeout(quitTimer)
}
console.log(`[tui-smoke] ${failures} 项失败`)
if (failures > 0) process.exit(1)
