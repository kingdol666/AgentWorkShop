/**
 * AML 作业编排器:FIFO 队列 + 并发上限 + 双段子进程(train → 平台评估)+ 停摆看门狗。
 *
 * 纪律:
 *  - 子进程经 line-spawn(Windows 引号安全);超时/停摆/取消一律杀整棵进程树;
 *  - ##AML NDJSON 协议行解析(非法行丢弃计数,不因日志格式炸掉);
 *  - 永久错误(契约缺失/评估失败)不重试;进程被杀/超时=可重试(retry_count<2);
 *  - 重启恢复:启动时活跃态作业批量置 interrupted;
 *  - 进度经 broadcastSceneEvent('aml.job') 推送(携带 lineId 享逐 peer 过滤)。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { AppError } from '../../../utils/errors'
import { createLogger } from '../logger'
import { amlSettings } from '../settings'
import { broadcastSceneEvent } from '../scene-events'
import { recordOps } from '../ops/ops'
import { spawnLineProcess } from '../agents/adapters/line-spawn'
import { ensureVenv, jobEnv, platformPythonDir, killHarnessProcess, probePython, requirementsHash } from './python-runtime'
import { hashDatasetDir, loadManifest } from './dataset-builder'
import { evaluateGates, type PlatformMetrics } from './gates'
import { registerModelFromJob } from './model-registry'
import { getAmlRuntime } from './runtime'
import type { AmlJobRow } from './aml.repo'

const log = createLogger('aml.job')

const PROGRESS_WS_MIN_MS = 2000

interface RunningJob {
  row: AmlJobRow
  jobDir: string
  child: ChildProcess | null
  startedAt: number
  lastProtocolAt: number
  lastWsAt: number
  logLines: string[]
  protocolBadLines: number
  killed: boolean
}

interface OrchestratorState {
  queue: AmlJobRow[]
  running: Map<string, RunningJob>
  ticker: ReturnType<typeof setInterval> | null
}

const g = globalThis as typeof globalThis & { __amlOrchestrator?: OrchestratorState }

function state(): OrchestratorState {
  if (!g.__amlOrchestrator) {
    g.__amlOrchestrator = { queue: [], running: new Map(), ticker: null }
  }
  return g.__amlOrchestrator
}

// ---------- 对外 API ----------

export interface SubmitJobInput {
  datasetId: string
  purpose?: 'mpc_surrogate' | 'quality_predict'
  parentExperimentId?: string | null
  changeNote?: string
  params?: Record<string, unknown>
  seed?: number
  trainFile?: string
  budget?: { maxExperiments?: number }
  /** 内联训练代码(REST 一次性提交;Agent 经 aml_job_submit 的 code 参数提交) */
  code?: string
  /** 发起者;byKind 决定审计归属(actorKind) */
  agent?: { id: string, channelId?: string, taskId?: string }
  byKind?: 'user' | 'agent'
  /** 实验谱系:由重试等内部路径复用既有 experiment 行 */
  experimentId?: string
}

