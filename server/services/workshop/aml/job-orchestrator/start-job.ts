/**
 * 启动单个作业(环境探测 / 参数组装 / 分支到 stub 或真实进程)
 * (由 server/services/workshop/aml/job-orchestrator.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AmlJobRow } from '../aml.repo'
import type { RunningJob } from './shared'
import { concludeJob, runStub } from './stages'
import { ensureVenv, platformPythonDir } from '../python-runtime'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { experimentFail, failPermanentOrRetry, finishRun, lastErrLine, safeParse } from './failure'
import { getAmlRuntime } from '../runtime'
import { hashDatasetDir } from '../dataset-builder'
import { createLogger } from '../../logger'
import { join } from 'node:path'
import { runPython } from './process'
import { state } from './shared'
import { wsStage } from './broadcast'

const log = createLogger('aml.job')

export async function startJob(row: AmlJobRow): Promise<void> {
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
    else if ((safeParse(row.budget).jobKind ?? 'supervised') === 'hybrid_residual') {
      // hybrid_residual 模板回退:平台参考训练器(物理参数校准→有界残差集成→UQ 校准)。
      // Agent 无需自带训练代码即可把冻结 PhysicsSpec + 数据集训练成 hybrid 模型。
      const template = join(platformPythonDir(), 'train-hybrid-example.py')
      if (!existsSync(template)) {
        rt.repo.job.fail(row.id, 'failed', `hybrid_residual 模板缺失:${template}(平台安装不完整,永久错误)`, new Date().toISOString())
        return
      }
      writeFileSync(join(workspace, 'train.py'), readFileSync(template, 'utf8'))
      trainFile = 'train.py'
      log.warn(`[aml-job] ${row.id} hybrid_residual 未携带 code,使用平台参考训练器`)
    }
    else {
      rt.repo.job.fail(row.id, 'failed', 'workspace/train.py 不存在(Agent 用 aml_job_submit 携带 code 提交,或 REST 提交时带 code)', new Date().toISOString())
      return
    }
  }

  const budget = safeParse(row.budget) as Record<string, unknown>
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify({
    jobId: row.id,
    datasetPath: dataset.path,
    workspaceDir: workspace,
    params: budget.params ?? {},
    seed: budget.seed ?? 42,
    trainFile,
    sceneId: budget.sceneId ?? null,
    sceneVersion: budget.sceneVersion ?? null,
    objectiveId: budget.objectiveId ?? null,
    jobKind: budget.jobKind ?? 'supervised',
    providerId: budget.providerId ?? null,
    providerVersion: budget.providerVersion ?? null,
    providerHash: budget.providerHash ?? null,
    providerGeneration: budget.providerGeneration ?? null,
  }, null, 2))
  // Hybrid Twin lineage is immutable job input. Persist these sidecars where
  // amlkit.load_* actually reads them (AML_JOB_DIR root) so training/evaluation
  // never trusts REST callers or reaches into the live database; the workspace
  // copy is a provenance archive of the exact bytes the job was submitted with.
  for (const [name, key] of [
    ['physics_manifest.json', 'physicsManifest'],
    ['physics_spec.json', 'physicsSpec'],
    ['twin_snapshot.json', 'twinSnapshot'],
    ['objective_profile.json', 'objectiveProfile'],
  ] as const) {
    const value = budget[key]
    if (value && typeof value === 'object') {
      writeFileSync(join(jobDir, name), JSON.stringify(value, null, 2))
      writeFileSync(join(workspace, name), JSON.stringify(value, null, 2))
    }
  }
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
      // 失败原因优先取评估器的 ##AML error 协议消息(如「test 切分为空…」,人读可操作);
      // stderr 尾兜底 —— 评估器把错误走 stdout 协议行时 errTail 常为空,只给 "exit" 无从排查。
      const reason = run.lastProtocolError || lastErrLine(exit2.errTail)
      rt.repo.job.fail(row.id, 'failed', `评估失败:${reason}(永久错误不重试)`, new Date().toISOString())
      experimentFail(run, `评估失败:${reason}`)
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
