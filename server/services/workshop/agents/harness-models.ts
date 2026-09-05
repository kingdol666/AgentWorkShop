/**
 * HarnessModelCatalog —— 各 harness 已配置的 LLM provider/model 目录发现(带缓存)。
 *
 * 归一化形状:{ providers: [{ id, models: [{ id, efforts?: string[], defaultEffort?: string }] }] }
 *  - omp:      `omp models list`(provider 分组表;thinking 列 = effort 级别)
 *  - codex:    `codex app-server` initialize → model/list(supportedReasoningEfforts)
 *  - opencode: `opencode models`(provider/model 行;effort = variant 自由串,由 UI 提示)
 *  - dsh:      内置 deepseek-official(适配器已知模型/effort)+ ~/.dsh/settings.yaml 的
 *              llm-pi-ai.providers 自定义网关(轻量行解析)
 *
 * 全部子进程拉起走受控面(line-spawn);目录结果缓存 5 分钟(目录变更低频)。
 * 用户目录读取一律经 homeDir() 白名单解析(resolve + 前缀边界校验),不接受任意路径输入。
 */
import { resolve, sep } from 'node:path'
import { spawnLineProcess } from './adapters/line-spawn'
import { StdioJsonRpcClient } from './adapters/stdio-jsonrpc'

export interface CatalogModel {
  id: string
  /** 支持的思考 effort 级别(空数组 = 引擎/模型未透出;opencode 为 variant 自由串) */
  efforts: string[]
  defaultEffort?: string
}
export interface CatalogProvider {
  id: string
  models: CatalogModel[]
}
export interface HarnessCatalog {
  providers: CatalogProvider[]
  /** effort 选取方式:levels=枚举选择;freetext=自由串(variant);unsupported=不可设 */
  effortMode: 'levels' | 'freetext' | 'unsupported'
  /** 透传提示(如 opencode variant 语义) */
  note?: string
}

const CACHE_TTL_MS = 5 * 60_000
const cache = new Map<string, { at: number, catalog: HarnessCatalog }>()

function getCached(id: string): HarnessCatalog | null {
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.catalog
  return null
}

function putCached(id: string, catalog: HarnessCatalog): HarnessCatalog {
  cache.set(id, { at: Date.now(), catalog })
  return catalog
}

/** 受控拉起并收集 stdout(超时强杀;env 增量仅注入进程,不做 shell 拼接) */
async function collect(command: string, args: string[], timeoutMs = 60_000, env?: Record<string, string>): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawnLineProcess(command, args, { env })
    let out = ''
    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (d: string) => {
      out += d
    })
    child.on('error', err => reject(err))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(out)
    }, timeoutMs)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}

/** 用户主目录(resolve 后;空串保护) */
function homeDir(): string {
  return resolve(process.env.HOME ?? process.env.USERPROFILE ?? '')
}

// ── omp:`omp models list` ──
// 输出形状:provider 头行 `<name> (N)`(顶格),模型行 `│ model │ ctx │ out │ thinking │ images │`
async function ompCatalog(): Promise<HarnessCatalog> {
  const out = await collect('omp', ['models', 'list'], 45_000)
  const providers: CatalogProvider[] = []
  let current: CatalogProvider | null = null
  for (const rawLine of out.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const header = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*\(\d+\)\s*$/)
    if (header) {
      current = { id: header[1] ?? '', models: [] }
      providers.push(current)
      continue
    }
    if (!current || !line.startsWith('│')) continue
    const cells = line.split('│').map(c => c.trim())
    const modelId = cells[1]
    if (!modelId || modelId === 'model') continue
    const thinking = (cells[4] ?? '').replace(/\s+/g, '')
    const efforts = thinking && !/^[—-]+$/.test(thinking) ? thinking.split(',').filter(Boolean) : []
    current.models.push({ id: modelId, efforts, defaultEffort: efforts[0] })
  }
  return { providers: providers.filter(p => p.models.length > 0), effortMode: 'levels' }
}

// ── codex:app-server model/list ──
interface CodexModelRaw {
  id?: string
  model?: string
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>
  defaultReasoningEffort?: string
}
async function codexCatalog(): Promise<HarnessCatalog> {
  const client = new StdioJsonRpcClient({ name: 'codex-models', command: 'codex', args: ['app-server'], requestTimeoutMs: 30_000 })
  try {
    await client.start()
    await client.request('initialize', { clientInfo: { name: 'agentworkshop-catalog', title: 'AgentWorkShop', version: '0.0.1' } }, 30_000)
    client.notify('initialized', {})
    const result = await client.request('model/list', {}, 30_000) as { data?: CodexModelRaw[] }
    const models: CatalogModel[] = (result?.data ?? []).map((m) => {
      const efforts = (m.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort ?? '').filter(Boolean)
      return { id: String(m.model ?? m.id ?? ''), efforts, defaultEffort: m.defaultReasoningEffort }
    }).filter(m => m.id)
    // codex 的 provider 由用户 config.toml 的 model_provider 决定(model/list 不分组)
    return { providers: [{ id: 'default', models }], effortMode: 'levels' }
  }
  finally {
    await client.dispose().catch(() => {})
  }
}

