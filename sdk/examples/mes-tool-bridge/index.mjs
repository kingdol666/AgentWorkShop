/**
 * mes-tool-bridge — 外接系统(MES/ERP)工具桥(参考实现)
 * ------------------------------------------------------------
 * 作用:把外部系统的 REST 能力暴露为 **Agent 工具**(ctx.omp.registerTool),
 * 演示「插件注册自定义工具 → 注入 Agent 会话 → Agent 按需求调用」的完整链路。
 * 本文件是模板而非产物:复制到 `.AgentWorkShop/plugins/mes-tool-bridge/`
 * (或 `aw plugin create` 生成的目录)即随宿主热装载;不随平台默认启用。
 *
 * 治理面(与内置工具同源,全部由宿主执行,插件无需自建):
 *  - 角色边界:`roles` 是执行期硬约束(worker 直调 lead-only 工具会被拒);
 *  - 风险分级:`riskClass:'write'` 进入写族判定(团队插件开关/写授权/审计同源);
 *  - 引用校验:`noRefs:true` 显式声明「不引用平台实体」(外部订单号不是产线/配方对象),
 *    避免被当成漏声明的写工具;
 *  - 结果截断/审计/错误隔离由 host-tool-bridge 统一处理。
 *
 * 凭据纪律:token 只从平台设置 `plugins.mes-tool-bridge.token` 读取(由运维写入),
 * 源码/默认值/日志/工具回包**都不落凭据字面量**。
 */
export default {
  name: 'mes-tool-bridge',
  version: '1.0.0',
  description: 'MES/ERP 工具桥:把外接系统订单查询与质量报告推送暴露为 Agent 工具(参考实现)',
  auth: 'user',
  settings: [
    { key: 'base_url', type: 'string', default: '', label: 'MES 基地址', description: '外部系统根地址,如 https://mes.example.com/api(仅 http/https)' },
    { key: 'token', type: 'string', default: '', label: 'MES 访问令牌', description: 'Bearer 令牌(写入平台设置;不要提交到仓库)' },
    { key: 'timeout_ms', type: 'number', default: 8000, min: 500, max: 60_000, label: '请求超时(ms)' },
  ],

  async setup(ctx) {
    const setting = key => ctx.config.get(`plugins.mes-tool-bridge.${key}`)

    /** 读取并校验连接配置;未配置返回 null(调用方给可操作指引,不假装成功) */
    const connection = () => {
      const raw = String(setting('base_url') ?? '').trim()
      if (!raw) return null
      const u = new URL(raw)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error(`MES 基地址协议不允许:${u.protocol}(仅 http/https)`)
      }
      const token = String(setting('token') ?? '').trim()
      const timeoutMs = Number(setting('timeout_ms')) || 8000
      return {
        base: raw.replace(/\/+$/, ''),
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        timeoutMs,
      }
    }
    const notConfigured = {
      text: 'MES 未配置:请在「系统设置 → 插件 → MES 工具桥」填写 base_url 与 token 后重试(未配置时不会发起任何外部请求)。',
      isError: true,
    }
    /** 统一错误出口:只回状态码与截断后的服务端说明 —— 不回显请求头/令牌 */
    const httpFailure = (verb, status, body) => {
      const brief = String(body ?? '').replace(/\s+/g, ' ').slice(0, 200)
      return { text: `MES ${verb} 失败:HTTP ${status}${brief ? ` — ${brief}` : ''}`, isError: true }
    }
    const networkFailure = (verb, err) => ({
      text: `MES ${verb} 网络异常:${err instanceof Error ? err.message : String(err)}(检查基地址/网络策略)`,
      isError: true,
    })
    const readJson = async (res) => {
      try {
        return await res.json()
      }
      catch {
        return null
      }
    }

    // ---- 只读工具:生产订单状态 ----
    ctx.omp.registerTool({
      name: 'mes_order_status',
      label: 'MES 订单状态',
      description: '查询外接 MES 系统的生产订单状态(状态/进度/缺陷数)。只读,不产生外部副作用。',
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'MES 生产订单号(外部系统标识)' },
        },
        required: ['orderId'],
        additionalProperties: false,
      },
      roles: ['lead', 'worker'],
      riskClass: 'read',
      noRefs: true,
      handler: async (args) => {
        const orderId = String(args.orderId ?? '').trim()
        if (!orderId) return { text: 'orderId 必填(MES 生产订单号)', isError: true }
        let conn
        try {
          conn = connection()
        }
        catch (err) {
          return { text: err instanceof Error ? err.message : String(err), isError: true }
        }
        if (!conn) return notConfigured
        let res
        try {
          res = await ctx.http.get(`${conn.base}/orders/${encodeURIComponent(orderId)}`, { headers: conn.headers, timeoutMs: conn.timeoutMs })
        }
        catch (err) {
          return networkFailure('查询', err)
        }
        const body = await readJson(res)
        if (!res.ok) return httpFailure('查询', res.status, res.status >= 500 ? body?.error : body?.message ?? body?.error)
        const status = String(body?.status ?? 'unknown')
        const progress = Number(body?.progress ?? 0)
        const defects = Number(body?.defects ?? 0)
        return { text: `MES 订单 ${orderId}:状态=${status},进度=${progress}%,缺陷=${defects} 件` }
      },
    })

    // ---- 写工具:质量报告推送(lead-only;riskClass=write 走写族治理) ----
    ctx.omp.registerTool({
      name: 'mes_quality_report',
      label: 'MES 质量报告推送',
      description: '把本批质量指标推送到外接 MES 系统(写操作,需 lead 角色;返回回执号)。',
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'MES 生产订单号' },
          metrics: { type: 'object', description: '质量指标键值(至少一项,如 { weight: 32.5, moldTemp: 226 })' },
          note: { type: 'string', description: '备注(可选)' },
        },
        required: ['orderId', 'metrics'],
        additionalProperties: false,
      },
      roles: ['lead'],
      riskClass: 'write',
      noRefs: true,
      handler: async (args) => {
        const orderId = String(args.orderId ?? '').trim()
        if (!orderId) return { text: 'orderId 必填(MES 生产订单号)', isError: true }
        const metrics = args.metrics
        if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics) || Object.keys(metrics).length === 0) {
          return { text: 'metrics 必填:至少提供一个质量指标键值(对象)', isError: true }
        }
        let conn
        try {
          conn = connection()
        }
        catch (err) {
          return { text: err instanceof Error ? err.message : String(err), isError: true }
        }
        if (!conn) return notConfigured
        let res
        try {
          res = await ctx.http.post(`${conn.base}/quality-reports`, { orderId, metrics, note: String(args.note ?? '') }, { headers: conn.headers, timeoutMs: conn.timeoutMs })
        }
        catch (err) {
          return networkFailure('推送', err)
        }
        const body = await readJson(res)
        if (!res.ok) return httpFailure('推送', res.status, body?.error ?? body?.message)
        const receipt = String(body?.receiptId ?? '').trim()
        return { text: receipt ? `已推送质量报告:MES 回执 ${receipt}` : '已推送质量报告(服务端未返回回执号,请人工核对 MES 单据)' }
      },
    })

    ctx.logger.info('MES 工具桥就绪:mes_order_status(读)/ mes_quality_report(写,lead-only)')
  },
}