export function submitJob(input: SubmitJobInput): AmlJobRow {
  const rt = getAmlRuntime()
  const s = amlSettings()
  const dataset = rt.repo.dataset.get(input.datasetId)
  if (!dataset) throw new AppError(404, 'AML_DATASET_MISSING', `数据集 ${input.datasetId} 不存在`)

  // 预算硬上限(ADR-3):单数据集实验数耗尽即拒绝,防 Agent 无限迭代
  const maxExperiments = input.budget?.maxExperiments ?? 12
  const used = rt.repo.experiment.countByDataset(input.datasetId)
  if (used >= maxExperiments) {
    throw new AppError(429, 'AML_BUDGET_EXHAUSTED', `该数据集实验预算已耗尽(${used}/${maxExperiments}):请审阅排行榜后决策,或提高 budget.maxExperiments`)
  }

  // 并发/排队上限:FIFO,防 Agent 无限刷队列
  const pending = state().queue.length
    + state().running.size
    + rt.repo.job.list({ status: 'queued' }).length
  if (pending >= 20) {
    throw new AppError(429, 'AML_QUEUE_FULL', `作业队列已满(${pending}),等待现有作业完成或取消排队作业`)
  }

  const byKind = input.byKind ?? (input.agent ? 'agent' : 'system')
  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  const row: AmlJobRow = {
    id,
    datasetId: input.datasetId,
    purpose: input.purpose ?? 'mpc_surrogate',
    status: 'queued',
    stage: '',
    progress: 0,
    budget: {
      maxExperiments,
      timeoutMs: s.job.timeoutMs,
      stallMs: s.job.stallMs,
      seed: input.seed ?? 42,
      params: input.params ?? {},
      changeNote: input.changeNote ?? '',
      parentExperimentId: input.parentExperimentId ?? null,
      inlineCode: input.code ?? null,
      byKind,
    },
    metricsJson: null,
    gatesJson: null,
    artifactsPath: null,
    error: null,
    retryCount: 0,
    agentId: input.agent?.id ?? '',
    channelId: input.agent?.channelId ?? '',
    taskId: input.agent?.taskId ?? '',
    createdAt: now,
    startedAt: null,
    endedAt: null,
  }
  rt.repo.job.insert({
    id,
    datasetId: row.datasetId,
    purpose: row.purpose,
    budget: row.budget,
    agentId: row.agentId,
    channelId: row.channelId,
    taskId: row.taskId,
    createdAt: now,
  })
  state().queue.push(row)
  ensureTicker()
  recordOps({
    actor: row.agentId || 'aml', actorName: row.agentId || 'AML', actorKind: byKind,
    action: 'aml.job.submit', kind: 'write', summary: `提交训练作业 ${id}(dataset=${input.datasetId}, purpose=${row.purpose})`,
    targetKind: 'aml_job', targetId: id, lineId: dataset.lineId, productId: dataset.productId, recipeId: dataset.recipeId,
  })
  wsJob(row, dataset)
  return row
}

export function cancelJob(id: string, by: { id: string, kind: 'user' | 'agent' }): boolean {
  const rt = getAmlRuntime()
  const st = state()
  const qi = st.queue.findIndex(j => j.id === id)
  if (qi >= 0) {
    st.queue.splice(qi, 1)
    rt.repo.job.fail(id, 'cancelled', `被 ${by.kind}:${by.id} 取消(排队中)`, new Date().toISOString())
    return true
  }
  const run = st.running.get(id)
  if (run) {
    run.killed = true
    void killJobProcess(run, 'cancelled')
    return true
  }
  const row = rt.repo.job.get(id)
  if (row && ['queued', 'provisioning', 'training', 'evaluating'].includes(row.status)) {
    rt.repo.job.fail(id, 'cancelled', `被 ${by.kind}:${by.id} 取消`, new Date().toISOString())
    return true
  }
  return false
}

export function retryJob(id: string): AmlJobRow {
  const rt = getAmlRuntime()
  const row = rt.repo.job.get(id)
  if (!row) throw new AppError(404, 'AML_JOB_MISSING', `作业 ${id} 不存在`)
  if (!['failed', 'timeout', 'interrupted', 'cancelled'].includes(row.status)) {
    throw new AppError(409, 'AML_JOB_NOT_RETRYABLE', `作业状态 ${row.status} 不可重试`)
  }
  if (row.retryCount >= 2) throw new AppError(429, 'AML_RETRY_EXHAUSTED', '重试次数已用尽(2)')
  rt.repo.job.requeue(id)
  const fresh = rt.repo.job.get(id)!
  state().queue.push(fresh)
  ensureTicker()
  return fresh
}

