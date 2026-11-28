/**
 * 本地向量模型下载（2026-11-28）。
 *
 * 安全边界（与 Mimosa 生成前约束一致）：
 *  - 只允许 https；host 固定白名单（HuggingFace 官方 + 公开镜像），不做任意 URL 代理；
 *  - 拒绝 IP 字面量与 localhost/环回/私网（白名单是域名，解析后的私网地址同样由
 *    下载层显式拒绝，避免 DNS 投毒把下载引到内网）；
 *  - 只写 `<AW_HOME>/models/embedding/<id>/`，文件名来自注册表而非响应头。
 *
 * 工程纪律：
 *  - 先写 `.part` 再 rename：中断/失败不会留下"看起来已安装"的半截文件；
 *  - 每模型同一时刻只允许一个下载任务（重复点击返回既有任务）；
 *  - 进度是进程内状态（下载属一次性交互，不落库；重启后按"未安装"重来）。
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { findLocalEmbeddingModel, localModelDir, totalModelBytes, type LocalEmbeddingModelDef } from './registry'
import { resetLocalEmbeddingCache } from './onnx'

export type DownloadStatus = 'running' | 'done' | 'failed' | 'canceled'

export interface DownloadJob {
  id: string
  modelId: string
  status: DownloadStatus
  received: number
  total: number
  fileIndex: number
  fileCount: number
  currentFile: string
  source: string
  error: string
  startedAt: string
  finishedAt: string
}

/**
 * 下载源白名单（2026-11-28 实机更新）：HuggingFace 会把 /resolve 302 到 Xet CAS 桥
 * （cas-bridge.xethub.hf.co 等 *.hf.co 官方子域），逐跳校验下精确主机名会误杀 ——
 * 实机 deepseek 验收轮真实抓到。改为**注册域后缀匹配**：hostname 等于条目，或以
 * '.'+条目 结尾（前导点防 evil-huggingface.co 这类同形域）；hf.co 与 huggingface.co
 * 均为 HF 官方注册域，子域内容仍受 https + 非私网校验约束。
 */
const DOWNLOAD_HOSTS = ['huggingface.co', 'hf.co', 'hf-mirror.com'] as const
function hostAllowed(hostname: string): boolean {
  return (DOWNLOAD_HOSTS as readonly string[]).some(h => hostname === h || hostname.endsWith(`.${h}`))
}
const jobs = new Map<string, DownloadJob>()
const controllers = new Map<string, AbortController>()
const activeByModel = new Map<string, string>()
const PER_REQUEST_TIMEOUT_MS = 10 * 60_000

function isPrivateHost(hostname: string): boolean {
  // IP 字面量一律拒绝（白名单只认域名）；再挡显式环回/私网/保留名
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) return true
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return true
  return false
}

function buildUrl(host: string, repo: string, path: string): string {
  return `https://${host}/${repo}/resolve/main/${path}`
}

/** 白名单 + https + 非私网校验（导出供单测锁定安全边界） */
export function assertAllowedUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:') throw new Error(`仅允许 https 下载: ${url.protocol}`)
  if (!hostAllowed(url.hostname)) throw new Error(`下载源不在白名单: ${url.hostname}`)
  if (isPrivateHost(url.hostname)) throw new Error(`拒绝私网/环回地址: ${url.hostname}`)
  return url
}

export function listDownloadJobs(): DownloadJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

/** 某模型当前是否有运行中的下载 */
export function activeJobForModel(modelId: string): DownloadJob | null {
  const id = activeByModel.get(modelId)
  if (!id) return null
  const job = jobs.get(id)
  return job && job.status === 'running' ? job : null
}

export function cancelDownloadJob(jobId: string): boolean {
  const ctrl = controllers.get(jobId)
  if (!ctrl) return false
  ctrl.abort(new Error('canceled'))
  return true
}

/**
 * 单文件下载（导出仅供测试；生产入口是 startModelDownload）。
 *
 * 进度语义（2026-11-28 实机修正）：`job.received` 必须**随字节推进**，而不是等整文件
 * rename 后一次性 +24MB —— 24MB 模型在这种实现下全程显示 0%，进度条等于摆设。
 * 现在用 Transform 计数流：每 chunk 累加；失败/取消回滚到本文件开始前的值（不虚报）。
 */
