/**
 * 插件对象(settings / routes / tools / hooks)
 * (由 server/plugins-builtin/diag-bridge/index.mjs 按职责拆出;内容逐行原文搬运)
 */
import { AUTO_COOLDOWN_MS, DEFAULT_BASE, MIN } from './constants.mjs'
import { absoluteUrl, authHeadersOf, authHint, autoEnabledOf, autoRulesOf, baseOf, diagTokenOf, harnessOf, jget, jpatch, kvRuns, mapResultsError, parseAutoRules, probeResults, resultsAllowAnnotateOf, resultsAllowWorkerOf, resultsDefaultLimitOf, resultsEnabledOf, resultsMdMaxOf, runKey } from './helpers.mjs'
import { snapshotCore } from './snapshot.mjs'
import { startDiagnosis } from './diagnosis.mjs'
import { uploadExportDataset } from './exports.mjs'
import { sweepOnce } from './sweep.mjs'
import { intentLabel } from './intents.mjs'

export default {
  name: 'diag-bridge',
  version: '2.2.0',
  description: '深度诊断桥接 v2.2:异步任务式深度诊断(提交即返 task_id)+ daq-export 数据集多文件分析(diag_run export_id= 全量时序+manifest)+ 同步等待模式(mode=sync)+ 完成自动回执 Channel(修复发起者身份丢失)+ 报告在线查看。完成后经 rag-bridge kb_agent 入库知识库。',
  auth: 'user',
  client: './client.mjs', // 前端面板(插件页注入;i18n 见 i18n.json)
  // 插件配置分组(声明式):连接 / 执行 / 自动化 三个独立分区
  configGroups: [
    { id: 'default', labelKey: 'plugin.diag-bridge.group.conn', label: '诊断服务连接', description: '后端地址与鉴权 Token', order: 420 },
    { id: 'run', labelKey: 'plugin.diag-bridge.group.run', label: '诊断执行参数', description: 'diag_run 的引擎与预算', order: 430 },
    { id: 'auto', labelKey: 'plugin.diag-bridge.group.auto', label: '自动诊断', description: '越限自动发起诊断(DAQ 采样事件驱动)', order: 440, collapsed: true },
    { id: 'results', labelKey: 'plugin.diag-bridge.group.results', label: '分析结果库', description: '对 IDD 结果库的检索/详情/元数据编辑(默认关闭;结果可见面 = Token 属主可见面)', order: 450, collapsed: true },
  ],
  // 插件设置声明(key 编址 plugins.diag-bridge.<key>;labelKey 解析 i18n.json)
  settings: [
    { key: 'base_url', type: 'string', default: DEFAULT_BASE, group: 'default', labelKey: 'plugin.diag-bridge.settings.base_url', label: '诊断服务地址', description: 'industrial-deep-diagnostic 后端(http/https,host 限 127.0.0.1/localhost);保存即热生效' },
    { key: 'token', type: 'string', default: '', group: 'default', labelKey: 'plugin.diag-bridge.settings.token', label: '诊断 API Token', description: '诊断服务开启鉴权时(v4 起默认强制)的 API Token(Authorization: Bearer);空=匿名;保存即热生效' },
    { key: 'harness', type: 'string', default: '', group: 'run', labelKey: 'plugin.diag-bridge.settings.harness', label: '诊断引擎', description: 'diag_run 用的引擎 id(omp/claude/mock 等;空=取 kv/omp);无 Anthropic key 的机器请用 omp' },
    { key: 'max_turns', type: 'number', default: 0, min: 0, max: 2000, group: 'run', labelKey: 'plugin.diag-bridge.settings.max_turns', label: '诊断最大轮数', description: 'diagnosis/start 的 maxTurns(0=取 kv/内置默认 220)' },
    { key: 'max_minutes', type: 'number', default: 0, min: 0, max: 720, group: 'run', labelKey: 'plugin.diag-bridge.settings.max_minutes', label: '诊断超时(分钟)', description: 'diagnosis/start 的 timeoutMinutes(0=取 kv/内置默认 40)' },
    { key: 'auto_enabled', type: 'boolean', default: false, group: 'auto', labelKey: 'plugin.diag-bridge.settings.auto_enabled', label: '自动诊断', description: 'daq:sample 越限命中规则时自动发起深度诊断(每产线冷却 30 分钟)' },
    { key: 'results_enabled', type: 'boolean', default: false, group: 'results', labelKey: 'plugin.diag-bridge.settings.results_enabled', label: '结果库总开关', description: '开启后提供 diag_results / diag_result_get / diag_result_annotate 三工具与结果面板;结果可见面 = 诊断 API Token 属主的可见面(平台级,不按产线隔离)' },
    { key: 'results_allow_annotate', type: 'boolean', default: false, group: 'results', labelKey: 'plugin.diag-bridge.settings.results_allow_annotate', label: '允许元数据编辑', description: '允许 lead 角色编辑结果的 description/tags/title(PATCH;最终属主校验在 IDD 侧);只改元数据,不触产线' },
    { key: 'results_allow_worker', type: 'boolean', default: false, group: 'results', labelKey: 'plugin.diag-bridge.settings.results_allow_worker', label: 'worker 可读', description: '允许 worker 角色使用读工具(默认仅 lead);编辑工具始终仅 lead' },
    { key: 'results_default_limit', type: 'number', default: 20, min: 1, max: 200, group: 'results', labelKey: 'plugin.diag-bridge.settings.results_default_limit', label: '索引页大小', description: 'diag_results 缺省返回条数(1-200)' },
    { key: 'results_md_max_chars', type: 'number', default: 4000, min: 500, max: 50000, group: 'results', labelKey: 'plugin.diag-bridge.settings.results_md_max_chars', label: '报告截断上限', description: 'diag_result_get include_md=true 时 report.md 最大字符数(超出截断并给完整 URL)' },
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
        // 首拍竞态:开线后首个越限样本即刻触发,快照查询早于 tsdb 首次刷盘(TSDB_FLUSH_MS=500ms)
        // → 时窗查空失败。空窗失败定向重试(≤3 次、间隔 5s,总窗 ≤20s);冷却不回滚,仍只此一次派发。
        const question = `${line} 产线该时窗数据深度根因诊断(自动触发:节点 ${s.nodeId} 采样值 ${s.value} ${rule.op === 'lt' ? '<' : '>'} ${rule.value})`
        const attempt = (n) => {
          startDiagnosis(ctx, {
            line,
            fromMs: now - 60 * MIN,
            toMs: now,
            question,
            scene: `${line}_auto`,
            source: 'auto',
          }).then((r) => {
            if (r.ok) ctx.logger.warn(`自动诊断已发起:产线 ${line} runId=${r.runId}(节点 ${s.nodeId}=${s.value} 越限)`)
            else if (n < 3 && String(r.error ?? '').includes('无数采样本')) setTimeout(() => attempt(n + 1), 5000)
            else ctx.logger.warn(`自动诊断发起失败(产线 ${line}): ${r.error}`)
          }).catch(() => {})
        }
        attempt(0)
      }
      catch { /* 钩子内绝不抛 */ }
    })

    // 工具 ×2
    ctx.omp.registerTool({
      name: 'diag_run',
      label: '发起分析',
      description: '发起 IDD 后台分析任务(提交即返 task_id,无需等待;完成后平台自动回执本频道,空闲时也可 diag_status 查询)。analysis_intent 选择分析模式,每种意图由 IDD 侧对应 skill 协议执行(harness 在 IDD 内,分析业务与平台解耦):deep-diagnosis=深度根因诊断(9 阶段管线,最重);stability-report=产线稳定报告(评分+等级+建议,零根因);quick-screen=快速筛查(越限/漂移/冻结异常清单+HTML 看板,最快);doe-analysis=DOE 试验分析(因子效应/显著性/最优工况);experience-mining=调参经验挖掘(结构化经验条目,供知识库沉淀);optimizer-campaign=优化战役(寻优迭代+推荐工况,最重)。数据来源三选一:① line+时间窗(导出产线 DAQ 快照);② data_path:诊断服务内已有数据文件;③ export_id(推荐):daq_export 导出的数据集。',
      parameters: {
        type: 'object',
        properties: {
          line: { type: 'string', description: '产线 id(与 data_path/export_id 三选一;export/data_path 模式可填 any)' },
          export_id: { type: 'string', description: 'daq_export 返回的数据集 id(daqexp-…):上传 manifest+全部节点全量时序 CSV 做多文件分析' },
          data_path: { type: 'string', description: '可选:诊断服务内数据文件相对路径(如 data/aw-snapshots/x.csv;跳过快照导出,适合离线数据分析)' },
          from_ms: { type: 'number', description: '窗口起点(epoch 毫秒;仅 line 模式;缺省 now-60min)' },
          to_ms: { type: 'number', description: '窗口终点(epoch 毫秒;仅 line 模式;缺省 now)' },
          question: { type: 'string', description: '分析问题(缺省按意图自动生成情景化提示词;业务要求特殊时才覆写)' },
          analysis_intent: {
            type: 'string',
            enum: ['deep-diagnosis', 'stability-report', 'quick-screen', 'doe-analysis', 'experience-mining', 'optimizer-campaign'],
            description: '分析模式(缺省 deep-diagnosis)。按业务情景选择:要根因→deep-diagnosis;要运行健康度评分/等级→stability-report;要快速异常清单→quick-screen;要多因子试验数据→doe-analysis;要沉淀调参经验→experience-mining;要寻优推荐工况→optimizer-campaign',
          },
          scene: { type: 'string', description: '场景名(缺省 <line>_diag);场景为自由标签,分析管线按数据特征自适应' },
          mode: { type: 'string', enum: ['async', 'sync'], description: 'async(缺省)=提交即返后台跑;sync=同步等待完成(最长 sync_timeout_s,超时自动转后台继续)' },
          sync_timeout_s: { type: 'number', description: 'sync 模式等待上限秒(缺省 240,上限 540)' },
          harness: { type: 'string', description: '分析引擎按次覆盖(omp/claude/mock;缺省用插件设置)' },
          model: { type: 'string', description: '可选:引擎模型按次覆盖(合法性由 IDD 校验,不合法返回 400 说明)' },
          permission_mode: { type: 'string', description: '可选:引擎权限模式按次覆盖(合法性由 IDD 校验)' },
        },
        required: [],
      },
      roles: ['lead', 'worker'],
      handler: async (args, agent) => {
        try {
          const line = String(args.line ?? '').trim()
          const dataPathDirect = String(args.data_path ?? '').trim()
          const exportId = String(args.export_id ?? '').trim()
          if (!line && !dataPathDirect && !exportId) return { text: 'line / data_path / export_id 至少给一个。', isError: true }
          // 产线模式按调用者可读面授权(插件工具不走工业工具 grant/verify 两道闸;
          // 此前任意 Agent 可对任意产线导出快照做诊断,构成跨线数据读取)。
          if (line && agent?.agentId) {
            try {
              const scope = await ctx.services.get('agentScope')
              const readable = scope.readableLines(agent.agentId)
              if (!readable.includes(line)) {
                return {
                  text: `产线「${line}」不在你的可读范围。你的可读产线:${readable.length ? readable.join(', ') : '(无)'}。如需诊断该产线,请让用户绑定该产线节点/把频道绑定到该产线,或改用上述产线重试。`,
                  isError: true,
                }
              }
            }
            catch (err) {
              // fail-closed:无法确认授权时不读取产线数据
              return { text: `产线授权校验不可用,已拒绝本次分析:${err?.message ?? err}。请联系管理员检查插件运行时服务。`, isError: true }
            }
          }
          const toMs = Number(args.to_ms) > 0 ? Number(args.to_ms) : Date.now()
          const fromMs = Number(args.from_ms) > 0 ? Number(args.from_ms) : toMs - 60 * MIN
          if (fromMs >= toMs) return { text: 'from_ms 必须小于 to_ms。', isError: true }

          // 数据集模式:上传 manifest + 全部节点 CSV(manifest 首位,IDD multi 模式)
          let dataPaths
          let via = ''
          let manifest = null
          if (exportId) {
            const up = await uploadExportDataset(ctx, exportId)
            if (!up.ok) return { text: up.error, isError: true }
            dataPaths = up.dataPaths
            manifest = up.manifest
            const nodeCount = Array.isArray(manifest?.nodes) ? manifest.nodes.length : dataPaths.length - 1
            const win = manifest?.window ? `窗口 ${String(manifest.window.from ?? '').slice(0, 16)} ~ ${String(manifest.window.to ?? '').slice(0, 16)}` : ''
            via = `数据集 ${up.folder}(${nodeCount} 节点全量时序 + manifest,${win})`
          }

          // 问题缺省:按数据来源自动组题(export 模式带产线与场景备注)
          let question = args.question ? String(args.question) : ''
          if (!question) {
            if (manifest) {
              const lineNames = (Array.isArray(manifest.lines) ? manifest.lines : []).map(l => l?.lineName || l?.lineId).filter(Boolean).join('、') || line || 'offline'
              const note = manifest.note ? `;场景备注:${String(manifest.note).slice(0, 200)}` : ''
              question = `${lineNames} 产线数据集深度根因诊断(${via})${note}`
            }
            else {
              question = `${line || 'offline-data'} 产线该时窗数据深度根因诊断`
            }
          }
          const r = await startDiagnosis(ctx, {
            line: line || 'offline-data',
            fromMs, toMs,
            question,
            scene: args.scene ? String(args.scene) : '',
            source: 'agent',
            dataPath: dataPathDirect || undefined,
            dataPaths,
            harness: args.harness ? String(args.harness) : undefined,
            analysisIntent: args.analysis_intent ? String(args.analysis_intent) : undefined,
            model: args.model ? String(args.model) : undefined,
            permissionMode: args.permission_mode ? String(args.permission_mode) : undefined,
            // 归因(分发层注入的调用方上下文):诊断完成后平台据此把结果回执给发起 Agent
            agentId: agent?.agentId ?? '',
            channelId: agent?.channelId ?? '',
          })
          if (!r.ok) return { text: r.error, isError: true }
          if (!via) via = dataPathDirect ? `离线数据 ${r.csvPath}` : `产线 ${line} 窗口 ${new Date(fromMs).toISOString()} ~ ${new Date(toMs).toISOString()} 快照 ${r.rows} 行 × ${r.nodes} 节点`

          // 同步模式:轮询到终态或超时(超时自动转后台,sweep 完成仍会回执)
          if (String(args.mode ?? '').toLowerCase() === 'sync') {
            const base = baseOf(ctx)
            const timeoutS = Math.min(Math.max(Number(args.sync_timeout_s) || 240, 10), 540)
            if (base) {
              const deadline = Date.now() + timeoutS * 1000
              let lastPollError = ''
              while (Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 5000))
                let st = null
                try {
                  st = (await jget(ctx, `${base}/api/diagnosis/tasks/${encodeURIComponent(r.runId)}`, 8000)).data ?? null
                  lastPollError = ''
                }
                catch (err) {
                  lastPollError = String(err?.message ?? err)
                  // 鉴权失败/任务不存在:继续等只会空耗到超时,直接如实返回
                  if (/HTTP (401|403|404)/.test(lastPollError)) {
                    return { text: `同步等待中止 task_id=${r.runId}:${lastPollError}。任务可能仍在后台运行;修复后可用 diag_status(run_id=${r.runId}) 查询,完成后平台仍会回执。`, isError: true }
                  }
                }
                const status = String(st?.status ?? r.status ?? 'running')
                if (status === 'completed') {
                  // 已同步拿到结果,认领回执防 sweep 补送重复
                  try {
                    const notify = await ctx.services.get('notify')
                    await notify?.claim?.('diag_run', r.runId)
                  }
                  catch { /* 未接线时忽略 */ }
                  const rep = st?.result?.report_md_path ?? '-'
                  return { text: `✅ 同步诊断完成 task_id=${r.runId}(${via})\n评分=${st?.result?.score ?? '-'} 结论=${st?.result?.verdict ?? '-'}\nreport_md_path=${rep}\n总结:${String(st?.result?.summary ?? '').slice(0, 800)}\n\n入库知识库:调用 rag-bridge 的 kb_agent(mode=async,prompt=「请把这份深度诊断报告入库到 aw-industrial 知识库:读取文件 ${rep} 的全文内容并入库,完成后报告 doc_path 与分块数。标签:诊断、深度诊断。」),完成后 kb_agent_status(task_id) 查询。` }
                }
                if (status === 'failed' || status === 'stopped') {
                  return { text: `分析任务 ${r.runId} 以 ${status} 结束:${st?.result?.error ?? '详见 diag_status'}`, isError: true }
                }
              }
              return { text: `已发起${intentLabel(r.intent)}任务 task_id=${r.runId}(${via})。同步等待 ${timeoutS}s 超时,分析仍在后台运行${lastPollError ? `(最近一次轮询失败:${lastPollError})` : ''}——完成后平台会自动把结果回执到你的信箱并唤醒你;也可 diag_status(run_id=${r.runId}) 主动查询。注入的分析问题:${r.question}` }
            }
          }
          return {
            text: `已发起「${intentLabel(r.intent)}」异步分析任务 task_id=${r.runId}(${via})。IDD 在后台以对应 skill 协议执行,Channel 无需等待——可继续其他任务;完成后平台会自动把结果回执到你的信箱并唤醒你(空闲时也可用 diag_status(run_id=${r.runId}) 主动查询;完成后按指引调 kb_agent 把报告入库知识库)。注入的分析问题:${r.question}`,
          }
        }
        catch (err) {
          return { text: `diag_run 异常: ${err?.message ?? err}`, isError: true }
        }
      },
    })

    ctx.omp.registerTool({
      name: 'diag_status',
      label: '分析任务状态',
      description: '查询后台分析任务进度:传 run_id 看单条实时状态(完成时含评分/结论/总结/报告路径),不传看最近 5 条概要。适用 diag_run 发起的全部意图(深度诊断/产线报告/快速筛查/DOE/经验挖掘/优化战役)。',
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
              `- ${rid} | ${meta.line} | [${intentLabel(meta.intent ?? 'deep-diagnosis')}] ${meta.status}${meta.stored ? '(已入库)' : ''} | ${meta.source ?? 'agent'} | ${meta.createdAt ? new Date(meta.createdAt).toISOString() : '?'} | ${meta.question ?? ''}`)
            return { text: `最近 ${runs.length} 条诊断:\n${lines.join('\n')}` }
          }
          const meta = ctx.kv.get(runKey(id))
          const base = baseOf(ctx)
          let st = null
          let remoteError = ''
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
                  summary: st.result.summary ?? '',
                  report_path: st.result.report_md_path ?? st.report_path ?? null,
                  error_message: st.result.error ?? st.error_message ?? null,
                }
              }
            }
            catch (err) {
              // 保留原始错误(404=任务不存在 / 401=token / 网络不可达),不再一律吞成"不可达"
              remoteError = String(err?.message ?? err)
            }
          }
          if (!st && !meta) {
            return { text: `诊断 ${id} 不存在或诊断服务不可达${remoteError ? `(${remoteError})` : ''}。`, isError: true }
          }
          const status = st?.engineStatus || st?.status || meta?.status || 'unknown'
          // 终态经轮询面亲自看到 → 认领结果所有权,取消平台的事后补送(先到先得)
          if (['completed', 'failed', 'stopped'].includes(status)) {
            const notify = await ctx.services.get('notify').catch(() => null)
            notify?.claim?.('diag_run', id)
          }
          const parts = [
            `run_id=${id}`,
            `name=${st?.name ?? meta?.name ?? '?'}`,
            `产线=${meta?.line ?? st?.scene_name ?? '?'}`,
            `意图=${meta?.intent ?? 'deep-diagnosis'}(${intentLabel(meta?.intent ?? 'deep-diagnosis')})`,
            `状态=${status}`,
            `来源=${meta?.source ?? '?'}`,
          ]
          if (meta?.fromMs && meta?.toMs) parts.push(`窗口=${new Date(meta.fromMs).toISOString()} ~ ${new Date(meta.toMs).toISOString()}`)
          if (meta?.question) parts.push(`问题=${meta.question}`)
          if (status === 'completed') {
            const reportPath = st?.report_path ?? meta?.reportPath ?? '-'
            parts.push(`评分=${st?.score ?? meta?.score ?? '-'}`)
            parts.push(`结论=${st?.judge_verdict ?? meta?.verdict ?? '-'}`)
            if (st?.summary) parts.push(`总结=${String(st.summary).slice(0, 600)}`)
            parts.push(`report_md_path=${reportPath}`)
            parts.push('')
            parts.push('✅ 分析完成,报告已就绪。入库知识库请调用 rag-bridge 的 kb_agent 工具:')
            parts.push(`  mode=async, prompt=「请把这份分析报告入库到 aw-industrial 知识库:读取文件 ${reportPath} 的全文内容并入库(写盘+索引),完成后报告 doc_path 与分块数。标签:分析、${intentLabel(meta?.intent ?? 'deep-diagnosis')}。」`)
            parts.push('提交后频道无需等待,空闲时用 kb_agent_status(task_id) 查询入库结果。')
          }
          if (status === 'failed' || status === 'stopped') parts.push(`错误=${st?.error_message ?? meta?.error ?? '-'}`)
          if (!st) {
            parts.push(`(远端查询失败:${remoteError || '诊断服务不可达'};以上为本地记录)`)
            if (remoteError.includes('HTTP 404') && ['queued', 'running'].includes(String(meta?.status))) {
              parts.push('远端任务已不存在(可能被 IDD 清理或服务重启);sweep 将在连续 3 轮确认后把本地状态收敛为 failed 并回执,不会永久占用产线单飞锁。')
            }
          }
          return { text: parts.join('\n') }
        }
        catch (err) {
          return { text: `diag_status 异常: ${err?.message ?? err}`, isError: true }
        }
      },
    })

    // ── 工具 ×3:分析结果库(§16;默认关闭,results_enabled 开启) ────────────
    // 可见性注意:结果库按 IDD Token 属主聚合,平台内不按产线隔离 —— 所以
    // 读面默认只给 lead(worker 可在 handler 内按设置热放开)、写面双闸门(设置 + lead + IDD 属主校验)。
    // roles 必须在注册期就包含 worker:注册后 roles 固化,设置热改不会重注册工具;
    // 因此 worker 的开关判断放在 handler 内(每次调用实时读设置)。
    const denyWorkerIfDisabled = agent => agent?.role === 'worker' && !resultsAllowWorkerOf(ctx)

    ctx.omp.registerTool({
      name: 'diag_results',
      label: '检索分析结果',
      description: '检索 IDD 分析结果库的摘要索引(全量历史分析,不限本平台发起):按关键词/意图/标签/场景/分数过滤,返回 result_id、标题、意图、评分与结论、时间与标签。先用本工具拿到 result_id,再用 diag_result_get 看完整详情。brief 模式(缺省)单卡很省 token。',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: '关键词(匹配 title/description/summary/scene/tags,大小写不敏感)' },
          intent: { type: 'string', enum: ['deep-diagnosis', 'stability-report', 'quick-screen', 'doe-analysis', 'experience-mining', 'optimizer-campaign'], description: '按分析模式过滤' },
          category_id: { type: 'string', description: '按结果分类 id 过滤(见 /results/categories)' },
          tag: { type: 'string', description: '按标签精确匹配' },
          scene: { type: 'string', description: '按场景名精确匹配' },
          harness: { type: 'string', description: '按执行引擎过滤(如 omp/claude/mock)' },
          min_score: { type: 'number', description: 'score >= min_score(稳定性报告 0-100;深度诊断为 Judge 分)' },
          sort: { type: 'string', enum: ['created_desc', 'created_asc', 'score_desc'], description: '排序(缺省 created_desc)' },
          limit: { type: 'number', description: '每页条数(1-200,缺省取插件设置)' },
          offset: { type: 'number', description: '分页偏移(缺省 0)' },
          brief: { type: 'boolean', description: '省 token 模式(缺省 true:无 key_numbers,display_text 截 160 字符)' },
        },
      },
      roles: ['lead', 'worker'],
      handler: async (args, agent) => {
        try {
          if (denyWorkerIfDisabled(agent)) {
            return { text: 'diag_results 当前仅对 lead 角色开放(管理员可在插件设置打开「worker 可读」)。', isError: true }
          }
          if (!resultsEnabledOf(ctx)) {
            return { text: '分析结果库未启用:请在 系统设置→运行配置→插件→diag-bridge 打开「结果库总开关」。', isError: true }
          }
          const probe = await probeResults(ctx)
          if (!probe.ok) return { text: probe.reason, isError: true }
          const base = baseOf(ctx)
          const params = new URLSearchParams()
          for (const [key, value] of Object.entries({
            q: args.q, intent: args.intent, category_id: args.category_id, tag: args.tag,
            scene: args.scene, harness: args.harness,
            min_score: args.min_score, sort: args.sort,
            limit: args.limit ?? resultsDefaultLimitOf(ctx), offset: args.offset,
            brief: args.brief === undefined ? true : args.brief,
          })) {
            if (value !== undefined && value !== null && String(value) !== '') params.set(key, String(value))
          }
          const body = await jget(ctx, `${base}/api/external/v1/results?${params.toString()}`)
          const d = body.data ?? {}
          const cards = d.results ?? []
          if (!cards.length) return { text: `无匹配结果(total=${d.total ?? 0})。放宽过滤或用 q 换个关键词。` }
          const showKn = briefOf(args) === false
          const lines = cards.map(c =>
            `- ${c.result_id} | ${c.intent} | ${c.score ?? '-'}分 ${c.verdict ?? ''} | ${c.created_at ?? '?'} | ${c.title}${(c.tags ?? []).length ? ` [${c.tags.join(',')}]` : ''}`
            + `\n  ${String(c.display_text ?? '').slice(0, showKn ? 400 : 160)}`
            + (showKn && c.key_numbers ? `\n  key_numbers=${JSON.stringify(c.key_numbers)}` : ''))
          return { text: [`分析结果 total=${d.total} limit=${d.limit} offset=${d.offset} 本页 ${cards.length} 条(brief=${briefOf(args)}):`, ...lines, '', '按 id 取完整详情 → diag_result_get(result_id)。'].join('\n') }
        }
        catch (err) {
          return { text: `diag_results 失败: ${mapResultsError(err, baseOf(ctx))}`, isError: true }
        }
      },
    })

    ctx.omp.registerTool({
      name: 'diag_result_get',
      label: '分析结果详情',
      description: '按 result_id 取一条分析结果的完整详情:结论摘要、关键数字(可溯源到工件字段)、产物清单(报告/HTML 的 API URL)、运行状态。缺省不带 report.md 全文(只给 URL);include_md=true 时携带全文但按插件设置截断保护上下文。',
      parameters: {
        type: 'object',
        properties: {
          result_id: { type: 'string', description: '结果 id(diag_results 返回的 result_id = run_id)' },
          include_md: { type: 'boolean', description: '携带 report.md 全文(缺省 false 只给 URL)' },
          md_max_chars: { type: 'number', description: '本次调用的 md 截断上限(覆盖插件设置;500-50000)' },
        },
      },
      required: ['result_id'],
      roles: ['lead', 'worker'],
      handler: async (args, agent) => {
        try {
          if (denyWorkerIfDisabled(agent)) {
            return { text: 'diag_result_get 当前仅对 lead 角色开放(管理员可在插件设置打开「worker 可读」)。', isError: true }
          }
          if (!resultsEnabledOf(ctx)) {
            return { text: '分析结果库未启用:请在 系统设置→运行配置→插件→diag-bridge 打开「结果库总开关」。', isError: true }
          }
          const probe = await probeResults(ctx)
          if (!probe.ok) return { text: probe.reason, isError: true }
          const id = String(args.result_id ?? '').trim()
          if (!id) return { text: 'result_id 必填(先用 diag_results 检索)。', isError: true }
          const base = baseOf(ctx)
          const wantMd = args.include_md === true
          const cap = Math.min(50000, Math.max(500, Math.round(Number(args.md_max_chars) || resultsMdMaxOf(ctx))))
          const body = await jget(ctx, `${base}/api/external/v1/results/${encodeURIComponent(id)}?include_md=${wantMd ? 'true' : 'false'}`)
          const d = body.data ?? {}
          const sj = d.summary_json ?? {}
          const meta = d.metadata ?? {}
          const parts = [
            `result_id=${d.result_id ?? id}`,
            `标题=${d.title ?? '-'} 意图=${d.intent ?? '-'} 评分=${d.score ?? '-'} 结论=${d.verdict ?? '-'}`,
            `摘要=${String(d.summary ?? '').slice(0, 800)}`,
          ]
          const kn = sj.key_numbers
          if (kn && Object.keys(kn).length) parts.push(`关键数字=${JSON.stringify(kn)}`)
          if (sj.sources) parts.push(`数字溯源=summary_json.sources(每个数字钉到 工件路径#字段)`)
          const artifacts = meta.artifacts ?? []
          if (artifacts.length) parts.push(`工件 ${artifacts.length} 项:${artifacts.slice(0, 12).map(a => a.path ?? a).join(', ')}${artifacts.length > 12 ? ' …' : ''}`)
          const htmls = d.files?.html ?? []
          if (htmls.length) parts.push(`HTML 报告 ${htmls.length} 份(在线查看需带 ?token=<诊断API Token>):${htmls.slice(0, 4).map(h => absoluteUrl(base, h.url)).join(', ')}`)
          parts.push(`报告=${absoluteUrl(base, d.report_md_url)}`)
          if (d.run) parts.push(`run=${d.run.run_id} ${d.run.status}${d.run.session_resumable ? '(可续聊)' : ''}`)
          if (d.derived) parts.push('(本条为按需派生记录:行缺失时详情接口即时生成并标注 derived=true)')
          if (wantMd && typeof d.report_md === 'string' && d.report_md.length) {
            const md = d.report_md
            if (md.length > cap) parts.push(`\nreport.md(截断 ${cap}/${md.length} 字符,全文用上面的报告 URL):\n${md.slice(0, cap)}\n…[已截断]`)
            else parts.push(`\nreport.md:\n${md}`)
          }
          const edited = d.description
          if (edited) parts.push(`\n用户描述=${String(edited).slice(0, 400)}`)
          if ((d.tags ?? []).length) parts.push(`标签=[${d.tags.join(',')}]`)
          parts.push('\n补充描述/标签 → diag_result_annotate(result_id, description, tags)。')
          return { text: parts.filter(Boolean).join('\n') }
        }
        catch (err) {
          return { text: `diag_result_get 失败: ${mapResultsError(err, baseOf(ctx))}`, isError: true }
        }
      },
    })

    ctx.omp.registerTool({
      name: 'diag_result_annotate',
      label: '编辑结果元数据',
      description: '编辑一条分析结果的元数据(description ≤2000 / tags ≤16×≤40 / title ≤200),用于沉淀"这条结果代表什么、何时复用"。只改元数据、不触产线;需插件设置「允许元数据编辑」且调用者是 lead;属主校验最终在 IDD 侧(非属主 403 如实回执)。',
      parameters: {
        type: 'object',
        properties: {
          result_id: { type: 'string', description: '结果 id(diag_results 返回)' },
          description: { type: ['string', 'null'], description: '结果描述(≤2000 字符;null=清除回落自动摘要)' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签数组(≤16 项,单项 ≤40 字符)' },
          title: { type: 'string', description: '标题(≤200 字符)' },
        },
      },
      required: ['result_id'],
      roles: ['lead'],
      handler: async (args) => {
        try {
          if (!resultsEnabledOf(ctx)) {
            return { text: '分析结果库未启用:请在 系统设置→运行配置→插件→diag-bridge 打开「结果库总开关」。', isError: true }
          }
          if (!resultsAllowAnnotateOf(ctx)) {
            return { text: '元数据编辑未开放:请管理员在插件设置打开「允许元数据编辑」(results_allow_annotate)。', isError: true }
          }
          const probe = await probeResults(ctx)
          if (!probe.ok) return { text: probe.reason, isError: true }
          const id = String(args.result_id ?? '').trim()
          if (!id) return { text: 'result_id 必填。', isError: true }
          const patch = {}
          let touched = 0
          if (args.description !== undefined) {
            patch.description = args.description
            touched += 1
          }
          if (args.tags !== undefined) {
            patch.tags = args.tags
            touched += 1
          }
          if (args.title !== undefined) {
            patch.title = args.title
            touched += 1
          }
          if (!touched) return { text: '至少给 description / tags / title 之一。', isError: true }
          const base = baseOf(ctx)
          await jpatch(ctx, `${base}/api/external/v1/results/${encodeURIComponent(id)}`, patch)
          // 回读校验:PATCH 响应不含 display_text,重新 GET 详情确认落库(display_text = description || summary)
          const detail = (await jget(ctx, `${base}/api/external/v1/results/${encodeURIComponent(id)}?include_md=false`)).data ?? {}
          ctx.kv.set('diag.results.lastWrite', JSON.stringify({ at: Date.now(), resultId: id, fields: Object.keys(patch) }))
          return { text: `已更新 result_id=${id}:title=${detail.title ?? '-'}\ndescription=${String(detail.description ?? '(未改/为空)').slice(0, 200)}\ntags=[${(detail.tags ?? []).join(',')}]\n(display_text 现为:${String(detail.display_text ?? '').slice(0, 160)}…)。` }
        }
        catch (err) {
          return { text: `diag_result_annotate 失败: ${mapResultsError(err, baseOf(ctx))}`, isError: true }
        }
      },
    })

    function briefOf(args) {
      return args.brief === undefined ? true : Boolean(args.brief)
    }

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

    // 报告查看(面板/前端):run_id → 诊断任务 → workspace run 目录 → report md 内容
    ctx.route('GET', '/report', async (event) => {
      try {
        const u = new URL(String(event?.path ?? event?.node?.req?.url ?? ''), 'http://local')
        const runId = String(u.searchParams.get('run_id') ?? '').trim()
        if (!runId) return { success: false, error: 'run_id 必填' }
        const base = baseOf(ctx)
        if (!base) return { success: false, error: 'diag.base_url 非法' }
        const st = (await jget(ctx, `${base}/api/diagnosis/tasks/${encodeURIComponent(runId)}`, 8000)).data ?? {}
        if (String(st.status ?? '') !== 'completed') {
          return { success: false, error: `诊断 ${runId} 状态 ${st.status ?? 'unknown'},报告未就绪` }
        }
        const ws = (await jget(ctx, `${base}/api/files/workspace`, 8000)).data ?? []
        const names = (Array.isArray(ws) ? ws : [])
        const meta = ctx.kv.get(runKey(runId)) ?? {}
        // 目录命名不统一(<ts>_<scene> 或 <ts>_<scene>_<runId>):runId → scene → 最新 逐级兜底
        const hit = names.find(e => String(e?.name ?? '').includes(runId))
          ?? names.find(e => meta?.scene && String(e?.name ?? '').toLowerCase().includes(String(meta.scene).toLowerCase()))
          ?? (names.length ? names.slice().sort((a, b) => Number(b?.created ?? 0) - Number(a?.created ?? 0))[0] : null)
        if (!hit) return { success: false, error: `诊断服务 workspace 未找到 ${runId} 的运行目录` }
        const rep = (await jget(ctx, `${base}/api/files/workspace/report/${encodeURIComponent(hit.name)}`, 15000)).data
        return { success: true, run_id: runId, run_name: hit.name, report: rep ?? null }
      }
      catch (err) {
        return { success: false, error: String(err?.message ?? err) }
      }
    })

    // ── 路由 ×4:分析结果库(§16;UI 面板同源,读写开关与工具一致) ────────────
    ctx.route('GET', '/results', async (event) => {
      try {
        if (!resultsEnabledOf(ctx)) return { success: false, error: '结果库未启用(results_enabled)' }
        const probe = await probeResults(ctx)
        if (!probe.ok) return { success: false, error: probe.reason }
        const base = baseOf(ctx)
        const u = new URL(String(event?.path ?? event?.node?.req?.url ?? ''), 'http://local')
        const params = new URLSearchParams()
        for (const key of ['q', 'intent', 'category_id', 'tag', 'scene', 'harness', 'min_score', 'sort', 'limit', 'offset', 'brief']) {
          const v = u.searchParams.get(key)
          if (v !== null && v !== '') params.set(key, v)
        }
        if (!params.has('limit')) params.set('limit', String(resultsDefaultLimitOf(ctx)))
        if (!params.has('brief')) params.set('brief', 'true')
        const body = await jget(ctx, `${base}/api/external/v1/results?${params.toString()}`)
        return { success: true, data: body.data }
      }
      catch (err) {
        return { success: false, error: mapResultsError(err, baseOf(ctx)) }
      }
    })

    ctx.route('GET', '/results/detail', async (event) => {
      try {
        if (!resultsEnabledOf(ctx)) return { success: false, error: '结果库未启用(results_enabled)' }
        const probe = await probeResults(ctx)
        if (!probe.ok) return { success: false, error: probe.reason }
        const u = new URL(String(event?.path ?? event?.node?.req?.url ?? ''), 'http://local')
        const id = String(u.searchParams.get('id') ?? '').trim()
        if (!id) return { success: false, error: 'id 必填(result_id = run_id)' }
        const includeMd = u.searchParams.get('include_md') === 'true' ? 'true' : 'false'
        const base = baseOf(ctx)
        const body = await jget(ctx, `${base}/api/external/v1/results/${encodeURIComponent(id)}?include_md=${includeMd}`)
        const d = body.data ?? {}
        // D5 跨机语义:不向浏览器透出 IDD 主机绝对路径;报告/HTML 一律给可打开的 URL
        const safe = {
          ...d,
          metadata: d.metadata ? { ...d.metadata, workspace_path: undefined } : d.metadata,
          files: {
            ...(d.files ?? {}),
            html: (d.files?.html ?? []).map(h => ({ path: h.path, url: absoluteUrl(base, h.url) })),
            report_md_path: undefined,
          },
          report_md_url: absoluteUrl(base, d.report_md_url),
        }
        return { success: true, data: { ...safe, baseUrl: base, canAnnotate: resultsAllowAnnotateOf(ctx) } }
      }
      catch (err) {
        return { success: false, error: mapResultsError(err, baseOf(ctx)) }
      }
    })

    ctx.route('PATCH', '/results/edit', async (event) => {
      try {
        if (!resultsEnabledOf(ctx)) return { success: false, error: '结果库未启用(results_enabled)' }
        if (!resultsAllowAnnotateOf(ctx)) return { success: false, error: '元数据编辑未开放(results_allow_annotate)' }
        // 写面角色闸门(文档 D3):UI 路由是用户面,要求 AW 管理员;
        // Agent 面走 diag_result_annotate 工具(lead-only + IDD 属主校验)。
        if (String(event?.awUser?.role ?? '') !== 'admin') {
          return { success: false, error: '元数据编辑需要管理员身份(当前账号角色不足)' }
        }
        const probe = await probeResults(ctx)
        if (!probe.ok) return { success: false, error: probe.reason }
        const u = new URL(String(event?.path ?? event?.node?.req?.url ?? ''), 'http://local')
        const id = String(u.searchParams.get('id') ?? '').trim()
        if (!id) return { success: false, error: 'id 必填(result_id = run_id)' }
        const b = event?.awBody ?? {}
        const patch = {}
        for (const key of ['description', 'tags', 'title']) {
          if (b[key] !== undefined) patch[key] = b[key]
        }
        if (!Object.keys(patch).length) return { success: false, error: '至少给 description/tags/title 之一' }
        const base = baseOf(ctx)
        await jpatch(ctx, `${base}/api/external/v1/results/${encodeURIComponent(id)}`, patch)
        const detail = (await jget(ctx, `${base}/api/external/v1/results/${encodeURIComponent(id)}?include_md=false`)).data ?? {}
        ctx.kv.set('diag.results.lastWrite', JSON.stringify({ at: Date.now(), resultId: id, fields: Object.keys(patch) }))
        return { success: true, data: { ...detail, baseUrl: base, canAnnotate: true } }
      }
      catch (err) {
        return { success: false, error: mapResultsError(err, baseOf(ctx)) }
      }
    })

    ctx.route('GET', '/results/categories', async () => {
      try {
        if (!resultsEnabledOf(ctx)) return { success: false, error: '结果库未启用(results_enabled)' }
        const probe = await probeResults(ctx)
        if (!probe.ok) return { success: false, error: probe.reason }
        const base = baseOf(ctx)
        const body = await jget(ctx, `${base}/api/external/v1/results/categories`)
        return { success: true, data: body.data }
      }
      catch (err) {
        return { success: false, error: mapResultsError(err, baseOf(ctx)) }
      }
    })

    ctx.logger.info('diag-bridge 就绪:工具 diag_run/diag_status/diag_results/diag_result_get/diag_result_annotate + 路由 health/runs/snapshot/report/results,轮询 15s 已启动')
  },
}