/** 日志尾随(内存环形;重启后为空属预期,完整日志在 run.log 文件) */
export function jobLogsTail(id: string, lines = 80): string[] {
  const run = state().running.get(id)
  if (run) return run.logLines.slice(-lines)
  const rt = getAmlRuntime()
  const p = join(rt.jobsDir, id, 'run.log')
  if (!existsSync(p)) return []
  const content = readFileSync(p, 'utf8')
  return content.split('\n').slice(-lines)
}

/** 启动恢复:活跃态置 interrupted(必须在任何 REST/工具访问前调用一次) */
export function recoverInterruptedJobs(): number {
  const rt = getAmlRuntime()
  return rt.repo.job.markActiveInterrupted(new Date().toISOString())
}

/** 关停:杀活树 + 停 ticker(nitro close 钩子) */
export function shutdownOrchestrator(): void {
  const st = state()
  if (st.ticker) {
    clearInterval(st.ticker)
    st.ticker = null
  }
  for (const run of st.running.values()) {
    run.killed = true
    if (run.child?.pid) void killHarnessProcess(run.child.pid)
  }
  st.running.clear()
  st.queue = []
}

// ---------- 内部 ----------

function ensureTicker(): void {
  const st = state()
  if (st.ticker) return
  st.ticker = setInterval(() => {
    void tick()
  }, 1000)
  st.ticker.unref()
}

async function tick(): Promise<void> {
  const rt = getAmlRuntime()
  const st = state()
  const s = amlSettings()

  // 停摆看门狗:无协议输出超时 → 杀
  for (const run of st.running.values()) {
    if (Date.now() - run.lastProtocolAt > s.job.stallMs) {
      log.warn(`[aml-job] ${run.row.id} 停摆(${Math.round(s.job.stallMs / 1000)}s 无协议输出)→ 终止`)
      run.killed = true
      rt.repo.job.fail(run.row.id, 'failed', `作业停摆(${Math.round(s.job.stallMs / 1000)}s 无进度输出)被终止`, new Date().toISOString())
      await killJobProcess(run, 'failed')
      finishRun(run)
      continue
    }
    if (Date.now() - run.startedAt > s.job.timeoutMs && !run.killed) {
      run.killed = true
      rt.repo.job.fail(run.row.id, 'timeout', `墙钟超时(${Math.round(s.job.timeoutMs / 60000)}min)`, new Date().toISOString())
      await killJobProcess(run, 'timeout')
      finishRun(run)
    }
  }

  if (st.running.size >= Math.max(1, s.job.maxConcurrent)) return
  const next = st.queue.shift()
  if (next) await startJob(next)
}

