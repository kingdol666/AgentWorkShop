/**
 * 本地数采基础设施凭据(Timescale / MinIO)的引导与分发。
 *
 * 背景(2026-10-30 安全审计 P0-5):docker-compose.yml 与 config.yml 曾把默认凭据
 * 字面量写在仓库里,且三个端口绑 0.0.0.0。现在:
 *  - compose 端口只绑 127.0.0.1;凭据一律由环境变量强注入(仓库零字面量);
 *  - 本模块在**配置服务解析之前**生成/采纳本机凭据并落到数据目录,
 *    服务端与 `docker compose` 共用同一份;
 *  - 存量部署(容器/数据卷已按旧值初始化)从**正在运行的容器**自省采纳现有值,
 *    保证升级不断连;源码中不保存任何凭据值。
 *
 * 字段名为中性标识符(tsSecret/osAccessId/osSecret),值全部来自运行时:
 * 凭据文件 → 存量容器自省 → 随机生成。任何情况下都不写死在源码里。
 *
 * 尊重显式配置:若运维通过 config.yml / 环境变量 / 运行时设置显式给了值,
 * 本模块不覆盖(见 `operatorSetKeys`)。
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataDirFor } from '@/shared/config/home.mjs'
import { findUp, loadEffective, settingsPathFor } from '@/shared/config/engine.mjs'

/** 三个凭据的持有形状(值均为运行时获得) */
export interface LocalInfraCredentials {
  /** Timescale/PostgreSQL 连接口令 */
  tsSecret: string
  /** MinIO 访问标识 */
  osAccessId: string
  /** MinIO 访问密钥 */
  osSecret: string
  /** generated=新随机; adopted=从存量容器自省(保持连通); file=读自凭据文件 */
  origin: 'generated' | 'adopted' | 'file'
}

/** 配置键(env 名由 engine.mjs 的 AW_<KEY> 规则派生,不在此重复字面量) */
const CONFIG_KEY = {
  tsSecret: 'daq.timescale.password',
  osAccessId: 'daq.objectstore.accessKey',
  osSecret: 'daq.objectstore.secretKey',
} as const

type CredField = keyof typeof CONFIG_KEY

/** 'daq.timescale.password' → 'AW_DAQ_TIMESCALE_PASSWORD'(与 engine.mjs 派生规则一致) */
export function envNameOf(cfgKey: string): string {
  return `AW_${cfgKey.toUpperCase().replace(/\./g, '_')}`
}

const CRED_FILE = 'daq-infra-credentials.json'
const CRED_ENV_FILE = 'daq-infra-credentials.env'
const TSDB_CONTAINER = 'awshop-daq-timescale'
const MINIO_CONTAINER = 'awshop-daq-minio'

/** 容器 env 里的键名(docker 镜像自带的变量名) */
const CT_KEY = { ts: 'POSTGRES_PASSWORD', osAccess: 'MINIO_ROOT_USER', osSecret: 'MINIO_ROOT_PASSWORD' } as const

export function credentialsPath(): string {
  return join(dataDirFor(), CRED_FILE)
}

/** docker compose 的 `--env-file` 形态(便于运维手动拉起同一套凭据) */
export function credentialsEnvFilePath(): string {
  return join(dataDirFor(), CRED_ENV_FILE)
}

/** 读容器环境变量(不存在/无 docker 返回 null) */
function containerEnv(name: string): Record<string, string> | null {
  try {
    const out = execFileSync('docker', ['inspect', name, '--format', '{{json .Config.Env}}'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    }).toString()
    const arr = JSON.parse(out) as string[]
    const env: Record<string, string> = {}
    for (const kv of arr) {
      const i = kv.indexOf('=')
      if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1)
    }
    return env
  }
  catch {
    return null
  }
}

/**
 * 从存量容器自省现有凭据(升级不断连的关键路径)。
 * 三个值必须全部拿到——部分采纳会造成"新值写进库、旧值连不上"的分裂。
 */
function adoptFromRunningContainers(): { tsSecret: string, osAccessId: string, osSecret: string } | null {
  const ts = containerEnv(TSDB_CONTAINER)
  const os = containerEnv(MINIO_CONTAINER)
  const tsSecret = ts?.[CT_KEY.ts]
  const osAccessId = os?.[CT_KEY.osAccess]
  const osSecret = os?.[CT_KEY.osSecret]
  if (!tsSecret || !osAccessId || !osSecret) return null
  return { tsSecret, osAccessId, osSecret }
}

/**
 * 哪些字段是运维显式配置的(env / runtime / 非空 config.yml)→ 不得覆盖。
 * 必须在把本模块的 env 注入 process.env **之前**调用。
 */
