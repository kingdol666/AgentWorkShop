/**
 * 自动巡检:轮询 IDD 后台任务并把终态/回执送达发起 Agent。
 *
 * 生命周期铁律(2026-10-18 修复,2026-11-18 WS-2 扩展 v1 契约):
 *  - 未终态 = queued | running | awaiting_input 都参与轮询与占锁;
 *  - v1 六态:completed/failed/stopped/interrupted/expired 为终态;
 *    awaiting_input 单列 —— 不触发终态回执、不释放单飞锁,超过老化上限转 expired 并提示;
 *  - 契约按 run meta.contract 路由(提交/轮询/状态/回执全链同契约,消除双状态源);
 *  - 终态先落 kv,再投递;投递失败保留 deliverPending 由下一轮重试(不再静默丢失回执);
 *  - v1 404 连续 3 轮 → 收敛为 expired(任务过期/IDD 重启丢失),legacy 仍为 failed;
 *  - 单轮不重入(15s 定时器不等待异步,串行 N×8s 可能超过周期)。
 */
import { baseOf, jget, kvRuns, runKey } from './helpers.mjs'
import { buildNotice, completedMeta, isTerminal, terminalMeta } from './receipt.mjs'
import { awaitingMaxMinutesOf, normalizeResult, v1Task } from './external-v1.mjs'

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

/** 远端状态查询:按 meta.contract 路由(v1 /tasks/:id vs legacy /diagnosis/tasks/:id) */
async function queryRemote(ctx, base, cur, id) {
  const contract = String(cur.contract ?? 'legacy')
  if (contract === 'v1') {
    const r = await v1Task(ctx, cur.taskId || id, 8000)
    if (!r.ok) {
      const err = new Error(r.error || 'v1 task query failed')
      err.code = String(r.body?.code ?? '')
      err.status = r.status
      throw err
    }
    return { contract, data: r.body?.data ?? {} }
  }
  const st = (await jget(ctx, `${base}/api/diagnosis/tasks/${encodeURIComponent(id)}`, 8000)).data ?? {}
  return { contract, data: st }
}

export async function sweepOnce(ctx) {
  if (sweeping) return
  const all = kvRuns(ctx).filter(({ meta }) => meta && (!isTerminal(meta.status) || meta.deliverPending))
  if (!all.length) return
  sweeping = true
  try {
    const notify = await notifyOf(ctx)
    const base = baseOf(ctx)
    if (!base) {
      ctx.logger.warn('diag.base_url 非法,本轮跳过任务轮询(仅重试待投递回执)')
      for (const { id, meta } of all) {
        if (isTerminal(meta.status) || meta.deliverPending) await tryDeliver(ctx, notify, id)
      }
      return
    }
    for (const { id, meta } of all) {
      const cur = ctx.kv.get(runKey(id)) ?? meta
      // 已终态但回执未送达:不重复查询远端,只重试投递
      if (isTerminal(cur.status)) {
        await tryDeliver(ctx, notify, id)
        continue
      }
      try {
        const { contract, data } = await queryRemote(ctx, base, cur, id)
        const status = String(data.status || data.run_status || cur.status)
        const normalized = normalizeResult(data)
        if (status === 'completed') {
          ctx.kv.set(runKey(id), completedMeta(cur, normalized, {
            contract,
            name: data.name ?? cur.name,
            taskId: cur.taskId || id,
            runId: data.run_id ?? cur.runId ?? id,
          }))
          ctx.logger.info(`分析任务 ${id}[${cur.intent ?? 'deep-diagnosis'}](产线 ${cur.line})完成[contract=${contract}]`)
          await tryDeliver(ctx, notify, id)
        }
        else if (isTerminal(status)) {
          ctx.kv.set(runKey(id), terminalMeta(cur, status, normalized.error ?? data.error_message ?? null, {
            contract,
            name: data.name ?? cur.name,
          }))
          ctx.logger.warn(`分析任务 ${id}[${cur.intent ?? 'deep-diagnosis'}](产线 ${cur.line})结束: ${status}${normalized.error ? `(${normalized.error})` : ''}`)
          await tryDeliver(ctx, notify, id)
        }
        else if (status === 'awaiting_input') {
          // 等待人工介入:占锁 + 不触发终态回执;老化到期转 expired 并提示(Agent 得知需人工介入)
          const since = Number(cur.awaitingSince ?? 0) || Date.now()
          const maxMs = awaitingMaxMinutesOf(ctx) * 60_000
          if (Date.now() - since >= maxMs) {
            const error = `分析在 awaiting_input(等待人工介入)超过 ${Math.round(maxMs / 60_000)} 分钟,已转为 expired;如需继续请重新发起或在 IDD 控制台处理。`
            ctx.kv.set(runKey(id), terminalMeta(cur, 'expired', error, { contract, awaitingSince: since }))
            ctx.logger.warn(`分析任务 ${id} awaiting_input 老化到期 → expired`)
            await tryDeliver(ctx, notify, id)
          }
          else {
            const patch = { ...cur, status: 'awaiting_input', contract, awaitingSince: since, pollErrors: 0 }
            if (!cur.awaitingNotified) {
              patch.awaitingNotified = true
              ctx.logger.warn(`分析任务 ${id} 进入 awaiting_input(等待人工介入,占锁;${Math.round(maxMs / 60_000)} 分钟内未处理将转 expired)`)
            }
            ctx.kv.set(runKey(id), patch)
          }
        }
        else if (status !== cur.status || cur.pollErrors || cur.contract !== contract) {
          // queued/running 变化照常落 kv(queued 必须留在轮询集合里)
          ctx.kv.set(runKey(id), { ...cur, status, contract, name: data.name ?? cur.name, pollErrors: 0, lastPollError: undefined })
        }
      }
      catch (err) {
        const msg = String(err?.message ?? err)
        const code = String(err?.code ?? '') || (/HTTP (\d{3})/.exec(msg)?.[1] ?? '')
        const attempts = Number(cur.pollErrors ?? 0) + 1
        // 404=任务在 IDD 侧不存在;401/403=token/所有权变化。连续 3 轮仍不可查询 →
        // v1 按 expired(任务过期/重启丢失),legacy 按 failed(历史语义不变)。
        if (['404', '401', '403'].includes(code) && attempts >= 3) {
          const contract = String(cur.contract ?? 'legacy')
          const status = code === '404' && contract === 'v1' ? 'expired' : 'failed'
          const error = code === '404'
            ? `远端分析任务不存在(HTTP 404,可能被 IDD 清理或服务重启):${msg}`
            : `远端任务查询被拒(HTTP ${code},请检查诊断 Token):${msg}`
          ctx.kv.set(runKey(id), terminalMeta(cur, status, error, { pollErrors: attempts }))
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
