/**
 * 自动巡检:轮询 IDD 后台任务并把终态/回执送达发起 Agent。
 *
 * 生命周期铁律(2026-10-18 修复):
 *  - 未终态 = queued | running 都参与轮询(此前只看 running,queued 会被写回后永久丢弃);
 *  - 终态先落 kv,再投递;投递失败保留 deliverPending 由下一轮重试(不再静默丢失回执);
 *  - 远端 404/401/403 连续 3 轮 → 收敛为 failed,避免永久 running 占住产线单飞锁;
 *  - 单轮不重入(15s 定时器不等待异步,串行 N×8s 可能超过周期)。
 */
import { baseOf, jget, kvRuns, runKey } from './helpers.mjs'
import { intentLabel } from './intents.mjs'

const TERMINAL = new Set(['completed', 'failed', 'stopped'])
const MAX_DELIVER_ATTEMPTS = 20
let sweeping = false

/** 平台通告面(异步结果回执):懒取,未接线/平台未就绪时 null(回执降级为日志) */
async function notifyOf(ctx) {
  try {
    return await ctx.services.get('notify')
  }
  catch {
    return null
  }
}

function buildNotice(meta, id) {
  const intent = meta.intent ?? 'deep-diagnosis'
  const label = intentLabel(intent)
  if (meta.status === 'completed') {
    const reportPath = meta.reportPath ?? null
    return {
      kind: 'tool-result',
      tool: 'diag_run',
      jobId: id,
      agentId: meta.agentId,
      ...(meta.channelId ? { channelId: meta.channelId } : {}),
      ok: true,
      title: `${label}完成(产线 ${meta.line})`,
      summary: [
        meta.score != null ? `评分=${meta.score}` : '',
        meta.verdict ? `结论=${meta.verdict}` : '',
        meta.summary ? `总结=${String(meta.summary).slice(0, 400)}` : '',
        reportPath ? `report_md_path=${reportPath}` : '',
        reportPath
          ? `入库知识库:调用 rag-bridge 的 kb_agent(mode=async)读取该报告文件全文入库(标签:分析,${label}),完成后用 kb_agent_status 查询入库结果。`
          : `报告路径未就绪,可用 diag_status(run_id=${id}) 查询详情。`,
      ].filter(Boolean).join(';'),
    }
  }
  return {
    kind: 'tool-result',
    tool: 'diag_run',
    jobId: id,
    agentId: meta.agentId,
    ...(meta.channelId ? { channelId: meta.channelId } : {}),
    ok: false,
    title: `${label}${meta.status === 'stopped' ? '已停止' : '失败'}(产线 ${meta.line})`,
    summary: meta.error
      ? `原因:${meta.error}`
      : `任务以 ${meta.status} 结束;可用 diag_status(run_id=${id}) 查询详情。`,
  }
}

/** 投递终态回执(幂等:deliveredAt/deliverSkipped 后不再投)。失败保留 pending 下轮重试。 */
async function tryDeliver(ctx, notify, id) {
  const cur = ctx.kv.get(runKey(id))
  if (!cur?.agentId || cur.deliveredAt || cur.deliverSkipped) return
  const attempts = Number(cur.deliverAttempts ?? 0) + 1
  if (!notify) {
    ctx.kv.set(runKey(id), attempts >= MAX_DELIVER_ATTEMPTS
      ? { ...cur, deliverPending: false, deliverSkipped: 'notify-unavailable', deliverAttempts: attempts }
      : { ...cur, deliverPending: true, deliverAttempts: attempts })
    return
  }
  try {
    const delivered = await notify.deliver(buildNotice(cur, id))
    if (delivered === false) {
      // 频道/成员已不存在或已被 Agent 主动 claim(先到先得)→ 重试无意义
      ctx.kv.set(runKey(id), { ...cur, deliverPending: false, deliverSkipped: 'receiver-unavailable', deliverAttempts: attempts, deliveredAt: Date.now() })
      ctx.logger.warn(`分析任务 ${id} 回执未投递(接收方不可用或已被主动领取);结果仍可用 diag_status 查询`)
      return
    }
    ctx.kv.set(runKey(id), { ...cur, deliverPending: false, deliveredAt: Date.now(), deliverAttempts: attempts })
  }
  catch (err) {
    ctx.logger.warn(`分析任务 ${id} 回执投递失败(第 ${attempts}/${MAX_DELIVER_ATTEMPTS} 次,下轮重试): ${err?.message ?? err}`)
    ctx.kv.set(runKey(id), attempts >= MAX_DELIVER_ATTEMPTS
      ? { ...cur, deliverPending: false, deliverSkipped: 'deliver-error', deliverAttempts: attempts }
      : { ...cur, deliverPending: true, deliverAttempts: attempts })
  }
}

