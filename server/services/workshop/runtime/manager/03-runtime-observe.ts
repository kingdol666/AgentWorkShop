/**
 * ManagerRuntimeObserve —— 运行时监控视图、进程终止与 shutdown
 * (分层 4/19,承 ManagerRuntimeWiring)
 */
import { ManagerRuntimeWiring } from './02-runtime-wiring'
import type { ActingUser, RuntimeAgentView, RuntimeChannelView, RuntimeMonitorSnapshot, RuntimeProcessView } from './types'
import { AppError } from '../../../../utils/errors'
import { hasTerminalSession, sweepTerminalSessions } from '../../agents/harness-terminal'
import { killHarnessProcess, listAliveHarnessProcessesByAgent, listHarnessProcesses, sweepHarnessProcesses } from '../../agents/harness-process'
import { log, resolveOwnerName } from './helpers'

export abstract class ManagerRuntimeObserve extends ManagerRuntimeWiring {
  runtimeStatus(): { wiredAgents: string[], activeChannels: string[] } {
    return {
      wiredAgents: [...this.agentIndex.values()].map(rt => rt.agentId),
      activeChannels: [...this.channels.keys()],
    }
  }

  /**
   * 运行时资源监控快照:已装配的 ChannelRuntime / AgentRuntime
   * + 全部已启动的 harness 进程(注册表,含已脱离 runtimes 的孤儿进程)。
   */
  monitorRuntime(): RuntimeMonitorSnapshot {
    sweepHarnessProcesses()
    sweepTerminalSessions()
    const channels: RuntimeChannelView[] = [...this.channels.values()].map((cr) => {
      const channel = this.deps.repos.channels.findById(cr.channelId)
      return {
        channelId: cr.channelId,
        wiredAgentCount: cr.getAgents().length,
        memberCount: this.deps.repos.channelAgents.listByChannel(cr.channelId).length,
        hasScheduler: cr.scheduler !== null,
        leadAgentId: channel?.leadAgentId ?? null,
        ownerUserId: channel?.ownerUserId ?? null,
      }
    })
    const agents: RuntimeAgentView[] = [...this.agentIndex.values()].map((rt) => {
      const status = rt.getStatus()
      const row = this.deps.repos.channelAgents.findByChannelAgent(rt.channelId, rt.agentId)
      return {
        channelId: rt.channelId,
        agentId: rt.agentId,
        name: rt.name,
        role: rt.role,
        harness: row?.harness ?? '?',
        state: status.state,
        currentTaskId: status.currentTaskId,
        queuedCount: status.queuedCount,
        completedCount: status.completedCount,
        process: rt.getProcessInfo(),
      }
    })
    const channelOwner = new Map(channels.map(c => [c.channelId, c.ownerUserId ?? null]))
    const boundPids = new Set(
      agents.map(a => a.process?.pid).filter((p): p is number => typeof p === 'number'),
    )
    const processes: RuntimeProcessView[] = listHarnessProcesses().map(p => ({
      pid: p.pid,
      harness: p.harness,
      command: p.command,
      args: p.args,
      agentId: p.agentId,
      channelId: p.channelId,
      name: p.name,
      role: p.role,
      startedAt: p.startedAt,
      alive: p.alive,
      exitCode: p.exitCode,
      bound: boundPids.has(p.pid),
      terminal: hasTerminalSession(p.pid),
    }))
    for (const a of agents) {
      a.ownerUserId = channelOwner.get(a.channelId) ?? null
    }
    for (const p of processes) {
      ;(p as RuntimeProcessView & { ownerUserId?: string | null }).ownerUserId = p.channelId
        ? channelOwner.get(p.channelId) ?? null
        : null
    }
    return {
      generatedAt: new Date().toISOString(),
      serverPid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
      channels,
      agents,
      processes,
      counts: {
        channels: channels.length,
        agents: agents.length,
        processes: processes.length,
        aliveProcesses: processes.filter(p => p.alive).length,
        orphanProcesses: processes.filter(p => p.alive && !p.bound).length,
      },
    }
  }