// ── opencode:`opencode models`(一次性临时数据目录 + 定点凭据拷贝)──
async function opencodeCatalog(): Promise<HarnessCatalog> {
  const { mkdtempSync, copyFileSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dataDir = resolve(mkdtempSync(join(tmpdir(), 'aw-oc-cat-')))
  try {
    mkdirSync(join(dataDir, 'opencode'), { recursive: true })
    const home = homeDir()
    const src = resolve(home, '.local', 'share', 'opencode', 'auth.json')
    const dst = resolve(dataDir, 'opencode', 'auth.json')
    // 只允许「全局 opencode 数据目录 → 本次一次性临时数据目录」的定点拷贝
    if (src.startsWith(home + sep) && dst.startsWith(dataDir + sep)) copyFileSync(src, dst)
  }
  catch { /* 无凭据则按未登录目录输出 */ }
  const configDir = resolve(mkdtempSync(join(tmpdir(), 'aw-oc-catc-')))
  const out = await collect('opencode', ['models'], 60_000, { XDG_DATA_HOME: dataDir, XDG_CONFIG_HOME: configDir })
  const providers = new Map<string, CatalogProvider>()
  for (const rawLine of out.split('\n')) {
    const line = rawLine.trim()
    if (!line || !line.includes('/')) continue
    const slash = line.indexOf('/')
    const provider = line.slice(0, slash)
    const model = line.slice(slash + 1).trim()
    if (!provider || !model) continue
    let p = providers.get(provider)
    if (!p) {
      p = { id: provider, models: [] }
      providers.set(provider, p)
    }
    p.models.push({ id: model, efforts: [] })
  }
  return {
    providers: [...providers.values()],
    effortMode: 'freetext',
    note: 'opencode 的 effort 以 provider variant 透传(自由串);常用 high/max,以 provider 实测为准',
  }
}

// ── dsh:内置 adapter 目录 + settings.yaml 自定义网关(轻量行解析)──
async function dshCatalog(): Promise<HarnessCatalog> {
  const providers: CatalogProvider[] = [{
    id: 'deepseek-official',
    models: [
      { id: 'deepseek-v4-flash', efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' },
      { id: 'deepseek-v4-pro', efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' },
    ],
  }]
  // settings.yaml 只允许从 ~/.dsh 读取(homeDir 白名单内定点解析)
  const dshHome = homeDir() ? resolve(homeDir(), '.dsh') : ''
  const settingsPath = resolve(dshHome, 'settings.yaml')
  if (dshHome.length > 0 && settingsPath.startsWith(dshHome + sep)) {
    try {
      const { readFileSync } = await import('node:fs')
      const raw = readFileSync(settingsPath, 'utf-8')
      // 轻量解析:llm-pi-ai.providers.<id>: 下的 models: - id: 与 reasoningEfforts: 键
      const lines = raw.split('\n')
      let inLlm = false
      let inProviders = false
      let current: CatalogProvider | null = null
      let inModels = false
      let inEfforts = false
      let effortModel: CatalogModel | null = null
      for (const line of lines) {
        if (/^llm-pi-ai:\s*$/.test(line)) {
          inLlm = true
          continue
        }
        if (/^\S/.test(line)) {
          inLlm = false
          current = null
          inModels = false
          inEfforts = false
        }
        if (!inLlm) continue
        // providers 容器键(2 空格);具体 provider 在其下 4 空格缩进
        if (/^ {2}providers:\s*$/.test(line)) {
          inProviders = true
          continue
        }
        const provMatch = line.match(/^ {4}([A-Za-z0-9_-]+):\s*$/)
        if (inProviders && provMatch) {
          current = { id: provMatch[1] ?? '', models: [] }
          providers.push(current)
          inModels = false
          inEfforts = false
          continue
        }
        if (!current) continue
        if (/^\s+models:\s*$/.test(line)) {
          inModels = true
          inEfforts = false
          continue
        }
        const modelId = line.match(/^\s+- id:\s*(\S+)/)
        if (inModels && modelId) {
          effortModel = { id: modelId[1] ?? '', efforts: [] }
          current.models.push(effortModel)
          inEfforts = false
          continue
        }
        if (/^\s+reasoningEfforts:\s*$/.test(line)) {
          inEfforts = true
          continue
        }
        if (inEfforts) {
          const effKey = line.match(/^\s+([A-Za-z]+):\s*$/)
          if (effKey && effortModel) {
            effortModel.efforts.push(effKey[1] ?? '')
            continue
          }
          if (!/^\s{8,}\S/.test(line)) inEfforts = false
        }
      }
    }
    catch { /* 无 settings.yaml/解析失败 → 仅内置目录 */ }
  }
  return { providers: providers.filter(p => p.models.length > 0), effortMode: 'levels' }
}

/** 目录发现入口(5 分钟缓存;未知 harness 返回空目录) */
export async function harnessModelCatalog(id: string): Promise<HarnessCatalog> {
  const hit = getCached(id)
  if (hit) return hit
  let catalog: HarnessCatalog
  switch (id) {
    case 'omp':
      catalog = await ompCatalog()
      break
    case 'codex':
      catalog = await codexCatalog()
      break
    case 'opencode':
      catalog = await opencodeCatalog()
      break
    case 'dsh':
      catalog = await dshCatalog()
      break
    default:
      catalog = { providers: [], effortMode: 'unsupported', note: '该 harness 未提供模型目录面' }
  }
  return putCached(id, catalog)
}