async function startJob(row: AmlJobRow): Promise<void> {
  const rt = getAmlRuntime()
  const st = state()
  const dataset = rt.repo.dataset.get(row.datasetId)
  if (!dataset) {
    rt.repo.job.fail(row.id, 'failed', '数据集已被删除(永久错误)', new Date().toISOString())
    return
  }
  // 快照完整性校验(防篡改;sha 失配 = 永久错误不重试)
  const actualSha = hashDatasetDir(dataset.path, dataset.specJson)
  if (actualSha !== dataset.sha256) {
    rt.repo.job.fail(row.id, 'failed', `数据集快照校验失败(sha256 不匹配,疑似被改动或损坏):${dataset.id}(永久错误)`, new Date().toISOString())
    return
  }
  const jobDir = join(rt.jobsDir, row.id)
  const workspace = join(jobDir, 'workspace')
  const artifacts = join(jobDir, 'artifacts')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(artifacts, { recursive: true })
  let trainFile = existsSync(join(workspace, 'train.py')) ? 'train.py' : null
  if (!trainFile) {
    // REST 内联代码路径:预算袋携带 inlineCode 时落盘(≤500KB,提交入口已限)
    const inline = safeParse(row.budget).inlineCode
    if (typeof inline === 'string' && inline.length > 0 && inline.length <= 512_000) {
      writeFileSync(join(workspace, 'train.py'), inline)
      trainFile = 'train.py'
    }
    else {
      rt.repo.job.fail(row.id, 'failed', 'workspace/train.py 不存在(Agent 用 aml_job_submit 携带 code 提交,或 REST 提交时带 code)', new Date().toISOString())
      return
    }
  }

  writeFileSync(join(jobDir, 'job.json'), JSON.stringify({
    jobId: row.id,
    datasetPath: dataset.path,
    workspaceDir: workspace,
    params: safeParse(row.budget).params ?? {},
    seed: safeParse(row.budget).seed ?? 42,
    trainFile,
  }, null, 2))
  const run: RunningJob = {
    row,
    jobDir,
    child: null,
    startedAt: Date.now(),
    lastProtocolAt: Date.now(),
    lastWsAt: 0,
    logLines: [],
    protocolBadLines: 0,
    killed: false,
  }
  st.running.set(row.id, run)
  rt.repo.job.markStarted(row.id, 'provisioning', 'provision', new Date().toISOString())
  wsStage(row, 'provision')

  try {
    if (process.env.AML_STUB === '1') {
      await runStub(run, artifacts)
      return
    }
    const vpy = await ensureVenv(rt)
    if (run.killed) return
    rt.repo.job.setState(row.id, 'training', 'train', 5)
    wsStage(row, 'train')
    // 第一拍:Agent 训练代码(独立进程;崩溃不伤评估器)
    const exit1 = await runPython(run, vpy, [join(workspace, trainFile)], workspace)
    if (run.killed) return
    if (exit1.code !== 0) {
      failPermanentOrRetry(run, `训练进程退出(${exit1.code}):${lastErrLine(exit1.errTail)}`, exit1.code)
      return
    }
    if (!existsSync(join(artifacts, 'model.onnx'))) {
      rt.repo.job.fail(row.id, 'failed', '训练未产出 artifacts/model.onnx(契约缺失,永久错误不重试)', new Date().toISOString())
      experimentFail(run, '契约缺失:model.onnx 未产出')
      finishRun(run)
      return
    }
    // 第二拍:平台权威评估
    rt.repo.job.setState(row.id, 'evaluating', 'evaluate', 80)
    wsStage(row, 'evaluate')
    const evalScript = join(platformPythonDir(), 'aml_eval.py')
    const exit2 = await runPython(run, vpy, [evalScript, '--job', join(jobDir, 'job.json')], jobDir)
    if (run.killed) return
    if (exit2.code !== 0) {
      rt.repo.job.fail(row.id, 'failed', `评估失败:${lastErrLine(exit2.errTail)}(永久错误不重试)`, new Date().toISOString())
      experimentFail(run, `评估失败:${lastErrLine(exit2.errTail)}`)
      finishRun(run)
      return
    }
    concludeJob(run, artifacts)
  }
  catch (err) {
    if (!run.killed) {
      const msg = err instanceof Error ? err.message : String(err)
      const permanent = String((err as { code?: string })?.code ?? '').startsWith('AML_')
      if (permanent) {
        rt.repo.job.fail(row.id, 'failed', msg, new Date().toISOString())
        experimentFail(run, msg)
        finishRun(run)
      }
      else {
        failPermanentOrRetry(run, msg, 1)
      }
    }
  }
}

interface ExitInfo { code: number, errTail: string }

function runPython(run: RunningJob, vpy: string, args: string[], cwd: string): Promise<ExitInfo> {
  return new Promise((resolve) => {
    const rt = getAmlRuntime()
    const child = spawnPython(vpy, args, {
      cwd,
      env: jobEnv(rt, run.jobDir),
      cleanEnv: true,
    }, (line) => {
      handleProtocolLine(run, line)
    })
    run.child = child
    let errTail = ''
    // stdout/stderr 统一进入行回调(runner 内部已按行拆分)
    child.on('exit', (code) => {
      run.child = null
      resolve({ code: code ?? -1, errTail: errTail.slice(-800) })
    })
    child.stderr?.on('data', (d) => {
      errTail += String(d)
      if (errTail.length > 4000) errTail = errTail.slice(-2000)
      pushLog(run, `[stderr] ${String(d).trimEnd()}`)
    })
    // killHarnessProcess 场景下 exit 可能不触发 stdout end;此处仅兜底 error
    child.on('error', (e) => {
      errTail += String(e)
    })
    void rt
  })
}