export async function sweepOnce(ctx) {
  if (sweeping) return
  const all = kvRuns(ctx).filter(({ meta }) => meta && (!TERMINAL.has(meta.status) || meta.deliverPending))
  if (!all.length) return
  sweeping = true
  try {
    const notify = await notifyOf(ctx)
    const base = baseOf(ctx)
    if (!base) {
      ctx.logger.warn('diag.base_url 非法,本轮跳过任务轮询(仅重试待投递回执)')
      for (const { id, meta } of all) {
        if (TERMINAL.has(meta.status) || meta.deliverPending) await tryDeliver(ctx, notify, id)
      }
      return
    }
    for (const { id, meta } of all) {
      const cur = ctx.kv.get(runKey(id)) ?? meta
      // 已终态但回执未送达:不重复查询远端,只重试投递
      if (TERMINAL.has(cur.status)) {
        await tryDeliver(ctx, notify, id)
        continue
      }
      try {
        // v2.3:统一走任务管理面 /tasks/:id(与 diag_status 同源)——
        // result.report_md_path 是绝对路径(kb_agent 可直接读),result.summary 是报告结论段;
        // 旧 /status 的相对路径会让 kb_agent/Agent 找不到文件。
        const st = (await jget(ctx, `${base}/api/diagnosis/tasks/${encodeURIComponent(id)}`, 8000)).data ?? {}
        const status = String(st.status || st.run_status || cur.status)
        const intent = cur.intent ?? 'deep-diagnosis'
        const result = st.result ?? {}
        if (status === 'completed') {
          ctx.kv.set(runKey(id), {
            ...cur,
            status: 'completed',
            completedAt: cur.completedAt ?? Date.now(),
            name: st.name ?? cur.name,
            score: result.score ?? null,
            verdict: result.verdict ?? null,
            summary: result.summary ?? '',
            reportPath: result.report_md_path ?? null,
            pollErrors: 0,
            deliverPending: Boolean(cur.agentId),
          })
          ctx.logger.info(`分析任务 ${id}[${intent}](产线 ${cur.line})完成——待 Channel 空闲时 diag_status 查询,经 kb_agent 入库知识库`)
          await tryDeliver(ctx, notify, id)
        }
        else if (status === 'failed' || status === 'stopped') {
          ctx.kv.set(runKey(id), {
            ...cur,
            status,
            completedAt: Date.now(),
            name: st.name ?? cur.name,
            error: result.error ?? st.error_message ?? null,
            pollErrors: 0,
            deliverPending: Boolean(cur.agentId),
          })
          ctx.logger.warn(`分析任务 ${id}[${intent}](产线 ${cur.line})结束: ${status}${result.error ? `(${result.error})` : ''}`)
          await tryDeliver(ctx, notify, id)
        }
        else if (status !== cur.status || cur.pollErrors) {
          // queued/running 变化照常落 kv(queued 必须留在轮询集合里)
          ctx.kv.set(runKey(id), { ...cur, status, name: st.name ?? cur.name, pollErrors: 0, lastPollError: undefined })
        }
      }
      catch (err) {
        const msg = String(err?.message ?? err)
        const code = /HTTP (\d{3})/.exec(msg)?.[1] ?? ''
        const attempts = Number(cur.pollErrors ?? 0) + 1
        // 404=任务在 IDD 侧不存在;401/403=token/所有权变化。连续 3 轮仍不可查询 →
        // 收敛为 failed 并回执,避免永久 running 占住产线单飞锁(此前每 15s 无限重试)。
        if (['404', '401', '403'].includes(code) && attempts >= 3) {
          const error = code === '404'
            ? `远端分析任务不存在(HTTP 404,可能被 IDD 清理或服务重启):${msg}`
            : `远端任务查询被拒(HTTP ${code},请检查诊断 Token):${msg}`
          ctx.kv.set(runKey(id), {
            ...cur,
            status: 'failed',
            completedAt: Date.now(),
            error,
            pollErrors: attempts,
            deliverPending: Boolean(cur.agentId),
          })
          ctx.logger.warn(`分析任务 ${id} 无法继续跟踪(第 ${attempts} 轮): ${error}`)
          await tryDeliver(ctx, notify, id)
        }
        else {
          ctx.kv.set(runKey(id), { ...cur, pollErrors: attempts, lastPollError: msg })
          ctx.logger.warn(`轮询分析任务 ${id} 失败(下轮继续): ${msg}`)
        }
      }
    }
  }
  finally {
    sweeping = false
  }
}

// ── 插件入口 ─────────────────────────────────────────────────────────────
