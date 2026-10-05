/**
 * 插件对象（settings / sweep / tools ×9）
 * —— idd-closedloop-bridge：包装 IDD 三件套（sentinel / tuning-memory / optimizer-loop）。
 * 异步范式对齐 diag-bridge v2.1：提交即返 task_id，15s sweep 轮询写 KV；
 * 完成后由 Agent 依返回指引：查状态工具取结果 → rag-bridge kb_agent 以 regime_key 场景化入库。
 */
import { DEFAULT_BASE, IDD_ROUTES, MIN, ROLES, SWEEP_INTERVAL_MS } from './constants.mjs'
import { baseOf, jget, jpost, kvRuns, runKey, text, trackTask } from './helpers.mjs'

export default {
  name: 'idd-closedloop-bridge',
  version: '0.1.0',
  description: 'IDD 闭环分析桥 v0.1:产线哨兵(快速筛查/漂移预警)、调优经验库(动作归因/故障 playbook 检索)、目标闭环寻优(小试轮次)。异步提交即返 task_id,完成后 status 工具取结果;入库知识库经 kb_agent 以工况场景(regime_key)分开。',
  auth: 'user',
  configGroups: [
    { id: 'default', labelKey: 'plugin.idd-closedloop-bridge.group.conn', label: 'IDD 服务连接', description: 'industrial-deep-diagnostic 后端地址与鉴权 Token', order: 460 },
  ],
  settings: [
    { key: 'base_url', type: 'string', default: DEFAULT_BASE, group: 'default', label: 'IDD 后端地址', description: 'industrial-deep-diagnostic 后端(host 限 127.0.0.1/localhost);保存即热生效' },
    { key: 'token', type: 'string', default: '', group: 'default', label: 'IDD API Token', description: 'X-API-Key / Bearer;空=匿名;保存即热生效' },
    { key: 'exchange_dir', type: 'string', default: '', group: 'default', label: '数据交换目录', description: '与 IDD 共享的数据交换目录(须位于 IDD 允许根内,如 IDD workspace/aw-exchange);sentinel/experience 的 data_path 必须指向此处,否则被 IDD 路径沙箱拒绝' },
  ],
  setup(ctx) {
    // 15s sweep:跟踪 sentinel_watch / attribution / optimizer 等异步任务
    const sweep = async () => {
      const running = kvRuns(ctx).filter(r => r.meta?.status === 'running')
      if (!running.length) return
      const base = baseOf(ctx)
      if (!base) return
      for (const { id, kind, meta } of running) {
        try {
          const route = kind === 'experience_log'
            ? IDD_ROUTES.experienceAttribution(id)
            : kind === 'sentinel_watch'
              ? IDD_ROUTES.sentinelStatus(id)
              : null
          if (!route) continue
          const r = await jget(ctx, base + route, 8000)
          const d = r.body?.data ?? r.body ?? {}
          const status = d.status ?? d.phase ?? meta.status
          const done = ['completed', 'converged', 'failed', 'stopped', 'paused', 'exhausted', 'aborted'].includes(String(status))
          if (done) {
            ctx.kv.set(runKey(id), { id, kind, meta: { ...meta, status, completedAt: Date.now(), result: d } })
            ctx.logger.info(`IDD ${kind} 任务 ${id} 结束:${status}——Agent 可用对应 status 工具取结果;分析结论入库经 kb_agent(场景 regime_key)。`)
          } else if (String(status) !== String(meta.status)) {
            const runs = kvRuns(ctx).map(x => (x.id === id ? { ...x, meta: { ...x.meta, status } } : x))
            // kvRuns 返回副本;用 set 写回
            ctx.kv.set('idd_closedloop_runs', runs)
          }
        } catch (err) {
          ctx.logger.warn(`IDD ${kind} 轮询 ${id} 失败(下轮继续): ${err?.message ?? err}`)
        }
      }
    }
    ctx.timer.setInterval(() => sweep().catch(err => ctx.logger.warn(`IDD sweep 异常(继续): ${err?.message ?? err}`)), SWEEP_INTERVAL_MS)
    sweep()

    // ── 哨兵 ─────────────────────────────────────────────────────────────
    ctx.omp.registerTool({
      name: 'sentinel_screen',
      label: '产线哨兵·秒筛',
      description: '增量数据快速筛查(1-500 行,≤5s 同步):判断是否有问题、问题参数是什么、检测指标是否异常。返回 alert.json(检查类型/规则/参数/指标/严重度/建议)。适合对最新一小窗数据做即时判断。',
      parameters: {
        type: 'object',
        properties: {
          data_path: { type: 'string', description: '增量数据 CSV 绝对路径(1-500 行,含 time_col 与参数列)' },
          baseline_path: { type: 'string', description: 'watch_baseline.json 路径(缺省用该产线已登记基线;无基线将返回 exit=2 指引先建基线)' },
          time_col: { type: 'string', description: '时间列名(缺省由基线继承)' },
          group_col: { type: 'string', description: '分组列名(多产品/牌号时)' },
        },
        required: ['data_path'],
      },
      roles: ROLES,
      handler: async (args) => {
        const base = baseOf(ctx)
        if (!base) return text('IDD base_url 未配置或非法(插件设置里填 127.0.0.1/localhost 地址)。')
        const payload = { data_path: String(args.data_path ?? ''), baseline_path: args.baseline_path ? String(args.baseline_path) : null, time_col: args.time_col ?? null, group_col: args.group_col ?? null }
        const r = await jpost(ctx, base + IDD_ROUTES.sentinelScreen, payload, 15000)
        if (!r.ok) return text('sentinel_screen 失败: ' + String(r.body?.error ?? r.status))
        const d = r.body?.data ?? r.body
        const exit = d.exit_code ?? d.exit ?? 0
        if (Number(exit) === 2) return text('无法判定(无基线或数据不足)。请先调 sentinel_baseline 产线建档,再用本工具重筛。')
        const alerts = d.alerts ?? []
        if (!alerts.length) return text('筛查完成:本次无异常(status=ok)。')
        const lines = alerts.map(a => `- [${a.severity}/${a.rule_name}] ${a.parameter ?? a.indicator ?? a.group ?? '?'} ${a.evidence?.hours_to_edge != null ? `(预计 ${a.evidence.hours_to_edge}h 后出窗)` : ''} 建议: ${a.suggested_check ?? '关注'}`)
        return text(`筛查完成:发现 ${alerts.length} 条告警(status=${d.status})。\n${lines.join('\n')}\n如需深挖根因可调 diag_run;如需看趋势与漂移可调 sentinel_watch 做整窗批筛。`)
      },
    })

    ctx.omp.registerTool({
      name: 'sentinel_watch',
      label: '产线哨兵·批筛',
      description: '整窗批筛(异步,提交即返 task_id,1k-10 万行,≤2min):SPC 规则/窗口漂移投影/变点与稳态/多变量稳健异常全量检查。完成后用 sentinel_status(task_id) 取 alert.json 与中文报告路径。',
      parameters: {
        type: 'object',
        properties: {
          data_path: { type: 'string', description: '数据窗 CSV 绝对路径' },
          baseline_path: { type: 'string', description: 'watch_baseline.json 路径(缺省自基线,告警会带 SELF_BASELINE 提示 48h 内固化)' },
          time_col: { type: 'string' },
          group_col: { type: 'string' },
        },
        required: ['data_path'],
      },
      roles: ROLES,
      handler: async (args) => {
        const base = baseOf(ctx)
        if (!base) return text('IDD base_url 未配置或非法。')
        const r = await jpost(ctx, base + IDD_ROUTES.sentinelWatch, { data_path: String(args.data_path ?? ''), baseline_path: args.baseline_path ?? null, time_col: args.time_col ?? null, group_col: args.group_col ?? null }, 30000)
        if (!r.ok) return text('sentinel_watch 提交失败: ' + String(r.body?.error ?? r.status))
        const taskId = String(r.body?.data?.task_id ?? r.body?.task_id ?? '')
        if (!taskId) return text('提交异常:响应缺少 task_id。')
        trackTask(ctx, { taskId, kind: 'sentinel_watch', meta: { source: 'agent' } })
        return text(`已提交哨兵批筛异步任务 task_id=${taskId}(后台执行,≤2min)。Channel 无需等待——空闲时用 sentinel_status(task_id=${taskId}) 取告警与报告;结论文档入库经 kb_agent(标题带工况 regime_key 场景)。`)
      },
    })

    ctx.omp.registerTool({
      name: 'sentinel_status',
      label: '哨兵任务状态',
      description: '查询哨兵批筛异步任务状态与结果(完成后返回告警摘要与 alert.json/报告 md 路径)。',
      parameters: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } },
      roles: ROLES,
      handler: async (args) => {
        const taskId = String(args.task_id ?? '').trim()
        const local = kvRuns(ctx).find(x => x.id === taskId)
        const base = baseOf(ctx)
        if (!base) return text('IDD base_url 未配置。')
        const r = await jget(ctx, base + IDD_ROUTES.sentinelStatus(taskId), 10000)
        const d = r.body?.data ?? r.body ?? {}
        const alerts = d.alerts ?? []
        const failed = String(d.status ?? '').toLowerCase() === 'failed'
        const head = alerts.length
          ? `告警 ${alerts.length} 条:\n` + alerts.slice(0, 8).map(a => `- [${a.severity}/${a.rule_name}] ${a.parameter ?? a.indicator ?? '?'}`).join('\n')
          : (failed ? '无告警(任务失败,原因见下)。' : '无告警(status=ok)。')
        const errNote = failed
          ? `\n⚠ 失败原因: ${d.error ?? d.error_message ?? '未知'}${d.stdout_tail ? `\n日志尾: ${String(d.stdout_tail).slice(0, 300)}` : ''}\n常见原因:数据路径不在 IDD 允许根内(把 CSV 放入插件 settings 的 exchange_dir 交换目录后重试)/CSV 缺时间列或参数列。`
          : ''
        return text(`task ${taskId} 状态=${d.status ?? local?.meta?.status ?? 'unknown'}。\n${head}${errNote}\n${d.report_path ? `报告: ${d.report_path}\n` : ''}${d.alert_path ? `alert.json: ${d.alert_path}\n` : ''}入库知识库请调 kb_agent(prompt 注明标题与工况场景 regime_key,如 PG31DS|磨机|steady)。`)
      },
    })

    ctx.omp.registerTool({
      name: 'sentinel_baseline',
      label: '哨兵建档',
      description: '从 doe-analyzer 分析产物+历史数据生成哨兵基线(watch_baseline.json):窗口/规格/稳态统计/相关结构。异步任务,完成后用 sentinel_status 查询。',
      parameters: {
        type: 'object',
        properties: {
          doe_run_dir: { type: 'string', description: 'doe-analyzer 分析 RUN_DIR(取 conclusions/recommendations.json 与 stability_report)' },
          history_csv: { type: 'string', description: '历史稳态数据 CSV 绝对路径' },
          line: { type: 'string', description: '产线/机组标识(基线登记名)' },
        },
        required: ['history_csv', 'line'],
      },
      roles: ROLES,
      handler: async (args) => {
        const base = baseOf(ctx)
        if (!base) return text('IDD base_url 未配置。')
        const r = await jpost(ctx, base + IDD_ROUTES.sentinelBaseline, { doe_run_dir: args.doe_run_dir ?? null, history_csv: String(args.history_csv ?? ''), line: String(args.line ?? '') }, 30000)
        if (!r.ok) return text('sentinel_baseline 提交失败: ' + String(r.body?.error ?? r.status))
        const taskId = String(r.body?.data?.task_id ?? r.body?.task_id ?? '')
        trackTask(ctx, { taskId, kind: 'sentinel_watch', meta: { source: 'agent', baseline: true } })
        return text(`基线构建已提交 task_id=${taskId}。完成后 sentinel_status(task_id=${taskId}) 查看;之后即可 sentinel_screen/watch 用该产线基线。`)
      },
    })

    // ── 调优经验库 ────────────────────────────────────────────────────
    ctx.omp.registerTool({
      name: 'experience_log',
      label: '调参动作登记',
      description: '登记一次调参动作(工程师或系统),IDD 后台做动作→效果确定性归因(异步)。这是经验库的数据入口:登记越规范,后续故障 playbook 越可信。',
      parameters: {
        type: 'object',
        properties: {
          actions: { type: 'array', description: '动作数组,每项 {parameter, from, to, unit}', items: { type: 'object' } },
          ts: { type: 'string', description: '动作生效时刻(ISO8601,缺省 now)' },
          product: { type: 'string', description: '牌号/产品(归因分层关键)' },
          machine: { type: 'string', description: '机台' },
          trigger_alert_id: { type: 'string', description: '触发告警 id(如有)' },
          recommendation_id: { type: 'string', description: '执行的 recommendation id(如按建议执行,必填以闭合回执链)' },
          confounds: { type: 'string', description: '同期混杂说明(换料/检修等,文本)' },
        },
        required: ['actions'],
      },
      roles: ROLES,
      handler: async (args) => {
        const base = baseOf(ctx)
        if (!base) return text('IDD base_url 未配置。')
        const body = {
          schema_version: '1.0',
          ts: args.ts ?? new Date().toISOString(),
          actor: { actor_id: 'aws_agent', actor_type: 'control_system' },
          actions: Array.isArray(args.actions) ? args.actions : [],
          context: { product: args.product ?? null, machine: args.machine ?? null },
          trigger: args.trigger_alert_id ? { trigger_type: 'alert', ref_id: String(args.trigger_alert_id) } : { trigger_type: 'manual' },
          attribution_confounds: args.confounds ? [{ type: 'other_action', note: String(args.confounds) }] : [],
          recommendation_ref: args.recommendation_id ? String(args.recommendation_id) : null,
          ingest_meta: { source: 'api' },
        }
        const r = await jpost(ctx, base + IDD_ROUTES.experienceActions, { action_log: body }, 30000)
        if (!r.ok) return text('experience_log 失败: ' + String(r.body?.error ?? r.status))
        const d = r.body?.data ?? {}
        trackTask(ctx, { taskId: String(d.attribution_job_id ?? d.action_log_id ?? ''), kind: 'experience_log', meta: { source: 'agent' } })
        return text(`动作已登记 id=${d.action_log_id ?? '?'}(归因任务 ${d.attribution_job_id ?? '排队中'},异步执行)。归因完成后 experience_recommend 即可检索到本条经验;同工况佐证 ≥2 自动升级 E2/approve_required。`)
      },
    })

    ctx.omp.registerTool({
      name: 'experience_recommend',
      label: '故障经验检索',
      description: '按故障签名(异常参数+方向+工况)检索历史有效控制动作 playbook,带证据分级(E0-E3)与自治级别(suggest/approve_required)。无命中时走四级降级链并给 doe-analyzer 现场分析提示。',
      parameters: {
        type: 'object',
        properties: {
          anomalous_params: { type: 'array', description: '异常参数数组,每项 {parameter, direction: high|low}', items: { type: 'object' } },
          product: { type: 'string' },
          machine: { type: 'string' },
          regime_label: { type: 'string' },
          degraded_metric: { type: 'string', description: '劣化的检测指标名' },
        },
        required: ['anomalous_params'],
      },
      roles: ROLES,
      handler: async (args) => {
        const base = baseOf(ctx)
        if (!base) return text('IDD base_url 未配置。')
        const sig = { signature_version: '1.0', anomalous_params: Array.isArray(args.anomalous_params) ? args.anomalous_params : [], regime: { product: args.product ?? null, machine: args.machine ?? null, regime_label: args.regime_label ?? null }, degraded_metric: args.degraded_metric ?? null }
        const r = await jpost(ctx, base + IDD_ROUTES.experienceRecommend, { fault_signature: sig, top_k: 5, regime_fallback: true }, 20000)
        if (!r.ok) return text('experience_recommend 失败: ' + String(r.body?.error ?? r.status))
        const d = r.body?.data ?? {}
        if (d.recommendation_status === 'no_playbook_hit') return text(`无 playbook 命中(降级链: ${(d.degradation_path ?? []).join(' → ')})。建议调 diag_run 做现场根因分析,或调 sentinel_watch 看趋势;拿到结论后用 experience_log 登记处置动作积累经验。`)
        const pbs = (d.playbooks ?? []).map((p, i) => `${i + 1}. [${p.evidence_grade}/${p.autonomy_level}] ${JSON.stringify(p.action_sequence ?? [])} (佐证 ${p.corroboration_count ?? 0}/反证 ${p.refutation_count ?? 0})`)
        const rid = d.recommendation_id ?? ''
        return text(`推荐 status=${d.recommendation_status} match_scope=${d.match_scope ?? '-'} recommendation_id=${rid}。\n${pbs.join('\n') || '(仅方向性知识,无完整 playbook)'}\n执行规则: suggest 仅人工参考;approve_required 需工程师批准;执行后务必用 experience_log(带 recommendation_id=${rid})回写动作以闭合效果归因。`)
      },
    })

    ctx.omp.registerTool({
      name: 'experience_feedback',
      label: '经验反馈',
      description: '对已执行的经验/建议回填结果(effective/ineffective/harmful):有效计佐证(≥2 升 E2),有害计反证(≥2 降级回 suggest)——经验库自我强化的闭环。',
      parameters: {
        type: 'object',
        properties: {
          experience_id: { type: 'string' },
          result: { type: 'string', enum: ['effective', 'ineffective', 'harmful'] },
          note: { type: 'string' },
        },
        required: ['experience_id', 'result'],
      },
      roles: ROLES,
      handler: async (args) => {
        const base = baseOf(ctx)
        if (!base) return text('IDD base_url 未配置。')
        const r = await jpost(ctx, base + IDD_ROUTES.experienceFeedback, { experience_id: String(args.experience_id), result: String(args.result), note: args.note ?? null }, 15000)
        if (!r.ok) return text('experience_feedback 失败: ' + String(r.body?.error ?? r.status))
        return text('反馈已记录: ' + JSON.stringify(r.body?.data ?? {}))
      },
    })

    // ── 目标闭环寻优 ────────────────────────────────────────────────
    ctx.omp.registerTool({
      name: 'optimizer_campaign',
      label: '创建寻优目标',
      description: '创建目标闭环寻优 campaign(例:把双折射率控制在 [1.52,1.56])。给定目标指标/方向/目标区间/因子域/预算;可引用 doe-analyzer 先验。返回 campaign_id 与首轮布点。',
      parameters: {
        type: 'object',
        properties: {
          target_metric: { type: 'string', description: '目标指标名(响应列名)' },
          goal: { type: 'string', enum: ['target', 'minimize', 'maximize'] },
          target_low: { type: 'number', description: 'goal=target 时必填:区间下界' },
          target_high: { type: 'number', description: 'goal=target 时必填:区间上界' },
          factors: { type: 'array', description: '因子数组 [{name,type,min,max,unit} 或 {name,type,levels[]}]', items: { type: 'object' } },
          constraints: { type: 'string', description: '约束说明(JSON 数组文本,含安全限 hard:true)' },
          doe_run_dir: { type: 'string', description: '可选:doe-analyzer 先验 RUN_DIR' },
          max_rounds: { type: 'number', description: '最大轮数(缺省 12)' },
          max_trials: { type: 'number', description: '最大试验点数(缺省 60;重复不计数)' },
        },
        required: ['target_metric', 'goal', 'factors'],
      },
      roles: ROLES,
      handler: async (args) => {
        const base = baseOf(ctx)
        if (!base) return text('IDD base_url 未配置。')
        const isTarget = String(args.goal) === 'target'
        if (isTarget && !(Number(args.target_low) < Number(args.target_high))) return text('goal=target 需要 target_low<target_high。')
        let constraints = []
        try { constraints = args.constraints ? JSON.parse(args.constraints) : [] } catch { return text('constraints 需为 JSON 数组文本。') }
        const objective = {
          contract_version: '1.0',
          campaign_id: `OPT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Date.now()).slice(-3)}`,
          target_metric: String(args.target_metric),
          goal: String(args.goal),
          target_range: isTarget ? [Number(args.target_low), Number(args.target_high)] : null,
          factors: Array.isArray(args.factors) ? args.factors : [],
          constraints,
          budget: { max_rounds: Number(args.max_rounds) || 12, max_trials: Number(args.max_trials) || 60 },
          prior: args.doe_run_dir ? { doe_analyzer_run_dir: String(args.doe_run_dir) } : null,
          seed: 42,
        }
        const r = await jpost(ctx, base + IDD_ROUTES.optimizerCampaign, objective, 30000)
        if (!r.ok) return text('optimizer_campaign 失败: ' + String(r.body?.error ?? r.status))
        const d = r.body?.data ?? {}
        return text(`campaign ${d.campaign_id ?? objective.campaign_id} 已创建(phase=${d.phase ?? 'initialized'})。调 optimizer_round(campaign_id, action='design') 取首轮布点;AWS/人工执行后 optimizer_round(action='ingest', trial_result) 回收——循环至 converged(双门槛:3 次重复落窗 ∧ D≥0.8·D_max)。收敛后经 kb_agent 把 recipe 按场景入库。`)
      },
    })

    ctx.omp.registerTool({
      name: 'optimizer_round',
      label: '寻优轮次',
      description: "寻优轮次操作:action='design' 取下一轮布点表(trial_design:每点 setpoints/预期/外推标记);action='ingest' 回收本轮试验结果(触发状态机转移)。",
      parameters: {
        type: 'object',
        properties: {
          campaign_id: { type: 'string' },
          action: { type: 'string', enum: ['design', 'ingest'] },
          trial_result: { type: 'object', description: "action=ingest 时必填:{round_id, trials:[{trial_id,status,measurements:{指标:[重复值]}}], late_results?}" },
        },
        required: ['campaign_id', 'action'],
      },
      roles: ROLES,
      handler: async (args) => {
        const base = baseOf(ctx)
        if (!base) return text('IDD base_url 未配置。')
        const action = String(args.action ?? 'design')
        const payload = { campaign_id: String(args.campaign_id), action }
        if (action === 'ingest') {
          if (!args.trial_result) return text("action=ingest 需要 trial_result。")
          payload.trial_result = args.trial_result
        }
        const r = await jpost(ctx, base + IDD_ROUTES.optimizerRound, payload, 60000)
        if (!r.ok) return text('optimizer_round 失败: ' + String(r.body?.error ?? r.status))
        const d = r.body?.data ?? {}
        if (action === 'design') {
          const trials = (d.trial_design?.trials ?? []).map(t => `- ${t.trial_id}: ${JSON.stringify(t.setpoints)}${t.extrapolation ? '(外推!需工艺确认)' : ''}`)
          return text(`R 轮布点(phase=${d.phase ?? '?'}, method=${d.method ?? '?'})剩预算 ${JSON.stringify(d.budget_remaining ?? {})}:\n${trials.join('\n') || '(无布点)'}\n执行后请以 trial_result 回收(每点重复值给 measurements 数组);人工实验室可用 CSV 模板。`)
        }
        return text(`结果已回收:phase=${d.phase} 转移=${d.transition ?? '-'} incumbent=${JSON.stringify(d.incumbent ?? {})} next=${d.next_action?.recommendation}${(d.next_action?.reasons ?? []).length ? '(' + d.next_action.reasons.join(';') + ')' : ''}。`)
      },
    })

    ctx.omp.registerTool({
      name: 'optimizer_state',
      label: '寻优状态',
      description: '查询 campaign 状态:phase/incumbent/预算/信念/轮次历史/下一步建议。',
      parameters: { type: 'object', required: ['campaign_id'], properties: { campaign_id: { type: 'string' } } },
      roles: ROLES,
      handler: async (args) => {
        const base = baseOf(ctx)
        if (!base) return text('IDD base_url 未配置。')
        const r = await jget(ctx, base + IDD_ROUTES.optimizerState + `?campaign_id=${encodeURIComponent(String(args.campaign_id))}`, 15000)
        const d = r.body?.data ?? r.body ?? {}
        return text(`campaign ${args.campaign_id}: phase=${d.phase} rounds=${d.round_count} trials=${d.trial_count}\nincumbent=${JSON.stringify(d.incumbent ?? {})}\nnext=${d.next_action?.recommendation ?? '-'}\nbudget=${JSON.stringify(d.budget ?? {})}`)
      },
    })
  },
}
