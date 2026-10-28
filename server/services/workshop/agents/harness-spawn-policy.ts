/**
 * harness 启动面策略 —— 谁能指定"拉起什么可执行文件/在哪个目录/带什么环境"。
 *
 * 背景(2026-10-28 审计):Channel/Agent 创建接受任意 `config`，manager 原样落库，
 * 各 harness impl 直接拿 `config.command/args/cwd` 去 spawn；`assertHarnessUsable`
 * 只判断"文件存在"。任何登录账号因此可以把 lead 的 command 设成 cmd.exe/sh，
 * 在首个调度回合获得服务账号的命令执行能力。
 *
 * 本模块把判定收敛为纯函数（便于单测）：
 *  - 非 admin 不得覆盖 command/args/cwd/env（一律 403，文案给出下一步）；
 *  - admin 覆盖 command 时，basename 必须与引擎自身命令一致（omp/omp.exe…），
 *    拒绝 cmd/sh/node 等通用解释器；
 *  - cwd 必须落在 process.cwd() 或 configRoot 之下（admin 可用
 *    AW_ALLOW_ARBITRARY_HARNESS_CWD=1 显式豁免，仅限受控部署）。
 *
 * 真正的执行层防御仍在 adapters/line-spawn（不走 shell、参数逐个校验、
 * 敏感 env 剥离），本层负责"授权谁可以改这些参数"。
 */
import { basename, resolve } from 'node:path'
import { AppError } from '../../../utils/errors'

/** 引擎自身允许的命令 basename（不含扩展名比较；.cmd/.bat shim 也算同族） */
const ALLOWED_COMMANDS: Record<string, string[]> = {
  omp: ['omp'],
  claude: ['claude'],
  codex: ['codex'],
  opencode: ['opencode'],
  dsh: ['dsh'],
  gemini: ['gemini'],
  copilot: ['copilot'],
  cursor: ['cursor-agent', 'cursor'],
  crush: ['crush'],
  goose: ['goose'],
  qwen: ['qwen'],
  pi: ['pi'],
  hermes: ['hermes'],
  mock: [],
}

/** 允许被 config 覆盖的启动键（出现即需要 admin） */
export const SPAWN_CONFIG_KEYS = ['command', 'args', 'cwd', 'env'] as const

export interface SpawnActor {
  id?: string
  role: string
}

/** 覆盖了哪些启动键（空数组 = 使用平台默认，任何角色都允许） */
export function spawnOverridesOf(config: Record<string, unknown> | undefined | null): string[] {
  if (!config || typeof config !== 'object') return []
  return SPAWN_CONFIG_KEYS.filter((k) => {
    const v = config[k]
    if (v === undefined || v === null) return false
    if (typeof v === 'string') return v.trim() !== ''
    if (Array.isArray(v)) return v.length > 0
    return true
  })
}

function baseNameOf(command: string): string {
  const base = basename(command.trim()).toLowerCase()
  return base.replace(/\.(exe|cmd|bat|com|sh)$/i, '')
}

function cwdAllowed(cwd: string): boolean {
  if (process.env.AW_ALLOW_ARBITRARY_HARNESS_CWD === '1') return true
  const target = resolve(cwd)
  const roots = [resolve(process.cwd())]
  const configRoot = process.env.AW_HOME
  if (configRoot) roots.push(resolve(configRoot))
  return roots.some(root => target === root || target.startsWith(root + '\\') || target.startsWith(root + '/'))
}

/**
 * 校验一次 harness 启动配置。通过返回 void；拒绝抛 403（message 可直接给用户）。
 * @param harness 引擎 id（用于取命令白名单）
 * @param config  即将落库的 agent/channel config
 * @param actor   调用者（角色决定是否允许覆盖）
 */
export function assertSpawnConfigAllowed(
  harness: string,
  config: Record<string, unknown> | undefined | null,
  actor: SpawnActor,
): void {
  const overrides = spawnOverridesOf(config)
  if (overrides.length === 0) return
  if (actor.role !== 'admin') {
    throw new AppError(
      403,
      'HARNESS_SPAWN_FORBIDDEN',
      `自定义 harness 启动参数（${overrides.join('/')}）仅管理员可配置。请使用平台提供的引擎默认安装路径，或联系管理员在受控部署中设置。`,
    )
  }
  const command = typeof config?.command === 'string' ? config.command.trim() : ''
  if (command) {
    const base = baseNameOf(command)
    const allowed = ALLOWED_COMMANDS[harness] ?? []
    if (!allowed.includes(base)) {
      throw new AppError(
        403,
        'HARNESS_COMMAND_DENIED',
        `harness「${harness}」不允许以「${base}」启动：命令必须与该引擎自身一致（允许 ${allowed.join('/') || '(无)'}）。通用解释器（cmd/sh/node/powershell）一律拒绝。`,
      )
    }
  }
  const cwd = typeof config?.cwd === 'string' ? config.cwd.trim() : ''
  if (cwd && !cwdAllowed(cwd)) {
    throw new AppError(
      403,
      'HARNESS_CWD_DENIED',
      `harness 工作目录「${cwd}」不在允许范围内（需位于平台工作根或配置根之下）。受控部署可显式设置 AW_ALLOW_ARBITRARY_HARNESS_CWD=1。`,
    )
  }
}
