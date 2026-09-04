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
  // 分发器传入 parseArgs 结果({ flags, positionals });aw-tui.main 自带
  // 数组形态的参数解析 —— 这里还原为等价数组,直接传对象会因无 .length 被静默丢弃。
  const flags = argv?.flags ?? {}
  const positionals = Array.isArray(argv?.positionals) ? argv.positionals : (Array.isArray(argv) ? argv : [])
  const legacy = [...positionals]
  for (const [key, value] of Object.entries(flags)) {
    if (value === true) legacy.push(`--${key}`)
    else if (value !== undefined && value !== false) legacy.push(`--${key}`, String(value))
  }
  await main(legacy)
  return 0
}