function spawnPython(
  vpy: string,
  args: string[],
  opts: { cwd: string, env: Record<string, string>, cleanEnv?: boolean },
  onLine: (line: string) => void,
): ChildProcess {
  const child = spawnLineProcess(vpy, args, opts)
  let buf = ''
  child.stdout?.on('data', (d) => {
    buf += String(d)
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.length > 65536) onLine(line.slice(0, 65536)) // 超长行截断(防日志炸内存)
      else onLine(line)
    }
    if (buf.length > 1_000_000) buf = ''
  })
  return child
}

function handleProtocolLine(run: RunningJob, rawLine: string): void {
  pushLog(run, rawLine)
  const line = rawLine.trimEnd()
  // 停摆看门狗只认 ##AML 协议行:任意 stdout 噪声不得重置活性基线
  if (!line.startsWith('##AML ')) return
  run.lastProtocolAt = Date.now()
  let evt: { type?: string, stage?: string, progress?: number, note?: string, metrics?: unknown, message?: string }
  try {
    evt = JSON.parse(line.slice(6))
  }
  catch {
    run.protocolBadLines++
    return
  }
  const rt = getAmlRuntime()
  if (evt.type === 'progress' && typeof evt.progress === 'number') {
    const p = Math.max(0, Math.min(99, Math.round(evt.progress)))
    rt.repo.job.setState(run.row.id, currentStatus(run.row.id), currentStage(run.row.id), p)
    wsProgress(run.row, p, evt.note ?? '')
  }
  else if (evt.type === 'stage' && evt.stage) {
    const status = evt.stage === 'evaluate' ? 'evaluating' : evt.stage === 'train' ? 'training' : 'provisioning'
    rt.repo.job.markStarted(run.row.id, status, evt.stage, new Date().toISOString())
  }
  else if (evt.type === 'metrics' && evt.metrics && typeof evt.metrics === 'object') {
    writeFileSync(join(run.jobDir, 'metrics.protocol.json'), JSON.stringify(evt.metrics, null, 2))
  }
  else if (evt.type === 'error' && evt.message) {
    pushLog(run, `[error] ${evt.message}`)
  }
}

function currentStatus(jobId: string): AmlJobRow['status'] {
  const row = getAmlRuntime().repo.job.get(jobId)
  return row?.status ?? 'training'
}
function currentStage(jobId: string): string {
  return getAmlRuntime().repo.job.get(jobId)?.stage ?? ''
}

/** 存根运行器(AML_STUB=1):不依赖 Python,模拟训练并产出可达标 metrics + STUB 标记 */
async function runStub(run: RunningJob, artifacts: string): Promise<void> {
  const rt = getAmlRuntime()
  rt.repo.job.setState(run.row.id, 'training', 'train', 30)
  wsStage(run.row, 'train')
  await new Promise(r => setTimeout(r, 500))
  const params = safeParse(rt.repo.job.get(run.row.id)?.budget ?? {}).params ?? {}
  const p = params as { stubNrmse?: number, stubRolloutNrmse?: number }
  const oneStep = Number(p.stubNrmse ?? 0.07)
  const rollout = Number(p.stubRolloutNrmse ?? 0.18)
  rt.repo.job.setState(run.row.id, 'evaluating', 'evaluate', 80)
  wsStage(run.row, 'evaluate')
  await new Promise(r => setTimeout(r, 200))
  const metrics: PlatformMetrics = {
    oneStepVal: { windows: 100, nrmse: oneStep * 0.9 },
    oneStepTest: { windows: 100, nrmse: oneStep },
    rolloutTest: { windows: 50, nrmse: rollout, horizon: 12 },
  }
  writeFileSync(join(artifacts, 'metrics.json'), JSON.stringify({ ...params, ...metrics }, null, 2))
  writeFileSync(join(artifacts, 'STUB'), new Date().toISOString())
  concludeJob(run, artifacts)
}

