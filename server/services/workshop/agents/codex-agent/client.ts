/**
 * CodexAgentImplClient —— codex 子进程与客户端管理
 * (拆分层,承 CodexAgentImplHitl;方法体与原文件逐行一致)
 */
import { CodexAgentImplHitl } from './hitl'
import type { AgentRunContext } from '../agent-interface'
import { StdioJsonRpcClient } from '../adapters/stdio-jsonrpc'
import { bindHarnessProcess, markHarnessProcessExit, registerHarnessProcess } from '../harness-process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { generateMcpBridgeEnv } from '../harness-env'
import { harnessSettings } from '../../settings'
import { join } from 'node:path'
import { log } from './helpers'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

export abstract class CodexAgentImplClient extends CodexAgentImplHitl {
  protected async ensureClient(ctx: AgentRunContext): Promise<void> {
    if (!this.workspace) this.workspace = ctx.workspace
    if (!this.agentInfo) {
      this.channelId = ctx.channelId
      this.agentRole = ctx.role
      this.refreshIdentity()
    }
    if (this.client?.alive && this.threadId) return
    if (this.client && !this.client.alive) {
      this.client = null
      this.threadId = null
    }
    this.clientStarting ??= this.startClient().finally(() => {
      this.clientStarting = null
    })
    await this.clientStarting
  }

  protected async startClient(): Promise<void> {
    const command = this.config.command ?? harnessSettings().codex_command
    const client = new StdioJsonRpcClient({
      name: 'codex',
      command,
      args: [...(this.config.args ?? []), 'app-server'],
      cwd: this.config.cwd ?? process.cwd(),
      env: generateMcpBridgeEnv({
        agentId: this.selfAgentId,
        token: this.config.token,
        baseUrl: this.config.baseUrl,
        bridgePath: this.config.mcpBridgePath,
        extra: this.config.codexHome ? { CODEX_HOME: this.config.codexHome } : {},
      }).engineEnv,
      requestTimeoutMs: 60_000,
    })
    const pidRef = { pid: undefined as number | undefined }
    client.onExit((code) => {
      if (pidRef.pid) markHarnessProcessExit(pidRef.pid, code)
      this.threadId = null
      log.warn(`[CodexAgent:${this.selfAgentId}] codex app-server 退出(code=${code});下回合自动重生`)
    })
    await client.start()
    pidRef.pid = client.pid
    if (client.pid) {
      registerHarnessProcess(client.pid, { harness: 'codex', command, args: ['app-server'] })
      bindHarnessProcess(client.pid, { agentId: this.selfAgentId, channelId: this.channelId, name: this.agentName, role: this.agentRole })
    }

    // 握手
    await client.request('initialize', {
      clientInfo: { name: 'agentworkshop', title: 'AgentWorkShop', version: '0.8.0' },
    }, 30_000)
    client.notify('initialized', {})

    // MCP 桥装配(per-agent CODEX_HOME 的 config.toml [mcp_servers.aw])
    this.writeCodexHomeConfig()

    // 建会话
    const result = await client.request('thread/start', {
      ...(this.config.model ? { model: this.config.model } : {}),
      cwd: this.config.cwd ?? process.cwd(),
      approvalPolicy: this.config.approvalPolicy ?? 'on-request',
      sandbox: this.config.sandbox ?? 'workspace-write',
    }, 60_000) as Record<string, unknown>
    const thread = (result?.thread ?? result) as Record<string, unknown>
    this.threadId = typeof thread?.id === 'string' ? thread.id : null
    if (!this.threadId) throw new Error('codex thread/start 未返回 thread id')

    // 事件监听挂接(通知在 streamTurn 内按回合订阅;此处仅挂请求处理器)
    client.onRequest((req) => {
      if (req.method === 'item/commandExecution/requestApproval' || req.method === 'item/fileChange/requestApproval') {
        const p = (req.params ?? {}) as Record<string, unknown>
        this.registerApprovalHitl(req.id, String(p.itemId ?? randomUUID()), req.method === 'item/fileChange/requestApproval' ? 'file' : 'command', p)
      }
      else if (req.method === 'tool/requestUserInput') {
        const p = (req.params ?? {}) as Record<string, unknown>
        this.registerUserInputHitl(req.id, p)
      }
      else {
        client.respondError(req.id, -32601, `方法不存在: ${req.method}`)
      }
    })

    this.client = client
  }

