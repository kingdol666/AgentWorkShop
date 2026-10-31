/**
 * Embedding provider — OpenAI 兼容 /embeddings 端点(配置驱动,原生 fetch 零 SDK)。
 * 未配置(memory.embed_base_url/embed_model 均空)→ 返回 null(向量分支整体关闭,记忆系统纯 FTS 降级)。
 * 覆盖链:config.yml < runtime-settings < env(AW_MEMORY_EMBED_*);原生 fetch 零 SDK。
 * 熔断:连续 3 次失败禁用 10 分钟(避免每个任务都白等超时)。
 * 维度:首次成功 embed 的返回长度(不信任配置,以实测为准)。
 */
import { memorySettings } from '../settings'
import { allowPrivateOutbound, assertSafeHttpUrl } from '../net/ssrf'

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<Float32Array[]>
  /** 已知维度(首次成功 embed 前 null) */
  dims(): number | null
}

const FAIL_THRESHOLD = 3
const COOLDOWN_MS = 10 * 60_000
const REQUEST_TIMEOUT_MS = 10_000

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
