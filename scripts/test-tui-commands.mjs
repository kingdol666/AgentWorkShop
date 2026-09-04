/**
 * TUI 命令系统单元测试(node 直跑):
 *   node scripts/test-tui-commands.mjs
 *
 * 覆盖:/命令解析(参数/--flag)/未知命令兜底/分发路由/mock ctx 下的命令执行。
 */
import { parseCommand, dispatchCommand } from '../tui/commands/index.mjs'

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` (${extra})` : ''}`)
  if (!cond) failures++
}

// ── 解析 ──
console.log('[1] parseCommand')
const p1 = parseCommand('/channel new demo --desc 测试频道 --lead 调度长')
check('命令名解析', p1?.name === 'channel')
check('位置参数', JSON.stringify(p1.args) === JSON.stringify(['new', 'demo']))
check('--flag 带值', p1.flags.desc === '测试频道' && p1.flags.lead === '调度长')
const p2 = parseCommand('/task 调高设定值 --mode loop')
check('中文标题 + 尾随 flag', p2.args.join(' ') === '调高设定值' && p2.flags.mode === 'loop')
const p3 = parseCommand('普通文本')
check('非 / 前缀返回 null', p3 === null)
const p4 = parseCommand('/hitl')
check('裸命令', p4.name === 'hitl' && p4.args.length === 0)
const p5 = parseCommand('/channel add 巡检员 --role lead --bool')
check('--bool 无值 flag', p5.flags.role === 'lead' && p5.flags.bool === true)

// ── 分发(mock ctx) ──
console.log('[2] dispatchCommand')
function mockCtx() {
  const calls = []
  const state = {
    channels: [{ id: 'ch-1', name: 'prod线' }],
    activeChannelId: 'ch-1',
    agents: [{ id: 'agt-1', name: '调度长', role: 'lead', harness: 'omp', enabled: 1 }],
    agentStates: {},
    tasks: [],
    hitl: [],
    hitlAnswering: null,
    log: [],
    userName: '张伟',
  }
  return {
    state,
    calls,
    echo: (kind, text) => calls.push({ kind, text }),
    api: {
      listChannels: async () => state.channels,
      createChannel: async body => ({ channelId: 'ch-new', leadAgentId: null, name: body.name }),
      listAgents: async () => state.agents,
      listTemplates: async () => [{ id: 'tpl-1', name: '巡检员' }],
      addAgent: async (_id, body) => ({ id: 'inst-1', name: body.agentId ? '巡检员' : body.name, role: body.role ?? 'worker' }),
      sendMessage: async (_id, body) => calls.push({ send: body }),
      submitTask: async (_id, body) => {
        calls.push({ task: body })
        return { id: 'tk-9' }
      },
      listTasks: async () => [],
      hitlPending: async () => [],
      hitlRespond: async body => calls.push({ respond: body }),
    },
    actions: {
      switchChannel: async (id) => {
        state.activeChannelId = id
        calls.push({ switched: id })
      },
      refreshAgents: async () => {},
      openMonitor: agent => calls.push({ monitor: agent.name }),
      closeMonitor: () => calls.push({ monitorOff: true }),
      submitHitlAnswer: async t => calls.push({ hitlAnswer: t }),
      quit: () => calls.push({ quit: true }),
    },
  }
}

let ctx = mockCtx()
check('未知命令被兜底', await dispatchCommand(ctx, '/nope') === true && ctx.calls[0].kind === 'error')
check('非命令放行', await dispatchCommand(ctx, '普通任务文本') === false)

ctx = mockCtx()
await dispatchCommand(ctx, '/channel new smoke线 --lead 调度长')
check('创建频道并自动切换', ctx.state.activeChannelId === 'ch-new' && ctx.calls.some(c => c.switched === 'ch-new'))
check('lead 内联定义传递', ctx.state.channels.some(c => c.id === 'ch-new'))

ctx = mockCtx()
await dispatchCommand(ctx, '/channel use prod线')
check('/channel use 按名切换', ctx.state.activeChannelId === 'ch-1')
await dispatchCommand(ctx, '/channel use 1')
check('/channel use 按序号切换', ctx.state.activeChannelId === 'ch-1')

ctx = mockCtx()
await dispatchCommand(ctx, '/channel add 巡检员 --role lead')
check('模板克隆放置(传 agentId)', ctx.calls.some(() => true) && ctx.state.agents.length === 1)

ctx = mockCtx()
await dispatchCommand(ctx, '/send 调度长 请确认产线状态')
const sent = ctx.calls.find(c => c.send)
check('/send immediate 直发+requireReply', sent?.send?.priority === 'immediate' && sent?.send?.toAgentId === 'agt-1')

ctx = mockCtx()
await dispatchCommand(ctx, '/send 不存在的人 你好')
check('/send 未知成员报错', ctx.calls.some(c => c.kind === 'error'))

ctx = mockCtx()
await dispatchCommand(ctx, '/task 调高温度到182 --mode loop --assignee 调度长')
const task = ctx.calls.find(c => c.task)
check('/task 标题+mode+assignee', task?.task?.title === '调高温度到182' && task?.task?.mode === 'loop' && task?.task?.assigneeId === 'agt-1')

ctx = mockCtx()
await dispatchCommand(ctx, '/monitor 调度长')
check('/monitor 打开面板', ctx.calls.some(c => c.monitor === '调度长'))
await dispatchCommand(ctx, '/monitor off')
check('/monitor off 关闭', ctx.calls.some(c => c.monitorOff))

ctx = mockCtx()
await dispatchCommand(ctx, '/hitl 1')
check('/hitl 序号无效报错', ctx.calls.some(c => c.kind === 'error'))

ctx = mockCtx()
ctx.state.hitl = [{ kind: 'omp-dialog', id: 'd1', method: 'confirm', title: '确认?', agentName: '调度长' }]
await dispatchCommand(ctx, '/hitl 1')
check('/hitl 进入作答模式', ctx.state.hitlAnswering?.id === 'd1')

ctx = mockCtx()
await dispatchCommand(ctx, '/quit')
check('/quit 触发退出', ctx.calls.some(c => c.quit))

console.log(failures === 0 ? '\n[commands] 全部通过' : `\n[commands] ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
