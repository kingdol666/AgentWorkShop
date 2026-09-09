/**
 * PiAgentImpl — pi coding agent(@mariozechner/pi-coding-agent,`pi -p --mode json`)的实现。
 *
 * 进程模型:每回合一个 `pi` 子进程(prompt 位置参数投递),--mode json 输出 JSONL 事件流:
 *   {type:"session",id} / {type:"message_end",message:{role:"assistant",content[],usage}}
 *   / {type:"message_update",assistantMessageEvent:{type:"text_delta"...}} / {type:"turn_end"}。
 *
 *  - steer:一次性进程模型 → 恒 'deferred';HITL:无程序化审批面
 *  - 工具:pi 无内建 MCP → 以零依赖扩展(server/harness/pi-aw-tools.mjs,经 -e 加载)注册
 *    平台 host tools;工具清单由 prepare() 从 hostToolsForRole 写入临时文件(AW_PI_TOOLS_FILE);
 *    execute 走平台 HTTP 回程(身份 env 由 pi 进程继承到扩展)
 *  - 鉴权/provider:provider/model 自定义(pi --provider/--model + ~/.pi/agent/models.json,
 *    智谱 anthropic-messages 网关实测可用);--api-key 可由 config.apiKey 透传
 *  - 上下文:usage 从 assistant message_end 透出
 */
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { harnessSettings } from '../settings'
import {
  OneShotCliAgentImpl,
  type OneShotEngineSpec,
} from './adapters/one-shot-cli-agent'
import { resolveBridgePath } from './harness-env'
import { hostToolsForRole } from './host-tool-bridge'

/** 安全路径段:agentId 白名单化(仅作为路径段使用) */
function safeId(agentId: unknown): string {
  const id = String(agentId ?? 'default').replace(/[^A-Za-z0-9_-]/g, '')
  return id !== '' ? id : 'default'
}

/** pi 扩展文件路径:与 aw-mcp-bridge.mjs 同目录;显式覆盖必须是含 .. 的绝对路径才接受 */
function piExtensionPath(config: Record<string, unknown>): string {
  const override = typeof config.piExtensionPath === 'string' ? config.piExtensionPath.trim() : ''
  if (override !== '') {
    if (override.split(/[\\/]/).includes('..') || !isAbsolute(override)) {
      throw new Error(`piExtensionPath 必须是不含 .. 的绝对路径: ${JSON.stringify(override.slice(0, 80))}`)
    }
    return resolve(override)
  }
  return join(dirname(resolveBridgePath()), 'pi-aw-tools.mjs')
}

/** 工具清单文件落在配置根白名单目录内 */
function toolsFilePath(config: Record<string, unknown>): string {
  const root = resolve(process.env.AW_PACKAGE_ROOT ?? process.cwd())
  return join(root, '.AgentWorkShop', 'harness-config', 'pi', `aw-tools-${safeId(config.agentId)}.json`)
}

const spec: OneShotEngineSpec = {
  harnessId: 'pi',
  resolveCommand: config => (typeof config.command === 'string' && config.command.trim() !== '' ? config.command.trim() : harnessSettings().pi_command),
  buildArgs: ({ config }) => {
    const args = [
      '-p',
      '--mode', 'json',
      '--provider', String(config.provider ?? 'zhipu'),
      '--model', String(config.model ?? 'glm-5.3-flash'),
      '-e', piExtensionPath(config),
    ]
    if (typeof config.apiKey === 'string' && config.apiKey !== '') args.push('--api-key', config.apiKey)
    if (typeof config.thinking === 'string' && config.thinking !== '') args.push('--thinking', config.thinking)
    return args
  },
  promptDelivery: 'argFile',
  engineEnv: (config) => {
    const env: Record<string, string> = {}
    if (typeof config.apiKey === 'string' && config.apiKey !== '') env.ZHIPU_API_KEY = config.apiKey
    env.AW_PI_TOOLS_FILE = toolsFilePath(config)
    return env
  },
  prepare: (config) => {
    // 把本角色可见的 host tools 写成文件,扩展同步读取注册(agent 身份 env 已注入 pi 进程)
    const file = toolsFilePath(config)
    const tools = hostToolsForRole(
      config.role === 'lead' ? 'lead' : 'worker',
      typeof config.channelId === 'string' ? config.channelId : undefined,
    )
    mkdirSync(dirname(file) + sep, { recursive: true })
    writeFileSync(file, JSON.stringify(tools), 'utf-8')
  },
  mapLine: (json, _raw, _state, sink) => {
    const type = String(json.type ?? '')
    if (type === 'session') {
      if (typeof json.id === 'string') sink.session(json.id)
      return
    }
    if (type === 'message_end') {
      const msg = (json.message ?? {}) as Record<string, unknown>
      if (String(msg.role ?? '') !== 'assistant') return
      const content = Array.isArray(msg.content) ? msg.content as Array<Record<string, unknown>> : []
      for (const part of content) {
        if (typeof part?.text === 'string' && part.text) sink.delta(part.text)
      }
      const usage = (msg.usage ?? {}) as Record<string, unknown>
      const total = Number(usage.totalTokens ?? ((Number(usage.input ?? 0)) + (Number(usage.output ?? 0))))
      if (total > 0) sink.usage({ inputTokens: total })
      return
    }
    // message_update(增量)/turn_*/agent_* :文本在 message_end 整段透出,此处不重复计
  },
}

export class PiAgentImpl extends OneShotCliAgentImpl {
  constructor(config: Record<string, unknown>) {
    super(config, spec)
  }
}
