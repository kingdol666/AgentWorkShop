/**
 * Embedding provider — 三种来源（配置驱动，原生 fetch / 本地 ONNX 零外部服务）：
 *  1) 本地模型（memory.embed_local_model 指向已下载的 ONNX，见 memory/local-embedding）
 *  2) OpenAI 兼容 /embeddings 端点（memory.embed_base_url + embed_model）
 *  3) 均未配置 → null（向量分支整体关闭，记忆系统纯 FTS 降级）
 * 覆盖链:config.yml < runtime-settings < env(AW_MEMORY_EMBED_*);原生 fetch 零 SDK。
 * 熔断:HTTP 端点连续 3 次失败禁用 10 分钟(避免每个任务都白等超时)。
 * 维度:HTTP 首次成功 embed 的返回长度(不信任配置,以实测为准);本地模型维度由注册表声明。
 *
 * 活性：getEmbeddingProvider() 按配置指纹缓存,模型启用/删除/设置变更后由
 * invalidateEmbeddingProvider() 重建 —— 记忆中心"启用模型"无需重启进程。
 */
import { memorySettings } from '../settings'
import { allowPrivateOutbound, assertSafeHttpUrl } from '../net/ssrf'
import { installedModel } from '../memory/local-embedding/registry'
import { embedWithLocalModel } from '../memory/local-embedding/onnx'

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<Float32Array[]>
  /** 检索查询向量(可带模型的检索指令/前缀);缺省回落 embed */
  embedQuery?(texts: string[]): Promise<Float32Array[]>
  /** 已知维度(HTTP 首次成功 embed 前 null) */
  dims(): number | null
  /** 来源描述(健康面板/记忆中心展示) */
  describe?(): { kind: 'local' | 'http', model: string }
}

const FAIL_THRESHOLD = 3
const COOLDOWN_MS = 10 * 60_000
const REQUEST_TIMEOUT_MS = 10_000

/** 本地 ONNX 模型 provider：维度静态已知，查询/文档走不同前缀 */
export function createLocalEmbeddingProvider(modelId: string): EmbeddingProvider | null {
  const info = installedModel(modelId)
  if (!info) return null
  const def = info.def
  return {
    dims: () => def.dims,
    describe: () => ({ kind: 'local', model: def.id }),
    embed: texts => embedWithLocalModel(def.id, texts, 'passage'),
    embedQuery: texts => embedWithLocalModel(def.id, texts, 'query'),
  }
}

export function createEnvEmbeddingProvider(): EmbeddingProvider | null {
  const memoryCfg = memorySettings()
  const baseUrl = memoryCfg.embed_base_url || undefined
  const model = memoryCfg.embed_model || undefined
  if (!baseUrl || !model) return null
  const apiKey = memoryCfg.embed_api_key ?? ''
  let dims: number | null = null
  let fails = 0
  let disabledUntil = 0
  // baseUrl 来自运行时设置(admin 可改):必须过 SSRF 护栏,否则可被指向内网/元数据服务。
  // 每实例校验一次(URL 不变),失败即永久熔断并记原因。
  let urlChecked = false
  let urlError: string | null = null

  return {
    dims: () => dims,
    describe: () => ({ kind: 'http', model }),
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (Date.now() < disabledUntil) throw new Error('embedding provider 冷却中')
      if (!urlChecked) {
        urlChecked = true
        try {
          await assertSafeHttpUrl(baseUrl, { label: 'embedding 服务', allowPrivateHost: allowPrivateOutbound() ? 'true' : 'false' })
        }
        catch (err) {
          urlError = err instanceof Error ? err.message : String(err)
          disabledUntil = Number.POSITIVE_INFINITY
          // cause 保留原始错误栈/类型,便于上游诊断 SSRF 拒因
          throw new Error(`embedding 服务地址被 SSRF 防护拒绝:${urlError}`, { cause: err })
        }
      }
      let res: Response
      try {
        res = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ input: texts, model }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      }
      catch (err) {
        // 网络层失败(拒绝连接/超时)同样计入熔断——超时是最常见失败形态
        if (++fails >= FAIL_THRESHOLD) {
          disabledUntil = Date.now() + COOLDOWN_MS
          fails = 0
        }
        throw err
      }
      if (!res.ok) {
        if (++fails >= FAIL_THRESHOLD) {
          disabledUntil = Date.now() + COOLDOWN_MS
          fails = 0
        }
        throw new Error(`embedding HTTP ${res.status}`)
      }
      const json = await res.json() as { data: Array<{ embedding: number[] }> }
      dims = json.data[0]?.embedding.length ?? dims
      fails = 0
      return json.data.map(d => Float32Array.from(d.embedding))
    },
  }
}

