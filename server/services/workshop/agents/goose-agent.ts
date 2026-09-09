/**
 * GooseAgentImpl — Block Goose(`goose run --output-format stream-json`)的实现。
 *
 * 进程模型:每回合一个 `goose run` 子进程(prompt 作为位置参数投递)。
 * 无头姿势(官方 headless 文档):GOOSE_MODE=auto、GOOSE_CONTEXT_STRATEGY=summarize
 * (引擎原生自动摘要)、GOOSE_MAX_TURNS、GOOSE_DISABLE_SESSION_NAMING=true。
 *
 *  - steer:一次性进程模型 → 恒 'deferred'
 *  - HITL:headless 官方语义 = "配置默认或安全失败",无程序化审批面
 *  - 会话:`--name aw-<agentId>` 固定 per-agent 会话名,config.resumeSession=true 时
 *    下一回合追加 `--resume`(按名续接,无跨 agent 串扰)
 *  - 工具:extensions(aw 桥)经 ~/.config/goose/config.yaml 或 --with-extension;
 *    v1 用 GOOSE_EXTENSIONS env / config 落地(以探针为准),身份经 env 继承
 *  - 鉴权:provider 走环境变量(config.apiKey → OPENAI_API_KEY;GOOSE_PROVIDER=openai,
 *    自定义网关经 OPENAI_HOST/OPENAI_BASE_PATH)
 */
import { harnessSettings } from '../settings'
import {
  OneShotCliAgentImpl,
  type OneShotEngineSpec,
} from './adapters/one-shot-cli-agent'
import { resolveBridgePath } from './harness-env'
import { toolArgsPreview } from './prompt-builder'

/** agentId 白名单化(作为 goose 会话名段) */
function safeId(agentId: unknown): string {
  const id = String(agentId ?? 'default').replace(/[^A-Za-z0-9_-]/g, '')
  return id !== '' ? id : 'default'
}

const spec: OneShotEngineSpec = {
  harnessId: 'goose',
  resolveCommand: config => (typeof config.command === 'string' && config.command.trim() !== '' ? config.command.trim() : harnessSettings().goose_command),
  buildArgs: ({ resumeSessionId, config }) => {
    const args = ['run', '--output-format', 'stream-json', '--name', `aw-${safeId(config.agentId)}`]
    if (resumeSessionId) args.push('--resume')
    if (typeof config.model === 'string' && config.model.trim() !== '') args.push('--model', config.model.trim())
    // aw 桥以临时 extension 挂载(身份 env 随 goose 进程继承到桥子进程)
    const bridgePath = resolveBridgePath(typeof config.mcpBridgePath === 'string' ? config.mcpBridgePath : undefined)
    const nodePath = process.execPath.replace(/\\/g, '/')
    args.push('--with-extension', `${nodePath} ${bridgePath}`)
    return args
  },
  promptDelivery: 'arg',
  promptDelivery: 'arg',
  promptArgFlag: '-t',
  engineEnv: (config) => {
    const key = typeof config.apiKey === 'string' ? config.apiKey : ''
    const baseHost = typeof config.providerHost === 'string' && config.providerHost !== '' ? config.providerHost : 'https://open.bigmodel.cn'
    const basePath = typeof config.providerBasePath === 'string' && config.providerBasePath !== '' ? config.providerBasePath : '/api/coding/paas/v4/chat/completions'
    return {
      GOOSE_MODE: 'auto',
      GOOSE_CONTEXT_STRATEGY: 'summarize',
      GOOSE_DISABLE_SESSION_NAMING: 'true',
      GOOSE_PROVIDER: String(config.provider ?? 'openai'),
      ...(typeof config.model === 'string' && config.model.trim() !== '' ? { GOOSE_MODEL: config.model.trim() } : { GOOSE_MODEL: 'glm-5.3-flash' }),
      ...(key !== '' ? { OPENAI_API_KEY: key, OPENAI_HOST: baseHost, OPENAI_BASE_PATH: basePath } : {}),
      ...(Number.isFinite(Number(config.maxTurns)) ? { GOOSE_MAX_TURNS: String(config.maxTurns) } : {}),
    }
  },
  mapLine: (json, _raw, _state, sink) => {
    const type = String(json.type ?? '')
    // goose 1.50 实测帧:{"type":"message","message":{"content":[{"type":"text","text":..}]}}
    // 与 {"type":"complete","total_tokens":..};其余事件宽容解析
    if (type === 'message') {
      const msg = (json.message ?? {}) as Record<string, unknown>
      const content = msg.content
      if (typeof content === 'string') {
        sink.delta(content)
      }
      else if (Array.isArray(content)) {
        for (const p of content as Array<Record<string, unknown>>) {
          if (typeof p?.text === 'string' && p.text) sink.delta(p.text)
        }
      }
      return
    }
    if (type === 'text') {
      if (typeof json.text === 'string') sink.delta(json.text)
      return
    }
    if (type === 'tool_call' || type === 'tool_use' || type === 'tool_output') {
      const tool = (json.tool_call ?? json.tool ?? json) as Record<string, unknown>
      sink.status(`🔧 ${String(tool.name ?? tool.tool_name ?? type)}${toolArgsPreview(tool.input ?? tool.arguments ?? tool.args)}`)
      return
    }
    if (type === 'complete' || type === 'result') {
      const input = Number(json.total_tokens ?? json.input_tokens)
      if (Number.isFinite(input) && input > 0) sink.usage({ inputTokens: input })
    }
  },
}

export class GooseAgentImpl extends OneShotCliAgentImpl {
  constructor(config: Record<string, unknown>) {
    super(config, spec)
  }
}
