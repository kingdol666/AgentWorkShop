/**
 * OpenCodeAgentImplLayer05 —— opencode 服务进程与 HTTP 客户端
 * (分层 6/6,承 OpenCodeAgentImplLayer04;方法体与原文件逐行一致)
 */
import { OpenCodeAgentImplLayer04 } from './04-hitl'
import type { AgentRunContext } from '../agent-interface'
import { DEFAULT_PERMISSION, freePort, log, sleep } from './helpers'
import { bindHarnessProcess, killHarnessProcess, markHarnessProcessExit, registerHarnessProcess } from '../harness-process'
import { harnessSettings } from '../../settings'
import { randomUUID } from 'node:crypto'
import { resolveBridgePath, resolvePlatformBaseUrl } from '../harness-env'
import { spawnLineProcess } from '../adapters/line-spawn'

export abstract class OpenCodeAgentImplLayer05 extends OpenCodeAgentImplLayer04 {
  protected async ensureServer(ctx: AgentRunContext): Promise<void> {
    if (!this.workspace) this.workspace = ctx.workspace
    if (!this.agentInfo) {
      this.channelId = ctx.channelId
      this.agentRole = ctx.role
      this.refreshIdentity()
    }
    if (this.sessionId && this.child && !this.exited) return
    this.serverStarting ??= this.startServer().finally(() => {
      this.serverStarting = null
    })
    await this.serverStarting
  }

