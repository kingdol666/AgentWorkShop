/**
 * rag-bridge —— rag-knowledge 知识库桥接插件。
 *
 * 把本地 rag-knowledge 服务(FastAPI 后端 + Nuxt web)集成为 AgentWorkShop 的
 * 团队知识库:启动即确保「aw-industrial」知识库存在,并向 agent 注入三个工具——
 * kb_agent(知识库 Agent 对话)——检索/入库/经验全部由知识库内部 Agent 处理。
 * 另开放 /health、/search、/experience 三个插件 API 便于运维探查。
 * 服务不可达时工具返回 isError 文本(含原因与修复建议),绝不抛异常拖垮宿主。
 */
const KB_NAME = 'aw-industrial'
const DEFAULT_BASE = 'http://127.0.0.1:8770' // FastAPI 后端
const DEFAULT_WEB = 'http://127.0.0.1:6789' // Nuxt web(文档写盘)

export default {
  name: 'rag-bridge',
  version: '2.1.0',
  description: 'rag-knowledge 知识库桥接 v2.1:kb_agent 对话工具(功能解耦,sync/async 双模式)+ kb_agent_status 异步结果查询',
  auth: 'user', // 平台转发层按此声明统一校验(缺省 'none' 开放)
  client: './client.mjs', // 前端面板(插件页注入;i18n 见 i18n.json)
  // 插件配置分组:插件调用平台 API 增加自己的设置分区(设置页独立成区、可折叠)。
  // id 由宿主收敛进 plugin-rag-bridge* 命名空间,不会与其它插件/平台分组撞车;
  // 插件卸载或停用时这两个分区随之消失,不残留空区块。
  configGroups: [
    { id: 'default', labelKey: 'plugin.rag-bridge.group.conn', label: 'rag-knowledge 连接', description: '后端与 Web 地址(保存即热生效)', order: 400 },
    { id: 'auth', labelKey: 'plugin.rag-bridge.group.auth', label: 'rag-knowledge 鉴权', description: '服务端开启鉴权时所需 Token', order: 410, collapsed: true },
  ],
  // 插件设置声明:key 强制编址 plugins.rag-bridge.<key>,进 SystemConfigService 后
  // 前端设置页自动渲染(labelKey 解析 i18n.json 的 plugin.rag-bridge.settings.*);
  // group 指向上面声明的分区 → 字段按分区隔离展示
  settings: [
    { key: 'base_url', type: 'string', default: DEFAULT_BASE, group: 'default', labelKey: 'plugin.rag-bridge.settings.base_url', label: 'rag-knowledge 后端地址', description: 'FastAPI 后端(http/https,host 限 127.0.0.1/localhost);保存即热生效' },
    { key: 'web_url', type: 'string', default: DEFAULT_WEB, group: 'default', labelKey: 'plugin.rag-bridge.settings.web_url', label: 'rag-knowledge Web 地址', description: 'Nuxt Web(文档写盘/目录);保存即热生效' },
    { key: 'token', type: 'string', default: '', group: 'auth', labelKey: 'plugin.rag-bridge.settings.token', label: 'rag-knowledge API Token', description: '服务端开启鉴权时的 MCP/API Token(Authorization: Bearer);空=匿名;保存即热生效' },
  ],
  async setup(ctx) {
    // ---- 运行态 ----
    const state = { outbound: true } // base_url 非法时禁用全部出站调用
    const base = () => trimSlash(String(ctx.config?.get?.('plugins.rag-bridge.base_url') || ctx.kv.get('kb.base_url') || DEFAULT_BASE))
    const web = () => trimSlash(String(ctx.config?.get?.('plugins.rag-bridge.web_url') || ctx.kv.get('kb.web_url') || DEFAULT_WEB))
    const kbId = () => String(ctx.kv.get('kb.id') || '')
    // 鉴权 token(系统配置优先,kv 兜底):rag-knowledge 开启 server.auth 时所有 /api/*
    // 要求 Bearer;backend 与 web 都认 Authorization: Bearer / X-KB-Token 两种头
    const kbToken = () => String(ctx.config?.get?.('plugins.rag-bridge.token') || ctx.kv.get('kb.token') || '').trim()
    const authHeaders = () => {
      const t = kbToken()
      return t ? { 'authorization': `Bearer ${t}`, 'x-kb-token': t } : {}
    }

    // ---- kv 默认值(幂等) ----
    if (ctx.kv.get('kb.base_url') == null) ctx.kv.set('kb.base_url', DEFAULT_BASE)
    if (ctx.kv.get('kb.web_url') == null) ctx.kv.set('kb.web_url', DEFAULT_WEB)
    ctx.kv.set('kb.name', KB_NAME)

    // base_url 守卫:仅 http/https 且 host 必须是 127.0.0.1/localhost(不合法则禁用出站)。
    // 每次配置变更都重算 —— 否则改错地址后旧判定会一直沿用,「独立配置即时生效」不成立。
    const applyOutboundGuard = () => {
      try {
        const u = new URL(base())
        if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !['127.0.0.1', 'localhost'].includes(u.hostname)) {
          throw new Error(`base_url 必须是 http(s)://127.0.0.1|localhost,实际 ${base()}`)
        }
        state.outbound = true
      }
      catch (err) {
        state.outbound = false
        ctx.logger.error(`出站调用已禁用:${err?.message ?? err}(修正 rag-bridge 的「后端地址」后即恢复)`)
      }
    }
    applyOutboundGuard()
    // 配置热更新(runtime-settings 变更)→ 立即重算出站开关与下次探活
    ctx.config.onChange(() => applyOutboundGuard())

    // ---- ensureKB:幂等初始化(失败仅告警,不阻塞装载) ----
    try {
      await ensureKB()
      ctx.logger.info(`rag-bridge 就绪:kb=${KB_NAME}(${kbId() || '待建'}),出站=${state.outbound ? '启用' : '禁用'}`)
    }
    catch (err) {
      ctx.logger.warn(`ensureKB 未完成(不影响装载,工具会在服务可用后按需重试):${err?.message ?? err}`)
    }

    // ================= 出站 HTTP(重试 + 超时 + success 断言) =================

    function sleep(ms) {
      return new Promise(resolve => ctx.timer.setTimeout(resolve, ms))
    }

    /** 单次 JSON 请求;429/网络错误按 1s*重试次数退避,最多重试 2 次;检索类调用方传 timeoutMs:30000 */
    async function callJson(method, url, body, { timeoutMs = 15000, retries = 2, headers = {} } = {}) {
      let lastErr = ''
      const h = { ...authHeaders(), ...headers }
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(1000 * attempt) // 退避 1s*n
        try {
          const res = method === 'GET'
            ? await ctx.http.get(url, { timeoutMs, headers: h })
            : await ctx.http.post(url, body ?? {}, { timeoutMs, headers: h })
          if (res.status === 429) {
            lastErr = `HTTP 429(限流)`
            continue
          }
          if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
          const json = await res.json().catch(() => null)
          if (json == null) return { ok: false, status: res.status, error: '响应不是合法 JSON' }
          return { ok: true, status: res.status, body: json }
        }
        catch (err) {
          lastErr = err?.message ?? String(err) // 网络错误/超时(AbortSignal.timeout)
        }
      }
      return { ok: false, error: lastErr || '未知错误' }
    }

    /** rag 业务调用:铁律——HTTP 200 但 body.success !== true 一律视为失败 */
    async function ragCall(method, url, body, opts = {}) {
      const r = await callJson(method, url, body, opts)
      if (!r.ok) return r
      if (r.body?.success !== true) {
        return { ok: false, error: `服务返回 success!=true:${JSON.stringify(r.body).slice(0, 200)}` }
      }
      return r
    }

    const outboundOff = () => ({ ok: false, error: '出站调用已禁用:kv["kb.base_url"] 非法(仅允许 http/https 且 host 为 127.0.0.1/localhost)' })

    // ================= 异步任务生命周期(提交 → 跟踪 → 进度/结果 → 回执) =================
    // rag-knowledge web 的任务登记表是进程内 Map(TTL 2h / 200 条),进程重启即丢失;
    // 这里把 task_id 与发起者归因落到插件 kv,15s 轮询终态并主动投递平台通告 ——
    // 否则 Agent 提交 async 入库后不主动轮询就永远不知道结果。
    const KB_TASK_PREFIX = 'kbtask:'
    const KB_TASK_TTL_MS = 3 * 60 * 60 * 1000
    let kbPolling = false

    const kbTaskKey = id => KB_TASK_PREFIX + id

    async function kbNotify() {
      try {
        return await ctx.services.get('notify')
      }
      catch {
        return null
      }
    }

    async function queryKbTask(taskId) {
      const r = await callJson('GET', web() + '/api/kb/agent/tasks/' + encodeURIComponent(taskId), null, { timeoutMs: 15000, retries: 0 })
      if (!r.ok) return { ok: false, error: String(r.error ?? ''), status: r.status }
      const body = r.body || {}
      return {
        ok: true,
        status: String(body.status ?? 'unknown'),
        reply: String(body.result?.reply ?? body.result?.partial_text ?? '').trim(),
        error: String(body.result?.error ?? '').slice(0, 600),
      }
    }

    async function deliverKbTask(task, ok, summary) {
      // 无发起者归因(手动调用/旧任务)→ 无收件人,跳过平台回执
      if (!task.agentId) return false
      const notify = await kbNotify()
      if (!notify) {
        ctx.logger.warn(`知识库任务 ${task.taskId} 已结束,但平台通告面不可用(可用 kb_agent_status 查询)`)
        return false
      }
      try {
        const delivered = await notify.deliver({
          kind: 'tool-result',
          tool: 'kb_agent',
          jobId: task.taskId,
          agentId: task.agentId,
          ...(task.channelId ? { channelId: task.channelId } : {}),
          ok,
          title: `知识库任务${ok ? '完成' : '失败'}`,
          summary: String(summary || (ok ? '(知识库 Agent 返回空结果)' : '任务失败')).slice(0, 900),
        })
        return delivered !== false
      }
      catch (err) {
        ctx.logger.warn(`知识库任务 ${task.taskId} 回执投递失败:${err?.message ?? err}`)
        return false
      }
    }

    async function pollKbTasks() {
      if (kbPolling || !state.outbound) return
      kbPolling = true
      try {
        const entries = Object.entries(ctx.kv.all())
          .filter(([k, v]) => k.startsWith(KB_TASK_PREFIX) && v && typeof v === 'object' && !v.deliveredAt)
        for (const [key, task] of entries) {
          if (!task.taskId) continue
          if (Date.now() - Number(task.createdAt || 0) > KB_TASK_TTL_MS) {
            await deliverKbTask(task, false, '任务超过 3 小时仍未结束,已停止跟踪;可稍后用 kb_agent_status 再查一次。')
            ctx.kv.set(key, { ...task, status: 'expired', error: '超过 3 小时未完成', deliveredAt: Date.now() })
            continue
          }
          const q = await queryKbTask(task.taskId)
          if (!q.ok) {
            const attempts = Number(task.pollErrors || 0) + 1
            // 404 = web 重启/任务被淘汰;连续 3 轮仍查不到 → 收敛为 failed 并回执
            if (/HTTP 404/.test(q.error) && attempts >= 3) {
              await deliverKbTask(task, false, `任务已无法查询(HTTP 404,可能因 web 重启或超过 2h 淘汰):${q.error}`)
              ctx.kv.set(key, { ...task, status: 'failed', error: q.error, pollErrors: attempts, deliveredAt: Date.now() })
            }
            else {
              ctx.kv.set(key, { ...task, pollErrors: attempts, lastPollError: q.error })
            }
            continue
          }
          if (q.status === 'running' || q.status === 'queued') {
            ctx.kv.set(key, { ...task, status: q.status, pollErrors: 0 })
            continue
          }
          const okStatus = q.status === 'completed'
          await deliverKbTask(task, okStatus, okStatus ? q.reply : `任务以 ${q.status} 结束:${q.error || '(无错误详情)'}`)
          ctx.kv.set(key, {
            ...task,
            status: q.status,
            reply: q.reply.slice(0, 2000),
            error: q.error,
            deliveredAt: Date.now(),
            deliverPending: false,
          })
        }
      }
      catch (err) {
        ctx.logger.warn(`知识库任务轮询异常(下轮继续):${err?.message ?? err}`)
      }
      finally {
        kbPolling = false
      }
    }

    // ================= ensureKB(catalog 查找 → 建库 → experience init) =================

    async function ensureKB() {
      // ① catalog 查找同名库(响应 {success,count,knowledgeBases:[{kbId,name,...}]})
      const cat = state.outbound
        ? await callJson('GET', `${web()}/api/kb/catalog`, null, { timeoutMs: 10000 })
        : { ok: false, error: '出站已禁用' }
      if (cat.ok) {
        const list = Array.isArray(cat.body?.knowledgeBases) ? cat.body.knowledgeBases : []
        const hit = list.find(kb => kb?.name === KB_NAME)
        if (hit?.kbId) ctx.kv.set('kb.id', hit.kbId)
      }
      else {
        ctx.logger.warn(`catalog 不可达(${cat.error}),跳过查找直接尝试建库`)
      }
      // ② 无则建库(响应 {success,knowledgeBase:{id,name,path,...}})
      if (!kbId()) {
        const created = state.outbound
          ? await ragCall('POST', `${web()}/api/kb/create`, { name: KB_NAME, description: 'AgentWorkShop 工业知识库(诊断报告/经验教训/操作规范)' }, { timeoutMs: 15000 })
          : { ok: false, error: '出站已禁用' }
        if (!created.ok) throw new Error(`创建知识库 ${KB_NAME} 失败:${created.error}`)
        const id = created.body?.knowledgeBase?.id
        if (!id) throw new Error(`建库响应缺少 knowledgeBase.id:${JSON.stringify(created.body).slice(0, 200)}`)
        ctx.kv.set('kb.id', id)
      }
      // ③ 经验文件夹初始化(容忍已初始化/失败:仅告警)
      const init = state.outbound
        ? await ragCall('POST', `${base()}/api/v1/experience/${kbId()}/init`, {}, { timeoutMs: 15000 })
        : { ok: false, error: '出站已禁用' }
      if (!init.ok) ctx.logger.warn(`experience init 未成功(可忽略或稍后手动重试):${init.error}`)
    }

    /** 工具侧兜底:kv 无 kb.id 时按需重跑 ensureKB */
    async function requireKbId() {
      if (kbId()) return kbId()
      await ensureKB()
      if (kbId()) return kbId()
      return null
    }

    // ================= 工具 ×1(kb_agent —— 功能解耦的唯一入口) =================
    // 外部系统不再拼装检索/入库步骤:一个对话工具把任务原话交给 rag-knowledge
    // 的原生 Agent(claude SDK + QDCVR skill + kb-mcp),检索/入库/经验/图谱全部
    // 由知识库内部 Agent 自主完成,直接返回最终结果。

    ctx.omp.registerTool({
      name: 'kb_agent',
      label: '知识库Agent',
      description: '与 rag-knowledge 知识库的原生 Agent 对话(知识库操作唯一入口,功能解耦)。把任务原话交给它:检索问答(知识库侧自动走 QDCVR 全流程,返回带引用的可信答案)、文档入库(给出标题与完整 markdown 正文,action=ingest)、经验沉淀(action=ingest)、图谱关联等,全部由知识库内部 Agent 自主处理并返回最终结果。入库类动作会进入平台审批(HITL),批准后才提交。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '给知识库 Agent 的完整任务原话。检索:要查的问题;入库:目标知识库名(缺省 aw-industrial)+文档标题+完整 markdown 正文;经验:标题/类别/问题/解决方案' },
          mode: { type: 'string', enum: ['sync', 'async'], description: '执行方式(按场景自选):sync 同步等待知识库执行完并返回结果(检索问答用,需要立刻拿到答案);async 异步——立即返回 task_id,知识库在后台完成任务,完成后可用 kb_agent_status 查询该 task 的结果(入库/经验沉淀类用,无需等待)' },
          action: { type: 'string', enum: ['query', 'ingest'], description: '动作类别:query=只读检索问答(缺省);ingest=写知识库(文档入库/经验沉淀),平台会挂 HITL 审批单,批准前不提交后端。入库务必显式声明 action=ingest。' },
        },
        required: ['prompt'],
      },
      roles: ['lead', 'worker'],
      riskClass: 'write',
      noRefs: true,
      handler: async (args, agent) => {
        if (!state.outbound) {
          return { text: '知识库 Agent 不可用:' + outboundOff().error + '。修复后重启服务。', isError: true }
        }
        const prompt = String(args.prompt ?? '').trim()
        if (!prompt) return { text: 'prompt 必填(把要做的任务完整描述给知识库 Agent)。', isError: true }
        const mode = String(args.mode ?? '').trim().toLowerCase() === 'async' ? 'async' : 'sync'
        // 权限档由服务端固定(不再接受调用方透传):历史参数 permission/harness 一律忽略。
        // 缺省 'default' 标准审批档;此前缺省传递 bypassPermissions 允许 Agent 自行提权。
        const body = { prompt, timeout_ms: 540000, mode, permission: 'default' }

        if (mode === 'async') {
          // 异步:立即返回 task_id,知识库后台完成;结果稍后用 kb_agent_status 查询
          const sub = await ragCall('POST', web() + '/api/kb/agent/chat', body, { timeoutMs: 30000, retries: 0 })
          if (!sub.ok) {
            return { text: '知识库异步任务提交失败:' + String(sub.error ?? '').slice(0, 200) + '。请确认 rag-knowledge web(' + web() + ') 已启动后重试。', isError: true }
          }
          const taskId = String(sub.body?.task_id ?? '')
          if (!taskId) return { text: '知识库异步任务提交异常:响应缺少 task_id。', isError: true }
          // 落 kv:异步任务与发起者归因,供后台轮询主动回执;进程重启后仍可继续跟踪
          ctx.kv.set(kbTaskKey(taskId), {
            taskId,
            createdAt: Date.now(),
            status: 'running',
            agentId: agent?.agentId ?? '',
            channelId: agent?.channelId ?? '',
            prompt: prompt.slice(0, 160),
          })
          return { text: '已提交知识库异步任务(后台执行中,无需等待):\ntask_id=' + taskId + '\n完成后平台会自动回执到你的信箱并唤醒你;空闲时也可调用 kb_agent_status(task_id, wait_seconds=120) 等待并获取结果。' }
        }

        // 同步请求禁止网络重试:POST 可能已在知识库侧启动回合,重试会重复入库/重复生成
        const r = await ragCall('POST', web() + '/api/kb/agent/chat', body, { timeoutMs: 580000, retries: 0 })
        if (!r.ok) {
          return { text: '知识库 Agent 调用失败:' + String(r.error ?? '').slice(0, 200) + '。请确认 rag-knowledge web(' + web() + ') 已启动后重试。', isError: true }
        }
        const reply = String(r.body?.reply ?? '').trim()
        return { text: reply || '(知识库 Agent 返回空回复)' }
      },
    })

    ctx.omp.registerTool({
      name: 'kb_agent_status',
      label: '知识库任务状态',
      description: '查询知识库异步任务的执行状态与结果(kb_agent 以 mode=async 提交后,用返回的 task_id 查询;任务完成后返回知识库 Agent 的完整结果)。可传 wait_seconds 最长等 120s:任务在窗口内完成则直接返回结果,免反复轮询。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'kb_agent 异步提交时返回的 task_id' },
          wait_seconds: { type: 'number', description: '长轮询等待秒数(0=立即返回,默认 0,上限 120);入库类任务建议 90~120' },
        },
        required: ['task_id'],
      },
      roles: ['lead', 'worker'],
      handler: async (args) => {
        if (!state.outbound) {
          return { text: '知识库 Agent 不可用:' + outboundOff().error + '。修复后重启服务。', isError: true }
        }
        const taskId = String(args.task_id ?? '').trim()
        if (!taskId) return { text: 'task_id 必填(kb_agent 异步提交时返回的 id)。', isError: true }
        const waitSec = Math.min(Math.max(Math.round(Number(args.wait_seconds ?? 0) || 0), 0), 120)
        const finish = async (reply, ok) => {
          // 终态由轮询面亲自看到 → 认领回执所有权,取消后台补送(先到先得)
          try {
            const notify = await kbNotify()
            notify?.claim?.('kb_agent', taskId)
          }
          catch { /* 未接线时忽略 */ }
          const known = ctx.kv.get(kbTaskKey(taskId))
          if (known) ctx.kv.set(kbTaskKey(taskId), { ...known, deliveredAt: Date.now(), deliveredBy: 'kb_agent_status', ...(ok != null ? { status: ok ? 'completed' : 'failed' } : {}) })
          return reply
        }
        const queryOnce = async () => {
          const q = await queryKbTask(taskId)
          if (!q.ok) {
            return { text: '任务查询失败:' + q.error + '(不存在/已过期 2h/服务重启过,或任务从未提交)。', isError: true }
          }
          if (q.status === 'running' || q.status === 'queued') return null
          if (q.status === 'completed') {
            return { text: await finish('任务 ' + taskId + ' 已完成。知识库 Agent 结果:\n\n' + (q.reply || '(知识库 Agent 返回空结果)'), true) }
          }
          return { text: await finish('任务 ' + taskId + ' 状态:' + q.status + '\n' + (q.error || '(无错误详情)'), false) }
        }
        // 长轮询:5s 步进,窗口内完成即返回结果
        const deadline = Date.now() + waitSec * 1000
        for (;;) {
          const got = await queryOnce()
          if (got) return got
          if (Date.now() >= deadline) {
            return { text: '任务 ' + taskId + ' 仍在后台执行中(running,已等待 ' + waitSec + 's)。稍后再次查询;完成后平台也会自动回执。' }
          }
          await sleep(5000)
        }
      },
    })

    // 后台轮询:15s 一次,终态主动回执(与 diag-bridge sweep 同构)
    ctx.timer.setInterval(() => {
      pollKbTasks().catch(err => ctx.logger.warn(`知识库任务轮询异常(继续):${err?.message ?? err}`))
    }, 15000)
    pollKbTasks().catch(() => {})

    // ================= 插件 API ×3(/api/plugins/rag-bridge/**) =================

    /** 从 h3 event 取查询参数(转发层只预挂 awBody;query 在 event.path 上) */
    function queryOf(event) {
      const raw = String(event?.path ?? event?.node?.req?.url ?? '')
      const q = {}
      try {
        const u = new URL(raw, 'http://local')
        for (const [k, v] of u.searchParams.entries()) q[k] = v
      }
      catch { /* 忽略,返回空 */ }
      return q
    }

    // 健康:后端 + web 存活、kb.id(缺失时按需自愈 ensureKB,token 后配的场景)、出站开关
    ctx.route('GET', '/health', async () => {
      const backend = state.outbound
        ? await callJson('GET', `${base()}/api/v1/health`, null, { timeoutMs: 5000, retries: 0 })
        : { ok: false, error: '出站已禁用' }
      const webR = state.outbound
        ? await callJson('GET', `${web()}/api/kb/catalog`, null, { timeoutMs: 5000, retries: 0 })
        : { ok: false, error: '出站已禁用' }
      if (!kbId() && state.outbound && backend.ok && webR.ok) {
        await ensureKB().catch(() => {}) // 装载期 401/不可达导致 kb.id 缺失 → 探活时自愈
      }
      return {
        plugin: 'rag-bridge',
        outbound: state.outbound,
        auth: kbToken() ? 'bearer' : 'anonymous',
        // token 配置与「实测是否被接受」分开呈现:401/403 = 明确被拒(运维一眼看出 token 配错),
        // 网络不通/超时为 null(未知),2xx 或非鉴权类失败为 true(未被拒)。
        // 实测打受保护 GET /api/v1/auth/me —— rag 后端 GET 只读端点公开(/health 匿名可过,
        // 测不出 token 对错),/auth/me 无 token/错 token 均 401。
        token: {
          configured: Boolean(kbToken()),
          accepted: await (async () => {
            if (!state.outbound) return null
            if (!kbToken()) return backend.ok ? true : null
            const me = await callJson('GET', `${base()}/api/v1/auth/me`, null, { timeoutMs: 5000, retries: 0 })
            return me.ok ? true : (me.status === 401 || me.status === 403 ? false : null)
          })(),
        },
        kb: { name: KB_NAME, id: kbId() || null },
        backend: { url: base(), ok: backend.ok, ...(backend.ok ? { status: backend.body?.status ?? null } : { status: backend.status ?? null, error: backend.error }) },
        web: { url: web(), ok: webR.ok, ...(webR.ok ? { knowledgeBases: webR.body?.count ?? null } : { error: webR.error }) },
        counters: { store: ctx.kv.get('store.count') ?? 0, index: ctx.kv.get('index.count') ?? 0 },
      }
    })

    // 检索:复用 two-stage(?q=&kb_id=&top_k=)
    ctx.route('GET', '/search', async (event) => {
      const q = queryOf(event)
      const query = String(q.q ?? '').trim()
      if (!query) return { success: false, error: '缺少参数 q(检索词)' }
      if (!state.outbound) return { success: false, error: outboundOff().error }
      const kb = String(q.kb_id ?? '').trim() || kbId() || undefined
      const topK = Math.min(Math.max(Math.round(Number(q.top_k) || 5), 1), 20)
      const r = await ragCall('POST', `${base()}/api/v1/search/two-stage`,
        { query, kb_id: kb, stage2_top_k: topK }, { timeoutMs: 30000 })
      if (!r.ok) return { success: false, error: r.error }
      return { success: true, query, total_results: r.body?.total_results ?? null, results: r.body?.stage2?.results ?? [] }
    })

    // 经验列表:GET {base}/api/v1/experience/{kb_id} → {success,count,experiences:[...]}(?limit= 截取)
    ctx.route('GET', '/experience', async (event) => {
      const q = queryOf(event)
      if (!state.outbound) return { success: false, error: outboundOff().error }
      const kb = await requireKbId()
      if (!kb) return { success: false, error: `知识库 ${KB_NAME} 不存在且自动建库失败(检查 web ${web()})` }
      const limit = Math.min(Math.max(Math.round(Number(q.limit) || 20), 1), 100)
      const r = await ragCall('GET', `${base()}/api/v1/experience/${kb}`, null, { timeoutMs: 15000 })
      if (!r.ok) return { success: false, error: `经验列表不可用:${r.error}` }
      const all = Array.isArray(r.body?.experiences) ? r.body.experiences : []
      return {
        success: true,
        kb: { name: KB_NAME, id: kb },
        count: all.length,
        experiences: all.slice(0, limit),
      }
    })
  },
}

// ================= 纯函数小工具 =================

function trimSlash(s) {
  return s.replace(/\/+$/, '')
}
