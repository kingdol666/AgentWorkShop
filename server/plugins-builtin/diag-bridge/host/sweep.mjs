/**
 * 自动巡检:按规则扫描产线并触发诊断
 * (由 server/plugins-builtin/diag-bridge/index.mjs 按职责拆出;内容逐行原文搬运)
 */
import { baseOf, jget, kvRuns, runKey } from './helpers.mjs'
import { intentLabel } from './intents.mjs'

/** 平台通告面(异步结果回执):懒取,未接线/平台未就绪时 null(回执降级为日志,行为同旧版) */
async function notifyOf(ctx) {
  try {
    return await ctx.services.get('notify')
  }
  catch {
    return null
  }
}

export async function sweepOnce(ctx) {
  const running = kvRuns(ctx).filter(r => r.meta?.status === 'running')
  if (!running.length) return
  const base = baseOf(ctx)
  if (!base) {
    ctx.logger.warn('diag.base_url 非法,本轮跳过诊断轮询')
    return
  }
  const notify = await notifyOf(ctx)
  for (const { id, meta } of running) {
    try {
      // v2.3:统一走任务管理面 /tasks/:id(与 diag_status 同源)——
      // result.report_md_path 是绝对路径(kb_agent 可直接读),result.summary 是报告结论段;
      // 旧 /status 的相对路径会让 kb_agent/Agent 找不到文件。
      const st = (await jget(ctx, `${base}/api/diagnosis/tasks/${encodeURIComponent(id)}`, 8000)).data ?? {}
      const status = st.status || st.run_status || meta.status
      const intent = meta.intent ?? 'deep-diagnosis'
      if (status === 'completed') {
        const result = st.result ?? {}
        ctx.kv.set(runKey(id), {
          ...meta,
          status: 'completed',
          completedAt: meta.completedAt ?? Date.now(),
          name: st.name ?? meta.name,
          score: result.score ?? null,
          verdict: result.verdict ?? null,
          summary: result.summary ?? '',
          reportPath: result.report_md_path ?? null,
        })
        ctx.logger.info(`分析任务 ${id}[${intent}](产线 ${meta.line})完成——待 Channel 空闲时 diag_status 查询,经 kb_agent 入库知识库`)
        // 异步结果回执:发起 Agent 不必轮询,完成后平台投递信箱消息并即时唤醒;
        // claim 先到先得(Agent 已用 diag_status 看到则不再补送)
        if (meta.agentId) {
          const reportPath = result.report_md_path ?? null
          notify?.deliver({
            kind: 'tool-result',
            tool: 'diag_run',
            jobId: id,
            agentId: meta.agentId,
            ...(meta.channelId ? { channelId: meta.channelId } : {}),
            ok: true,
            title: `${intentLabel(intent)}完成(产线 ${meta.line})`,
            summary: [
              result.score != null ? `评分=${result.score}` : '',
              result.verdict ? `结论=${result.verdict}` : '',
              result.summary ? `总结=${String(result.summary).slice(0, 400)}` : '',
              reportPath ? `report_md_path=${reportPath}` : '',
              reportPath
                ? '入库知识库:调用 rag-bridge 的 kb_agent(mode=async)读取该报告文件全文入库(标签:分析,' + intentLabel(intent) + '),完成后用 kb_agent_status 查询入库结果。'
                : '报告路径未就绪,可用 diag_status(run_id=' + id + ') 查询详情。',
            ].filter(Boolean).join(';'),
          })
        }
      }
      else if (status === 'failed' || status === 'stopped') {
        ctx.kv.set(runKey(id), {
          ...meta,
          status,
          completedAt: Date.now(),
          name: st.name ?? meta.name,
          error: st.result?.error ?? null,
        })
        ctx.logger.warn(`分析任务 ${id}[${intent}](产线 ${meta.line})结束: ${status}${st.result?.error ? `(${st.result.error})` : ''}`)
        if (meta.agentId) {
          notify?.deliver({
            kind: 'tool-result',
            tool: 'diag_run',
            jobId: id,
            agentId: meta.agentId,
            ...(meta.channelId ? { channelId: meta.channelId } : {}),
            ok: false,
            title: `${intentLabel(intent)}${status === 'stopped' ? '已停止' : '失败'}(产线 ${meta.line})`,
            summary: st.result?.error
              ? `原因:${st.result.error}`
              : `任务以 ${status} 结束;可用 diag_status(run_id=${id}) 查询详情。`,
          })
        }
      }
      else if (status !== meta.status) {
        ctx.kv.set(runKey(id), { ...meta, status, name: st.name ?? meta.name })
      }
    }
    catch (err) {
      ctx.logger.warn(`轮询分析任务 ${id} 失败(下轮继续): ${err?.message ?? err}`)
    }
  }
}

// ── 插件入口 ─────────────────────────────────────────────────────────────
