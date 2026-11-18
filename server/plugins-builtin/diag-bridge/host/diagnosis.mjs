/**
 * 启动一次诊断(契约定轨 → 建运行记录 / 调 IDD / 落 KV)
 * WS-2:主契约迁移 external v1(auto 提交前探测定轨,legacy 显式回退);
 * run meta 持久化 contract + task_id + run_id,轮询/状态/回执全链同契约。
 */
import { baseOf, harnessOf, jpost, maxMinutesOf, maxTurnsOf, runKey, runningOfLine, short } from './helpers.mjs'
import { snapshotCore } from './snapshot.mjs'
import { startingLines } from './constants.mjs'
import { defaultQuestionFor, resolveBridgeIntent } from './intents.mjs'
import { getCapabilities, mapV1Error, preflightCapabilities, resolveContract, v1Request } from './external-v1.mjs'

export async function startDiagnosis(ctx, {
  line, fromMs, toMs, question, scene, source, dataPath, dataPaths,
  harness, agentId, channelId, analysisIntent, model, permissionMode,
  ontologyMode, ontologyScene, ontologySource, preprocessingMode, reportLanguage,
}) {
  const base = baseOf(ctx)
  if (!base) return { ok: false, error: 'diag.base_url 非法(仅允许 http/https 且 host 为 127.0.0.1/localhost)。' }
  const intent = resolveBridgeIntent(analysisIntent)
  if (analysisIntent && String(analysisIntent).trim() && !intent) {
    return { ok: false, error: `未知分析意图: ${String(analysisIntent)}(支持 deep-diagnosis/stability-report/quick-screen/doe-analysis/experience-mining/optimizer-campaign/improvement-advisory)` }
  }
  if (startingLines.has(line)) return { ok: false, error: `产线 ${line} 已有诊断正在启动,请稍后再试。` }
  const existing = runningOfLine(ctx, line)
  if (existing) return { ok: false, error: `产线 ${line} 已有运行中的诊断(run_id=${existing.id}),请稍后用 diag_status 查询。` }
  startingLines.add(line)
  try {
    // ① 契约定轨(提交前;v1 /analyze 无幂等键,禁止"失败后回退"式重提交)
    const track = await resolveContract(ctx)
    if (!track.contract) return { ok: false, error: track.error }
    const contract = track.contract

    // ② v1 能力预检(软拒绝:intent/引擎不在 capabilities 清单 → 提交前可读拒绝)
    if (contract === 'v1') {
      const cap = await getCapabilities(ctx)
      const reject = preflightCapabilities(cap, { intent, harness: harness || harnessOf(ctx) })
      if (reject) return { ok: false, error: reject }
    }

    let snap = { ok: true, csvPath: '', rows: 0, nodes: 0 }
    if (!dataPath && !(Array.isArray(dataPaths) && dataPaths.length > 0)) {
      snap = await snapshotCore(ctx, line, fromMs, toMs)
      if (!snap.ok) return { ok: false, error: snap.error }
    }
    // 按情景注入业务提示词:调用方显式 question 优先,否则用意图目录的模板(分析语义在此,执行解耦在 IDD)
    const q = question || defaultQuestionFor(intent, { line, fromMs, toMs })
    const sceneName = scene || `${line}_diag`
    const engine = harness || harnessOf(ctx)
    const notes = []

    let runId
    let taskId = ''
    let initialStatus = 'running'
    let name = ''

    if (contract === 'v1') {
      // v1 提交:202 {task_id, run_id, status, links}(无 success 字段,按 HTTP 状态码分支)
      const payload = Array.isArray(dataPaths) && dataPaths.length > 0
        ? { dataPaths }
        : { dataPath: dataPath || snap.csvPath }
      const body = {
        ...payload,
        analysisIntent: intent,
        harness: engine,
        sceneName,
        question: q,
        reportLanguage: String(reportLanguage || 'zh'),
        wait: false,
        ...(ontologyMode ? { ontologyMode: String(ontologyMode) } : {}),
        ...(ontologyScene ? { ontologyScene: String(ontologyScene) } : {}),
        ...(ontologySource ? { ontologySource: String(ontologySource) } : {}),
        ...(preprocessingMode ? { preprocessingMode: String(preprocessingMode) } : {}),
        maxTurns: maxTurnsOf(ctx),
        timeoutMinutes: maxMinutesOf(ctx),
      }
      if (model || permissionMode) notes.push('external v1 无 model/permissionMode 字段,本次已忽略(按 IDD 默认执行)')
      const started = await v1Request(ctx, 'POST', '/analyze', body, 20000)
      if (!started.ok) {
        return { ok: false, error: `发起分析失败:${mapV1Error(started, { base })}` }
      }
      const data = started.body?.data ?? {}
      taskId = String(data.task_id ?? '')
      runId = String(data.run_id ?? taskId)
      name = String(data.name ?? '')
      const ackStatus = String(data.status ?? '').toLowerCase()
      if (!taskId || !runId) return { ok: false, error: `v1 analyze 响应缺少 task_id/run_id: ${short(started.body)}` }
      if (['failed', 'interrupted', 'expired'].includes(ackStatus)) {
        return { ok: false, error: `诊断任务已受理但立即 ${ackStatus}(run_id=${runId}):${data.error ?? 'IDD 未返回原因'}` }
      }
      initialStatus = ['queued', 'running', 'accepted', 'awaiting_input'].includes(ackStatus) ? ackStatus : 'running'
    }
    else {
      // legacy 提交(/api/diagnosis/tasks):接收即返 task_id,诊断在 IDD 后台执行
      const payload = Array.isArray(dataPaths) && dataPaths.length > 0
        ? { dataPaths }
        : { dataPath: dataPath || snap.csvPath }
      const started = await jpost(ctx, `${base}/api/diagnosis/tasks`, {
        ...payload,
        sceneName,
        userQuestion: q,
        harness: engine, // 缺省落 claude 引擎会因无 key 失败,必须显式(系统配置 → kv → omp)
        ...(intent && intent !== 'deep-diagnosis' ? { analysisIntent: intent } : {}),
        ...(model ? { model: String(model) } : {}),
        ...(permissionMode ? { permissionMode: String(permissionMode) } : {}),
        ...(reportLanguage ? { reportLanguage: String(reportLanguage) } : { reportLanguage: 'zh' }),
        ...(ontologyMode ? { ontologyMode: String(ontologyMode) } : {}),
        ...(ontologyScene ? { ontologyScene: String(ontologyScene) } : {}),
        ...(ontologySource ? { ontologySource: String(ontologySource) } : {}),
        ...(preprocessingMode ? { preprocessingMode: String(preprocessingMode) } : {}),
        enhancement: 'off',
        maxTurns: maxTurnsOf(ctx),
        timeoutMinutes: maxMinutesOf(ctx),
      })
      runId = String(started.data?.task_id ?? started.data?.runId ?? '')
      taskId = runId
      name = String(started.data?.name ?? '')
      if (!runId) return { ok: false, error: `tasks 响应缺少 data.task_id: ${short(started)}` }
      // 采用 IDD ack 的真实初始态:队列满时是 queued,触发失败时是 failed。
      const ackStatus = String(started.data?.status ?? '').toLowerCase()
      if (ackStatus === 'failed') {
        return { ok: false, error: `诊断任务已受理但立即失败(run_id=${runId}):${started.data?.error ?? started.data?.result?.error ?? 'IDD 未返回原因'}` }
      }
      initialStatus = ['queued', 'running'].includes(ackStatus) ? ackStatus : 'running'
    }

    ctx.kv.set(runKey(runId), {
      line, fromMs, toMs, question: q, scene: sceneName,
      intent: intent || 'deep-diagnosis',
      status: initialStatus, createdAt: Date.now(), source,
      csvPath: snap.csvPath,
      files: Array.isArray(dataPaths) ? dataPaths.length : 0,
      name,
      // 契约路由字段:轮询/状态/回执/report 全链同契约(跨 sweep 与工具面)
      contract,
      taskId,
      runId,
      // 归因:发起 Agent 完成后的结果回执靠它寻址(平台通告面 deliver)
      agentId: agentId || '', channelId: channelId || '',
    })
    return {
      ok: true,
      runId,
      taskId,
      contract,
      name,
      status: initialStatus,
      csvPath: snap.csvPath,
      rows: snap.rows,
      nodes: snap.nodes,
      files: Array.isArray(dataPaths) ? dataPaths.length : 0,
      intent: intent || 'deep-diagnosis',
      question: q,
      notes,
    }
  }
  catch (err) {
    return { ok: false, error: `发起诊断失败: ${err?.message ?? err}` }
  }
  finally {
    startingLines.delete(line)
  }
}