  /**
   * per-agent CODEX_HOME config.toml:注册 MCP 桥(required=true,桥挂了宁可失败)。
   * 已有 config.toml(从全局目录种子化复制)→ 追加本段(保留用户的 provider/model
   * 配置,自定义网关/密钥不丢失);全新目录 → 独立写入。
   *
   * 无条件种子化(不再仅当 effort 配置时才挂桥):MCP 桥是 codex worker 的 host
   * 工具面(complete_task/ops_log/…)唯一入口;不挂桥的实例模型只能拿自带 shell
   * 乱翻工作区,永远调不到 complete_task → 任务停滞被看门狗回收
   * (实测 codex 任务终态 CANCELED、交付物却只落在频道消息里的根因)。
   */
  protected writeCodexHomeConfig(): void {
    let home = this.config.codexHome
    if (!home) {
      // 自动种子化 per-agent CODEX_HOME(拷贝全局凭据/网关配置,保登录与自定义
      // provider;追加 MCP 段 + 顶部 effort)
      home = join(tmpdir(), `aw-codex-${this.selfAgentId.slice(0, 8)}`)
      this.config.codexHome = home
      for (const f of ['auth.json', 'config.toml', 'cc-switch-model-catalog.json']) {
        try {
          const src = join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.codex', f)
          if (existsSync(src)) copyFileSync(src, join(home, f))
        }
        catch { /* 单文件缺失忽略 */ }
      }
    }
    try {
      mkdirSync(home, { recursive: true })
      const configFile = join(home, 'config.toml')
      const env = generateMcpBridgeEnv({ agentId: this.selfAgentId, token: this.config.token, baseUrl: this.config.baseUrl, bridgePath: this.config.mcpBridgePath })
      const envLines = Object.entries(env.bridgeEnv).map(([k, v]) => `      ${k} = "${v}"`).join('\n')
      const section = [
        ``,
        `[mcp_servers.aw]`,
        `command = ${JSON.stringify(process.execPath)}`,
        `args = [${JSON.stringify(join(process.env.AW_PACKAGE_ROOT ?? process.cwd(), 'server', 'harness', 'aw-mcp-bridge.mjs'))}]`,
        `required = true`,
        ``,
        `[mcp_servers.aw.env]`,
        envLines,
        ``,
      ].join('\n')
      // effort 走 TOML 顶层键(model_reasoning_effort):必须位于任何 [table] 之前 → 顶部插入
      const effortLine = this.config.effort
        ? `model_reasoning_effort = ${JSON.stringify(this.config.effort)}
`
        : ''
      if (existsSync(configFile)) {
        const existing = readFileSync(configFile, 'utf-8')
        const withoutDup = this.config.effort
          ? existing.replace(/^model_reasoning_effort = .*\n?/m, '')
          : existing
        if (withoutDup.includes('[mcp_servers.aw]')) {
          if (effortLine && !withoutDup.startsWith(effortLine.trim())) {
            writeFileSync(configFile, effortLine + withoutDup, 'utf-8')
          }
          return
        }
        writeFileSync(configFile, effortLine + withoutDup + section, 'utf-8')
      }
      else {
        writeFileSync(configFile, effortLine + section, 'utf-8')
      }
    }
    catch (err) {
      log.warn(`[CodexAgent:${this.selfAgentId}] CODEX_HOME config 写入失败(信任全局配置):`, err instanceof Error ? err.message : err)
    }
  }
}