/** 测试用确定性词袋 hash provider:相同词集 → 相近向量(零网络)。 */
export function createHashEmbeddingProvider(dims: number): EmbeddingProvider {
  return {
    dims: () => dims,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => {
        const v = new Float32Array(dims)
        for (const w of t.toLowerCase().split(/\s+/).filter(Boolean)) {
          let h = 2166136261
          for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619)
          v[Math.abs(h) % dims] = (v[Math.abs(h) % dims] ?? 0) + 1
        }
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
        return v.map(x => x / norm) as Float32Array
      })
    },
  }
}

// ===== 进程级 provider 解析（按配置指纹缓存；模型启用/删除后热切换）=====

interface ResolvedProvider {
  fingerprint: string
  provider: EmbeddingProvider | null
}

let resolved: ResolvedProvider | null = null

function currentFingerprint(): string {
  const cfg = memorySettings()
  return [cfg.embed_local_model ?? '', cfg.embed_base_url ?? '', cfg.embed_model ?? '', cfg.embed_api_key ? 'k' : ''].join('|')
}

/**
 * 当前生效的向量 provider（本地模型优先于 HTTP 端点：本地模型是用户在记忆中心
 * 显式"启用"的选择，HTTP 端点是运维级兜底）。
 * 配置或已安装状态变化时自动重建——所以"下载→启用→回填"全流程无需重启。
 */
export function getEmbeddingProvider(): EmbeddingProvider | null {
  const fingerprint = currentFingerprint()
  const localId = (memorySettings().embed_local_model ?? '').trim()
  // 已安装状态参与指纹：模型被删除/重下后必须换实例（旧会话持有已删文件的句柄）
  const localReady = localId ? installedModel(localId) !== null : false
  const full = `${fingerprint}|${localReady ? 'ready' : 'missing'}`
  if (resolved && resolved.fingerprint === full) return resolved.provider
  let provider: EmbeddingProvider | null = null
  if (localId && localReady) provider = createLocalEmbeddingProvider(localId)
  if (!provider) provider = createEnvEmbeddingProvider()
  resolved = { fingerprint: full, provider }
  return provider
}

/** 强制重建（模型启用/删除/设置写入后调用；不改变配置时也生效） */
export function invalidateEmbeddingProvider(): void {
  resolved = null
}

export type EmbeddingProviderInfo
  = | { kind: 'local', model: string, dims: number }
    | { kind: 'http', model: string, baseUrl: string, dims: number | null, warning?: 'local_model_missing' }
    | { kind: 'none', reason: 'not_configured' | 'local_model_missing', localModelId: string }

/** 只读描述（记忆中心/健康面板展示"当前用的是什么"）；与 getEmbeddingProvider 同序 */
export function embeddingProviderInfo(): EmbeddingProviderInfo {
  const cfg = memorySettings()
  const localId = (cfg.embed_local_model ?? '').trim()
  const localMissing = localId !== '' && installedModel(localId) === null
  if (localId && !localMissing) {
    const info = installedModel(localId)!
    return { kind: 'local', model: localId, dims: info.def.dims }
  }
  if (cfg.embed_base_url && cfg.embed_model) {
    return {
      kind: 'http',
      model: cfg.embed_model,
      baseUrl: cfg.embed_base_url,
      dims: null,
      ...(localMissing ? { warning: 'local_model_missing' as const } : {}),
    }
  }
  if (localMissing) return { kind: 'none', reason: 'local_model_missing', localModelId: localId }
  return { kind: 'none', reason: 'not_configured', localModelId: '' }
}