  /**
   * 用户级监控快照(v10 用户隔离):
   * - 普通用户:仅本人 channel 的 runtime/agent,以及绑定到本人 channel 的进程;
   *   未绑定/孤儿进程与遗留无主 channel 一律不可见。
   * - admin:全量视图,每个 channel/agent/process 附带 ownerUserId(ownerName 由路由层补注)。
   */
  monitorRuntimeForUser(user: ActingUser): RuntimeMonitorSnapshot & { scope: 'user' | 'admin', ownerNames?: Record<string, string> } {
    const snap = this.monitorRuntime()
    if (user.role === 'admin') {
      const ownerIds = new Set<string>()
      for (const c of snap.channels) {
        if (c.ownerUserId) ownerIds.add(c.ownerUserId)
      }
      const ownerNames: Record<string, string> = {}
      for (const id of ownerIds) {
        const name = resolveOwnerName(id)
        if (name) ownerNames[id] = name
      }
      for (const c of snap.channels) c.ownerName = c.ownerUserId ? ownerNames[c.ownerUserId] ?? null : null
      for (const a of snap.agents) a.ownerName = a.ownerUserId ? ownerNames[a.ownerUserId] ?? null : null
      return { ...snap, scope: 'admin', ownerNames }
    }
    const visibleChannels = new Set(snap.channels.filter(c => c.ownerUserId === user.id).map(c => c.channelId))
    // 本人有主但当前未装配 runtime 的 channel 也计入 channels 视图(成员数来自 DB,装配为 0)
    for (const row of this.deps.repos.channels.list()) {
      if (row.ownerUserId === user.id) visibleChannels.add(row.id)
    }
    const channels = snap.channels.filter(c => visibleChannels.has(c.channelId))
    for (const row of this.deps.repos.channels.list()) {
      if (visibleChannels.has(row.id) && !channels.some(c => c.channelId === row.id)) {
        channels.push({
          channelId: row.id,
          wiredAgentCount: 0,
          memberCount: this.deps.repos.channelAgents.listByChannel(row.id).length,
          hasScheduler: false,
          leadAgentId: row.leadAgentId,
          ownerUserId: row.ownerUserId,
        })
      }
    }
    const agents = snap.agents.filter(a => visibleChannels.has(a.channelId))
    const processes = snap.processes.filter(p => p.channelId !== null && visibleChannels.has(p.channelId))
    return {
      generatedAt: snap.generatedAt,
      serverPid: snap.serverPid,
      uptimeMs: snap.uptimeMs,
      channels,
      agents,
      processes,
      counts: {
        channels: channels.length,
        agents: agents.length,
        processes: processes.length,
        aliveProcesses: processes.filter(p => p.alive).length,
        orphanProcesses: processes.filter(p => p.alive && !p.bound).length,
      },
      scope: 'user',
    }
  }

  /**
   * 终止指定 runtime 的 harness 进程 → 对应 AgentRuntime 随之 stop 并卸载。
   * 语义比 HITL stopAgentRuntime 更强:先强杀进程(进程树),再走 stopAndDetach
   * (停 SchedulerLoop / 中断当前 run / dispose impl / 移出索引)。成员行保留,
   * 后续任务投递按需重新装配。
   * runtime 未装配(如已被空闲卸载)但进程残留 → 按 agentId 兜底强杀进程,防资源浪费。
   */
  async terminateRuntimeProcess(channelId: string, agentId: string): Promise<{ agentId: string, stopped: boolean }> {
    const m = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!m) throw new AppError(404, 'NOT_FOUND', `成员不存在: ${agentId}`)
    const runtime = this.runtimeOf(channelId, agentId)
    if (runtime) {
      try {
        runtime.killProcess()
      }
      catch (err) {
        log.error(`[AgentChannelManager] 终止进程失败 ${channelId}/${agentId}:`, err)
      }
      await this.stopAndDetach(channelId, agentId)
      return { agentId, stopped: true }
    }
    const leftover = listAliveHarnessProcessesByAgent(agentId)
    for (const p of leftover) killHarnessProcess(p.pid)
    return { agentId, stopped: leftover.length > 0 }
  }

  /** 按 PID 终止 harness 进程(孤儿进程专用;已绑定 runtime 的请走 terminateRuntimeProcess) */
  killHarnessProcessByPid(pid: number): { pid: number, killed: boolean } {
    return { pid, killed: killHarnessProcess(pid) }
  }

  async shutdown(): Promise<void> {
    if (this.idleSweeperTimer) {
      clearInterval(this.idleSweeperTimer)
      this.idleSweeperTimer = null
    }
    if (this.memoryTimer) {
      clearInterval(this.memoryTimer)
      this.memoryTimer = null
    }
    this.scheduleRuntime?.stop()
    this.scheduleRuntime = null
    for (const cr of this.channels.values()) {
      cr.scheduler?.stop()
      cr.scheduler = null
    }
    await Promise.all([...this.agentIndex.values()].map(a => a.stop()))
    this.agentIndex.clear()
    this.channels.clear()
    this.buses.clear()
  }
}