export async function downloadFile(
  def: LocalEmbeddingModelDef,
  file: { name: string, path: string },
  dir: string,
  job: DownloadJob,
  signal: AbortSignal,
): Promise<string> {
  let lastError: unknown = null
  for (const host of DOWNLOAD_HOSTS) {
    // 逐跳校验（评审发现 5，2026-11-28）：redirect:'follow' 会让白名单只约束首跳 ——
    // 镜像 302 可把后续跳转引向任意地址（含私网）。manual + 逐跳 assertAllowedUrl，≤3 跳。
    let url = assertAllowedUrl(buildUrl(host, def.repo, file.path))
    const receivedBefore = job.received
    try {
      let res: Response | null = null
      for (let hop = 0; hop < 4; hop++) {
        const r = await fetch(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS)]),
          redirect: 'manual',
          headers: { 'user-agent': 'AgentWorkShop/memory-embedding (+local model fetch)' },
        })
        if (r.status >= 300 && r.status < 400) {
          const loc = r.headers.get('location')
          if (!loc) throw new Error(`HTTP ${r.status} 重定向缺 location`)
          await r.body?.cancel()
          url = assertAllowedUrl(new URL(loc, url).toString())
          continue
        }
        res = r
        break
      }
      if (!res) throw new Error('重定向次数超限（>3 跳）')
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const contentLength = Number(res.headers.get('content-length') ?? '0')
      job.source = host
      job.currentFile = file.name
      const target = join(dir, `${file.name}.part`)
      let written = 0
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length
          job.received = receivedBefore + written
          cb(null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(target))
      const size = (await stat(target)).size
      if (size === 0) throw new Error('下载内容为空')
      if (contentLength > 0 && size !== contentLength) throw new Error(`体积不符（${size}/${contentLength}）`)
      renameSync(target, join(dir, file.name))
      job.received = receivedBefore + size
      return host
    }
    catch (err) {
      lastError = err
      // 失败/取消：进度回滚到本文件开始前（跨源重试时也不累计失败字节）
      job.received = receivedBefore
      if (signal.aborted) throw err
      // 换镜像重试；上一源的半截文件清掉
      try {
        rmSync(join(dir, `${file.name}.part`), { force: true })
      }
      catch { /* 清理失败不阻断换源 */ }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('所有下载源均失败')
}

/** 启动下载（同步返回任务视图；实际进度由 listDownloadJobs 轮询） */
export function startModelDownload(modelId: string): DownloadJob {
  const def = findLocalEmbeddingModel(modelId)
  if (!def) throw new Error(`未知模型: ${modelId}`)
  const existing = activeJobForModel(modelId)
  if (existing) return existing
  const dir = localModelDir(modelId)
  mkdirSync(dir, { recursive: true })
  const controller = new AbortController()
  const job: DownloadJob = {
    id: `dl-${randomUUID().slice(0, 8)}`,
    modelId,
    status: 'running',
    received: 0,
    total: totalModelBytes(def),
    fileIndex: 0,
    fileCount: def.files.length,
    currentFile: '',
    source: '',
    error: '',
    startedAt: new Date().toISOString(),
    finishedAt: '',
  }
  jobs.set(job.id, job)
  controllers.set(job.id, controller)
  activeByModel.set(modelId, job.id)
  // 上限 50 条任务记录（一次性交互，防长跑进程内存堆积）
  if (jobs.size > 50) {
    for (const [id, old] of jobs) {
      if (old.status !== 'running' && old.id !== job.id) jobs.delete(id)
      if (jobs.size <= 40) break
    }
  }
  void (async () => {
    const sources = new Set<string>()
    try {
      for (let i = 0; i < def.files.length; i++) {
        job.fileIndex = i
        sources.add(await downloadFile(def, def.files[i]!, dir, job, controller.signal))
      }
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
        id: def.id,
        repo: def.repo,
        dims: def.dims,
        pooling: def.pooling,
        source: [...sources].join(','),
        installedAt: new Date().toISOString(),
      }, null, 2))
      // 新模型文件就位 → 丢掉旧的 ONNX 会话缓存（同 id 换源重下也能生效）
      resetLocalEmbeddingCache()
      job.status = 'done'
    }
    catch (err) {
      job.status = controller.signal.aborted ? 'canceled' : 'failed'
      job.error = String((err as Error)?.message ?? err).slice(0, 400)
      // 失败/取消清理：半截文件 + 已完成文件一并清掉（半套文件既不能启用也不能续传，
      // 留着只会让 installedModel/用户误判）。失败与取消同口径，不再分叉。
      // 每个 rm 独立兜错（评审 P2）：前一个删不掉不能连累后一个。
      for (const f of def.files) {
        for (const name of [`${f.name}.part`, f.name]) {
          try {
            rmSync(join(dir, name), { force: true })
          }
          catch { /* 忽略 */ }
        }
      }
      try {
        rmSync(join(dir, 'manifest.json'), { force: true })
      }
      catch { /* 忽略 */ }
    }
    finally {
      job.finishedAt = new Date().toISOString()
      controllers.delete(job.id)
      if (activeByModel.get(modelId) === job.id) activeByModel.delete(modelId)
    }
  })()
  return job
}

/** 删除已安装模型（可指定目录名，防御性校验存在性） */
export function removeLocalModel(modelId: string): boolean {
  const def = findLocalEmbeddingModel(modelId)
  if (!def) return false
  const dir = localModelDir(modelId)
  if (!existsSync(dir)) return false
  // 会话缓存先释放（Windows 下打开的文件句柄会挡住 rm）
  resetLocalEmbeddingCache()
  rmSync(dir, { recursive: true, force: true })
  return true
}
