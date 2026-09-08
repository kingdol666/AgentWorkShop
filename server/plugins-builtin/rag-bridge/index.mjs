/**
 * rag-bridge —— rag-knowledge 知识库桥接插件。
 *
 * 把本地 rag-knowledge 服务(FastAPI 后端 + Nuxt web)集成为 AgentWorkShop 的
 * 团队知识库:启动即确保「aw-industrial」知识库存在,并向 agent 注入三个工具——
 * kb_search(全库检索)/ kb_store(经验沉淀)/ kb_index(文档入库)。
 * 另开放 /health、/search、/experience 三个插件 API 便于运维探查。
 * 服务不可达时工具返回 isError 文本(含原因与修复建议),绝不抛异常拖垮宿主。
 */
const KB_NAME = 'aw-industrial'
const CATEGORIES = ['best_practice', 'troubleshooting', 'lesson_learned', 'optimization', 'tip', 'workflow', 'decision']
const DEFAULT_BASE = 'http://127.0.0.1:8770' // FastAPI 后端
const DEFAULT_WEB = 'http://127.0.0.1:6789' // Nuxt web(文档写盘)

export default {
  name: 'rag-bridge',
  version: '1.0.0',
  description: 'rag-knowledge 知识库桥接:工业知识检索/经验沉淀/文档入库三工具',
  auth: 'user', // 平台转发层按此声明统一校验(缺省 'none' 开放)
  async setup(ctx) {
    // ---- 运行态 ----
    const state = { outbound: true } // base_url 非法时禁用全部出站调用
    const base = () => trimSlash(String(ctx.config?.get?.('plugins.kb.base_url') || ctx.kv.get('kb.base_url') || DEFAULT_BASE))
    const web = () => trimSlash(String(ctx.config?.get?.('plugins.kb.web_url') || ctx.kv.get('kb.web_url') || DEFAULT_WEB))
    const kbId = () => String(ctx.kv.get('kb.id') || '')

    // ---- kv 默认值(幂等) ----
    if (ctx.kv.get('kb.base_url') == null) ctx.kv.set('kb.base_url', DEFAULT_BASE)
    if (ctx.kv.get('kb.web_url') == null) ctx.kv.set('kb.web_url', DEFAULT_WEB)
    ctx.kv.set('kb.name', KB_NAME)

    // base_url 守卫:仅 http/https 且 host 必须是 127.0.0.1/localhost(不合法则禁用出站)
    try {
      const u = new URL(base())
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !['127.0.0.1', 'localhost'].includes(u.hostname)) {
        throw new Error(`base_url 必须是 http(s)://127.0.0.1|localhost,实际 ${base()}`)
      }
      state.outbound = true
    }
    catch (err) {
      state.outbound = false
      ctx.logger.error(`出站调用已禁用:${err?.message ?? err}(修正 kv['kb.base_url'] 后重启生效)`)
    }

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
    async function callJson(method, url, body, { timeoutMs = 15000, retries = 2 } = {}) {
      let lastErr = ''
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(1000 * attempt) // 退避 1s*n
        try {
          const res = method === 'GET'
            ? await ctx.http.get(url, { timeoutMs })
            : await ctx.http.post(url, body ?? {}, { timeoutMs })
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

    // ================= 工具 ×3(omp host 工具,lead/worker 全员可用) =================

    ctx.omp.registerTool({
      name: 'kb_search',
      label: '全库检索',
      description: '检索工业知识库(诊断报告/经验教训/操作规范),作业前先查历史经验,避免重复踩坑。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索问题(自然语言,中英文均可)' },
          kb_id: { type: 'string', description: '限定知识库 ID(缺省为 aw-industrial)' },
          top_k: { type: 'number', description: '返回条数上限(默认 5,经 stage2 精筛)' },
        },
        required: ['query'],
      },
      roles: ['lead', 'worker'],
      handler: async (args) => {
        if (!state.outbound) {
          return { text: `知识库检索不可用:${outboundOff().error}。修复后重启服务。`, isError: true }
        }
        const query = String(args.query ?? '').trim()
        if (!query) return { text: 'query 必填(要查什么问题)。', isError: true }
        const kb = String(args.kb_id ?? '').trim() || kbId() || undefined
        const topK = Math.min(Math.max(Math.round(Number(args.top_k) || 5), 1), 20)
        const r = await ragCall('POST', `${base()}/api/v1/search/two-stage`,
          { query, kb_id: kb, stage2_top_k: topK }, { timeoutMs: 30000 })
        if (!r.ok) {
          return { text: `检索失败:${r.error}。请确认 rag 后端(${base()})已启动(rag-knowledge 目录 start.bat / ragctl),稍后重试。`, isError: true }
        }
        const results = Array.isArray(r.body?.stage2?.results) ? r.body.stage2.results : []
        if (results.length === 0) {
          return { text: `未检索到相关经验/文档(查询:「${query}」)。可尝试更换关键词,或确认资料是否已用 kb_index 入库。` }
        }
        const top = results.slice(0, 5)
        const lines = top.map((h, i) => {
          const score = Number(h?.score ?? 0).toFixed(4)
          const path = String(h?.doc_path ?? '(无路径)')
          const brief = String(h?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
          return `${i + 1}. [score=${score}] ${path}\n   ${brief}${String(h?.content ?? '').length > 160 ? '…' : ''}`
        })
        return { text: `检索到 ${results.length} 条(展示前 ${top.length} 条):\n${lines.join('\n')}` }
      },
    })

    ctx.omp.registerTool({
      name: 'kb_store',
      label: '经验沉淀',
      description: '把本次作业中值得复用的经验(最佳实践/踩坑教训/操作要点)写入知识库,供团队后续检索。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '经验标题(一句话概括)' },
          category: { type: 'string', enum: CATEGORIES, description: '经验类别' },
          problem: { type: 'string', description: '遇到的问题/场景' },
          solution: { type: 'string', description: '解决方案/操作步骤' },
          key_lessons: { type: 'array', items: { type: 'string' }, description: '关键教训(条目列表,可选)' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签(可选)' },
          severity: { type: 'string', description: '严重程度(如 info/normal/critical,可选)' },
        },
        required: ['title', 'category'],
      },
      roles: ['lead', 'worker'],
      handler: async (args) => {
        if (!state.outbound) {
          return { text: `经验沉淀不可用:${outboundOff().error}。修复后重启服务。`, isError: true }
        }
        const title = String(args.title ?? '').trim()
        if (!title) return { text: 'title 必填(经验标题)。', isError: true }
        const category = String(args.category ?? '').trim()
        if (!CATEGORIES.includes(category)) {
          return { text: `category 必须是以下之一:${CATEGORIES.join('/')}`, isError: true }
        }
        const kb = await requireKbId()
        if (!kb) {
          return { text: `经验沉淀失败:知识库 ${KB_NAME} 不存在且自动建库失败(检查 web ${web()} 是否启动)。`, isError: true }
        }
        const body = {
          title,
          category,
          problem: String(args.problem ?? ''),
          solution: String(args.solution ?? ''),
        }
        const lessons = (Array.isArray(args.key_lessons) ? args.key_lessons : []).map(s => String(s).trim()).filter(Boolean)
        if (lessons.length) body.key_lessons = lessons
        const tags = (Array.isArray(args.tags) ? args.tags : []).map(s => String(s).trim()).filter(Boolean)
        if (tags.length) body.tags = tags
        const severity = String(args.severity ?? '').trim()
        if (severity) body.severity = severity
        const r = await ragCall('POST', `${base()}/api/v1/experience/${kb}`, body, { timeoutMs: 30000 })
        if (!r.ok) {
          return { text: `经验沉淀失败:${r.error}。请确认 rag 后端(${base()})已启动后重试。`, isError: true }
        }
        const expId = String(r.body?.experience?.id ?? '(未返回 id)')
        ctx.kv.bump('store.count')
        return { text: `经验已沉淀:${title}(id=${expId},category=${category},kb=${KB_NAME})。` }
      },
    })

    ctx.omp.registerTool({
      name: 'kb_index',
      label: '文档入库',
      description: '把一份 markdown 文档写入知识库并建立向量/图谱索引,供 kb_search 日后检索。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '文档标题(同时作为文件名)' },
          content: { type: 'string', description: '文档正文(markdown)' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签(可选)' },
        },
        required: ['title', 'content'],
      },
      roles: ['lead', 'worker'],
      handler: async (args) => {
        if (!state.outbound) {
          return { text: `文档入库不可用:${outboundOff().error}。修复后重启服务。`, isError: true }
        }
        const title = String(args.title ?? '').trim()
        const content = String(args.content ?? '')
        if (!title) return { text: 'title 必填(文档标题)。', isError: true }
        if (!content.trim()) return { text: 'content 必填(markdown 正文,不能为空)。', isError: true }
        const kb = await requireKbId()
        if (!kb) {
          return { text: `文档入库失败:知识库 ${KB_NAME} 不存在且自动建库失败(检查 web ${web()} 是否启动)。`, isError: true }
        }
        const tags = (Array.isArray(args.tags) ? args.tags : []).map(s => String(s).trim()).filter(Boolean)
        // 第 1 步:web 写盘(响应 {success,document:{path,...}})
        const docName = safeFileName(title)
        const w = await ragCall('POST', `${web()}/api/kb/documents/create`,
          { kbId: kb, name: docName, content, description: title }, { timeoutMs: 30000 })
        if (!w.ok) {
          return { text: `文档入库卡在第 1 步(web 写盘 ${web()}/api/kb/documents/create):${w.error}。未产生索引,可直接重试。`, isError: true }
        }
        const docPath = String(w.body?.document?.path ?? '')
        if (!docPath) {
          return { text: '文档入库卡在第 1 步:写盘成功但响应缺少 document.path,无法继续索引。', isError: true }
        }
        // 第 2 步:backend 索引(content 直传,doc_path 用写盘返回路径)
        const r = await ragCall('POST', `${base()}/api/v1/search/index-document`,
          { kb_id: kb, doc_path: docPath, doc_name: docName, description: title, content, tags }, { timeoutMs: 60000 })
        if (!r.ok) {
          return { text: `文档入库卡在第 2 步(backend 索引 ${base()}/api/v1/search/index-document):${r.error}。文档已写盘(${docPath}),服务恢复后可重试入库(同名会生成新文件)。`, isError: true }
        }
        const chunks = Number(r.body?.vector_index?.total_chunks ?? 0)
        ctx.kv.bump('index.count')
        return { text: `文档已入库:${docPath}(向量分块 ${chunks},kb=${KB_NAME}),可立即用 kb_search 检索。` }
      },
    })

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

    // 健康:后端 + web 存活、kb.id、出站开关
    ctx.route('GET', '/health', async () => {
      const backend = state.outbound
        ? await callJson('GET', `${base()}/api/v1/health`, null, { timeoutMs: 5000, retries: 0 })
        : { ok: false, error: '出站已禁用' }
      const webR = state.outbound
        ? await callJson('GET', `${web()}/api/kb/catalog`, null, { timeoutMs: 5000, retries: 0 })
        : { ok: false, error: '出站已禁用' }
      return {
        plugin: 'rag-bridge',
        outbound: state.outbound,
        kb: { name: KB_NAME, id: kbId() || null },
        backend: { url: base(), ok: backend.ok, ...(backend.ok ? { status: backend.body?.status ?? null } : { error: backend.error }) },
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

/** 标题 → 安全文件名(剔除路径非法字符;确保 .md 后缀) */
function safeFileName(title) {
  // eslint-disable-next-line no-control-regex -- 文件名净化:必须剔除控制字符
  let name = String(title).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '')
  if (!name) name = 'untitled'
  if (name.length > 80) name = name.slice(0, 80).trim()
  return name.toLowerCase().endsWith('.md') ? name : `${name}.md`
}
