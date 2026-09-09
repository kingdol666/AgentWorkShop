/**
 * CrushAgentImpl — Charm Crush(`crush run --format json`)的 AgentInterface 实现。
 *
 * 进程模型:每回合一个 `crush run` 子进程(prompt 作为单参数投递,--format json 输出
 * JSONL 事件,opencode 血统):step_start / text / step_finish(含 cost/tokens)。
 *
 *  - steer:一次性进程模型 → 恒 'deferred'
 *  - HITL:run 模式无程序化审批面(如后续版本输出权限事件再升级)
 *  - 工具/模型:crush 配置解析序 ./.crushrc → ./crushrc → ~/.config/crush/crushrc;
 *    首次回合 merge-only 写 <workspace>/.crushrc(mcp add aw 桥 + zhipu openai-compat
 *    provider,api_key 引用 AW_CRUSH_API_KEY 环境变量,不落明文进配置文件)
 *  - 鉴权:config.apiKey → 进程 env AW_CRUSH_API_KEY(经 crushrc $() 引用) +
 *    OPENAI_API_KEY 兜底
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../logger'
import { harnessSettings } from '../settings'
import {
  OneShotCliAgentImpl,
  type OneShotEngineSpec,
} from './adapters/one-shot-cli-agent'
import { resolveBridgePath } from './harness-env'
import { toolArgsPreview } from './prompt-builder'

const log = createLogger('workshop.crush')

/** crushrc 的 bash 方言内变量引用固定为 AW_CRUSH_API_KEY(凭据不落盘) */
const CRUSH_KEY_ENV = 'AW_CRUSH_API_KEY'

/**
 * 确保 <cwd>/.crushrc 存在且含 aw 桥与 zhipu provider(仅当文件缺失时整份生成;
 * 已有用户 crushrc 时不动 —— 用户自行按官方文档接入)。
 */
export function ensureCrushConfig(cwd: string, bridgePath: string, baseUrl: string): void {
  const file = join(cwd, '.crushrc')
  if (existsSync(file)) return
  // crushrc 是 bash 方言:路径统一正斜杠,避免反斜杠被转义吞掉
  const nodePath = process.execPath.replace(/\\/g, '/')
  const bridgeForward = bridgePath.replace(/\\/g, '/')
  const lines = [
    `# AgentWorkShop 生成(幂等;删除后下次回合重建)。凭据经 ${CRUSH_KEY_ENV} 环境变量注入。`,
    `mcp add aw --command "${nodePath}" --args "${bridgeForward}" --timeout 30`,
    `provider add zhipu --type openai-compat --base-url ${baseUrl} --api-key "\${${CRUSH_KEY_ENV}}"`,
    `model add zhipu/glm-5.3-flash`,
    `model large zhipu/glm-5.3-flash`,
    '',
  ]
  try {
    writeFileSync(file, lines.join('\n'), 'utf-8')
  }
  catch (err) {
    log.warn(`.crushrc 写入失败(引擎侧将以无桥模式运行): ${err instanceof Error ? err.message : String(err)}`)
  }
}

const spec: OneShotEngineSpec = {
  harnessId: 'crush',
  resolveCommand: config => (typeof config.command === 'string' && config.command.trim() !== '' ? config.command.trim() : harnessSettings().crush_command),
  buildArgs: ({ config }) => {
    // crush v0.92:run 无 --format 旗标(JSON 输出已移除);-q 静默 spinner,输出纯文本
    const args = ['run', '-q']
    if (typeof config.model === 'string' && config.model.trim() !== '') args.push('-m', config.model.trim())
    return args
  },
  promptDelivery: 'arg',
  plainTextStdout: true,
  engineEnv: (config) => {
    const key = typeof config.apiKey === 'string' ? config.apiKey : ''
    return {
      ...(key !== '' ? { [CRUSH_KEY_ENV]: key, OPENAI_API_KEY: key } : {}),
    }
  },
  prepare: (config) => {
    const cwd = (typeof config.cwd === 'string' && config.cwd !== '' ? config.cwd : process.cwd())
    ensureCrushConfig(cwd, resolveBridgePath(typeof config.mcpBridgePath === 'string' ? config.mcpBridgePath : undefined), String(config.providerBaseUrl ?? 'https://open.bigmodel.cn/api/coding/paas/v4'))
  },
  mapLine: (json, _raw, _state, sink) => {
    const type = String(json.type ?? '')
    if (type === 'step_start' || type === 'step-start') {
      sink.status('▶ crush step')
      return
    }
    if (type === 'text') {
      const part = (json.part ?? json) as Record<string, unknown>
      if (typeof part.text === 'string') sink.delta(part.text)
      return
    }
    if (type === 'tool_use' || type === 'tool_call' || type === 'tool') {
      const part = (json.part ?? json.tool ?? json) as Record<string, unknown>
      sink.status(`🔧 ${String(part.tool ?? part.name ?? part.type ?? 'tool')}${toolArgsPreview(part.input ?? part.arguments ?? part.args)}`)
      return
    }
    if (type === 'step_finish' || type === 'step-finish') {
      const part = (json.part ?? json) as Record<string, unknown>
      const tokens = (part.tokens ?? {}) as Record<string, unknown>
      const input = Number(tokens.input ?? tokens.inputTokens ?? tokens.total)
      if (Number.isFinite(input) && input > 0) sink.usage({ inputTokens: input })
    }
  },
}

export class CrushAgentImpl extends OneShotCliAgentImpl {
  constructor(config: Record<string, unknown>) {
    super(config, spec)
  }
}
