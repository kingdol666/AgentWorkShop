/**
 * 自动巡检:按规则扫描产线并触发诊断
 * (由 server/plugins-builtin/diag-bridge/index.mjs 按职责拆出;内容逐行原文搬运)
 */
import { baseOf, jget, kvRuns, runKey } from './helpers.mjs'

export async function sweepOnce(ctx) {
  const running = kvRuns(ctx).filter(r => r.meta?.status === 'running')
  if (!running.length) return
  const base = baseOf(ctx)
  if (!base) {
    ctx.logger.warn('diag.base_url 非法,本轮跳过诊断轮询')
    return
  }
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
