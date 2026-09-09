/**
 * CursorAgentImpl — Cursor CLI(`cursor-agent -p --output-format stream-json`)的实现。
 *
 * 进程模型:每回合一个 `cursor-agent -p` 子进程(prompt 作为单参数投递,经消毒;
 * --stream-partial-output 提供增量 delta)。帧形(官方 headless 文档,Claude Code 同构):
 *   {"type":"system","subtype":"init","model":"..."}
 *   {"type":"assistant","timestamp_ms":..,"message":{"content":[{"text":"..."}]}}
 *   {"type":"tool_call","subtype":"started"|"completed","tool_call":{...}}
 *   {"type":"result","duration_ms":..}
 *
 *  - steer:一次性进程模型 → 恒 'deferred'
 *  - HITL:无程序化审批面(--force 二档制)。默认**不带** --force:文件变更只提案不落地
 *    (与平台写控制哲学一致);config.force=true 显式放开
 *  - 工具:--mcp-config 指向 .AgentWorkShop/harness-config/cursor/aw-mcp.json(aw 桥);
 *    agent 身份经进程 env 继承到 MCP 子进程
 *  - 已知边界:社区报告 print 模式下 MCP 工具偶发不触发(版本相关);鉴权仅
 *    CURSOR_API_KEY(Cursor 账号侧),无 OpenAI 兼容 provider 面
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { harnessSettings } from '../settings'
import {
  OneShotCliAgentImpl,
  type OneShotEngineSpec,
} from './adapters/one-shot-cli-agent'
import { resolveBridgePath } from './harness-env'
import { toolArgsPreview } from './prompt-builder'

/** aw 桥 mcp-config 固定路径(无 agent 段:身份走 env 继承,配置可共享) */
function mcpConfigPath(): string {
  return join(process.env.AW_PACKAGE_ROOT ?? process.cwd(), '.AgentWorkShop', 'harness-config', 'cursor', 'aw-mcp.json')
}

export function ensureCursorMcpConfig(bridgePath: string): void {
  const file = mcpConfigPath()
  let doc: Record<string, unknown> = {}
  try {
    if (existsSync(file)) doc = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
  }
  catch {
    doc = {}
  }
  const servers = (doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : {}) as Record<string, unknown>
  const existing = servers.aw as Record<string, unknown> | undefined
  if (existing?.command && existing?.args) return
  servers.aw = { command: process.execPath, args: [bridgePath] }
  doc.mcpServers = servers
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(doc, null, 2), 'utf-8')
}

const spec: OneShotEngineSpec = {
  harnessId: 'cursor',
  resolveCommand: config => (typeof config.command === 'string' && config.command.trim() !== '' ? config.command.trim() : harnessSettings().cursor_command),
  buildArgs: ({ config }) => {
    const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--mcp-config', mcpConfigPath()]
    if (typeof config.model === 'string' && config.model.trim() !== '') args.push('--model', config.model.trim())
    if (config.force === true) args.push('--force')
    return args
  },
  promptDelivery: 'arg',
  engineEnv: config => ({
    ...(typeof config.apiKey === 'string' && config.apiKey !== '' ? { CURSOR_API_KEY: config.apiKey } : {}),
  }),
  prepare: () => {
    ensureCursorMcpConfig(resolveBridgePath())
  },
  mapLine: (json, _raw, _state, sink) => {
    const type = String(json.type ?? '')
    if (type === 'system' && String(json.subtype ?? '') === 'init') {
      sink.status(`▶ cursor(${String(json.model ?? 'default')})`)
      return
    }
    if (type === 'assistant') {
      const msg = (json.message ?? {}) as Record<string, unknown>
      const content = msg.content ?? json.content
      if (Array.isArray(content)) {
        for (const p of content as Array<Record<string, unknown>>) {
          if (typeof p?.text === 'string' && p.text) sink.delta(p.text)
        }
      }
      else if (typeof content === 'string' && content) sink.delta(content)
      return
    }
    if (type === 'tool_call') {
      const tool = (json.tool_call ?? {}) as Record<string, unknown>
      const name = String(tool.name ?? (tool as Record<string, unknown>).tool_name ?? json.tool_name ?? 'tool')
      const status = String(json.subtype ?? '')
      sink.status(`🔧 ${name}${status === 'completed' ? ' ✓' : ''}${status !== 'completed' ? toolArgsPreview(tool.input ?? tool.arguments) : ''}`)
      return
    }
    if (type === 'result') {
      sink.status(`✓ cursor 回合完成(${Number(json.duration_ms ?? 0)}ms)`)
    }
  },
}

export class CursorAgentImpl extends OneShotCliAgentImpl {
  constructor(config: Record<string, unknown>) {
    super(config, spec)
  }
}
