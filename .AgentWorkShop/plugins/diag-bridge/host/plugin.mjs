/**
 * 插件对象(settings / routes / tools / hooks)
 * (由 server/plugins-builtin/diag-bridge/index.mjs 按职责拆出;内容逐行原文搬运)
 */
import { AUTO_COOLDOWN_MS, DEFAULT_BASE, MIN } from './constants.mjs'
import { authHeadersOf, authHint, autoEnabledOf, autoRulesOf, baseOf, diagTokenOf, harnessOf, jget, kvRuns, parseAutoRules, runKey } from './helpers.mjs'
import { snapshotCore } from './snapshot.mjs'
import { startDiagnosis } from './diagnosis.mjs'
import { sweepOnce } from './sweep.mjs'

export default {
  name: 'diag-bridge',
  version: '2.1.0',
  description: '深度诊断桥接 v2.1:异步任务式深度诊断(提交即返 task_id,Channel 免等待);完成后 diag_status 给出报告 md 路径,由 Agent 调 rag-bridge 的 kb_agent 入库知识库(插件协同)。',
  auth: 'user',
  client: './client.mjs', // 前端面板(插件页注入;i18n 见 i18n.json)
  // 插件配置分组(声明式):连接 / 执行 / 自动化 三个独立分区
  configGroups: [
    { id: 'default', labelKey: 'plugin.diag-bridge.group.conn', label: '诊断服务连接', description: '后端地址与鉴权 Token', order: 420 },
    { id: 'run', labelKey: 'plugin.diag-bridge.group.run', label: '诊断执行参数', description: 'diag_run 的引擎与预算', order: 430 },
    { id: 'auto', labelKey: 'plugin.diag-bridge.group.auto', label: '自动诊断', description: '越限自动发起诊断(DAQ 采样事件驱动)', order: 440, collapsed: true },
  ],
  // 插件设置声明(key 编址 plugins.diag-bridge.<key>;labelKey 解析 i18n.json)
  settings: [
    { key: 'base_url', type: 'string', default: DEFAULT_BASE, group: 'default', labelKey: 'plugin.diag-bridge.settings.base_url', label: '诊断服务地址', description: 'industrial-deep-diagnostic 后端(http/https,host 限 127.0.0.1/localhost);保存即热生效' },
    { key: 'token', type: 'string', default: '', group: 'default', labelKey: 'plugin.diag-bridge.settings.token', label: '诊断 API Token', description: '诊断服务开启鉴权时(v4 起默认强制)的 API Token(Authorization: Bearer);空=匿名;保存即热生效' },
    { key: 'harness', type: 'string', default: '', group: 'run', labelKey: 'plugin.diag-bridge.settings.harness', label: '诊断引擎', description: 'diag_run 用的引擎 id(omp/claude/mock 等;空=取 kv/omp);无 Anthropic key 的机器请用 omp' },
    { key: 'max_turns', type: 'number', default: 0, min: 0, max: 2000, group: 'run', labelKey: 'plugin.diag-bridge.settings.max_turns', label: '诊断最大轮数', description: 'diagnosis/start 的 maxTurns(0=取 kv/内置默认 220)' },
    { key: 'max_minutes', type: 'number', default: 0, min: 0, max: 720, group: 'run', labelKey: 'plugin.diag-bridge.settings.max_minutes', label: '诊断超时(分钟)', description: 'diagnosis/start 的 timeoutMinutes(0=取 kv/内置默认 40)' },
    { key: 'auto_enabled', type: 'boolean', default: false, group: 'auto', labelKey: 'plugin.diag-bridge.settings.auto_enabled', label: '自动诊断', description: 'daq:sample 越限命中规则时自动发起深度诊断(每产线冷却 30 分钟)' },
  ],
  setup(ctx) {
    // 运行时追加分区与字段(ctx.config.defineGroup / defineField):
    // 字段 key 与声明式完全等价(plugins.diag-bridge.auto_rules),已保存的值不丢;
    // 这里演示「插件在 setup 里按条件调用平台 API 扩展自己的配置面」。
    ctx.config.defineGroup({
      id: 'rules',
      labelKey: 'plugin.diag-bridge.group.rules',
      label: '自动诊断规则',
      description: 'JSON 规则;命中即触发自动诊断(仅 auto_enabled=true 时生效)',
      order: 450,
    })
    ctx.config.defineField({
      key: 'auto_rules',
      type: 'string',
      default: '',
      group: 'rules',
      labelKey: 'plugin.diag-bridge.settings.auto_rules',
      label: '自动诊断规则',
      description: 'JSON: {"节点id":{"op":"gt|lt","value":数值}};命中即触发自动诊断(空=无规则)',
    })
    // 轮询器(15s)+ setup 重水化:恢复对 kv 中 running run 的跟踪(热重载安全)
    const sweep = () => sweepOnce(ctx).catch(err => ctx.logger.warn(`诊断轮询异常(继续): ${err?.message ?? err}`))
    ctx.timer.setInterval(sweep, 15000)
    sweep()

    // 自动诊断(默认关):daq:sample 命中规则 → 冷却 30min → 同管线发起(source:'auto')
    ctx.hooks.on('daq:sample', (s) => {
      try {
        if (!autoEnabledOf(ctx)) return
        if (!s || typeof s.value !== 'number' || !s.nodeId || !s.lineId) return
        const rule = parseAutoRules(autoRulesOf(ctx))[s.nodeId]
        if (!rule || typeof rule?.value !== 'number' || !['gt', 'lt'].includes(rule.op)) return
        const hit = rule.op === 'lt' ? s.value < rule.value : s.value > rule.value
        if (!hit) return
        const line = s.lineId
        const last = Number(ctx.kv.get(`cooldown:${line}`)) || 0
        if (Date.now() - last < AUTO_COOLDOWN_MS) return
        const now = Date.now()
        ctx.kv.set(`cooldown:${line}`, now) // 先占冷却,防同窗连发
        startDiagnosis(ctx, {
          line,
          fromMs: now - 60 * MIN,
          toMs: now,
          question: `${line} 产线该时窗数据深度根因诊断(自动触发:节点 ${s.nodeId} 采样值 ${s.value} ${rule.op === 'lt' ? '<' : '>'} ${rule.value})`,
          scene: `${line}_auto`,
          source: 'auto',
        }).then((r) => {
          if (r.ok) ctx.logger.warn(`自动诊断已发起:产线 ${line} runId=${r.runId}(节点 ${s.nodeId}=${s.value} 越限)`)
          else ctx.logger.warn(`自动诊断发起失败(产线 ${line}): ${r.error}`)
        }).catch(() => {})
      }
      catch { /* 钩子内绝不抛 */ }
    })

    // 工具 ×2
    ctx.omp.registerTool({
      name: 'diag_run',
      label: '深度诊断',
      description: '导出产线指定时窗的 DAQ 快照 CSV 并发起深度根因诊断(异步任务,提交即返 task_id,无需等待)。Channel 可继续其他任务,空闲时用 diag_status 查询;完成后按其给出的指引调 kb_agent 入库知识库。',
      parameters: {
        type: 'object',
        properties: {
          line: { type: 'string', description: '产线 id(与 data_path 二选一)' },
          data_path: { type: 'string', description: '可选:直接指定诊断数据 CSV 绝对路径(跳过 DAQ 快照导出,适合离线数据分析);给了 data_path 则 line 可填 any' },
          from_ms: { type: 'number', description: '窗口起点(epoch 毫秒;缺省 now-60min)' },
          to_ms: { type: 'number', description: '窗口终点(epoch 毫秒;缺省 now)' },
          question: { type: 'string', description: '诊断问题(缺省为该产线时窗数据深度根因诊断)' },
          scene: { type: 'string', description: '场景名(缺省 <line>_diag)' },
        },
        required: ['line'],
      },
      roles: ['lead', 'worker'],
      handler: async (args) => {
        try {
          const line = String(args.line ?? '').trim()
          const dataPathDirect = String(args.data_path ?? '').trim()
          if (!line && !dataPathDirect) return { text: 'line 与 data_path 至少给一个(产线 id 或诊断数据 CSV 绝对路径)。', isError: true }
          const toMs = Number(args.to_ms) > 0 ? Number(args.to_ms) : Date.now()
          const fromMs = Number(args.from_ms) > 0 ? Number(args.from_ms) : toMs - 60 * MIN
          if (fromMs >= toMs) return { text: 'from_ms 必须小于 to_ms。', isError: true }
          const r = await startDiagnosis(ctx, {
            line: line || 'offline-data',
            fromMs, toMs,
            question: args.question ? String(args.question) : '',
            scene: args.scene ? String(args.scene) : '',
            source: 'agent',
            dataPath: dataPathDirect || '',
          })
          if (!r.ok) return { text: r.error, isError: true }
          const via = dataPathDirect ? `离线数据 ${r.csvPath}` : `产线 ${line} 窗口 ${new Date(fromMs).toISOString()} ~ ${new Date(toMs).toISOString()} 快照 ${r.rows} 行 × ${r.nodes} 节点`
          return {
            text: `已发起深度诊断异步任务 task_id=${r.runId}(${via})。知识库 IDD 在后台执行,Channel 无需等待——可继续其他任务,空闲时用 diag_status(run_id=${r.runId}) 查询;完成后按 diag_status 给出的指引调用 kb_agent 把报告 md 入库知识库。`,
          }
        }
        catch (err) {
          return { text: `diag_run 异常: ${err?.message ?? err}`, isError: true }
        }
      },
    })

    ctx.omp.registerTool({
      name: 'diag_status',
      label: '诊断状态',
      description: '查询深度诊断进度:传 run_id 看单条实时状态(完成时含评分/结论/报告路径),不传看最近 5 条概要。',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: '诊断 runId(缺省列最近 5 条概要)' },
        },
      },
      roles: ['lead', 'worker'],
      handler: async (args) => {
        try {
          const id = String(args.run_id ?? '').trim()
          if (!id) {
            const runs = kvRuns(ctx)
              .sort((a, b) => (b.meta?.createdAt ?? 0) - (a.meta?.createdAt ?? 0))
              .slice(0, 5)
            if (!runs.length) return { text: '暂无诊断记录。用 diag_run 发起一次深度诊断。' }
            const lines = runs.map(({ id: rid, meta }) =>
              `- ${rid} | ${meta.line} | ${meta.status}${meta.stored ? '(已入库)' : ''} | ${meta.source ?? 'agent'} | ${meta.createdAt ? new Date(meta.createdAt).toISOString() : '?'} | ${meta.question ?? ''}`)
            return { text: `最近 ${runs.length} 条诊断:\n${lines.join('\n')}` }
          }
          const meta = ctx.kv.get(runKey(id))
          const base = baseOf(ctx)
          let st = null
          if (base) {
            try {
              // v2.1:走任务管理面 /tasks/:id——result.report_md_path 是绝对路径,
              // 可直接交给 kb_agent 读取入库(旧 /status 的相对路径会让 kb_agent 找不到文件)
              st = (await jget(ctx, `${base}/api/diagnosis/tasks/${encodeURIComponent(id)}`, 8000)).data ?? null
              if (st && st.result) {
                st = {
                  ...st,
                  engineStatus: st.status,
                  score: st.result.score ?? null,
                  judge_verdict: st.result.verdict ?? null,
                  report_path: st.result.report_md_path ?? st.report_path ?? null,
                  error_message: st.result.error ?? st.error_message ?? null,
                }
              }
            }
            catch { /* 3210 不可达时回退 kv 元数据 */ }
          }
          if (!st && !meta) return { text: `诊断 ${id} 不存在或诊断服务不可达。`, isError: true }
          const status = st?.engineStatus || st?.status || meta?.status || 'unknown'
          const parts = [
            `run_id=${id}`,
            `name=${st?.name ?? meta?.name ?? '?'}`,
            `产线=${meta?.line ?? st?.scene_name ?? '?'}`,
            `状态=${status}`,
            `来源=${meta?.source ?? '?'}`,
          ]
          if (meta?.fromMs && meta?.toMs) parts.push(`窗口=${new Date(meta.fromMs).toISOString()} ~ ${new Date(meta.toMs).toISOString()}`)
          if (meta?.question) parts.push(`问题=${meta.question}`)
          if (status === 'completed') {
            const reportPath = st?.report_path ?? meta?.reportPath ?? '-'
            parts.push(`评分=${st?.score ?? meta?.score ?? '-'}`)
            parts.push(`结论=${st?.judge_verdict ?? meta?.verdict ?? '-'}`)
            parts.push(`report_md_path=${reportPath}`)
            parts.push('')
            parts.push('✅ 诊断完成,报告已就绪。入库知识库请调用 rag-bridge 的 kb_agent 工具:')
            parts.push(`  mode=async, prompt=「请把这份深度诊断报告入库到 aw-industrial 知识库:读取文件 ${reportPath} 的全文内容并入库(写盘+索引),完成后报告 doc_path 与分块数。标签:诊断、深度诊断。」`)
            parts.push('提交后频道无需等待,空闲时用 kb_agent_status(task_id) 查询入库结果。')
          }
          if (status === 'failed' || status === 'stopped') parts.push(`错误=${st?.error_message ?? meta?.error ?? '-'}`)
          if (!st) parts.push('(诊断服务不可达,以上为本地记录)')
          return { text: parts.join('\n') }
        }
        catch (err) {
          return { text: `diag_status 异常: ${err?.message ?? err}`, isError: true }
        }
      },
    })

    // 路由 ×3(挂 /api/plugins/diag-bridge/*)
    ctx.route('GET', '/health', async () => {
      const runs = kvRuns(ctx)
      const byStatus = {}
      for (const { meta } of runs) byStatus[meta?.status ?? 'unknown'] = (byStatus[meta?.status ?? 'unknown'] ?? 0) + 1
      const base = baseOf(ctx)
      let remote
      let tokenState = { configured: Boolean(diagTokenOf(ctx)), accepted: null }
      if (base) {
        try {
          // 连通性:/api/health 是公开端点(无鉴权),只回答「服务在不在」。
          const res = await ctx.http.get(`${base}/api/health`, { timeoutMs: 5000 })
          const body = await res.json().catch(() => null)
          remote = res.ok && body
            ? { status: body.status ?? 'ok', activeRuns: body.checks?.activeRuns ?? null }
            : { status: `HTTP ${res.status}`, activeRuns: null }
          // Token 有效性:/api/health 不校验鉴权,必须另打一个受保护端点,
          // 否则 token 配错时健康面依旧 ok —— 配置错误完全不可见(实测踩过)。
          if (tokenState.configured) {
            try {
              const auth = await ctx.http.get(`${base}/api/files/workspace`, {
                timeoutMs: 5000,
                headers: authHeadersOf(ctx),
              })
              if (auth.status === 401 || auth.status === 403) {
                tokenState = { configured: true, accepted: false, hint: authHint(auth.status, 'Token 被上游拒绝') }
                remote = { ...remote, auth: `HTTP ${auth.status}(鉴权被拒)`, hint: tokenState.hint }
              }
              else if (auth.ok) {
                tokenState = { configured: true, accepted: true }
                remote = { ...remote, auth: 'ok' }
              }
              else {
                remote = { ...remote, auth: `HTTP ${auth.status}` }
              }
            }
            catch (err) {
              remote = { ...remote, auth: 'unreachable', authError: String(err?.message ?? err) }
            }
          }
          else {
            tokenState = { configured: false, accepted: null }
          }
        }
        catch (err) {
          remote = { status: 'unreachable', error: String(err?.message ?? err) }
        }
      }
      else {
        remote = { status: 'bad_base_url' }
      }
      return {
        plugin: ctx.name,
        base: base ?? String(ctx.kv.get('diag.base_url') || DEFAULT_BASE),
        harness: harnessOf(ctx),
        auth: diagTokenOf(ctx) ? 'bearer' : 'anonymous',
        /** Token 配置态 + 实测是否被上游接受(401/403 → false;网络不通 → null) */
        token: tokenState,
        remote,
        runs: { total: runs.length, byStatus },
      }
    })

    ctx.route('GET', '/runs', () => ({
      success: true,
      runs: kvRuns(ctx)
        .sort((a, b) => (b.meta?.createdAt ?? 0) - (a.meta?.createdAt ?? 0))
        .map(({ id, meta }) => ({ runId: id, ...meta })),
    }))

    ctx.route('POST', '/snapshot', async (event) => {
      try {
        const b = event?.awBody ?? {}
        const line = String(b.line ?? '').trim()
        if (!line) return { success: false, error: 'line 必填(产线 id)' }
        const toMs = Number(b.to_ms) > 0 ? Number(b.to_ms) : Date.now()
        const fromMs = Number(b.from_ms) > 0 ? Number(b.from_ms) : toMs - 60 * MIN
        if (fromMs >= toMs) return { success: false, error: 'from_ms 必须小于 to_ms' }
        const snap = await snapshotCore(ctx, line, fromMs, toMs)
        if (!snap.ok) return { success: false, error: snap.error }
        return { success: true, csvPath: snap.csvPath, rows: snap.rows, nodes: snap.nodes, fromMs: snap.fromMs, toMs: snap.toMs }
      }
      catch (err) {
        return { success: false, error: String(err?.message ?? err) }
      }
    })

    ctx.logger.info('diag-bridge 就绪:工具 diag_run/diag_status + 路由 health/runs/snapshot,轮询 15s 已启动')
  },
}
