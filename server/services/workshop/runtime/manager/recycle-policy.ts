/**
 * Channel 配置变更重装判定(纯函数,供 manager 与回归测试共用)。
 *
 * 配置变更(workspace / scenarioPrompt / channel LLM / twin-profile)需要让新运行时
 * 读到新配置,但不得在以下窗口卸载:
 *  - 任一成员 busy(回合进行中,卸载会 abort 在途工作);
 *  - 信箱仍有 pending 消息(卸载后消息要等停滞看门狗才重投);
 *  - 有挂起 HITL 审批(卸载会将其收敛为拒绝)。
 * 未装配(agents 为空)→ skip:懒装配路径下次任务会直接按新配置 wire,无需冷启动。
 */
export type ChannelRecycleDecision = 'now' | 'defer' | 'skip'

export interface ChannelRecycleState {
  /** 已装配成员运行时的状态(idle/busy/stopped) */
  states: string[]
  /** 任一成员信箱是否有待消费消息 */
  hasPendingMessages: boolean
  /** 任一成员是否有挂起 HITL 审批 */
  hasPendingApprovals: boolean
}

export function channelRecycleDecision(input: ChannelRecycleState): ChannelRecycleDecision {
  if (input.states.length === 0) return 'skip'
  if (input.states.some(state => state !== 'idle')) return 'defer'
  if (input.hasPendingMessages || input.hasPendingApprovals) return 'defer'
  return 'now'
}