  protected async startServer(): Promise<void> {
    const command = this.config.command ?? harnessSettings().opencode_command
    const port = await freePort()
    const password = randomUUID()
    const cwd = this.config.cwd ?? process.cwd()
    this.exited = false
    const child = spawnLineProcess(command, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      cwd,
      env: {
        OPENCODE_SERVER_PASSWORD: password,
        ...(this.config.dataDir ? { XDG_DATA_HOME: this.config.dataDir } : {}),
        ...(this.config.configDir ? { XDG_CONFIG_HOME: this.config.configDir } : {}),
      },
    })
    this.child = child
    this.baseUrl = `http://127.0.0.1:${port}`
    this.basicAuth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-8000)
    })
    const pid = child.pid
    if (pid) {
      registerHarnessProcess(pid, { harness: 'opencode', command, args: ['serve', '--port', String(port)] })
      bindHarnessProcess(pid, { agentId: this.selfAgentId, channelId: this.channelId, name: this.agentName, role: this.agentRole })
    }
    child.on('exit', code => this.handleServerExit(code))

    // 健康探测(serve 冷启动含 provider registry,预算 60s;/global/health 需 Basic 认证)
    const deadline = Date.now() + 60_000
    let healthy = false
    while (Date.now() < deadline) {
      if (this.exited) {
        throw new Error(`opencode serve 启动失败(进程退出)${this.stderrTail ? `\nstderr: ${this.stderrTail.slice(-400)}` : ''}`)
      }
      try {
        const res = await fetch(`${this.baseUrl}/global/health`, {
          headers: { authorization: this.basicAuth },
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) {
          healthy = true
          break
        }
      }
      catch { /* 未就绪,重试 */ }
      await new Promise(r => setTimeout(r, 500))
    }
    if (!healthy) throw new Error(`opencode serve 健康探测超时(60s)${this.stderrTail ? `\nstderr: ${this.stderrTail.slice(-400)}` : ''}`)

    // 注册 MCP 桥(全量 host tools 注入;幂等;command 为 [可执行, 参数...] 数组形态)
    try {
      await this.api('POST', '/mcp', {
        name: 'aw-host-tools',
        config: {
          type: 'local',
          command: [process.execPath, resolveBridgePath(this.config.mcpBridgePath)],
          environment: {
            AW_BASE_URL: resolvePlatformBaseUrl(this.config.baseUrl),
            AW_AGENT_ID: this.selfAgentId,
            AW_AGENT_TOKEN: this.config.token ?? '',
            AW_MCP_TOOL_TIMEOUT_MS: String(200_000),
          },
        },
      })
    }
    catch (err) {
      log.warn(`[OpenCodeAgent:${this.selfAgentId}] MCP 桥注册失败(host tools 不可用):`, err instanceof Error ? err.message : err)
    }

    // 建会话(权限策略缺省全 ask;部分版本不认 permission/model 字段时降级重试;
    // model 按回合在 prompt_async 里传 —— session 创建面不接受它)
    const body: Record<string, unknown> = {
      title: `${this.agentName}@${this.channelId || 'channel'}`,
    }
    const createWith = async (extra: Record<string, unknown> | undefined): Promise<Record<string, unknown>> =>
      this.api('POST', '/session', { ...body, ...(extra ?? {}) })
    // 历史实现写作 `await (cond) ? a : b`:await 只作用于条件,整个三元表达式的结果是**未 await** 的
    // Promise,故 created?.id 恒为 undefined → sessionId 恒为 String(undefined ?? '') === '' →
    // 必然落到下面的 2.5s 重试循环(真正被使用的会话来自重试那次 createWith(undefined))。
    // 此处逐字保留该运行时语义:同样的 await 让出一次微任务、同样的请求照发、首次结果同样丢弃。
    // 直白的修法是给整个三元表达式加括号 await(会用上带 permission 的首次会话、省掉 2.5s 重试),
    // 但那会改变 opencode 会话的权限策略与启动时序,故本次不改 —— 见报告"未修的缺陷"一节。
    const firstAttempt = await (this.config.permission ?? DEFAULT_PERMISSION)
    void (firstAttempt
      ? createWith({ permission: this.config.permission ?? DEFAULT_PERMISSION }).catch(() => createWith(undefined))
      : createWith(undefined))
    this.sessionId = ''
    if (!this.sessionId) {
      // 瞬态失败(实例刚起/内部分配竞态/权限规则不兼容)→ 无附加字段重试,最多 3 次
      for (let i = 0; i < 3 && !this.sessionId; i++) {
        await sleep(2500)
        const retry = await createWith(undefined).catch(() => null)
        this.sessionId = String(retry?.id ?? '')
      }
    }
    if (!this.sessionId) {
      // 会话建不出来(版本/参数不兼容):回收 serve 子进程与句柄后抛错,防泄漏
      const detail = this.stderrTail ? ` stderr: ${this.stderrTail.slice(-300)}` : ''
      killHarnessProcess(this.child?.pid ?? -1)
      this.child = null
      this.exited = true
      throw new Error(`opencode 会话创建失败(无 session id)${detail}`)
    }

    // 订阅全局事件流
    this.openEventStream()
  }

  protected modelRef(): Record<string, string> | undefined {
    const model = this.config.model
    if (!model) return undefined
    if (model.includes('/')) {
      const [providerID, modelID] = model.split('/', 2)
      return { providerID: providerID ?? '', modelID: modelID ?? '' }
    }
    return { providerID: 'opencode', modelID: model }
  }

  protected handleServerExit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.sseAbort?.abort()
    const pid = this.child?.pid
    if (pid) markHarnessProcessExit(pid, code)
    // 在途回合经引擎错误归位:下一回合 ensureServer 重生
    log.warn(`[OpenCodeAgent:${this.selfAgentId}] opencode serve 退出(code=${code});下回合自动重生`)
  }

  /** 全局 SSE 订阅(断线重连;帧解析 data: 行) */
  protected openEventStream(): void {
    this.sseAbort?.abort()
    const ctrl = new AbortController()
    this.sseAbort = ctrl
    const connect = async (): Promise<void> => {
      while (!ctrl.signal.aborted && !this.exited) {
        try {
          const res = await fetch(`${this.baseUrl}/event`, {
            headers: { authorization: this.basicAuth, accept: 'text/event-stream' },
            signal: ctrl.signal,
          })
          if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`)
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buf = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const chunks = buf.split('\n\n')
            buf = chunks.pop() ?? ''
            for (const chunk of chunks) {
              for (const line of chunk.split('\n')) {
                if (!line.startsWith('data:')) continue
                const payload = line.slice(5).trim()
                if (!payload) continue
                try {
                  this.dispatchEngineEvent(JSON.parse(payload))
                }
                catch { /* 非 JSON data 行忽略 */ }
              }
            }
          }
        }
        catch (err) {
          if (ctrl.signal.aborted || this.exited) return
          log.warn(`[OpenCodeAgent:${this.selfAgentId}] SSE 断开(1s 后重连):`, err instanceof Error ? err.message : err)
          await new Promise(r => setTimeout(r, 1000))
        }
      }
    }
    void connect()
  }

  /** SSE 事件缓冲(回合未激活时事件即到即弃,激活后由 mapEngineEvent 消费) */
  protected engineListeners = new Set<(ev: Record<string, unknown>) => void>()

  protected dispatchEngineEvent(ev: Record<string, unknown>): void {
    for (const fn of this.engineListeners) fn(ev)
  }

  protected onEngineEvent(fn: (ev: Record<string, unknown>) => void): () => void {
    this.engineListeners.add(fn)
    return () => this.engineListeners.delete(fn)
  }

  protected async api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: this.basicAuth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    })
    if (res.status === 204) return {}
    const text = await res.text()
    let json: Record<string, unknown> = {}
    try {
      json = text ? JSON.parse(text) as Record<string, unknown> : {}
    }
    catch { /* 非 JSON 响应体 */ }
    if (!res.ok) {
      throw new Error(`opencode API ${method} ${path} → HTTP ${res.status}: ${String((json as { message?: string }).message ?? text.slice(0, 200))}`)
    }
    return json
  }

  protected async promptAsync(text: string): Promise<void> {
    if (!this.sessionId) throw new Error('会话未就绪')
    await this.api('POST', `/session/${this.sessionId}/prompt_async`, {
      parts: [{ type: 'text', text }],
      ...(this.config.agent ? { agent: this.config.agent } : {}),
      ...(this.config.model ? { model: this.modelRef() } : {}),
      ...(this.config.variant ? { variant: this.config.variant } : (this.config.effort ? { variant: this.config.effort } : {})),
    })
  }
}