function operatorSetKeys(env: NodeJS.ProcessEnv): Set<CredField> {
  const out = new Set<CredField>()
  try {
    const cwd = process.cwd()
    const configPath = findUp(cwd, 'config.yml')
    const root = configPath ? dirname(configPath) : cwd
    const eff = loadEffective({ configPath: configPath ?? undefined, settingsPath: settingsPathFor(root), env }) as {
      effective: Record<string, unknown>
      sources: Record<string, string>
    }
    for (const [field, cfgKey] of Object.entries(CONFIG_KEY) as [CredField, string][]) {
      const src = eff.sources[cfgKey]
      const value = eff.effective[cfgKey]
      // env/runtime 显式给了 → 尊重;config.yml 给了非空真实值 → 尊重
      if (src === 'env' || src === 'runtime') out.add(field)
      else if (src === 'config.yml' && typeof value === 'string' && value.trim() !== '') out.add(field)
    }
  }
  catch { /* 配置不可读:按"未显式设置"处理,交给下方生成 */ }
  return out
}

function generate(): { tsSecret: string, osAccessId: string, osSecret: string } {
  const rand = () => randomBytes(24).toString('base64url')
  return { tsSecret: rand(), osAccessId: `awshop-${randomBytes(4).toString('hex')}`, osSecret: rand() }
}

function writeCredentials(creds: LocalInfraCredentials): void {
  const p = credentialsPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 })
  const lines = (Object.keys(CONFIG_KEY) as CredField[]).map(f => `${envNameOf(CONFIG_KEY[f])}=${creds[f]}`)
  writeFileSync(credentialsEnvFilePath(), `${lines.join('\n')}\n`, { mode: 0o600 })
}

/** 读凭据文件;不存在或损坏返回 null */
function readCredentials(): LocalInfraCredentials | null {
  const p = credentialsPath()
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<Record<CredField, unknown>> & { origin?: unknown }
    const tsSecret = raw.tsSecret
    const osSecret = raw.osSecret
    if (typeof tsSecret !== 'string' || !tsSecret) return null
    if (typeof osSecret !== 'string' || !osSecret) return null
    const osAccessId = typeof raw.osAccessId === 'string' && raw.osAccessId ? raw.osAccessId : `awshop-${osSecret.slice(0, 8)}`
    return { tsSecret, osAccessId, osSecret, origin: 'file' }
  }
  catch {
    return null
  }
}

/**
 * 取本机基础设施凭据(缺失则采纳存量容器 / 生成随机,并落盘)。幂等,可多处调用。
 * @param adopt true=允许 docker inspect 自省存量容器(需要保证连通时);false=直接随机(测试/不启容器)
 */
export function loadOrCreateCredentials({ adopt = true }: { adopt?: boolean } = {}): LocalInfraCredentials {
  const existing = readCredentials()
  if (existing) return existing
  const adopted = adopt ? adoptFromRunningContainers() : null
  const next: LocalInfraCredentials = adopted
    ? { ...adopted, origin: 'adopted' }
    : { ...generate(), origin: 'generated' }
  try {
    writeCredentials(next)
    if (adopted) {
      console.info(`[daq-infra] 已从存量容器采纳现有基础设施凭据(保持数据卷连通),落盘:${credentialsPath()}`)
    }
  }
  catch (err) {
    // 落盘失败不阻断启动:env 仍会注入,只是重启后可能与数据卷凭据不匹配
    console.warn('[daq-infra] 凭据落盘失败(重启后可能与数据卷不匹配):', err instanceof Error ? err.message : String(err))
  }
  return next
}

/**
 * 把凭据注入 process.env(仅注入未被运维显式配置的键)。
 * **必须在 system-config 服务 init 之前调用**,否则 env 覆盖不生效。
 */
export function publishCredentialsToEnv(creds = loadOrCreateCredentials(), env: NodeJS.ProcessEnv = process.env): void {
  const operatorSet = operatorSetKeys(env)
  for (const field of Object.keys(CONFIG_KEY) as CredField[]) {
    if (operatorSet.has(field)) continue
    const name = envNameOf(CONFIG_KEY[field])
    if (env[name] === undefined) env[name] = creds[field]
  }
}

/** docker compose 子进程要用的环境(显式注入) */
export function composeEnvFor(creds = loadOrCreateCredentials(), base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base }
  for (const field of Object.keys(CONFIG_KEY) as CredField[]) out[envNameOf(CONFIG_KEY[field])] = creds[field]
  return out
}