function concludeJob(run: RunningJob, artifactsDir: string): void {
  const rt = getAmlRuntime()
  const dataset = rt.repo.dataset.get(run.row.datasetId)
  if (!dataset) {
    rt.repo.job.fail(run.row.id, 'failed', '数据集已被删除', new Date().toISOString())
    finishRun(run)
    return
  }
  let metrics: PlatformMetrics | undefined
  try {
    // 存储形态:平台指标平铺顶层(消费方契约)+ 保留 agent 自报段;
    // 兼容读取:平台评估器嵌套于 platform.* 时展平
    const parsed = JSON.parse(readFileSync(join(artifactsDir, 'metrics.json'), 'utf8')) as { platform?: PlatformMetrics, agent?: unknown } & PlatformMetrics
    metrics = parsed.platform
      ? { ...parsed.platform, agent: parsed.agent }
      : parsed
  }
  catch { /* 缺 metrics → 门禁全挂 */ }
  const manifest = loadManifest(dataset)
  const gates = evaluateGates(run.row.purpose, dataset, manifest, metrics, artifactsDir)
  const gatesJson = JSON.stringify(gates)
  const metricsJson = JSON.stringify(metrics ?? {})
  rt.repo.job.finish(run.row.id, gates.passed ? 'done' : 'failed', metricsJson, gatesJson, artifactsDir, new Date().toISOString())
  if (!gates.passed) {
    rt.repo.job.fail(run.row.id, 'failed', `评测门未通过:${gates.checks.filter(c => !c.pass).map(c => `${c.id} ${c.detail}`).join('; ')}`, new Date().toISOString())
    // 门禁未过=实验记录 gates_failed(非作业错误语义,但作业 fail 承载原因)
  }
  // 实验与模型登记(实验 id = job id 首跑对应;重试复用)
  try {
    registerModelFromJob(run.row.id, gates, metricsJson)
  }
  catch (err) {
    log.warn(`[aml-job] ${run.row.id} 模型登记失败:${err instanceof Error ? err.message : String(err)}`)
  }
  const datasetFresh = rt.repo.dataset.get(run.row.datasetId)
  const byKind = safeParse(run.row.budget).byKind
  const actorKind: 'user' | 'agent' | 'system' = byKind === 'user' || byKind === 'agent' ? byKind : run.row.agentId ? 'agent' : 'system'
  recordOps({
    actor: run.row.agentId || 'aml', actorName: run.row.agentId || 'AML', actorKind,
    action: 'aml.job.finish', kind: 'system',
    summary: `作业 ${run.row.id} 结束:门禁${gates.passed ? '全部通过' : '未通过'}`,
    targetKind: 'aml_job', targetId: run.row.id,
    lineId: datasetFresh?.lineId, productId: datasetFresh?.productId, recipeId: datasetFresh?.recipeId,
  })
  wsJob(rt.repo.job.get(run.row.id) ?? run.row, datasetFresh)
  finishRun(run)
}

function failPermanentOrRetry(run: RunningJob, msg: string, exitCode: number): void {
  const rt = getAmlRuntime()
  const retryable = exitCode === -1 && run.row.retryCount < 2 // 被杀才可重试;exit>0 是代码/契约问题
  if (retryable) {
    rt.repo.job.requeue(run.row.id)
    const fresh = rt.repo.job.get(run.row.id)
    if (fresh) state().queue.push(fresh)
  }
  else {
    rt.repo.job.fail(run.row.id, 'failed', msg, new Date().toISOString())
    experimentFail(run, msg)
  }
  finishRun(run)
}

