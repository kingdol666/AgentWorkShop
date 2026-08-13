/**
 * Workshop 启动插件(设计文档 §8)。
 * Nitro 启动时:创建 data/ 目录 → openWorkshopDb(data/workshop.sqlite)→ 装配 5 个 repo
 * + createAgentImpl 工厂 → createAgentChannelManager → restore() 恢复运行时
 * → 为有 lead 的 channel 启动 SchedulerLoop → 挂 globalThis.__workshopManager。
 *
 * 导出:
 *  - getWorkshopManager():读取进程级 manager 单例(先检查已设置;未初始化抛 503)
 *  - ensureLeadSchedulerLoop():为 channel 装配并启动 lead 的 SchedulerLoop(幂等)
 *
 * 注意:不静态 import 'nitropack/runtime/plugin'——defineNitroPlugin 是恒等函数,
 * 插件 default 直接导出普通函数即可,避免把 nitropack 依赖引入可被 tsx 直跑测试
 * 导入的模块图(顶层 node_modules 无 nitropack 符号链接)。
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { openWorkshopDb, initWorkshopDb } from '../services/workshop/db/database'
import { createChannelRepo } from '../services/workshop/db/channel.repo'
import { createAgentRepo } from '../services/workshop/db/agent.repo'
import { createTaskRepo } from '../services/workshop/db/task.repo'
import { createMessageRepo } from '../services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../services/workshop/db/subscription.repo'
import { createAgentImpl } from '../services/workshop/agents/factory'
import {
  createAgentChannelManager,
  type AgentChannelManager,
  type AllRepos,
  type ManagerDeps,
} from '../services/workshop/runtime/manager'
import { SchedulerLoop } from '../services/workshop/runtime/scheduler-loop'
import type { ChannelRuntime } from '../services/workshop/runtime/channel-runtime'
import type { AgentRuntime } from '../services/workshop/runtime/agent-runtime'
import { AppError } from '../utils/errors'

declare global {

  var __workshopManager: AgentChannelManager | undefined
}

/** manager 内部结构(类型收窄:公开 API 未暴露 channel 运行时映射) */
interface ManagerInternals {
  channels: Map<string, ChannelRuntime>
  agentIndex: Map<string, AgentRuntime>
}

function internalsOf(manager: AgentChannelManager): ManagerInternals {
  return manager as unknown as ManagerInternals
}

/** 读取进程级 manager 单例(先检查已设置;未初始化抛 503) */
export function getWorkshopManager(): AgentChannelManager {
  const manager = globalThis.__workshopManager
  if (!manager) {
    throw new AppError(503, 'WORKSHOP_NOT_READY', 'workshop 尚未初始化(plugin 未执行)')
  }
  return manager
}

/**
 * 为 channel 装配并启动 lead 的 SchedulerLoop(幂等)。
 * 无 lead / 已装配 / channel 未加载时跳过;新任命 lead(createChannel 带 leadAgent
 * 或 createAgent role=lead)后由 REST 入口调用,与 plugin 启动恢复同路径。
 */
export function ensureLeadSchedulerLoop(
  manager: AgentChannelManager,
  channelId: string,
  options?: { tickMs?: number, stallMs?: number },
): void {
  const internal = internalsOf(manager)
  const cr = internal.channels.get(channelId)
  if (!cr || cr.scheduler) return
  const lead = cr.getAgents().find(a => a.role === 'lead')
  if (!lead) return
  const runtime = internal.agentIndex.get(lead.agentId)
  if (!runtime) return
  cr.scheduler = new SchedulerLoop(cr, runtime, options)
  cr.scheduler.start()
}

/**
 * Nitro 启动插件(默认导出普通函数;defineNitroPlugin 为恒等包装)。
 * 注意:runNitroPlugins 同步调用 plugin,不 await 返回值;manager.restore() 方法体全同步
 * (无 await 语句),直接调用即同步完成恢复,故此处不 await。
 * 幂等:globalThis.__workshopManager 已设置(如测试预置)则跳过初始化。
 */
export default function workshopPlugin(nitroApp: {
  hooks: { hook(name: string, fn: (...args: unknown[]) => void | Promise<void>): void }
}): void {
  // 先检查已设置:避免重复装配覆盖既有单例
  if (globalThis.__workshopManager) return

  // data/ 目录不存在则创建(openWorkshopDb 依赖目录存在)
  const dataDir = resolve(process.cwd(), 'data')
  mkdirSync(dataDir, { recursive: true })

  // 打开(或创建)数据库 → 初始化(建表 + PRAGMA;openWorkshopDb 已内置,显式再调一次保持幂等)
  const db = openWorkshopDb(resolve(dataDir, 'workshop.sqlite'))
  initWorkshopDb(db)

  // 装配 repos + Agent impl 工厂
  const repos: AllRepos = {
    channels: createChannelRepo(db),
    agents: createAgentRepo(db),
    messages: createMessageRepo(db),
    subscriptions: createSubscriptionRepo(db),
    tasks: createTaskRepo(db),
  }
  const deps: ManagerDeps = { repos, implFactory: createAgentImpl, db }

  // 创建 manager → 挂全局单例(后续 REST/A2A/WS 经 getWorkshopManager() 读取)
  const manager = createAgentChannelManager(deps)
  globalThis.__workshopManager = manager

  // 启动恢复:consuming 重置 + 非终态任务回 ASSIGNED + enabled 的 channel/agent 重建运行时
  manager.restore()

  // lead 恢复后启动其 SchedulerLoop(调度循环随 lead 生命周期运行)
  for (const channel of repos.channels.list()) {
    if (channel.enabled === 1) ensureLeadSchedulerLoop(manager, channel.id)
  }

  // 关机:停止全部 SchedulerLoop 与 Agent 消费循环(优雅等待当前 run/supervise 结束),关闭数据库
  nitroApp.hooks.hook('close', async () => {
    const internal = internalsOf(manager)
    for (const cr of internal.channels.values()) cr.scheduler?.stop()
    await Promise.all([...internal.agentIndex.values()].map(a => a.stop()))
    db.close()
  })
}
