/**
 * OmpRpcAgentImplClient —— omp 客户端管理(ensureClient / probeContext)
 * (拆分层,承 OmpRpcAgentImplEventMapping;方法体与原文件逐行一致)
 */
import { OmpRpcAgentImplEventMapping } from './event-mapping'
import type { AgentRunContext } from '../agent-interface'
import { OmpRpcClient } from '../adapters/omp-rpc-client'
import { attachTerminalTap, markTerminalSessionExit } from '../harness-terminal'
import { bindHarnessProcess, markHarnessProcessExit, registerHarnessProcess } from '../harness-process'
import { hostToolsForAgent } from '../host-tool-bridge'

export abstract class OmpRpcAgentImplClient extends OmpRpcAgentImplEventMapping {
  protected async ensureClient(ctx: AgentRunContext): Promise<void> {
    if (!this.workspace) {
      this.workspace = ctx.workspace
    }
    if (!this.agentInfo) {
      // init() 可能未调用;从 ctx 推断
      this.channelId = ctx.channelId
      this.agentRole = ctx.role
      // harness 字段必须保留(治理审计 identityFields 要求非空;2026-11-11 H13:
      // 此前重写丢 harness → 开 AW_GOV_HARNESS_EVENT_LOG 时 tool_start 被拒)
      this.bridgeCtx.identity = { agentId: this.selfAgentId, channelId: this.channelId, role: this.agentRole, name: this.agentName, harness: this.harnessId }
    }

    if (!this.client || !this.client.alive) {
      // 旧客户端已退出(exit 事件/OS 存活校准 reconcile 触发)——必须丢弃并重生,
      // 否则后续回合会一直对着死 stdio 报 PROMPT_FAILED 烧重试配额
      if (this.client) this.harnessRestartReason = 'PROCESS_EXIT'
      this.client = null
      this.hostToolsRegistered = false
      // 会话身份随进程失效:新进程是**新会话**,旧 sessionId 残留会被
      // noteHarnessUse 绑到新 pid(continuity 报假身份,比 null 更危险)。
      // 置空后由下方 probeContext 从新进程 get_state 重新取回。
      this.sessionId = null
      const command = this.config.command ?? 'omp'
      const client = new OmpRpcClient({
        command,
        mode: this.rpcMode,
        // 重复键 args 的生效者是下一行(JS 对象字面量后写覆盖先写):保留生效语义,删除被覆盖项。
        // (原 ['--thinking', level] 从未真正传给 omp —— 见报告"未修的缺陷"一节。)
        args: this.config.args,
        cwd: this.config.cwd ?? process.cwd(),
        // 进程退出 → 注册表标记(供运行时资源监控);pid=-1 表示无法取得,忽略
        onExit: (pid, code) => {
          if (pid > 0) {
            markHarnessProcessExit(pid, code)
            markTerminalSessionExit(pid, code)
          }
        },
      })
      await client.start()

      // 登记 + 绑定 agent 身份(harness 进程监控的事实源)
      const pid = client.pid
      if (pid) {
        registerHarnessProcess(pid, {
          harness: 'omp',
          command,
          args: ['--mode', this.rpcMode, ...(this.config.args ?? [])],
        })
        bindHarnessProcess(pid, {
          agentId: this.selfAgentId,
          channelId: this.channelId,
          name: this.agentName,
          role: this.agentRole,
        })
        // 终端镜像 tap:全部 RPC 帧 → /monitor 终端(实时 TUI 渲染 + HITL)
        attachTerminalTap(client, {
          pid,
          harness: 'omp',
          agentId: this.selfAgentId,
          channelId: this.channelId,
          name: this.agentName,
          role: this.agentRole,
        })
      }

      // 设置模型(如果配置了 provider/model 任一;omp 以当前已设值为缺省补全,
      // 只配其一时也显式发送,避免 respawn 后静默回落默认模型)
      if (this.config.provider || this.config.model) {
        try {
          // 未配置一侧保持 undefined(JSON 序列化丢键)→ omp 以当前已设值补全
          await client.send({
            type: 'set_model',
            provider: this.config.provider as string,
            modelId: this.config.model as string,
          })
        }
        catch {
          // 模型设置失败不致命(用 omp 默认模型)
        }
      }

      // 注册 host tools(按角色差异化:lead 全量,worker 剔除调度/团队管理专属工具)
      client.onHostToolCall(req => this.handleHostTool(req, client))
      await client.send({ type: 'set_host_tools', tools: hostToolsForAgent(this.selfAgentId, this.agentRole, this.channelId) })

      // 上下文治理探测(feature-detect 一次;失败退化被动 usage 跟踪)+ 原生压缩兜底保持开启
      // 会话身份(sessionId)也由 probeContext 取回:必须 **await** —— fire-and-forget 会与
      // omp 会话 bootstrap 竞态,首回合可能取不到 → continuity 长期 sessionless(实测)。
      // 探测失败不阻塞建连(旧版 omp 无 get_state),此时由回合落定钩子 probeSessionIdentity 补探。
      try {
        await this.probeContext(client)
      }
      catch { /* 探测不可用:仅被动 usage 跟踪 */ }
      void client.send({ type: 'set_auto_compaction', enabled: true }).catch(() => {})

      this.client = client
      this.hostToolsRegistered = true
    }
  }

  /** 会话身份兜底探测(覆盖 core 的空实现):回合落定后若无 sessionId,向活客户端补探一次。 */
  protected override async probeSessionIdentity(): Promise<void> {
    const client = this.client
    if (!client || !client.alive) return
    await this.probeContext(client)
  }

  /** 上下文状态探测:get_state 取 contextWindow/sessionId(一次;失败仅损失 percent 精度) */
  protected async probeContext(client: OmpRpcClient): Promise<void> {
    try {
      const resp = await client.send({ type: 'get_state' })
      const data = (resp.data ?? {}) as Record<string, unknown>
      const model = data.model as { contextWindow?: number } | undefined
      if (typeof model?.contextWindow === 'number' && model.contextWindow > 0) {
        this.contextWindow = model.contextWindow
        client.setContextWindow(model.contextWindow)
      }
      if (typeof data.sessionId === 'string' && data.sessionId) this.sessionId = data.sessionId
    }
    catch { /* get_state 不可用:仅被动 usage */ }
  }
}
