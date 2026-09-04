// ============================================================
// TUI 命令系统 —— SlashCommand 集中注册 + 解析(仿 openclaw tui/commands.ts)。
// handler(ctx, args):ctx = { state, notify, api, ws, actions, echo }。
// actions 由 aw-tui 注入(switchChannel/openMonitor/submitHitl 等带副作用的装配)。
// ============================================================

/** 解析 '/cmd arg1 arg2 --flag val --bool' → { name, args, flags } */
export function parseCommand(input) {
  const text = String(input ?? '').trim()
  if (!text.startsWith('/')) return null
  const tokens = text.slice(1).split(/\s+/).filter(Boolean)
  const name = tokens.shift() ?? ''
  const args = []
  const flags = {}
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.startsWith('--')) {
      const key = tok.slice(2)
      const next = tokens[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      }
      else flags[key] = true
    }
    else args.push(tok)
  }
  return { name, args, flags, rest: args.join(' ') }
}

export const commands = [
  {
    name: 'help',
    description: '命令列表',
    handler(ctx) {
      const rows = commands.map(c => `  /${c.name}${c.usage ? ` ${c.usage}` : ''}  — ${c.description}`)
      ctx.echo('system', `可用命令:\n${rows.join('\n')}\n普通文本按当前目标发送:频道 → 发布正式任务;@成员(Tab 选择) → 通信消息。/msg /task 可显式指定。`)
    },
  },
  {
    name: 'channels',
    description: '列出我的频道',
    async handler(ctx) {
      const list = await ctx.api.listChannels()
      ctx.state.channels = list
      ctx.echo('system', `频道 ${list.length} 个:`)
      for (const [i, c] of list.entries()) {
        ctx.echo('system', `  ${i + 1}. ${c.name}${c.id === ctx.state.activeChannelId ? ' ◀ 当前' : ''}(id ${c.id.slice(0, 8)})`)
      }
    },
  },
  {
    name: 'channel',
    usage: 'new <name> [--desc …] [--lead <名>] | use [名|序号] | add <模板|名> [--role lead] [--harness omp] [--config JSON]',
    description: '创建/切换频道(use 不带参数 = 交互选择)、向频道放置 Agent',
    async handler(ctx, args, flags) {
      const sub = args.shift()
      if (sub === 'new') {
        const name = args.shift()
        if (!name) return ctx.echo('error', '用法:/channel new <name> [--desc …] [--lead <名>]')
        const desc = args.join(' ')
        const body = { name, description: desc }
        if (flags.lead) body.leadAgent = { name: String(flags.lead), harness: String(flags.harness ?? 'omp') }
        // 响应为 { channelId, leadAgentId }(manager.createChannel 收敛)
        const result = await ctx.api.createChannel(body)
        ctx.state.channels.push({ id: result.channelId, name, description: desc, leadAgentId: result.leadAgentId ?? null })
        ctx.echo('system', `✔ 频道已创建:${name}(id ${result.channelId.slice(0, 8)})`)
        await ctx.actions.switchChannel(result.channelId)
      }
      else if (sub === 'use') {
        const key = args.shift()
        if (!key) {
          // 交互式选择(浮层)
          ctx.actions.pickChannel?.()
          return
        }
        const ch = resolveChannel(ctx.state, key)
        if (!ch) return ctx.echo('error', `频道不存在:${key}`)
        await ctx.actions.switchChannel(ch.id)
      }
      else if (sub === 'add') {
        const name = args.shift()
        if (!name) return ctx.echo('error', '用法:/channel add <模板名|名称> [--role lead|worker] [--harness omp] [--config JSON]')
        const role = flags.role === 'lead' ? 'lead' : 'worker'
        const harness = String(flags.harness ?? 'omp')
        let body
        const templates = await ctx.api.listTemplates().catch(() => [])
        const tpl = templates.find(t => t.name === name)
        if (tpl) {
          body = { agentId: tpl.id, role, configOverride: parseConfigFlag(flags.config) }
        }
        else {
          body = { name, harness, role, config: parseConfigFlag(flags.config) }
          ctx.echo('system', `未找到模板「${name}」,按内联定义创建(harness=${harness})。`)
        }
        const inst = await ctx.api.addAgent(ctx.state.activeChannelId, body)
        await ctx.actions.refreshAgents()
        ctx.echo('system', `✔ Agent 已放入频道:${inst?.name ?? name}(${role})`)
      }
      else {
        ctx.echo('error', '用法:/channel new|use|add …(/help)')
      }
    },
  },
  {
    name: 'agents',
    description: '当前频道成员与实时状态',
    async handler(ctx) {
      await ctx.actions.refreshAgents()
      const rows = ctx.state.agents.map((a, i) => {
        const st = ctx.state.agentStates[a.id]
        const state = st?.state ?? 'idle'
        const queued = st?.queued ?? 0
        return `  ${i + 1}. ${a.name}${a.role === 'lead' ? '(lead)' : ''} ${state === 'busy' ? '● busy' : state === 'stopped' ? '○ stopped' : '○ idle'}${queued ? ` 队列${queued}` : ''} [${a.id.slice(0, 8)}]`
      })
      ctx.echo('system', `成员 ${rows.length}:\n${rows.join('\n') || '  (空 —— /channel add <名>)'}`)
    },
  },
  {
    name: 'send',
    usage: '<agent名|序号> <文本…>',
    description: '向指定 Agent 直发消息(忙碌时 steer 注入当前回合)',
    async handler(ctx, args) {
      const key = args.shift()
      const text = args.join(' ')
      if (!key || !text) return ctx.echo('error', '用法:/send <agent名|序号> <文本…>')
      const agent = resolveAgent(ctx.state, key)
      if (!agent) return ctx.echo('error', `成员不存在:${key}(/agents 查看)`)
      await ctx.api.sendMessage(ctx.state.activeChannelId, { toAgentId: agent.id, text, priority: 'immediate', requireReply: true, fromLabel: ctx.state.userName || '用户' })
      ctx.echo('system', `✔ 已直发 ${agent.name}`)
    },
  },
  {
    name: 'msg',
    usage: '[<agent>] <文本…>',
    description: '发布通信消息(即时送达,忙碌时 steer 注入;缺省收件人 = 当前对话目标或 lead)',
    async handler(ctx, args) {
      let target = ctx.state.target
      const first = args[0]
      if (first && !ctx.state.agents.some(a => a.name === first || a.id === first) && !/^\d+$/.test(first)) {
        // 首参不是成员 → 整段是文本
      }
      else if (first) {
        const key = args.shift()
        target = resolveAgent(ctx.state, key)
        if (!target) return ctx.echo('error', `成员不存在:${key}(/agents 查看)`)
      }
      const text = args.join(' ')
      if (!text) return ctx.echo('error', '用法:/msg [<agent>] <文本…>')
      const to = target ?? leadOf(ctx.state)
      if (!to) return ctx.echo('error', '频道没有 lead,请指定收件人:/msg <agent> <文本…>')
      await ctx.api.sendMessage(ctx.state.activeChannelId, { toAgentId: to.id, text, priority: 'immediate', requireReply: true, fromLabel: ctx.state.userName || '用户' })
      ctx.echo('system', `✔ 通信消息已发 → @${to.name}`)
    },
  },
  {
    name: 'task',
    usage: '<标题…> [--mode goal|loop|pipeline] [--assignee <agent>]',
    description: '发布正式任务(缺省路由 lead,状态经 /tasks 跟踪)',
    async handler(ctx, args, flags) {
      const title = args.join(' ')
      if (!title) return ctx.echo('error', '用法:/task <标题…> [--mode goal|loop|pipeline] [--assignee <agent>]')
      const body = { title, mode: flags.mode ?? 'goal' }
      if (flags.assignee) {
        const a = resolveAgent(ctx.state, String(flags.assignee))
        if (!a) return ctx.echo('error', `assignee 不存在:${flags.assignee}`)
        body.assigneeId = a.id
      }
      else if (ctx.state.target) {
        body.assigneeId = ctx.state.target.agentId
      }
      const task = await ctx.api.submitTask(ctx.state.activeChannelId, body)
      ctx.echo('system', `✔ 任务已发布:${task?.id?.slice(0, 8) ?? ''}「${title}」`)
    },
  },
  {
    name: 'tasks',
    description: '任务列表与状态',
    async handler(ctx) {
      const list = await ctx.api.listTasks(ctx.state.activeChannelId)
      ctx.state.tasks = list
      const rows = list.slice(0, 20).map((t, i) => `  ${i + 1}. [${t.state}] ${t.title ?? t.taskId?.slice(0, 8)}${t.progress ? ` ${t.progress}%` : ''}`)
      ctx.echo('system', `任务 ${list.length}:\n${rows.join('\n') || '  (无)'}`)
    },
  },
  {
    name: 'monitor',
    usage: '<agent名|序号|off>',
    description: '开/关右侧终端镜像面板(实时查看该 Agent 执行过程)',
    async handler(ctx, args) {
      const key = args.shift()
      if (!key || key === 'off') {
        ctx.actions.closeMonitor()
        ctx.echo('system', '监控面板已关闭')
        return
      }
      await ctx.actions.refreshAgents()
      const agent = resolveAgent(ctx.state, key)
      if (!agent) return ctx.echo('error', `成员不存在:${key}(/agents 查看)`)
      ctx.actions.openMonitor(agent)
    },
  },
  {
    name: 'hitl',
    usage: '[序号|off]',
    description: '列出待人工处理事项;带序号进入作答;off 放弃作答',
    async handler(ctx, args) {
      const key = args.shift()
      if (key === 'off') {
        ctx.state.hitlAnswering = null
        ctx.echo('system', '已放弃当前作答(对话框仍在待办中,可 /hitl 重进)')
        return
      }
      if (key === undefined) {
        const list = ctx.state.hitl.length > 0 ? ctx.state.hitl : await ctx.api.hitlPending(ctx.state.activeChannelId)
        ctx.state.hitl = list
        if (list.length === 0) return ctx.echo('system', '当前没有待人工处理的事项。')
        const rows = list.map((it, i) => `  ${i + 1}. [${it.kind}] ${it.title} —— ${it.agentName}${it.expiresAt ? `(park 截止 ${it.expiresAt.slice(11, 19)})` : ''}`)
        ctx.echo('warn', `待人工处理 ${list.length} 项:\n${rows.join('\n')}\n/hitl <序号> 进入作答。`)
        return
      }
      const idx = Number.parseInt(key, 10) - 1
      const item = ctx.state.hitl[idx]
      if (!item) return ctx.echo('error', `序号无效:${key}(/hitl 查看列表)`)
      ctx.state.hitlAnswering = item
      ctx.echo('warn', `进入作答:${item.title} —— 完成输入回车提交,/hitl off 放弃。`)
    },
  },
  {
    name: 'quit',
    description: '退出 TUI',
    handler(ctx) {
      ctx.actions.quit()
    },
  },
]

