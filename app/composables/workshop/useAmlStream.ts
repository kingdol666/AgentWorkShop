/**
 * useAmlStream —— AML 自动建模实时流的前端单一消费口(与 useDcwStream/useOpsLog 对称)。
 *
 * 数据权威在 server:REST 快照(GET /api/workshop/aml/*)+ WS 实时帧增量收敛
 * (aml.job 训练进度 / aml.dataset 数据集构建 / aml.model 模型晋升,均经 townBus 旁路)。
 * townBus 单例挂 globalThis,subscribe 返回退订函数;ensure() 幂等建订阅,dispose() 释放。
 */
import { ref } from 'vue'
import { useTownBus } from './useTownBus'
import type { AepEnvelope } from '#shared/workshop-protocol'

/** aml.job 帧 payload(server/services/workshop/aml/job-orchestrator broadcastSceneEvent) */
export interface AmlJobFrame {
  jobId: string
  datasetId: string
  lineId?: string
  status: string
  stage: string
  progress: number
  purpose?: string
  note?: string
}

/** aml.dataset 帧 payload(数据集快照构建完成) */
export interface AmlDatasetFrame {
  op: 'built'
  datasetId: string
  lineId?: string
  rowCount: number
}

/** aml.model 帧 payload(模型阶段晋升/退役) */
export interface AmlModelFrame {
  op: 'promoted'
  modelId: string
  stage: string
}

/** 作业实时投影(REST 快照行 + WS 增量收敛) */
export interface AmlJobLive {
  jobId: string
  datasetId: string
  lineId: string
  status: string
  stage: string
  progress: number
  purpose?: string
  note?: string
  at: string
}

function createStore() {
  /** jobId → 实时投影(整表替换触发响应;帧频低,拷贝成本可忽略) */
  const jobs = ref(new Map<string, AmlJobLive>())
  const lastJob = ref<AmlJobFrame | null>(null)
  const lastDataset = ref<AmlDatasetFrame | null>(null)
  const lastModel = ref<AmlModelFrame | null>(null)

  function applyJob(p: AmlJobFrame): void {
    const prev = jobs.value.get(p.jobId)
    const next = new Map(jobs.value)
    next.set(p.jobId, {
      jobId: p.jobId,
      datasetId: p.datasetId || prev?.datasetId || '',
      lineId: p.lineId ?? prev?.lineId ?? '',
      status: p.status,
      stage: p.stage,
      progress: p.progress,
      purpose: p.purpose ?? prev?.purpose,
      note: p.note,
      at: new Date().toISOString(),
    })
    jobs.value = next
  }

  function handler(e: AepEnvelope): void {
    // aml.* 帧类型尚未并入 AepEvent 联合(e.type 只作为 string 分派),payload 经 unknown 桥接
    if (e.type === 'aml.job') {
      const p = e.payload as unknown as AmlJobFrame
      if (!p?.jobId) return
      lastJob.value = p
      applyJob(p)
    }
    else if (e.type === 'aml.dataset') {
      const p = e.payload as unknown as AmlDatasetFrame
      if (!p?.datasetId) return
      lastDataset.value = p
    }
    else if (e.type === 'aml.model') {
      const p = e.payload as unknown as AmlModelFrame
      if (!p?.modelId) return
      lastModel.value = p
    }
  }

  /** 引用计数订阅(同 useDcwStream):首个调用建订阅,归零才退订 */
  let feedConsumers = 0
  let feedUnsub: (() => void) | null = null

  function release(): void {
    feedConsumers = Math.max(0, feedConsumers - 1)
    if (feedConsumers === 0 && feedUnsub) {
      feedUnsub()
      feedUnsub = null
    }
  }

  /** 建立订阅(幂等);返回本次消费的退订函数 */
  function ensure(): () => void {
    feedConsumers++
    if (!feedUnsub) feedUnsub = useTownBus().subscribe(handler)
    let done = false
    return () => {
      if (done) return
      done = true
      release()
    }
  }

  /** 释放一次消费(与 ensure 配对;幂等到归零) */
  function dispose(): void {
    release()
  }

  return { jobs, lastJob, lastDataset, lastModel, ensure, dispose }
}

type AmlStreamStore = ReturnType<typeof createStore>

const GLOBAL_KEY = '__amlStream'

export function useAmlStream(): AmlStreamStore {
  const g = globalThis as typeof globalThis & Record<string, unknown>
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = createStore()
  return g[GLOBAL_KEY] as AmlStreamStore
}
