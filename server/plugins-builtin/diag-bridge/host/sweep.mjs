/**
 * 自动巡检:按规则扫描产线并触发诊断
 * (由 server/plugins-builtin/diag-bridge/index.mjs 按职责拆出;内容逐行原文搬运)
 */
import { baseOf, jget, kvRuns, runKey } from './helpers.mjs'

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
      const st = (await jget(ctx, `${base}/api/diagnosis/status/${encodeURIComponent(id)}`, 8000)).data ?? {}
      const status = st.engineStatus || st.status || meta.status
      if (status === 'completed') {
        ctx.kv.set(runKey(id), {
          ...meta,
          status: 'completed',
          completedAt: meta.completedAt ?? Date.now(),
          name: st.name ?? meta.name,
          score: st.score ?? null,
          verdict: st.judge_verdict ?? null,
          reportPath: st.report_path ?? null,
        })
        ctx.logger.info(`诊断 ${id}(产线 ${meta.line})完成——待 Channel 空闲时 diag_status 查询,经 kb_agent 入库知识库`)
        // 异步结果回执:发起 Agent 不必轮询,完成后平台投递信箱消息并即时唤醒;
        // claim 先到先得(Agent 已用 diag_status 看到则不再补送)
        if (meta.agentId) {
          const reportPath = st.report_path ?? null
          notify?.deliver({
            kind: 'tool-result',
            tool: 'diag_run',
            jobId: id,
            agentId: meta.agentId,
            ...(meta.channelId ? { channelId: meta.channelId } : {}),
            ok: true,
            title: `深度诊断完成(产线 ${meta.line})`,
            summary: [
              st.score != null ? `评分=${st.score}` : '',
              st.judge_verdict ? `结论=${st.judge_verdict}` : '',
              reportPath ? `report_md_path=${reportPath}` : '',
              reportPath
                ? '入库知识库:调用 rag-bridge 的 kb_agent(mode=async)读取该报告文件全文入库(标签:诊断、深度诊断),完成后用 kb_agent_status 查询入库结果。'
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
          error: st.error_message ?? null,
        })
        ctx.logger.warn(`诊断 ${id}(产线 ${meta.line})结束: ${status}${st.error_message ? `(${st.error_message})` : ''}`)
        if (meta.agentId) {
          notify?.deliver({
            kind: 'tool-result',
            tool: 'diag_run',
            jobId: id,
            agentId: meta.agentId,
            ...(meta.channelId ? { channelId: meta.channelId } : {}),
            ok: false,
            title: `深度诊断${status === 'stopped' ? '已停止' : '失败'}(产线 ${meta.line})`,
            summary: st.error_message
              ? `原因:${st.error_message}`
              : `诊断以 ${status} 结束;可用 diag_status(run_id=${id}) 查询详情。`,
          })
        }
      }
      else if (status !== meta.status) {
        ctx.kv.set(runKey(id), { ...meta, status, name: st.name ?? meta.name })
      }
    }
    catch (err) {
      ctx.logger.warn(`轮询诊断 ${id} 失败(下轮继续): ${err?.message ?? err}`)
    }
  }
}

// ── 插件入口 ─────────────────────────────────────────────────────────────