function resolveChannel(state, key) {
  const byIdx = state.channels[Number.parseInt(key, 10) - 1]
  return state.channels.find(c => c.name === key || c.id === key) ?? (Number.isInteger(Number.parseInt(key, 10)) ? byIdx : undefined)
}

function resolveAgent(state, key) {
  const byIdx = state.agents[Number.parseInt(key, 10) - 1]
  return state.agents.find(a => a.name === key || a.id === key) ?? (Number.isInteger(Number.parseInt(key, 10)) ? byIdx : undefined)
}

/** 当前对话目标的收件人解析:目标成员 → lead */
function leadOf(state) {
  const ch = state.channels.find(c => c.id === state.activeChannelId)
  const leadId = ch?.leadAgentId ?? state.agents.find(a => a.role === 'lead')?.id
  return state.agents.find(a => a.id === leadId) ?? null
}

function parseConfigFlag(raw) {
  if (!raw || raw === true) return undefined
  try {
    return JSON.parse(String(raw))
  }
  catch {
    throw new Error(`--config 不是合法 JSON:${raw}`)
  }
}

/** 命令分发(编辑器 onSubmit 入口;返回 true = 已作为命令消费) */
export async function dispatchCommand(ctx, input) {
  const parsed = parseCommand(input)
  if (!parsed) return false
  const cmd = commands.find(c => c.name === parsed.name)
  if (!cmd) {
    ctx.echo('error', `未知命令:/${parsed.name}(/help 查看命令列表)`)
    return true
  }
  try {
    await cmd.handler(ctx, parsed.args, parsed.flags)
  }
  catch (err) {
    ctx.echo('error', `/${cmd.name} 失败:${err.message}`)
  }
  return true
}

/** pi-tui CombinedAutocompleteProvider 的命令表(斜杠补全;name 不带 '/'——
 *  provider 把 '/' 当触发符自带,带了会在应用补全时拼出 '//cmd') */
export function slashCommandCompletions() {
  return commands.map(c => ({ name: c.name, description: c.description }))
}
