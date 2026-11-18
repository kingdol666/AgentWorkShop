/**
 * rag-bridge —— rag-knowledge 知识库桥接插件。
 *
 * 把本地 rag-knowledge 服务(FastAPI 后端 + Nuxt web)集成为 AgentWorkShop 的
 * 团队知识库:
 *  - 经验面:启动即确保「aw-industrial」知识库存在,注入 kb_agent / kb_agent_status
 *    ——检索/入库/经验全部由知识库内部 Agent 处理;
 *  - 文档面(v2.3):kb_doc_create / kb_doc_search / kb_doc_read / kb_catalog 四个
 *    确定性工具,直接走 Web 层文档与两段检索端点(不依赖知识库内部 agent 回合)。
 * 另开放 /health、/search、/experience 三个插件 API 便于运维探查。
 * 服务不可达时工具返回 isError 文本(含原因与修复建议),绝不抛异常拖垮宿主。
 *
 * WS-0 封装约束(2026-11-18):工具名 `{前缀}_{动作}`;描述点名输入来源与输出形状;
 * 输出首行机器可读键值;写类 riskClass='write' + noRefs;读类 riskClass='read';
 * 调用计数入 kv(health 可见);读 ≤15s、写 ≤60s、长任务返 task_id。
 */
const KB_NAME = 'aw-industrial'
const DOCS_KB_NAME = 'aw-docs'
const DEFAULT_BASE = 'http://127.0.0.1:8770' // FastAPI 后端
const DEFAULT_WEB = 'http://127.0.0.1:6789' // Nuxt web(文档写盘/检索)

/** 读类调用超时(WS-0:读 ≤15s;两段检索允许 15s) */
const READ_TIMEOUT_MS = 15000
/** 写类调用超时(WS-0:写 ≤60s;create+reindex 合计预算) */
const WRITE_TIMEOUT_MS = 20000