function experimentFail(run: RunningJob, reason: string): void {
  // 实验行由 model-registry 在 conclude 时建;失败路径只留作业侧错误(避免半态行)
  void run
  void reason
}

async function killJobProcess(run: RunningJob, status: 'cancelled' | 'timeout' | 'failed'): Promise<void> {
  if (run.child?.pid) await killHarnessProcess(run.child.pid)
  run.child = null
  void status
}

function finishRun(run: RunningJob): void {
  const st = state()
  // 落盘完整日志(run.log)
  try {
    appendFileSync(join(run.jobDir, 'run.log'), run.logLines.join('\n') + '\n')
    // GC:终态后清 workspace 中间产物(保留 run.log/metrics/artifacts/job.json)
    if (!process.env.AML_KEEP_WORKSPACE) {
      try {
        rmSync(join(run.jobDir, 'workspace'), { recursive: true, force: true })
      }
      catch { /* 已被外部清理 */ }
    }
  }
  catch { /* 日志落盘失败不阻断 */ }
  st.running.delete(run.row.id)
}

function pushLog(run: RunningJob, line: string): void {
  run.logLines.push(`${new Date().toISOString()} ${line}`)
  if (run.logLines.length > amlSettings().job.logTailLines) run.logLines.splice(0, run.logLines.length - amlSettings().job.logTailLines)
}

function safeParse(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Record<string, unknown>
    }
    catch { return {} }
  }
  return (v ?? {}) as Record<string, unknown>
}

function lastErrLine(errTail: string): string {
  const lines = errTail.split('\n').map(l => l.trim()).filter(Boolean)
  return (lines[lines.length - 1] ?? `exit`).slice(0, 300)
}

// ---------- WS ----------

function wsJob(row: AmlJobRow | undefined, dataset: { lineId: string } | undefined): void {
  if (!row) return
  broadcastSceneEvent('aml.job', {
    jobId: row.id, datasetId: row.datasetId, lineId: dataset?.lineId,
    status: row.status, stage: row.stage, progress: row.progress, purpose: row.purpose,
  })
}

function wsStage(row: AmlJobRow, stage: string): void {
  const rt = getAmlRuntime()
  wsJob(rt.repo.job.get(row.id), rt.repo.dataset.get(row.datasetId))
  void stage
}

function wsProgress(row: AmlJobRow, progress: number, note: string): void {
  const rt = getAmlRuntime()
  const run = state().running.get(row.id)
  const now = Date.now()
  if (run && now - run.lastWsAt < PROGRESS_WS_MIN_MS && progress < 100) return
  if (run) run.lastWsAt = now
  broadcastSceneEvent('aml.job', {
    jobId: row.id, datasetId: row.datasetId, lineId: rt.repo.dataset.get(row.datasetId)?.lineId,
    status: currentStatus(row.id), stage: currentStage(row.id), progress, note,
  })
}

/** 探针(python 缺失时给 UI/工具明确状态) */
export async function runtimeStatus(): Promise<{ python: { ok: boolean, version?: string, reason?: string }, venvReady: boolean, queued: number, running: number }> {
  const probe = await probePython()
  const rt = getAmlRuntime()
  const st = state()
  return {
    python: { ok: probe.ok, version: probe.version, reason: probe.reason },
    venvReady: probe.ok ? existsSync(join(venvDirOf(rt), `.aml-ok-${requirementsHashOf()}`)) : false,
    queued: st.queue.length + rt.repo.job.list({ status: 'queued' }).length,
    running: st.running.size,
  }
}

function venvDirOf(rt: { root: string }): string {
  return join(rt.root, 'runtime', 'venv')
}

function requirementsHashOf(): string {
  // 与 python-runtime.requirementsHash 同源(marker 摘要探测;异常时容错取空)
  try {
    return requirementsHash()
  }
  catch { return '' }
}
