/**
 * 团队级插件开关 + 内置插件 轻量冒烟(单元级,零 HTTP/零 LLM/零服务器)。
 * 覆盖:pluginOfTool 反查 / hostToolsForRole 团队过滤 / channel_plugins 表读写 /
 * dispatch 拒绝语义 / 内置作用域发现。
 * 运行:npx tsx tests/team-plugins-smoke.ts
 */
process.env.AGENTWORKSHOP_TEST = '1'

async function main() {
  const { registerPluginTool, pluginOfTool } = await import('../server/services/workshop/agents/plugin-tools')
  const { hostToolsForRole, dispatchHostTool } = await import('../server/services/workshop/agents/host-tool-bridge')
  const { getChannelPluginsRepo } = await import('../server/services/workshop/db/channel-plugins.repo')
  const { discoverPluginDirs } = await import('../server/services/workshop/plugins/host.mjs')

  let pass = 0
  let fail = 0
  const ok = (cond: boolean, label: string, detail = '') => {
    if (cond) {
      pass++
      console.log(`  ✔ ${label}${detail ? ` —— ${detail}` : ''}`)
    }
    else {
      fail++
      console.error(`  ✘ ${label}${detail ? ` —— ${detail}` : ''}`)
    }
  }

  // 1) 内置作用域发现(builtin 目录在前)
  const dirs = discoverPluginDirs(process.cwd())
  const scopes = new Set(dirs.map(d => d.scope))
  ok(scopes.has('builtin'), '内置作用域被发现(server/plugins-builtin)', [...scopes].join(','))
  ok(dirs.some(d => d.scope === 'builtin' && ['rag-bridge', 'diag-bridge'].includes(d.dir.split(/[\\/]/).pop() ?? '')), '两桥接插件在内置目录', dirs.filter(d => d.scope === 'builtin').map(d => d.dir.split(/[\\/]/).pop()).join(','))

  // 2) 注册一个测试插件工具(模拟桥接插件注册)
  registerPluginTool('smoke-test', {
    name: 'smoke_tool_echo',
    description: '冒烟测试用回声工具',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    roles: ['lead', 'worker'],
    handler: async args => ({ text: `echo:${String(args.text ?? '')}` }),
  })
  ok(pluginOfTool('smoke_tool_echo') === 'smoke-test', 'pluginOfTool 反查注册方插件')

  // 3) 工具清单含插件工具(无团队过滤时)
  const allLead = hostToolsForRole('lead')
  ok(allLead.some(t => t.name === 'smoke_tool_echo'), 'hostToolsForRole(lead) 含插件工具', `total=${allLead.length}`)

  // 4) 团队级过滤:先建真实 channel(外键约束),再关闭 smoke-test 插件 → 工具消失
  const repo = getChannelPluginsRepo()
  const { randomUUID } = await import('node:crypto')
  const { DatabaseSync } = await import('node:sqlite')
  const { join } = await import('node:path')
  const { ensureDataDir } = await import('../shared/config/home.mjs')
  const dbPath = join(ensureDataDir(), 'workshop.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout=4000')
  const mkChannel = (name: string) => {
    const id = `smoke-${randomUUID().slice(0, 8)}`
    db.prepare('INSERT OR IGNORE INTO channels (id, name, description, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
      .run(id, name, 'team-plugins-smoke', new Date().toISOString(), new Date().toISOString())
    return id
  }
  const chOff = mkChannel('smoke-off')
  repo.setMany(chOff, [{ name: 'smoke-test', enabled: false }])
  const offLead = hostToolsForRole('lead', chOff)
  ok(!offLead.some(t => t.name === 'smoke_tool_echo'), '团队关闭插件 → 工具从清单消失')
  ok(offLead.some(t => t.name === 'dcw_control'), '关闭插件不影响内置工业工具', `total=${offLead.length}`)

  // 5) 未配置团队(无显式行)= 全启用(向后兼容)
  const chDefault = mkChannel('smoke-default')
  const defLead = hostToolsForRole('lead', chDefault)
  ok(defLead.some(t => t.name === 'smoke_tool_echo'), '未配置团队默认全启用(向后兼容)')

  // 6) dispatch 拒绝语义:关闭团队调插件工具 → isError
  const offRes = await dispatchHostTool(
    { identity: { agentId: 'smoke-agent', channelId: chOff, role: 'lead', name: '冒烟' }, state: { currentTaskId: null, replyContext: null }, getWorkspace: () => null },
    { toolName: 'smoke_tool_echo', arguments: { text: 'hi' } },
  )
  ok(offRes.isError === true && offRes.text.includes('未启用插件'), '关闭团队的 dispatch 被拒(isError + 提示)', offRes.text.slice(0, 60))

  // 7) 开启团队 dispatch 正常
  const onRes = await dispatchHostTool(
    { identity: { agentId: 'smoke-agent', channelId: chDefault, role: 'lead', name: '冒烟' }, state: { currentTaskId: null, replyContext: null }, getWorkspace: () => null },
    { toolName: 'smoke_tool_echo', arguments: { text: 'hi' } },
  )
  ok(!onRes.isError && onRes.text === 'echo:hi', '开启团队的 dispatch 正常执行', onRes.text)

  // 8) 清理冒烟数据
  repo.removeForChannel(chOff)
  repo.removeForChannel(chDefault)
  ok(repo.explicitFor(chOff) === null, '清理后无显式行')

  console.log(`\n══ 团队插件开关冒烟:${pass} 通过 / ${fail} 失败 ══`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('冒烟异常:', err)
  process.exit(1)
})
