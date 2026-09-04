// ============================================================
// 指令:tui —— 终端工作台(与 AgentTeam 交互作业;实现在 tui/)。
// 用法:aw tui [--url http://127.0.0.1:3000] [--token ut-*] [--channel <名>]
// ============================================================

export const meta = {
  name: 'tui',
  aliases: ['tui'],
  group: '交互',
  summary: '终端工作台 TUI:频道管理/发任务/实时监控/HITL 作答',
  usage: 'aw tui [--url <baseUrl>] [--token <ut-*>] [--channel <名>]',
  needsProject: false,
}

export async function run(argv) {
  const { main } = await import('../../tui/aw-tui.mjs')
  await main(argv)
  return 0
}