export default {
  name: 'rag-bridge',
  version: '2.3.0',
  description: 'rag-knowledge 知识库桥接 v2.3:kb_agent 对话工具(功能解耦)+ 文档工具族(kb_doc_create/search/read/catalog,aw-docs 库,two-stage 检索)+ 韧性(有界 prompt/429 退避/L1 超时)',
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
    { key: 'docs_kb', type: 'string', default: DOCS_KB_NAME, group: 'default', labelKey: 'plugin.rag-bridge.settings.docs_kb', label: '文档知识库名', description: 'kb_doc_* 工具的缺省目标库(缺省 aw-docs;经验入库仍写 aw-industrial);保存即热生效' },
    { key: 'token', type: 'string', default: '', group: 'auth', labelKey: 'plugin.rag-bridge.settings.token', label: 'rag-knowledge API Token', description: '服务端开启鉴权时的 MCP/API Token(Authorization: Bearer);空=匿名;保存即热生效' },
    { key: 'agent_harness', type: 'string', default: '', group: 'default', labelKey: 'plugin.rag-bridge.settings.agent_harness', label: '知识库 Agent 引擎', description: '可选:rag-knowledge chat 的 harness(如 omp/claude);空=使用 RAG 服务默认。仅选择知识库内部 Agent 引擎,不改变平台固定的权限档。' },
  ],
  async setup(ctx) {
    // ---- 运行态 ----
    const state = { outbound: true } // base_url 非法时禁用全部出站调用
    const base = () => trimSlash(String(ctx.config?.get?.('plugins.rag-bridge.base_url') || ctx.kv.get('kb.base_url') || DEFAULT_BASE))
    const web = () => trimSlash(String(ctx.config?.get?.('plugins.rag-bridge.web_url') || ctx.kv.get('kb.web_url') || DEFAULT_WEB))
    const kbId = () => String(ctx.kv.get('kb.id') || '')
    // 文档库独立 kv 键:双库复用同一键会互踩(经验库与文档库 kbId 不同)
    const docsKbId = () => String(ctx.kv.get('docs.kb.id') || '')
    const docsKbName = () => String(ctx.config?.get?.('plugins.rag-bridge.docs_kb') || ctx.kv.get('docs.kb.name') || DOCS_KB_NAME).trim() || DOCS_KB_NAME
    // 鉴权 token(系统配置优先,kv 兜底):rag-knowledge 开启 server.auth 时所有 /api/*
    // 要求 Bearer;backend 与 web 都认 Authorization: Bearer / X-KB-Token 两种头
    const kbToken = () => String(ctx.config?.get?.('plugins.rag-bridge.token') || ctx.kv.get('kb.token') || '').trim()
    // 可选:知识库内部 Agent 引擎(空=RAG 服务默认 claude)。只影响 RAG 侧执行器,
    // 权限档仍由下方服务端固定为 default;便于与平台 omp 执行模型对齐/排障。
    const agentHarness = () => String(ctx.config?.get?.('plugins.rag-bridge.agent_harness') || ctx.kv.get('kb.agent_harness') || '').trim()
    const authHeaders = () => {
      const t = kbToken()
      return t ? { 'authorization': `Bearer ${t}`, 'x-kb-token': t } : {}
    }

    // ---- kv 默认值(幂等) ----
    if (ctx.kv.get('kb.base_url') == null) ctx.kv.set('kb.base_url', DEFAULT_BASE)
    if (ctx.kv.get('kb.web_url') == null) ctx.kv.set('kb.web_url', DEFAULT_WEB)
    ctx.kv.set('kb.name', KB_NAME)
    if (ctx.kv.get('docs.kb.name') == null) ctx.kv.set('docs.kb.name', DOCS_KB_NAME)

    // base_url/web_url 守卫:仅 http/https 且 host 必须是 127.0.0.1/localhost。
    // web_url 也会带 Bearer token 出站(文档写盘/目录),不能只校验 base_url。
    // 每次配置变更都重算 —— 否则改错地址后旧判定会一直沿用,「独立配置即时生效」不成立。
    const assertLocalHttpUrl = (raw, label) => {
      const u = new URL(raw)
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !['127.0.0.1', 'localhost'].includes(u.hostname)) {
        throw new Error(`${label} 必须是 http(s)://127.0.0.1|localhost,实际 ${raw}`)
      }
      return u
    }
    const applyOutboundGuard = () => {
      try {
        assertLocalHttpUrl(base(), 'base_url')
        assertLocalHttpUrl(web(), 'web_url')
        state.outbound = true
      }
      catch (err) {
        state.outbound = false
        ctx.logger.error(`出站调用已禁用:${err?.message ?? err}(修正 rag-bridge 的「后端地址/Web 地址」后即恢复)`)
      }
    }
    applyOutboundGuard()
    // 配置热更新(runtime-settings 变更)→ 立即重算出站开关与下次探活
    ctx.config.onChange(() => applyOutboundGuard())

    // ---- ensureKB:幂等初始化(失败仅告警,不阻塞装载) ----
    try {
      await ensureKbByName(KB_NAME, 'kb.id', { experience: true })
      ctx.logger.info(`rag-bridge 就绪:经验库=${KB_NAME}(${kbId() || '待建'}),文档库=${docsKbName()}(${docsKbId() || '按需自愈'}),出站=${state.outbound ? '启用' : '禁用'}`)
    }
    catch (err) {
      ctx.logger.warn(`ensureKB 未完成(不影响装载,工具会在服务可用后按需重试):${err?.message ?? err}`)
    }

    // ================= 出站 HTTP(重试 + 超时 + success 断言) =================

    function sleep(ms) {
      return new Promise(resolve => ctx.timer.setTimeout(resolve, ms))
    }

    /** 工具调用计数(kv;health 可见 —— WS-4 S3 可观测三件套之一) */
    function bump(tool, ok) {
      const key = `usage.${tool}.${ok ? 'ok' : 'err'}`
      try {
        ctx.kv.set(key, Number(ctx.kv.get(key) ?? 0) + 1)
      }
      catch { /* 计数失败不影响调用 */ }
    }

    function toolCounters() {
      const out = {}
      for (const [k, v] of Object.entries(ctx.kv.all())) {
        const m = /^usage\.(.+)\.(ok|err)$/.exec(k)
        if (!m) continue
        out[m[1]] ??= { ok: 0, err: 0 }
        out[m[1]][m[2]] = Number(v) || 0
      }
      return out
    }

    /** 写类操作审计(WS-4 S2:谁在何时写了哪个库的哪篇文档,由平台 ops 面留痕) */
    async function auditWrite(entry) {
      try {
        const rec = await ctx.services.get('ops.record')
        if (typeof rec === 'function') rec(entry)
      }
      catch { /* 审计不可用不阻断写入(与 diag 侧同纪律) */ }
    }

    /**
     * 单次 JSON 请求;429/网络错误按 1s*重试次数退避,最多重试 2 次;
     * retry429Ms>0 时对 429 额外等待一次(限流退避,文档 §4.5)后重试。
     * 非 2xx 返回 { ok:false, status, error, body }(body 供调用方读 stage/error 细节)。
     */
    async function callJson(method, url, body, { timeoutMs = 15000, retries = 2, headers = {}, retry429Ms = 0 } = {}) {
      let lastErr = ''
      let lastStatus = 0
      const h = { ...authHeaders(), ...headers }
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(1000 * attempt) // 退避 1s*n
        try {
          let res
          if (method === 'GET') {
            res = await ctx.http.get(url, { timeoutMs, headers: h })
          }
          else if (method === 'PATCH') {
            if (typeof ctx.http.patch !== 'function') return { ok: false, error: '宿主不支持 PATCH 请求' }
            res = await ctx.http.patch(url, body ?? {}, { timeoutMs, headers: h })
          }
          else {
            res = await ctx.http.post(url, body ?? {}, { timeoutMs, headers: h })
          }
          if (res.status === 429) {
            lastErr = 'HTTP 429(限流)'
            lastStatus = 429
            if (retry429Ms > 0) {
              ctx.logger.warn(`rag-knowledge 限流(429):退避 ${Math.round(retry429Ms / 1000)}s 后重试一次`)
              await sleep(retry429Ms)
              retry429Ms = 0 // 只退避一次
            }
            continue
          }
          if (!res.ok) {
            const errBody = await res.json().catch(() => null)
            return { ok: false, status: res.status, error: `HTTP ${res.status}`, body: errBody }
          }
          const json = await res.json().catch(() => null)
          if (json == null) return { ok: false, status: res.status, error: '响应不是合法 JSON' }
          return { ok: true, status: res.status, body: json }
        }
        catch (err) {
          lastErr = err?.message ?? String(err) // 网络错误/超时(AbortSignal.timeout)
        }
      }
      return { ok: false, status: lastStatus || undefined, error: lastErr || '未知错误' }
    }

    /** rag 业务调用:铁律——HTTP 200 但 body.success !== true 一律视为失败 */
    async function ragCall(method, url, body, opts = {}) {
      const r = await callJson(method, url, body, opts)
      if (!r.ok) return r
      if (r.body?.success !== true) {
        return { ok: false, status: r.status, error: `服务返回 success!=true:${JSON.stringify(r.body).slice(0, 200)}`, body: r.body }
      }
      return r
    }

    const outboundOff = () => ({ ok: false, error: '出站调用已禁用:kv["kb.base_url"] 非法(仅允许 http/https 且 host 为 127.0.0.1/localhost)' })

    // 失败分类文案(2026-11-16 实测回归,2026-11-18 扩文档面):过去一切失败都套同一句
    // "请确认 rag-knowledge web 已启动" —— 401(token 过期)时把人引去查一个活着的
    // web,完全误导。按 status/错误形态分类给出可执行的下一步。
    const describeKbFailure = (r) => {
      const st = Number(r?.status ?? 0)
      const raw = String(r?.error ?? '')
      const stage = String(r?.body?.stage ?? r?.body?.data?.stage ?? '')
      if (st === 401 || st === 403) {
        return `rag-knowledge Token 被拒绝(HTTP ${st}):token 可能已过期或权限不足 —— 请在设置页「rag-knowledge 鉴权」轮换 plugins.rag-bridge.token 后重试(`
          + `重铸路径:POST /api/auth/tokens,name=aw-bridge,scopes=[read,write];原登录会话不失效。web/backend 本身不受影响)。`
      }
      if (st === 429) {
        return 'rag-knowledge 限流(HTTP 429,per-IP 600 req/60s):已退避重试一次仍限流 —— 请降低批量调用频率,稍后重试;单条检索可改用 kb_doc_search(以两段检索为主,请求更轻)。'
      }
      if (st === 404) {
        return `目标资源不存在(HTTP 404):知识库/文档名可能拼错,或 async 任务已过期(2h/重启清空)。先用 kb_catalog 确认库名,再用 kb_doc_search 确认文档。原始:${raw}`
      }
      if (st === 502 || st === 503 || stage === 'timeout') {
        return `知识库 Agent 面不可用(${st ? `HTTP ${st}` : ''}${stage ? `,stage=${stage}` : ''}):${raw}。只读检索可直接改用 kb_doc_search(两段检索,不依赖内部 agent 回合);若仍需 agent 面,稍后重试或改用 async + kb_agent_status。`
      }
      if (/abort|timeout|timed?\s*out/i.test(raw)) {
        return `等待窗内知识库 Agent 未返回终态(${raw})——知识库内部执行慢或连接被对端挂断(服务端 600s 硬顶,客户端读超时已设 ≥750s)。建议改用 mode:'async' 提交,再用 kb_agent_status(task_id, wait_seconds=120) 轮询结果;只读检索可用 kb_doc_search 兜底。`
      }
      if (/fetch failed|ECONN|socket|network/i.test(raw)) {
        return `到 rag-knowledge web(${web()})的请求失败(${raw})。请确认 web/backend 存活;若两者健康(可用 /api/plugins/rag-bridge/health 核对),多为知识库内部 agent 回合挂断 —— 同样建议改用 async + kb_agent_status,或只读用 kb_doc_search。`
      }
      return raw || '未知错误'
    }

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

    // ================= ensureKB(catalog 查找 → 建库 → 可选 experience init) =================

    /**
     * 幂等确保某知识库存在并返回 kbId。
     * ① catalog 查找同名库;② 无则建库;③ experience=true 时初始化经验文件夹(仅告警)。
     * 双库分键:经验库 → kv 'kb.id',文档库 → kv 'docs.kb.id'(互不覆盖)。
     */
    async function ensureKbByName(name, idKey, { experience = false } = {}) {
      if (!state.outbound) throw new Error('出站调用已禁用')
      // ① catalog 查找同名库(响应 {success,count,knowledgeBases:[{kbId,name,...}]})
      const cat = await callJson('GET', `${web()}/api/kb/catalog`, null, { timeoutMs: 10000 })
      if (cat.ok) {
        const list = Array.isArray(cat.body?.knowledgeBases) ? cat.body.knowledgeBases : []
        const hit = list.find(kb => kb?.name === name)
        if (hit?.kbId) ctx.kv.set(idKey, hit.kbId)
      }
      else {
        ctx.logger.warn(`catalog 不可达(${cat.error}),跳过查找直接尝试建库`)
      }
      // ② 无则建库(响应 {success,knowledgeBase:{id,name,path,...}})
      if (!ctx.kv.get(idKey)) {
        const created = await ragCall('POST', `${web()}/api/kb/create`, { name, description: `AgentWorkShop ${name === DOCS_KB_NAME ? '文档库(报告/规范/协议)' : '工业知识库(诊断报告/经验教训/操作规范)'}` }, { timeoutMs: WRITE_TIMEOUT_MS })
        // 并发建库:重名 409 时按 catalog 回查一次(其他实例已建好)
        if (!created.ok) {
          if (created.status === 409) {
            const again = await callJson('GET', `${web()}/api/kb/catalog`, null, { timeoutMs: 10000 })
            const hit = (again.body?.knowledgeBases ?? []).find(kb => kb?.name === name)
            if (hit?.kbId) ctx.kv.set(idKey, hit.kbId)
            else throw new Error(`创建知识库 ${name} 返回 409 但 catalog 查不到同名库`)
          }
          else {
            throw new Error(`创建知识库 ${name} 失败:${created.error}`)
          }
        }
        else {
          const id = created.body?.knowledgeBase?.id
          if (!id) throw new Error(`建库响应缺少 knowledgeBase.id:${JSON.stringify(created.body).slice(0, 200)}`)
          ctx.kv.set(idKey, id)
        }
      }
      // ③ 经验文件夹初始化(仅经验库;容忍已初始化/失败:仅告警)
      if (experience) {
        const init = await ragCall('POST', `${base()}/api/v1/experience/${ctx.kv.get(idKey)}/init`, {}, { timeoutMs: 15000 })
        if (!init.ok) ctx.logger.warn(`experience init 未成功(可忽略或稍后手动重试):${init.error}`)
      }
      return String(ctx.kv.get(idKey) || '')
    }

    /** 工具侧兜底:kv 无 kb.id 时按需重跑 ensureKbByName */
    async function requireKbId() {
      if (kbId()) return kbId()
      await ensureKbByName(KB_NAME, 'kb.id', { experience: true })
      return kbId() || null
    }

    /** 文档库按需自愈(懒初始化:装载期不增加一个建库往返) */
    async function requireDocsKbId() {
      if (docsKbId()) return docsKbId()
      await ensureKbByName(docsKbName(), 'docs.kb.id')
      ctx.kv.set('docs.kb.name', docsKbName())
      return docsKbId() || null
    }

    // ================= 文档面基础调用(Web 层 §5.4/§5.5) =================

    /** 目录缓存(30s):kb_doc_search/read 的 kb 解析与首个路径段归属判断用 */
    let catalogCache = { at: 0, list: [] }
    async function catalogList(force = false) {
      if (!force && Date.now() - catalogCache.at < 30_000 && catalogCache.list.length) return { ok: true, list: catalogCache.list }
      const r = await callJson('GET', `${web()}/api/kb/catalog`, null, { timeoutMs: 10000 })
      if (!r.ok) return { ok: false, error: r.error, status: r.status }
      const list = Array.isArray(r.body?.knowledgeBases) ? r.body.knowledgeBases : []
      catalogCache = { at: Date.now(), list }
      return { ok: true, list }
    }

    /** kb 参数(uuid 或名称)→ { kbId, name };缺省文档库 */
    async function resolveKb(nameOrId) {
      const want = String(nameOrId ?? '').trim()
      if (!want) {
        const id = await requireDocsKbId()
        return id ? { ok: true, kbId: id, name: docsKbName() } : { ok: false, error: `文档库 ${docsKbName()} 不存在且自动建库失败(检查 web ${web()} 与 token)` }
      }
      const cat = await catalogList()
      if (cat.ok) {
        const hit = cat.list.find(kb => kb?.kbId === want || kb?.name === want || String(kb?.path ?? '').replace(/\\/g, '/') === want)
        if (hit?.kbId) return { ok: true, kbId: hit.kbId, name: hit.name }
        return { ok: false, error: `知识库「${want}」不存在。可用 kb_catalog 查看全部库名(缺省文档库=${docsKbName()})。` }
      }
      // catalog 不可达:直接按名称交给服务端解析(kb_id 接受 UUID 或相对路径名,§4.2)
      return { ok: true, kbId: want, name: want }
    }

    /** 文档列表({success,kbId,count,documents:[{id,name,path,...}]}) */
    async function docList(kbIdValue) {
      return await ragCall('GET', `${web()}/api/kb/documents?kbId=${encodeURIComponent(kbIdValue)}`, null, { timeoutMs: READ_TIMEOUT_MS })
    }

    const normSlashes = p => String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '')

    /** 同名文档预查(幂等):服务端 create 对重名是自动改名去重而非 409,故幂等必须前置 */
    function findDocByName(documents, fileName) {
      const want = String(fileName).toLowerCase()
      return (Array.isArray(documents) ? documents : []).find(d => String(d?.name ?? '').toLowerCase() === want)
        ?? (Array.isArray(documents) ? documents : []).find(d => normSlashes(d?.path).toLowerCase().endsWith('/' + want))
        ?? null
    }

    /** 若 doc_path 首段命中某个库名/路径,按该库解析(跨库读取正确归属) */
    async function kbOfDocPath(docPath) {
      const norm = normSlashes(docPath)
      const seg = norm.includes('/') ? norm.slice(0, norm.indexOf('/')) : ''
      if (!seg) return null
      const cat = await catalogList()
      if (!cat.ok) return null
      const hit = cat.list.find(kb => String(kb?.name ?? '') === seg || normSlashes(kb?.path) === seg)
      return hit ? { kbId: hit.kbId, name: hit.name } : null
    }

    // ================= 工具 ×2(kb_agent / kb_agent_status) =================
    // 外部系统不再拼装检索/入库步骤:一个对话工具把任务原话交给 rag-knowledge
    // 的原生 Agent(claude SDK + QDCVR skill + kb-mcp),检索/入库/经验/图谱全部
    // 由知识库内部 Agent 自主完成,直接返回最终结果。

    ctx.omp.registerTool({
      name: 'kb_agent',
      label: '知识库Agent',
      description: '与 rag-knowledge 知识库的原生 Agent 对话(知识库操作唯一入口,功能解耦)。把任务原话交给它:检索问答(知识库侧自动走 QDCVR 全流程,返回带引用的可信答案)、文档入库(给出标题与完整 markdown 正文,action=ingest)、经验沉淀(action=ingest)、图谱关联等,全部由知识库内部 Agent 自主处理并返回最终结果。入库类动作会进入平台审批(HITL),批准后才提交。只读检索若需确定性/低延迟,优先用 kb_doc_search。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '给知识库 Agent 的完整任务原话。检索:要查的问题;入库:目标知识库名(缺省 aw-industrial)+文档标题+完整 markdown 正文;经验:标题/类别/问题/解决方案' },
          mode: { type: 'string', enum: ['sync', 'async'], description: '执行方式(旧口径,建议改用 wait/wait_seconds):sync 同步等待;async 立即返回 task_id 后台跑' },
          wait: { type: 'boolean', description: '是否等待结果(推荐口径):true=本次调用挂起直到知识库任务终态——成功/失败都返回完整结果,任务未完不返回;false/缺省=提交即返 task_id 后台跑(结果存后台任务台账,kb_agent_status(task_id) 随时可查)' },
          wait_seconds: { type: 'number', description: 'wait=true 的等待上限秒(缺省 600,上限 1800);窗口内未完则如实返回 running 态与 task_id,任务后台继续并仍会自动回执' },
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
        const action = String(args.action ?? '').trim().toLowerCase()
        // 等待语义:wait=true 显式挂起到终态(成功/失败都给完整结果);wait=false/缺省=提交即返。
        // 挂起期间 Agent 的回合被本工具调用占住——结构上保证"任务未完不能标记完成"。
        const legacyAsync = args.wait === undefined && String(args.mode ?? '').trim().toLowerCase() === 'async'
        const mode = (args.wait === false || legacyAsync) ? 'async' : 'sync'
        const waitSec = Math.min(Math.max(Math.round(Number(args.wait_seconds ?? 600) || 600), 10), 1800)
        // 权限档由服务端固定(不再接受调用方透传):历史参数 permission/harness 一律忽略。
        // 缺省 'default' 标准审批档;此前缺省传递 bypassPermissions 允许 Agent 自行提权。
        // RAG web 侧硬上限 600s(MAX_TIMEOUT_MS);异步入库给足上限,避免 540s 提前截断。
        const harness = agentHarness()
        // 有界 prompt(api-web §7.4):只读检索追加执行约束,降低无界深检索触发 600s 硬顶的概率。
        // 入库(ingest)不改写业务内容,避免污染待入库正文。
        const boundedPrompt = action === 'ingest' ? prompt : `${prompt}\n\n执行约束(平台侧追加):按 /knowledgebase-search skill 的快速路径作业(kb_list 甄别 → kb_search_vector → kb_laya_judge 一批 ≤6 refs → 至多 1-2 次 kb_doc_read 验证),不要委派子代理,不要浏览仓库文件。最终答案 ≤800 字并给出 doc_path 出处。`
        const body = { prompt: boundedPrompt, timeout_ms: mode === 'sync' ? waitSec * 1000 : 600000, mode, permission: 'default', ...(harness ? { harness } : {}) }

        if (mode === 'async') {
          // 异步:立即返回 task_id,知识库后台完成;结果稍后用 kb_agent_status 查询
          const sub = await ragCall('POST', web() + '/api/kb/agent/chat', body, { timeoutMs: 30000, retries: 0, retry429Ms: 30000 })
          if (!sub.ok) {
            bump('kb_agent', false)
            return { text: '知识库异步任务提交失败:' + describeKbFailure(sub), isError: true }
          }
          const taskId = String(sub.body?.task_id ?? '')
          if (!taskId) {
            bump('kb_agent', false)
            return { text: '知识库异步任务提交异常:响应缺少 task_id。', isError: true }
          }
          // 落 kv:异步任务与发起者归因,供后台轮询主动回执;进程重启后仍可继续跟踪
          ctx.kv.set(kbTaskKey(taskId), {
            taskId,
            createdAt: Date.now(),
            status: 'running',
            agentId: agent?.agentId ?? '',
            channelId: agent?.channelId ?? '',
            prompt: prompt.slice(0, 160),
          })
          bump('kb_agent', true)
          return { text: '已提交知识库异步任务(后台执行中,无需等待):\ntask_id=' + taskId + '\n完成后平台会自动回执到你的信箱并唤醒你;空闲时也可调用 kb_agent_status(task_id, wait_seconds=120) 等待并获取结果。' }
        }

        // 同步请求禁止网络重试:POST 可能已在知识库侧启动回合,重试会重复入库/重复生成。
        // 读超时 ≥750s(L1:服务端 600s 硬顶,超时回合回包可能晚于 630s)。
        const syncTimeoutMs = Math.max(waitSec * 1000 + 30_000, 750_000)
        const r = await ragCall('POST', web() + '/api/kb/agent/chat', body, { timeoutMs: syncTimeoutMs, retries: 0, retry429Ms: 30000 })
        if (!r.ok) {
          bump('kb_agent', false)
          // 只读检索类失败 → 追加确定性兜底指引(api-web §7.9:two-stage 可作只读降级)
          const fallback = action !== 'ingest'
            ? '\n\n降级方案:本次为只读检索,可直接改用 kb_doc_search(query=同一个问题,kb=目标库) 走两段检索(不依赖知识库内部 Agent 回合)。'
            : ''
          return { text: '知识库 Agent 调用失败(本次调用即终态,失败结果已如实返回):' + describeKbFailure(r) + fallback, isError: true }
        }
        const reply = String(r.body?.reply ?? '').trim()
        bump('kb_agent', true)
        return { text: '✅ 知识库任务完成(等待到终态)。\n\n' + (reply || '(知识库 Agent 返回空回复)') }
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
          wait_seconds: { type: 'number', description: '长轮询等待秒数(0=立即返回,默认 0,上限 1800);任务在窗口内完成则直接返回结果' },
        },
        required: ['task_id'],
      },
      roles: ['lead', 'worker'],
      riskClass: 'read',
      noRefs: true,
      handler: async (args) => {
        if (!state.outbound) {
          return { text: '知识库 Agent 不可用:' + outboundOff().error + '。修复后重启服务。', isError: true }
        }
        const taskId = String(args.task_id ?? '').trim()
        if (!taskId) return { text: 'task_id 必填(kb_agent 异步提交时返回的 id)。', isError: true }
        const waitSec = Math.min(Math.max(Math.round(Number(args.wait_seconds ?? 0) || 0), 0), 1800)
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

    // ================= 工具 ×4(文档面:确定性,不依赖内部 agent 回合) =================

    ctx.omp.registerTool({
      name: 'kb_doc_create',
      label: '创建知识库文档',
      description: '把 Markdown 文档写入 rag-knowledge 知识库(缺省 aw-docs)并重建索引。name=标题(同名已存在视为成功,幂等);content=完整正文;可选 description/tags。返回 doc_path,可直接交给 kb_doc_read/kb_doc_search 验证。写类工具,调用留审计。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '文档标题/文件名(自动补 .md;同名文档已存在时幂等返回既有 doc_path)' },
          content: { type: 'string', description: '完整 Markdown 正文(纯文本直入;超过服务端大文档阈值时由服务端拆分)' },
          description: { type: 'string', description: '文档描述(可选;进入检索元数据,建议 1-2 句)' },
          kb: { type: 'string', description: `目标知识库名或 kbId(缺省 ${DOCS_KB_NAME};经验库是 ${KB_NAME},显式指定时输出漂移警告)` },
          tags: { type: 'array', items: { type: 'string' }, description: '标签(可选,≤16 项;创建后尽力写入,失败不影响文档落盘)' },
        },
        required: ['name', 'content'],
      },
      roles: ['lead', 'worker'],
      riskClass: 'write',
      noRefs: true,
      handler: async (args, agent) => {
        try {
          if (!state.outbound) return { text: '出站调用已禁用:' + outboundOff().error, isError: true }
          const rawName = String(args.name ?? '').trim()
          const content = String(args.content ?? '')
          if (!rawName) return { text: 'name 必填(文档标题)。', isError: true }
          if (!content.trim()) return { text: 'content 必填(文档正文不能为空)。', isError: true }
          // 文件名净化:Windows 非法字符(<>:"/\|?* 与控制字符)会让服务端写盘 500;
          // 在客户端先行替换为 '-' 并保留中文/空格,避免不可读的 500。
          const unsafeChars = '<>:"/\\|?*'
          const safeBase = Array.from(rawName)
            .map(ch => (ch.charCodeAt(0) < 32 || unsafeChars.includes(ch) ? '-' : ch))
            .join('')
            .replace(/\s+/g, ' ')
            .trim()
          const fileName = /\.[A-Za-z0-9]+$/.test(safeBase) ? safeBase : `${safeBase}.md`
          const kbSel = await resolveKb(args.kb)
          if (!kbSel.ok) return { text: kbSel.error, isError: true }
          const { kbId: targetKb, name: targetName } = kbSel
          const drift = targetName === KB_NAME
            ? `\n⚠️ 目标库是经验库 ${KB_NAME};文档默认应入 ${docsKbName()}(已按显式指定执行,未拦截)。`
            : ''

          // 幂等前置:服务端 create 对重名是「自动改名 (n)」而非 409 —— 先按同名查既有文档,
          // 命中即视为完成(同一份文档重复调用不会产生副本)。
          const listed = await docList(targetKb)
          if (listed.ok) {
            const hit = findDocByName(listed.body?.documents, fileName)
            if (hit?.path) {
              bump('kb_doc_create', true)
              return { text: `status=exists doc_path=${normSlashes(hit.path)} kb=${targetName} chars=${String(content).length} idempotent=yes\n文档「${fileName}」已存在于 ${targetName},本次未重复创建(幂等)。` + drift }
            }
          }
          else if (listed.status === 401 || listed.status === 403) {
            bump('kb_doc_create', false)
            return { text: describeKbFailure(listed), isError: true }
          }

          const created = await callJson('POST', `${web()}/api/kb/documents/create`,
            { kbId: targetKb, name: fileName, content, description: String(args.description ?? '').trim() },
            { timeoutMs: WRITE_TIMEOUT_MS, retries: 0 })
          if (!created.ok) {
            // 并发竞态或服务端策略:409 时回查同名文档,命中即按幂等成功
            if (created.status === 409) {
              const again = await docList(targetKb)
              const hit = findDocByName(again.body?.documents, fileName)
              if (hit?.path) {
                bump('kb_doc_create', true)
                return { text: `status=exists doc_path=${normSlashes(hit.path)} kb=${targetName} chars=${String(content).length} idempotent=yes\n重名冲突(HTTP 409)但同名文档已存在,按幂等成功处理。` + drift }
              }
            }
            bump('kb_doc_create', false)
            return { text: `文档创建失败(${describeKbFailure(created)})。先 kb_catalog 确认库「${targetName}」存在、token 有效后重试。`, isError: true }
          }
          const docPath = normSlashes(created.body?.document?.path ?? '')
          const docId = String(created.body?.document?.id ?? '')
          const partCount = Number(created.body?.part_count ?? 0) || 0
          const splitNote = created.body?.split ? `(服务端按大文档拆分为 ${partCount} 篇,首篇 doc_path 如下)` : ''

          // 单文档索引(documents/create 只写盘,不建向量/BM25 —— 文档 §5.5)。
          // 走 backend /api/v1/search/index-document:向量 + 图谱 + **BM25 增量**
          // (实测:web /api/search/reindex 不刷新 backend 进程内 BM25,新文档两段检索会 0 命中)。
          let indexState = 'ok'
          const idx = await callJson('POST', `${base()}/api/v1/search/index-document`,
            docId
              ? { doc_id: docId, doc_name: fileName, description: String(args.description ?? '').trim() }
              : { kb_id: targetKb, doc_path: docPath, doc_name: fileName, description: String(args.description ?? '').trim(), content },
            { timeoutMs: WRITE_TIMEOUT_MS, retries: 0 })
          if (!idx.ok) {
            // 索引失败不影响文档落盘:退一步整库 reindex(会重建向量;BM25 是否刷新取决于后端版本),如实标注降级
            const rx = await callJson('POST', `${web()}/api/search/reindex`, { kb_id: targetKb }, { timeoutMs: WRITE_TIMEOUT_MS, retries: 0 })
            indexState = rx.ok ? 'degraded(reindex)' : `failed(${idx.error})`
            ctx.logger.warn(`kb_doc_create:index-document 失败(${idx.status ?? '?'} ${idx.error});fallback reindex=${rx.ok ? 'ok' : rx.error}`)
          }
          // 可见性窗口:create 已返回 path 时一次即时确认;缺失时按 3×5s 重试列表(≤15s)
          let visible = Boolean(docPath)
          if (!visible) {
            for (let i = 0; i < 3 && !visible; i++) {
              if (i > 0) await sleep(5000)
              const again = await docList(targetKb)
              const hit = findDocByName(again.body?.documents, fileName)
              if (hit?.path) {
                visible = true
                break
              }
            }
          }
          // 标签:尽力写入(PATCH 失败不影响文档本体)
          let tagsState = 'none'
          if (Array.isArray(args.tags) && args.tags.length && docPath) {
            const tagRes = await callJson('PATCH', `${web()}/api/kb/documents/tags`,
              { kbId: targetKb, docPath, tags: args.tags.map(String).slice(0, 16) },
              { timeoutMs: READ_TIMEOUT_MS, retries: 0 })
            tagsState = tagRes.ok ? 'ok' : `failed(${tagRes.error})`
          }
          const finalPath = docPath || '(列表暂未确认,可稍后用 kb_doc_search 检索)'
          bump('kb_doc_create', true)
          await auditWrite({
            actor: agent?.agentId ?? 'user', actorName: agent?.name ?? '', actorKind: agent ? 'agent' : 'user',
            action: 'plugin.kb_doc.create', kind: 'write', scope: 'system',
            targetKind: 'document', targetId: finalPath,
            summary: `知识库文档创建 ${targetName}:${fileName}(${String(content).length} 字符)`,
            detail: { kb: targetName, kbId: targetKb, docPath: finalPath, channelId: agent?.channelId ?? '', role: agent?.role ?? '' },
          })
          return {
            text: [
              `status=created doc_path=${finalPath} kb=${targetName} chars=${String(content).length} index=${indexState} tags=${tagsState}${splitNote ? ' split=yes' : ''}`,
              `✅ 文档「${fileName}」已写入 ${targetName}${splitNote}。${visible ? '' : ' 列表可见性暂未确认(索引窗口),稍后 kb_doc_search 复核。'}`,
              `调用者=${agent?.agentId ?? '(用户直调)'} 角色=${agent?.role ?? '-'}${drift}`,
              `下一步:kb_doc_search(query=标题或关键词) 验证可检索;kb_doc_read(doc_path) 核对正文。`,
            ].filter(Boolean).join('\n'),
          }
        }
        catch (err) {
          bump('kb_doc_create', false)
          return { text: `kb_doc_create 异常:${err?.message ?? err}`, isError: true }
        }
      },
    })

    ctx.omp.registerTool({
      name: 'kb_doc_search',
      label: '检索知识库文档',
      description: '检索 rag-knowledge 文档(two-stage 两段检索为主,失败自动关键词兜底)。query=检索词(自然语言);kb 缺省 aw-docs,top_k 缺省 5。返回每条 doc_path+分数+片段,可直接接 kb_doc_read 读全文。只读、秒级。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词/问题(自然语言;中文可直接用)' },
          kb: { type: 'string', description: `知识库名或 kbId(缺省 ${DOCS_KB_NAME};不传=文档库)` },
          top_k: { type: 'number', description: '返回条数(1-20,缺省 5)' },
        },
        required: ['query'],
      },
      roles: ['lead', 'worker'],
      riskClass: 'read',
      noRefs: true,
      handler: async (args) => {
        try {
          if (!state.outbound) return { text: '出站调用已禁用:' + outboundOff().error, isError: true }
          const query = String(args.query ?? '').trim()
          if (!query) return { text: 'query 必填(检索词)。', isError: true }
          const kbsel = await resolveKb(args.kb)
          if (!kbsel.ok) return { text: kbsel.error, isError: true }
          const topK = Math.min(Math.max(Math.round(Number(args.top_k) || 5), 1), 20)
          const ts = await ragCall('POST', `${web()}/api/search/two-stage`, { query, kb_id: kbsel.kbId, stage2_top_k: topK }, { timeoutMs: READ_TIMEOUT_MS })
          if (ts.ok) {
            const results = Array.isArray(ts.body?.stage2?.results) ? ts.body.stage2.results.slice(0, topK) : []
            const total = Number(ts.body?.total_results ?? results.length)
            if (!results.length) {
              bump('kb_doc_search', true)
              return { text: `status=ok mode=two-stage hits=0 kb=${kbsel.name} total=${total}\n未命中。放宽关键词(去掉限定词),或确认文档是否已入库(kb_catalog 看 documentCount)。` }
            }
            const lines = results.map((r, i) => {
              const snippet = String(r?.content ?? '').replace(/\s+/g, ' ').slice(0, 220)
              return `${i + 1}. doc_path=${normSlashes(r?.doc_path)} score=${Number(r?.score ?? 0).toFixed(4)}${r?.chunk_index != null ? ` chunk=${r.chunk_index}` : ''}\n   ${snippet}${snippet.length >= 220 ? '…' : ''}`
            })
            bump('kb_doc_search', true)
            return {
              text: [
                `status=ok mode=two-stage hits=${results.length} kb=${kbsel.name} total=${total}`,
                ...lines,
                '',
                '读全文 → kb_doc_read(doc_path=<上面任一条>)。',
              ].join('\n'),
            }
          }
          // 兜底:关键词检索(api-web §5.4/§7.9)
          const kw = await ragCall('GET', `${web()}/api/kb/search?query=${encodeURIComponent(query)}&top_k=${topK}`, null, { timeoutMs: READ_TIMEOUT_MS })
          if (kw.ok) {
            const hits = Array.isArray(kw.body?.hits) ? kw.body.hits.slice(0, topK) : []
            bump('kb_doc_search', hits.length > 0)
            if (!hits.length) {
              return { text: `status=ok mode=keyword-degraded hits=0 kb=(跨库) total=0\n两段检索不可用(${ts.error}),关键词兜底也未命中。稍后重试两段检索,或换关键词。` }
            }
            const lines = hits.map((h, i) => `${i + 1}. doc_path=${normSlashes(h?.path)} score=${Number(h?.score ?? 0).toFixed(2)} kb=${h?.kbName ?? '?'}\n   名称=${h?.docName ?? '?'} 描述=${String(h?.description ?? '').slice(0, 160)}`)
            return {
              text: [
                `status=ok mode=keyword-degraded hits=${hits.length} kb=(跨库) degraded=two-stage(${ts.error})`,
                ...lines,
                '',
                '注意:两段检索(向量)不可用,本次为关键词元数据兜底(仅名称/描述匹配,不扫正文);命中后一定要 kb_doc_read 核实。',
              ].join('\n'),
            }
          }
          bump('kb_doc_search', false)
          return { text: `文档检索失败(two-stage:${describeKbFailure(ts)};关键词兜底:${kw.error})。检查 web 地址/token 与 IDD/RAG 服务状态。`, isError: true }
        }
        catch (err) {
          bump('kb_doc_search', false)
          return { text: `kb_doc_search 异常:${err?.message ?? err}`, isError: true }
        }
      },
    })

    ctx.omp.registerTool({
      name: 'kb_doc_read',
      label: '读取知识库文档',
      description: '读取知识库文档正文(doc_path 来自 kb_doc_search / kb_doc_create)。kb 缺省 aw-docs;doc_path 含库名前缀时自动识别归属。max_chars 截断(缺省 4000,上限 20000)。返回正文与截断标记,可核对内容一致性。',
      parameters: {
        type: 'object',
        properties: {
          doc_path: { type: 'string', description: '文档路径(kb_doc_search 返回的 doc_path,或库内相对路径/文件名)' },
          kb: { type: 'string', description: `知识库名或 kbId(缺省 ${DOCS_KB_NAME};doc_path 自带库名前缀时以路径为准)` },
          max_chars: { type: 'number', description: '正文截断上限(500-20000,缺省 4000)' },
        },
        required: ['doc_path'],
      },
      roles: ['lead', 'worker'],
      riskClass: 'read',
      noRefs: true,
      handler: async (args) => {
        try {
          if (!state.outbound) return { text: '出站调用已禁用:' + outboundOff().error, isError: true }
          const docPath = String(args.doc_path ?? '').trim()
          if (!docPath) return { text: 'doc_path 必填(先用 kb_doc_search 检索)。', isError: true }
          const maxChars = Math.min(Math.max(Math.round(Number(args.max_chars) || 4000), 500), 20000)
          let kbSel = await resolveKb(args.kb)
          if (!kbSel.ok) return { text: kbSel.error, isError: true }
          // 路径自带库名前缀(如 aw-docs/xxx.md)→ 按前缀解析归属,避免跨库读取时被拼错库根
          const byPath = await kbOfDocPath(docPath)
          if (byPath) kbSel = { ok: true, kbId: byPath.kbId, name: byPath.name }
          const r = await ragCall('GET', `${web()}/api/kb/document?kbId=${encodeURIComponent(kbSel.kbId)}&docPath=${encodeURIComponent(docPath)}&max_chars=${maxChars}`, null, { timeoutMs: READ_TIMEOUT_MS })
          if (!r.ok) {
            bump('kb_doc_read', false)
            const detail = r.status === 400
              ? 'doc_path 无法在目标库内解析(检查库名与路径;路径可来自 kb_doc_search)'
              : r.status === 404
                ? '404 文档不存在(路径可能拼错;先用 kb_doc_search 重新获取 doc_path)'
                : describeKbFailure(r)
            return { text: `文档读取失败(${detail})。`, isError: true }
          }
          const content = String(r.body?.content ?? '')
          bump('kb_doc_read', true)
          return {
            text: [
              `status=ok doc_path=${normSlashes(r.body?.path ?? docPath)} kb=${kbSel.name} chars=${content.length} total_lines=${r.body?.totalLines ?? '?'} truncated=${r.body?.truncated ? 'yes' : 'no'}`,
              content,
              r.body?.truncated ? `…[已截断:max_chars=${maxChars};需要更多内容可提高 max_chars(≤20000)]` : '',
            ].filter(Boolean).join('\n'),
          }
        }
        catch (err) {
          bump('kb_doc_read', false)
          return { text: `kb_doc_read 异常:${err?.message ?? err}`, isError: true }
        }
      },
    })

    ctx.omp.registerTool({
      name: 'kb_catalog',
      label: '知识库目录',
      description: '列出 rag-knowledge 全部知识库:名称、kbId、文档数。用于确认目标库存在(如 aw-docs/aw-industrial)与挑选 kb_doc_search 的 kb 参数。只读一次调用,≤15s。',
      parameters: { type: 'object', properties: {} },
      roles: ['lead', 'worker'],
      riskClass: 'read',
      noRefs: true,
      handler: async () => {
        try {
          if (!state.outbound) return { text: '出站调用已禁用:' + outboundOff().error, isError: true }
          const cat = await catalogList(true)
          if (!cat.ok) {
            bump('kb_catalog', false)
            return { text: `知识库目录不可用(${describeKbFailure(cat)})。`, isError: true }
          }
          const list = cat.list
          const shown = list.slice(0, 60)
          const lines = shown.map(kb => `- ${kb?.name ?? '?'} | ${kb?.kbId ?? '?'} | docs=${kb?.documentCount ?? '?'}${kb?.parentId ? ' (子库)' : ''}`)
          bump('kb_catalog', true)
          return {
            text: [
              `status=ok kbs=${list.length} shown=${shown.length} docs_kb=${docsKbName()}(${docsKbId() || '按需自愈'})`,
              ...lines,
              list.length > shown.length ? `…还有 ${list.length - shown.length} 个库未列出(按需用 kb 参数直接指定名称)` : '',
            ].filter(Boolean).join('\n'),
          }
        }
        catch (err) {
          bump('kb_catalog', false)
          return { text: `kb_catalog 异常:${err?.message ?? err}`, isError: true }
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

    // 健康:后端 + web 存活、双 kb.id(缺失时按需自愈)、出站开关、token 实测、工具计数
    ctx.route('GET', '/health', async () => {
      const backend = state.outbound
        ? await callJson('GET', `${base()}/api/v1/health`, null, { timeoutMs: 5000, retries: 0 })
        : { ok: false, error: '出站已禁用' }
      const webR = state.outbound
        ? await callJson('GET', `${web()}/api/kb/catalog`, null, { timeoutMs: 5000, retries: 0 })
        : { ok: false, error: '出站已禁用' }
      if ((!kbId() || !docsKbId()) && state.outbound && webR.ok) {
        // 装载期 401/不可达导致 kb.id 缺失 → 探活时自愈(经验库与文档库各自独立)
        if (!kbId()) await ensureKbByName(KB_NAME, 'kb.id', { experience: true }).catch(() => {})
        if (!docsKbId()) await ensureKbByName(docsKbName(), 'docs.kb.id').catch(() => {})
      }
      // token 三态实测(api-web §3:Web 层 POST /api/auth/verify {token});未配 token 时按匿名
      const verify = await (async () => {
        if (!state.outbound) return { configured: Boolean(kbToken()), accepted: null, reason: '出站已禁用' }
        if (!kbToken()) return { configured: false, accepted: true, reason: 'anonymous' }
        const v = await callJson('POST', `${web()}/api/auth/verify`, { token: kbToken() }, { timeoutMs: 5000, retries: 0 })
        if (v.ok) return { configured: true, accepted: v.body?.valid === true, reason: 'verify' }
        // verify 端点不可用(旧后端)→ 回退到受保护 GET /auth/me
        const me = await callJson('GET', `${base()}/api/v1/auth/me`, null, { timeoutMs: 5000, retries: 0 })
        return { configured: true, accepted: me.ok ? true : (me.status === 401 || me.status === 403 ? false : null), reason: 'auth/me-fallback' }
      })()
      return {
        plugin: 'rag-bridge',
        version: '2.3.0',
        outbound: state.outbound,
        auth: kbToken() ? 'bearer' : 'anonymous',
        token: {
          configured: Boolean(kbToken()),
          accepted: verify.accepted,
          verify: verify.reason,
        },
        kb: { name: KB_NAME, id: kbId() || null, role: 'experience' },
        docs: { name: docsKbName(), id: docsKbId() || null, role: 'documents' },
        backend: { url: base(), ok: backend.ok, ...(backend.ok ? { status: backend.body?.status ?? null } : { status: backend.status ?? null, error: backend.error }) },
        web: { url: web(), ok: webR.ok, ...(webR.ok ? { knowledgeBases: webR.body?.count ?? null } : { error: webR.error }) },
        counters: { store: ctx.kv.get('store.count') ?? 0, index: ctx.kv.get('index.count') ?? 0 },
        toolCounters: toolCounters(),
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
