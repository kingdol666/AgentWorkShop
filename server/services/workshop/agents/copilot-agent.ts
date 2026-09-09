/**
 * CopilotAgentImpl — GitHub Copilot CLI(`-p/--output-format json`)的 AgentInterface 实现。
 *
 * 进程模型:每回合一个 `copilot` 子进程(prompt 经 stdin 管道投递,--output-format json
 * 输出 JSONL)。鉴权走 token 链(COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN,
 * 服务端无需浏览器);配置经 COPILOT_HOME 按 agent 隔离(<root>/.AgentWorkShop/
 * harness-config/copilot/<agentId>/,内种子 mcp-config.json 挂 aw 桥)。
 *
 *  - steer:一次性进程模型 → 恒 'deferred'
 *  - HITL:无程序化审批面(--allow-tool 白名单制)。默认仅授权 aw 桥工具
 *    (--allow-tool aw),native shell/write 保持未授权;config.copilotAllowTools 可扩
 *  - 事件帧:JSONL 逐行(行级 schema 以探针为准;解析器对未知 type 忽略并计数)
 */
import { isAbsolute, join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { createLogger } from '../logger'
import { harnessSettings } from '../settings'
import {
  OneShotCliAgentImpl,
  type OneShotEngineSpec,
} from './adapters/one-shot-cli-agent'
import { resolveBridgePath } from './harness-env'
import { toolArgsPreview } from './prompt-builder'

const log = createLogger('workshop.copilot')

/** agentId 白名单化(仅作为路径段使用;杜绝 ../ 与分隔符注入) */
function safeId(agentId: unknown): string {
  const id = String(agentId ?? 'default').replace(/[^A-Za-z0-9_-]/g, '')
  return id !== '' ? id : 'default'
}

/** COPILOT_HOME 解析:显式 config 路径须为绝对路径且不含 .. 段;否则落配置根白名单目录 */
function resolveCopilotHome(config: Record<string, unknown>): string {
  const raw = typeof config.copilotHome === 'string' ? config.copilotHome.trim() : ''
  if (raw !== '') {
    if (raw.split(/[\\/]/).includes('..') || !isAbsolute(raw)) {
      throw new Error(`copilotHome 必须是不含 .. 的绝对路径: ${JSON.stringify(raw.slice(0, 80))}`)
    }
    return resolve(raw)
  }
  const root = process.env.AW_PACKAGE_ROOT ?? process.cwd()
  return join(root, '.AgentWorkShop', 'harness-config', 'copilot', safeId(config.agentId))
}

/** 确保 <copilotHome>/mcp-config.json 含 aw 桥(merge-only) */
export function ensureCopilotMcpConfig(home: string, bridgePath: string): void {
  mkdirSync(home, { recursive: true })
  const file = join(home, 'mcp-config.json')
  let doc: Record<string, unknown> = {}
  try {
    if (existsSync(file)) doc = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
  }
  catch (err) {
    log.warn(`copilot mcp-config.json 解析失败,保留原文件: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const servers = (doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : {}) as Record<string, unknown>
  const existing = servers.aw as Record<string, unknown> | undefined
  if (existing?.command && existing?.args) return
  servers.aw = { type: 'stdio', command: process.execPath, args: [bridgePath] }
  doc.mcpServers = servers
  writeFileSync(file, JSON.stringify(doc, null, 2), 'utf-8')
}

/** 从行 JSON 中尽力抽取文本增量/工具名(官方行级 schema 未稳定,宽容解析) */
function extractAssistantText(json: Record<string, unknown>): string {
  const msg = (json.message ?? {}) as Record<string, unknown>
  const content = (json.content ?? msg.content) as unknown
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p) => {
      const part = p as Record<string, unknown>
      if (typeof part?.text === 'string') return part.text
      return ''
    }).join('')
  }
  if (typeof json.text === 'string') return json.text
  if (typeof msg.text === 'string') return msg.text
  return ''
}

const spec: OneShotEngineSpec = {
  harnessId: 'copilot',
  resolveCommand: config => (typeof config.command === 'string' && config.command.trim() !== '' ? config.command.trim() : harnessSettings().copilot_command),
  buildArgs: ({ config }) => {
    const args = ['--output-format', 'json', '--no-ask-user', '--allow-tool', 'aw']
    if (typeof config.model === 'string' && config.model.trim() !== '') args.push('--model', config.model.trim())
    const extra = Array.isArray(config.copilotAllowTools) ? config.copilotAllowTools as unknown[] : []
    for (const t of extra) {
      if (typeof t === 'string' && t.trim() !== '') args.push('--allow-tool', t.trim())
    }
    return args
  },
  engineEnv: (config) => {
    let home: string
    try {
      home = resolveCopilotHome(config)
    }
    catch (err) {
      log.warn(`copilotHome 非法,回退默认目录: ${err instanceof Error ? err.message : String(err)}`)
      home = join(process.env.AW_PACKAGE_ROOT ?? process.cwd(), '.AgentWorkShop', 'harness-config', 'copilot', safeId(config.agentId))
    }
    return {
      COPILOT_HOME: home,
      ...(typeof config.apiKey === 'string' && config.apiKey !== '' ? { COPILOT_GITHUB_TOKEN: config.apiKey } : {}),
    }
  },
  prepare: (config) => {
    ensureCopilotMcpConfig(resolveCopilotHome(config), resolveBridgePath(typeof config.mcpBridgePath === 'string' ? config.mcpBridgePath : undefined))
  },
  mapLine: (json, _raw, _state, sink) => {
    const type = String(json.type ?? '')
    if (type === 'assistant' || type === 'message' || (!type && (json.message || json.content))) {
      const text = extractAssistantText(json)
      if (text) sink.delta(text)
      return
    }
    if (type === 'tool_call' || type === 'tool_use' || type === 'tool') {
      const tool = (json.tool_call ?? json.tool ?? json) as Record<string, unknown>
      sink.status(`🔧 ${String(tool.name ?? tool.tool_name ?? type)}${toolArgsPreview(tool.input ?? tool.arguments ?? tool.args)}`)
      return
    }
    if (type === 'result' || type === 'done') {
      const usage = (json.usage ?? json.token_usage ?? {}) as Record<string, unknown>
      const input = Number(usage.input_tokens ?? usage.input ?? usage.total_tokens)
      if (Number.isFinite(input) && input > 0) sink.usage({ inputTokens: input })
    }
  },
}

export class CopilotAgentImpl extends OneShotCliAgentImpl {
  constructor(config: Record<string, unknown>) {
    super(config, spec)
  }
}
