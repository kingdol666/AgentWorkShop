/**
 * 启动一次诊断(建运行记录 / 调 harness / 落 KV)
 * (由 server/plugins-builtin/diag-bridge/index.mjs 按职责拆出;内容逐行原文搬运)
 */
import { baseOf, harnessOf, jpost, maxMinutesOf, maxTurnsOf, runKey, runningOfLine, short } from './helpers.mjs'
import { snapshotCore } from './snapshot.mjs'
import { startingLines } from './constants.mjs'

export async function startDiagnosis(ctx, { line, fromMs, toMs, question, scene, source, dataPath }) {
  const base = baseOf(ctx)
  if (!base) return { ok: false, error: 'diag.base_url 非法(仅允许 http/https 且 host 为 127.0.0.1/localhost)。' }
  if (startingLines.has(line)) return { ok: false, error: `产线 ${line} 已有诊断正在启动,请稍后再试。` }
  const existing = runningOfLine(ctx, line)
  if (existing) return { ok: false, error: `产线 ${line} 已有运行中的诊断(run_id=${existing.id}),请稍后用 diag_status 查询。` }
  startingLines.add(line)
  try {
    let snap = { ok: true, csvPath: '', rows: 0, nodes: 0 }
    if (!dataPath) {
      snap = await snapshotCore(ctx, line, fromMs, toMs)
      if (!snap.ok) return { ok: false, error: snap.error }
    }
    const q = question || `${line} 产线该时窗数据深度根因诊断`
    const sceneName = scene || `${line}_diag`
    // v2.1:统一走 IDD 任务管理面 /api/diagnosis/tasks——接收即返 task_id,
    // 诊断在 IDD 后台线程执行(内部 start+execute),Channel 绝不等待。
    const started = await jpost(ctx, `${base}/api/diagnosis/tasks`, {
      dataPath: dataPath || snap.csvPath,
      sceneName,
      userQuestion: q,
      harness: harnessOf(ctx), // 缺省落 claude 引擎会因无 key 失败,必须显式(系统配置 plugins.diag-bridge.harness → kv → omp)
      enhancement: 'off',
      reportLanguage: 'zh',
      maxTurns: maxTurnsOf(ctx), // 修复循环会加转数;150 不够走完全管线
      timeoutMinutes: maxMinutesOf(ctx),
    })
    const runId = String(started.data?.task_id ?? started.data?.runId ?? '')
    const name = String(started.data?.name ?? '')
    if (!runId) return { ok: false, error: `tasks 响应缺少 data.task_id: ${short(started)}` }
    ctx.kv.set(runKey(runId), {
      line, fromMs, toMs, question: q, scene: sceneName,
      status: 'running', createdAt: Date.now(), source, csvPath: snap.csvPath, name,
    })
    return { ok: true, runId, name, csvPath: snap.csvPath, rows: snap.rows, nodes: snap.nodes }
  }
  catch (err) {
    return { ok: false, error: `发起诊断失败: ${err?.message ?? err}` }
  }
  finally {
    startingLines.delete(line)
  }
}

// ── 轮询器:15s 扫描 kv 中 running 的 run → 更新状态 ──────────────────────
// v2.1:入库不再由本插件自动执行(web documents/create 旧两步管线已移除)。
// 完成后的协调契约:Channel 空闲时用 diag_status 查询 → 拿到 诊断总结+报告 md
// 路径 → 由 Agent 调用 rag-bridge 的 kb_agent(mode=async) 把报告入库知识库。
