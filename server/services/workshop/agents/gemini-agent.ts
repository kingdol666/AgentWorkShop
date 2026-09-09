/**
 * GeminiAgentImpl — Google Gemini CLI(`--output-format stream-json`)的 AgentInterface 实现。
 *
 * 进程模型:每回合一个 `gemini` 子进程(prompt 经 stdin 投递,-p 仅显式启用无头),
 * init 事件捕获 session_id。本机实测帧形(gemini 0.51.0):
 *   {"type":"init","session_id":"...","model":"auto"}
 *   {"type":"message","role":"assistant|user","content": string|parts[]}
 *   {"type":"tool_use"|"tool_result"|"result"|...};API 错误走 stderr + 非 0 退出码。
 *
 *  - steer:一次性进程模型 → 恒 'deferred'
 *  - HITL:无程序化审批面(--approval-mode 策略制;默认 default=native 工具被拒,
 *    AW 桥工具经 --allowed-mcp-server-names aw + settings trust=true 白名单放行)
 *  - 工具:<workspace>/.gemini/settings.json 合并写入 aw 桥 stdio 条目(merge-only,
 *    不动用户已有 server);agent 身份经进程 env 继承到 MCP 子进程
 *  - 已知边界:gemini 协议仅对接 Google 侧鉴权(GEMINI_API_KEY/OAuth),暂无
 *    OpenAI 兼容 provider 面 —— 自定义网关模型须由引擎侧后续版本支持
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../logger'
import { harnessSettings } from '../settings'
import {
  OneShotCliAgentImpl,
  type OneShotEngineSpec,
  type OneShotTurnState,
  type OneShotEventSink,
} from './adapters/one-shot-cli-agent'
import { resolveBridgePath, generateMcpBridgeEnv } from './harness-env'
import { toolArgsPreview } from './prompt-builder'

const log = createLogger('workshop.gemini')

/** 确保 <workspace>/.gemini/settings.json 含 aw 桥(merge-only;保留用户配置) */
export function ensureGeminiMcpConfig(cwd: string, bridgePath: string): void {
  const dir = join(cwd, '.gemini')
  const file = join(dir, 'settings.json')
  let doc: Record<string, unknown> = {}
  try {
    if (existsSync(file)) doc = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
  }
  catch (err) {
    log.warn(`gemini settings.json 解析失败,保留原文件不动: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const servers = (doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : {}) as Record<string, unknown>
  const existing = servers.aw as Record<string, unknown> | undefined
  if (existing?.command && existing?.args) return
  servers.aw = {
    command: process.execPath,
    args: [bridgePath],
    trust: true,
  }
  doc.mcpServers = servers
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(doc, null, 2), 'utf-8')
}

const spec: OneShotEngineSpec = {
  harnessId: 'gemini',
  resolveCommand: config => (typeof config.command === 'string' && config.command.trim() !== '' ? config.command.trim() : harnessSettings().gemini_command),
  buildArgs: ({ resumeSessionId, config }) => {
    const args = ['--output-format', 'stream-json', '--approval-mode', String(config.approvalMode ?? 'default'), '--allowed-mcp-server-names', 'aw']
    if (typeof config.model === 'string' && config.model.trim() !== '') args.push('--model', config.model.trim())
    if (resumeSessionId) args.push('--resume', resumeSessionId)
    return args
  },
  engineEnv: config => ({
    GEMINI_CLI_TRUST_WORKSPACE: 'true',
    ...(typeof config.apiKey === 'string' && config.apiKey !== '' ? { GEMINI_API_KEY: config.apiKey } : {}),
  }),
  prepare: (config) => {
    const cwd = (typeof config.cwd === 'string' && config.cwd !== '' ? config.cwd : process.cwd())
    const bridgePath = resolveBridgePath(typeof config.mcpBridgePath === 'string' ? config.mcpBridgePath : undefined)
    ensureGeminiMcpConfig(cwd, bridgePath)
  },
  mapLine: (json, _raw, _state: OneShotTurnState, sink: OneShotEventSink) => {
    const type = String(json.type ?? '')
    if (type === 'init') {
      sink.session(String(json.session_id ?? ''))
      sink.status(`▶ gemini(${String(json.model ?? 'auto')})`)
      return
    }
    if (type === 'message') {
      const role = String(json.role ?? '')
      if (role === 'assistant' || role === 'model') {
        const content = json.content
        if (typeof content === 'string') sink.delta(content)
        else if (Array.isArray(content)) {
          for (const part of content as Array<Record<string, unknown>>) {
            if (typeof part?.text === 'string') sink.delta(part.text)
          }
        }
      }
      return
    }
    if (type === 'tool_use' || type === 'tool_call') {
      sink.status(`🔧 ${String(json.tool_name ?? json.name ?? 'tool')}${toolArgsPreview(json.args ?? json.arguments ?? json.input)}`)
      return
    }
    if (type === 'result') {
      const stats = (json.stats ?? {}) as Record<string, unknown>
      const usage = (stats.token_usage ?? stats.usage ?? json.usage ?? {}) as Record<string, unknown>
      const input = Number(usage.input_tokens ?? usage.input ?? usage.total_tokens)
      if (Number.isFinite(input) && input > 0) sink.usage({ inputTokens: input })
      return
    }
    // error / tool_result / 其他:由退出码收口
  },
  contextWindow: config => Number(config.contextWindow ?? 1_048_576),
}

export class GeminiAgentImpl extends OneShotCliAgentImpl {
  constructor(config: Record<string, unknown>) {
    super(config, spec)
  }

  /** 桥身份 env 组装暴露给调试面(与基座 streamTurn 同源) */
  bridgeEnvPreview(): Record<string, string> {
    return generateMcpBridgeEnv({ agentId: this.selfAgentId, token: this.config.token }).bridgeEnv
  }
}
