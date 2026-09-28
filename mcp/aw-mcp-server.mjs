#!/usr/bin/env node
/**
 * mcp/aw-mcp-server.mjs —— AgentWorkShop 工业 MCP server(stdio,零依赖)。
 *
 * 与 server/harness/aw-mcp-bridge.mjs(host tools 回程桥,面向频道内 agent)不同,
 * 本 server 面向 **外部 skill / MCP 客户端 / 工程师工作台**:把平台 REST 的关键方法
 * (产线/节点绑定/参数映射/配方开跑/频道与优化闭环/插件管理)暴露为一等 MCP 工具,
 * 并 **自动发现本机运行实例的端口**(锁文件 → 惯例端口 → config.yml,见 discovery.mjs),
 * 连接中断自动重发现 —— 挂上就能用,不要求手填端口。
 *
 * 启动:  aw mcp            (或 node mcp/aw-mcp-server.mjs)
 * 诊断:  aw mcp --doctor
 * 客户端配置: aw mcp --print-config
 *
 * 环境变量(全部可选):
 *   AW_BASE_URL   显式平台地址(跳过自动发现)
 *   AW_PORT       多实例并存时钉住端口
 *   AW_HOME       home 级配置根(锁文件发现用)
 *   AW_TOKEN      直接带 token(优先)
 *   AW_EMAIL / AW_PASSWORD  自动登录(首次鉴权调用时懒登录)
 *   AW_MCP_TIMEOUT_MS       默认工具 HTTP 超时(默认 30000)
 *
 * 协议:MCP stdio(JSON-RPC 2.0,逐行),与 aw-mcp-bridge 同款约定。
 */
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { discoverInstance, discoverWithReport, readMcpEnabled } from './discovery.mjs'

const DEFAULT_TIMEOUT_MS = Number(process.env.AW_MCP_TIMEOUT_MS ?? 30_000)
const INVOKE_TIMEOUT_MS = 200_000 // agent 工具可能阻塞(HITL 审批 180s)

/** 会话状态:createState 一次,handleMessage 复用 */
export function createState(opts = {}) {
  const env = opts.env ?? process.env
  return {
    env,
    cwd: opts.cwd ?? process.cwd(),
    base: opts.env?.AW_BASE_URL ? opts.env.AW_BASE_URL.replace(/\/$/, '') : null,
    port: null,
    source: null,
    token: env.AW_TOKEN ?? null,
    user: null,
    loginError: null,
  }
}

export class AuthRequiredError extends Error {}

/** 登录被拒(凭据错误/账号不存在)——不是网络问题,不得触发端口重发现 */
export class LoginError extends Error {}

/** fetch 网络层失败(连接拒绝/超时),才值得作废 base 重发现 */
function isNetworkError(err) {
  return err instanceof TypeError || err?.name === 'AbortError' || err?.name === 'TimeoutError'
}

// ── 平台 HTTP ──────────────────────────────────────────────

async function ensureBase(state) {
  if (state.base) return state.base
  const found = await discoverInstance({ cwd: state.cwd, env: state.env })
  if (!found) {
    throw new Error('未发现运行中的 AgentWorkShop 实例(已探测锁文件/惯例端口/config.yml)。请先 aw start,或为 MCP 进程设置 AW_BASE_URL / AW_PORT。')
  }
  state.base = found.base
  state.port = found.port
  state.source = found.source
  return state.base
}

export async function doLogin(state, email, password) {
  const base = await ensureBase(state)
  const res = await fetch(`${base}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.data?.token) {
    throw new LoginError(`登录失败(HTTP ${res.status}): ${json?.message ?? res.statusText}`)
  }
  state.token = json.data.token
  state.user = json.data.user ?? null
  state.loginError = null
  return { user: state.user }
}

async function ensureToken(state) {
  if (state.token) return state.token
  const email = state.env.AW_EMAIL
  const password = state.env.AW_PASSWORD
  if (!email || !password) {
    throw new AuthRequiredError('未鉴权:请先调用 aw_login 工具,或为 MCP 进程设置 AW_EMAIL + AW_PASSWORD(或 AW_TOKEN)环境变量。实例若从未初始化管理员,先用 /setup 注册(首注册即 admin)。')
  }
  await doLogin(state, email, password)
  return state.token
}

/**
 * 统一平台调用。返回 { ok, status, data, message }。
 * - 网络层失败:作废 base 自动重发现一次再重试("确保连接")
 * - 401:作废 token 懒重登录一次再重试
 */
export async function apiCall(state, method, path, body, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, auth = true } = opts
  const doFetch = async () => {
    // base 每次 fetch 时重新解析(闭包不得缓存:重发现后旧 base 即刻失效)
    const base = await ensureBase(state)
    const headers = { 'content-type': 'application/json' }
    if (auth) headers.authorization = `Bearer ${await ensureToken(state)}`
    return fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  }
  let res
  try {
    res = await doFetch()
  }
  catch (err) {
    if (!isNetworkError(err)) throw err // 登录失败/未鉴权等业务错误直接上抛
    // 连接断了:重新发现端口再试一次(实例可能顺延换端口)
    state.base = null
    state.port = null
    state.source = null
    const base2 = await ensureBase(state)
    try {
      res = await doFetch()
    }
    catch (err2) {
      throw new Error(`平台不可达(重发现后 ${base2} 仍失败): ${err2?.message ?? err?.message}`, { cause: err2 })
    }
  }
  if (res.status === 401 && auth) {
    state.token = null
    await ensureToken(state)
    res = await doFetch()
  }
  const json = await res.json().catch(() => null)
  return {
    ok: res.ok,
    status: res.status,
    // 信封嗅探:绝大多数端点走 defineApiHandler({code,message,data}),
    // 少数(如 GET /api/workshop/plugins)是裸 defineEventHandler 直返载荷
    data: isEnvelope(json) ? json.data : json,
    message: json?.message ?? res.statusText,
  }
}

function isEnvelope(json) {
  return json != null && typeof json === 'object' && !Array.isArray(json) && 'code' in json && 'data' in json
}

// ── 工具注册表 ──────────────────────────────────────────────

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: true })
const s = (description, type = 'string') => ({ type, description })

/** 结果包装:成功吐 JSON 文本;失败 isError */
function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}
function fail(message) {
  return { content: [{ type: 'text', text: String(message) }], isError: true }
}

/** 生成"调 REST → 包装结果"的处理器 */
function rest(method, pathOf, { timeoutMs, auth = true, bodyOf } = {}) {
  return async (args, state) => {
    const path = typeof pathOf === 'function' ? pathOf(args) : pathOf
    const body = method === 'GET' ? undefined : (bodyOf ? bodyOf(args) : args)
    const r = await apiCall(state, method, path, body, { timeoutMs, auth })
    if (!r.ok) return fail(`${method} ${path} → HTTP ${r.status}: ${r.message}`)
    return ok(r.data)
  }
}

function queryOf(args) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v === undefined || v === null || k === 'body') continue
    qs.set(k, String(v))
  }
  const q = qs.toString()
  return q ? `?${q}` : ''
}

/** 摘掉路径参数后的剩余字段作 body(路径参数不属于请求体) */
function omit(obj, ...keys) {
  const copy = { ...obj }
  for (const k of keys) delete copy[k]
  return copy
}

/**
 * 工具面(35 个)—— 按三个 skill 的标准流程分组:
 *   连接:aw_status / aw_login
 *   节点绑定:aw_line_* / aw_product_create / aw_recipe_create / aw_dcw_* / aw_param_* / aw_daq_*
 *   优化 channel:aw_channel_* / aw_team_provision / aw_agent_tool_* / aw_twin_profile_* / aw_task_* / aw_model_* / aw_optimization_judge
 *   插件:aw_plugin_list / aw_plugin_toggle
 *   逃生舱:aw_request(限 /api/ 前缀)
 */
export function buildToolDefs() {
  const defs = [
    // ── 连接与鉴权 ──
    {
      name: 'aw_status',
      description: '发现并探测本机 AgentWorkShop 实例:返回实际端口/发现来源/健康摘要/鉴权状态。任何流程的第一步。',
      inputSchema: obj(),
      run: async (_args, state) => {
        const report = await discoverWithReport({ cwd: state.cwd, env: state.env })
        if (!report.hit) {
          state.base = null
          return fail(`未发现运行实例。探测记录:\n${JSON.stringify(report.candidates, null, 2)}`)
        }
        state.base = report.hit.base
        state.port = report.hit.base ? Number(new URL(report.hit.base).port) || null : null
        state.source = report.hit.source
        let setup
        try {
          const r = await apiCall(state, 'GET', '/api/users/setup-status', undefined, { auth: false })
          setup = r.data
        }
        catch {
          setup = null
        }
        return ok({
          base: report.hit.base,
          port: state.port,
          discoveredVia: report.hit.source,
          health: report.hit.health,
          needsSetup: setup?.needsSetup ?? null,
          authed: Boolean(state.token),
          mcpEnabled: isMcpEnabled(state),
          mcpEnableHint: '系统设置 → MCP 集成 → 启动 MCP 集成(或 env AW_MCP_ENABLED=true)',
          user: state.user,
          candidates: report.candidates,
        })
      },
    },
    {
      name: 'aw_login',
      description: '登录平台换取 token(email 或用户名 + 密码;缺省回落 AW_EMAIL/AW_PASSWORD 环境变量)。返回当前用户。',
      inputSchema: obj({
        email: s('邮箱或用户名(缺省用环境变量 AW_EMAIL)'),
        password: s('密码(缺省用环境变量 AW_PASSWORD;不会回显)'),
      }),
      run: async (args, state) => {
        const email = args?.email ?? state.env.AW_EMAIL
        const password = args?.password ?? state.env.AW_PASSWORD
        if (!email || !password) return fail('缺少凭据:请传 email/password,或设置 AW_EMAIL/AW_PASSWORD 环境变量。')
        try {
          const { user } = await doLogin(state, email, password)
          return ok({ user, authed: true })
        }
        catch (err) {
          state.loginError = err.message
          return fail(err.message)
        }
      },
    },

    // ── 产线 / 产品 / 配方(执行侧)──
    {
      name: 'aw_line_list',
      description: '产线列表(含运行状态)。返回 data 为产线数组。',
      inputSchema: obj(),
      run: rest('GET', '/api/workshop/dcw/lines'),
    },
    {
      name: 'aw_line_create',
      description: '新建产线。{ name, color?, description? } → 返回 { line }。',
      inputSchema: obj({ name: s('产线名', 'string'), color: s('颜色,如 #35e0a0'), description: s('描述') }, ['name']),
      run: rest('POST', '/api/workshop/dcw/lines'),
    },
    {
      name: 'aw_line_start',
      description: '产线开跑:按配方逐参数下发并激活打标采集窗。{ lineId, recipeId }(recipe 须属本产线产品)。',
      inputSchema: obj({ lineId: s('产线 id'), recipeId: s('配方 id') }, ['lineId', 'recipeId']),
      run: async (args, state) => {
        const r = await apiCall(state, 'POST', `/api/workshop/dcw/lines/${args.lineId}/start`, { recipeId: args.recipeId })
        if (!r.ok) return fail(`开跑失败 → HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },
    {
      name: 'aw_line_stop',
      description: '停线(停止采集/关闭打标窗)。{ lineId }。',
      inputSchema: obj({ lineId: s('产线 id') }, ['lineId']),
      run: async (args, state) => {
        const r = await apiCall(state, 'POST', `/api/workshop/dcw/lines/${args.lineId}/stop`, {})
        if (!r.ok) return fail(`停线失败 → HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },
    {
      name: 'aw_product_create',
      description: '创建产品(产线隔离顶层归属)。{ lineId, name, description?, paramLimits? }(paramLimits: 参数 key → {min,max},仅可收窄)。',
      inputSchema: obj({ lineId: s('产线 id'), name: s('产品名'), description: s('描述'), paramLimits: s('参数限界对象', 'object') }, ['lineId', 'name']),
      run: async (args, state) => {
        const { lineId, ...body } = args
        const r = await apiCall(state, 'POST', '/api/workshop/dcw/products', { ...body, lineId })
        if (!r.ok) return fail(`创建产品失败 → HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },
    {
      name: 'aw_recipe_create',
      description: '创建配方(节点级参数绑定)。{ productId?, name, description?, params?: [{nodeId, value, min?, max?, stepLimit?}], daqWindows?: [{nodeId, min?, max?}] }。description 是配方的元字段:用一句话写明目标工况(如「目标:膜厚 50±2μm;线速 99/模口 0.97;探索收敛于 2026-09-27」),便于按目标检索与区分不同目标保存的配方。',
      inputSchema: obj({
        productId: s('产品 id'),
        name: s('配方名'),
        description: s('配方描述(元字段):优化目标/工况要点/来源,建议一句话讲清"这个配方是为了什么"'),
        params: s('参数绑定数组', 'array'),
        daqWindows: s('数采监控窗口数组', 'array'),
      }, ['name']),
      run: rest('POST', '/api/workshop/dcw/recipes'),
    },
    {
      name: 'aw_recipe_list',
      description: '配方列表(含 description 元字段/params/版本/lastGoodRunId)+ 批次列表。{ productId?, lineId? } 过滤可选。用于核对"不同目标保存的不同配方"。',
      inputSchema: obj({ productId: s('按产品过滤'), lineId: s('按产线过滤') }),
      run: async (args, state) => {
        const r = await apiCall(state, 'GET', '/api/workshop/dcw/recipes', undefined)
        if (!r.ok) return fail(`HTTP ${r.status}: ${r.message}`)
        const data = r.data ?? {}
        let recipes = Array.isArray(data) ? data : (data.recipes ?? [])
        if (args.productId) recipes = recipes.filter(x => x.productId === args.productId)
        if (args.lineId) recipes = recipes.filter(x => x.lineId === args.lineId)
        return ok({ recipes: recipes.map(x => ({ id: x.id, name: x.name, description: x.description, productId: x.productId, lineId: x.lineId, params: x.params, version: x.version, lastGoodRunId: x.lastGoodRunId ?? null })), runs: data.runs ?? [] })
      },
    },
    {
      name: 'aw_recipe_update',
      description: '编辑配方(params 变更自动版本化入史;description/name 可直接改)。{ id, name?, description?, params? }。优化收敛后用本工具把最佳参数与目标描述写回配方。',
      inputSchema: obj({
        id: s('配方 id'),
        name: s('新名称'),
        description: s('新描述(元字段)'),
        params: s('新参数绑定数组(自动版本化)', 'array'),
      }, ['id']),
      run: async (args, state) => {
        const { id, ...body } = args
        const r = await apiCall(state, 'PATCH', `/api/workshop/dcw/recipes/${id}`, body)
        if (!r.ok) return fail(`更新被拒 → HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },
    {
      name: 'aw_recipe_mark_good',
      description: '标记已知良好批次(lastGoodRunId,回退/基准恢复的目标)。{ id, runId }。',
      inputSchema: obj({ id: s('配方 id'), runId: s('批次 id(该配方的已完结批次)') }, ['id', 'runId']),
      run: async (args, state) => {
        const r = await apiCall(state, 'POST', `/api/workshop/dcw/recipes/${args.id}/mark-good`, { runId: args.runId })
        if (!r.ok) return fail(`标记失败 → HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },

    // ── DCW 写控制节点与参数映射 ──
    {
      name: 'aw_dcw_snapshot',
      description: 'DCW 全量快照:controller/nodes/params/templates/drivers/recipes/runs/products/lines。查模板 ref 与现有拓扑的标准入口。',
      inputSchema: obj(),
      run: rest('GET', '/api/workshop/dcw'),
    },
    {
      name: 'aw_dcw_create',
      description: '创建写控制节点(PLC 执行面)。必填 templateRef(模板 ref,如 dcw-temp-sp);driver+driverConfig 必须取自模拟器 export 或真实设备规约,禁止手抄;建议显式传 lineId/unit/min/max/decimals/holdIntervalMs。节点创建即自动生成同名工艺参数映射。',
      inputSchema: obj({
        templateRef: s('模板 ref(dcw-<key>)'),
        name: s('节点名'),
        lineId: s('所属产线 id'),
        driver: s('驱动:modbus-tcp | modbus-rtu | opcua | mqtt | http'),
        driverConfig: s('驱动配置对象(取自设备 export)', 'object'),
        unit: s('工程单位'), min: s('量程下限', 'number'), max: s('量程上限', 'number'), decimals: s('小数位(量化精度)', 'number'),
        holdIntervalMs: s('保持周期 ms', 'number'), readIntervalMs: s('回读周期 ms', 'number'), writeLockSeconds: s('写锁秒数', 'number'), stepLimit: s('单步限幅', 'number'),
        semantics: s('工艺语义文案'),
        transform: s('量程变换 {kind,scale,offset}', 'object'),
      }, ['templateRef']),
      run: rest('POST', '/api/workshop/dcw'),
    },
    {
      name: 'aw_dcw_write',
      description: '节点直写(核心写命令,四层限界联锁生效,越界 400 并点名约束层)。{ id, value }。',
      inputSchema: obj({ id: s('节点 id'), value: s('工程量纲目标值', 'number') }, ['id', 'value']),
      run: async (args, state) => {
        const r = await apiCall(state, 'POST', `/api/workshop/dcw/${args.id}/write`, { value: args.value })
        if (!r.ok) return fail(`写入被拒 → HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },
    {
      name: 'aw_dcw_read',
      description: '读节点 PLC 实时值(被动观测免审批)。{ id }。',
      inputSchema: obj({ id: s('节点 id') }, ['id']),
      run: async (args, state) => {
        const r = await apiCall(state, 'POST', `/api/workshop/dcw/${args.id}/read`, {})
        if (!r.ok) return fail(`读失败 → HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },
    {
      name: 'aw_param_list',
      description: '工艺参数映射列表(语义面,不透出寄存器细节)。{ lineId?, limits? }(limits=1 附四层写入限界剖面)。',
      inputSchema: obj({ lineId: s('按产线过滤'), limits: s('是否附限界剖面(1/0)') }),
      run: async (args, state) => {
        const r = await apiCall(state, 'GET', `/api/workshop/dcw/params${queryOf(args)}`, undefined)
        if (!r.ok) return fail(`HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },
    {
      name: 'aw_param_write',
      description: '参数映射标准写入口(工程量纲;四层限界联锁:参数基准 ∩ 产品限界 ∩ 配方窗 ∩ 节点量程)。{ id, value }。',
      inputSchema: obj({ id: s('参数映射 id'), value: s('工程量纲目标值', 'number') }, ['id', 'value']),
      run: async (args, state) => {
        const r = await apiCall(state, 'POST', `/api/workshop/dcw/params/${args.id}/write`, { value: args.value })
        if (!r.ok) return fail(`写入被拒 → HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },
    {
      name: 'aw_param_read',
      description: '读参数映射当前工程量纲值。{ id }。',
      inputSchema: obj({ id: s('参数映射 id') }, ['id']),
      run: async (args, state) => {
        const r = await apiCall(state, 'POST', `/api/workshop/dcw/params/${args.id}/read`, {})
        if (!r.ok) return fail(`读失败 → HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },

    // ── DAQ 数采 ──
    {
      name: 'aw_daq_create',
      description: '创建数采节点(观测面;不下发)。{ templateRef, name?, lineId?, driver?, driverConfig?, unit?, min?, max?, decimals?, warnLow?, warnHigh?, intervalMs?, semantics? }。',
      inputSchema: obj({
        templateRef: s('数采模板 ref(如 daq-temp-tc)'),
        name: s('节点名'), lineId: s('所属产线 id'),
        driver: s('驱动'), driverConfig: s('驱动配置对象', 'object'),
        unit: s('单位'), min: s('量程下限', 'number'), max: s('量程上限', 'number'), decimals: s('小数位', 'number'),
        warnLow: s('低警线', 'number'), warnHigh: s('高警线', 'number'), intervalMs: s('采样周期 ms', 'number'),
        semantics: s('语义标注(场景编译 target 词表推断依据,建议写明"…质量输出")'),
      }, ['templateRef']),
      run: rest('POST', '/api/workshop/daq'),
    },
    {
      name: 'aw_daq_controller',
      description: '数采采集总控。{ action: start|stop|pause|resume|config, defaultIntervalMs? }。重启实例后必须显式 start;未开产线不采样是设计。',
      inputSchema: obj({ action: s('start | stop | pause | resume | config'), defaultIntervalMs: s('默认采样周期 ms', 'number') }, ['action']),
      run: rest('POST', '/api/workshop/daq/controller'),
    },
    {
      name: 'aw_daq_samples',
      description: '数采时序历史(点序新→旧!)。{ id, bucketMs?, limit?, from?, to? }。取时间窗口前先按 at 升序整理。',
      inputSchema: obj({ id: s('数采节点 id'), bucketMs: s('桶化毫秒', 'number'), limit: s('条数上限', 'number'), from: s('起始 ISO 时间'), to: s('结束 ISO 时间') }, ['id']),
      run: async (args, state) => {
        const { id, ...query } = args
        const r = await apiCall(state, 'GET', `/api/workshop/daq/${id}/samples${queryOf(query)}`, undefined)
        if (!r.ok) return fail(`HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },

    // ── 场景优化 Channel 与闭环 ──
    {
      name: 'aw_channel_list',
      description: '频道(Agent 团队)列表。',
      inputSchema: obj(),
      run: rest('GET', '/api/workshop/channels'),
    },
    {
      name: 'aw_channel_create',
      description: '直接创建频道。{ name, scenarioPrompt?, workspace? } → { channelId }。要建「优化闭环频道」优先用 aw_channel_template_instantiate。',
      inputSchema: obj({ name: s('频道名'), scenarioPrompt: s('场景纪律 prompt'), workspace: s('工作目录') }, ['name']),
      run: rest('POST', '/api/workshop/channels'),
    },
    {
      name: 'aw_channel_template_list',
      description: '频道模板列表(含内置 seed:chtpl-aml-optimization-default 工艺优化通道、chtpl-aml-training-default 训练通道等)。',
      inputSchema: obj(),
      run: rest('GET', '/api/workshop/channel-templates'),
    },
    {
      name: 'aw_channel_template_instantiate',
      description: '从模板实例化优化频道。{ id, name?, toolProfile?(\u0027aml_optimization\u0027等), controlPolicy?(\u0027recommendation_only\u0027|\u0027hitl_governed\u0027|\u0027bounded_auto\u0027), optimizationMode?(\u0027exploration\u0027|\u0027aml\u0027), boundModelId?, objective?, scene?, scenePackId?, providerId? } → { channelId, leadAgentId }。',
      inputSchema: obj({
        id: s('模板 id'),
        name: s('新频道名'),
        toolProfile: s('legacy | hybrid_twin | aml_training | aml_optimization'),
        controlPolicy: s('recommendation_only | hitl_governed | bounded_auto'),
        optimizationMode: s('exploration | aml'),
        boundModelId: s('绑定 AML 模型 id(可选)'),
        objective: s('优化目标对象', 'object'),
        scene: s('场景对象 {sceneId,sceneVersion,lineId,productId,recipeId}', 'object'),
      }, ['id']),
      run: rest('POST', args => `/api/workshop/channel-templates/${args.id}/instantiate`, { bodyOf: args => omit(args, 'id') }),
    },
    {
      name: 'aw_team_provision',
      description: '组装频道剧组(组合工具):建 lead+worker 两个 agent → 建 team → 加成员 → deploy 到频道 → 返回频道内实例 agent 列表(绑定节点工具用实例 id)。',
      inputSchema: obj({
        channelId: s('目标频道 id'),
        lead: s('lead 定义 {name, harness, config?}', 'object'),
        worker: s('worker 定义 {name, harness, config?}', 'object'),
        teamName: s('团队名(缺省自动)'),
      }, ['channelId', 'lead', 'worker']),
      run: async (args, state) => {
        const mkAgent = async (def, role) => {
          const r = await apiCall(state, 'POST', '/api/workshop/agents', { name: def.name, harness: def.harness ?? 'omp', config: def.config ?? {} })
          if (!r.ok) throw new Error(`创建 ${role} agent 失败: HTTP ${r.status} ${r.message}`)
          return r.data
        }
        try {
          const lead = await mkAgent(args.lead, 'lead')
          const worker = await mkAgent(args.worker, 'worker')
          const teamR = await apiCall(state, 'POST', '/api/workshop/teams', { name: args.teamName ?? `team-${Date.now()}` })
          if (!teamR.ok) throw new Error(`建 team 失败: HTTP ${teamR.status} ${teamR.message}`)
          const teamId = teamR.data?.id ?? teamR.data?.team?.id
          for (const [agentId, role] of [[lead.id, 'lead'], [worker.id, 'worker']]) {
            const m = await apiCall(state, 'POST', `/api/workshop/teams/${teamId}/members`, { agentId, role })
            if (!m.ok) throw new Error(`加成员 ${role} 失败: HTTP ${m.status} ${m.message}`)
          }
          const d = await apiCall(state, 'POST', `/api/workshop/teams/${teamId}/deploy`, { channelId: args.channelId })
          if (!d.ok) throw new Error(`deploy 失败: HTTP ${d.status} ${d.message}`)
          const inst = await apiCall(state, 'GET', `/api/workshop/channels/${args.channelId}/agents`, undefined)
          const instances = inst.data ?? []
          return ok({
            channelId: args.channelId,
            teamId,
            leadInstanceId: instances.find(a => a.role === 'lead')?.id ?? null,
            workerInstanceId: instances.find(a => a.role === 'worker')?.id ?? null,
            instances,
          })
        }
        catch (err) {
          return fail(err.message)
        }
      },
    },
    {
      name: 'aw_agent_tool_bind',
      description: '把节点授权给频道成员实例(Agent 工具鉴权基础)。{ agentId(实例 id,非模板 id), nodeId, kind: dcw|daq, mode: auto|manual }。',
      inputSchema: obj({ agentId: s('频道成员实例 id'), nodeId: s('节点 id'), kind: s('dcw | daq'), mode: s('auto | manual') }, ['agentId', 'nodeId', 'kind']),
      run: rest('POST', '/api/workshop/agent-tools/bindings'),
    },
    {
      name: 'aw_agent_tool_invoke',
      description: '以频道成员实例身份调用宿主工具(optimization_explore / mpc_optimize / twin_* / dcw_control / param_control / daq_query 等,面见 GET /api/workshop/agent-tools/list)。可能阻塞(HITL 审批)。',
      inputSchema: obj({ agentId: s('实例 id'), tool: s('工具名'), args: s('工具参数对象', 'object') }, ['agentId', 'tool']),
      timeoutMs: INVOKE_TIMEOUT_MS,
      run: async (args, state) => {
        const r = await apiCall(state, 'POST', '/api/workshop/agent-tools/invoke', { agentId: args.agentId, tool: args.tool, args: args.args ?? {} }, { timeoutMs: INVOKE_TIMEOUT_MS })
        if (!r.ok) return fail(`工具调用失败(${args.tool}) → HTTP ${r.status}: ${r.message}`)
        // 宿主工具的业务错误(HTTP 200 但 result.isError)必须透传为 MCP isError
        const result = r.data?.result
        if (result?.isError) return { content: [{ type: 'text', text: String(result.text ?? '') }], isError: true }
        return ok(r.data)
      },
    },
    {
      name: 'aw_twin_profile_get',
      description: '读频道孪生 profile(优化维度):toolProfile/optimizationMode(exploration|aml)/boundModelId/objective/controlPolicy;?agentId 附 promptPreview。',
      inputSchema: obj({ channelId: s('频道 id'), agentId: s('可选:附该成员的 prompt 预览') }, ['channelId']),
      run: async (args, state) => {
        const { channelId, agentId } = args
        const q = agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''
        const r = await apiCall(state, 'GET', `/api/workshop/channels/${channelId}/twin-profile${q}`, undefined)
        if (!r.ok) return fail(`HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },
    {
      name: 'aw_twin_profile_patch',
      description: '切换频道优化模式/绑定模型(闭环开关)。{ channelId, optimizationMode?, controlPolicy?, objective?, boundModelId? }。绑模型即自动 exploration→aml(fail-closed:谱系一致+门禁全过,否则 409);boundModelId=null 解绑自动回落 exploration。',
      inputSchema: obj({
        channelId: s('频道 id'),
        optimizationMode: s('exploration | aml'),
        controlPolicy: s('recommendation_only | hitl_governed | bounded_auto'),
        objective: s('优化目标对象', 'object'),
        boundModelId: s('绑定模型 id;null=解绑回落 exploration'),
      }, ['channelId']),
      run: rest('PATCH', args => `/api/workshop/channels/${args.channelId}/twin-profile`, { bodyOf: args => omit(args, 'channelId') }),
    },
    {
      name: 'aw_task_create',
      description: '向频道下达任务。{ channelId, title, parts: [{text}], mode: goal|..., modeConfig? } (goal 模式配 goalCriteria 验收判据)。',
      inputSchema: obj({
        channelId: s('频道 id'), title: s('任务标题'),
        parts: s('任务书分段 [{text}]', 'array'),
        mode: s('执行模式(如 goal)'),
        modeConfig: s('模式配置,如 {goalCriteria}', 'object'),
      }, ['channelId', 'title', 'parts']),
      run: async (args, state) => {
        const { channelId, ...body } = args
        const r = await apiCall(state, 'POST', `/api/workshop/channels/${channelId}/tasks`, body)
        if (!r.ok) return fail(`下达失败 → HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },
    {
      name: 'aw_task_list',
      description: '频道任务列表(轮询状态用)。{ channelId }。',
      inputSchema: obj({ channelId: s('频道 id') }, ['channelId']),
      run: async (args, state) => {
        const r = await apiCall(state, 'GET', `/api/workshop/channels/${args.channelId}/tasks`, undefined)
        if (!r.ok) return fail(`HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },
    {
      name: 'aw_model_list',
      description: 'AML 模型列表(含 stage: candidate|shadow|production|retired 与门禁摘要)。{ lineId?, stage? } 等 query 透传。',
      inputSchema: obj({ lineId: s('按产线过滤'), stage: s('按阶段过滤') }),
      run: async (args, state) => {
        const r = await apiCall(state, 'GET', `/api/workshop/aml/models${queryOf(args)}`, undefined)
        if (!r.ok) return fail(`HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },
    {
      name: 'aw_model_promote',
      description: '模型阶段晋升(candidate→shadow→production;production 前做 ONNX 深检)。{ id, toStage }。',
      inputSchema: obj({ id: s('模型 id'), toStage: s('目标阶段 shadow | production') }, ['id', 'toStage']),
      run: async (args, state) => {
        const r = await apiCall(state, 'POST', `/api/workshop/aml/models/${args.id}/promote`, { toStage: args.toStage })
        if (!r.ok) return fail(`晋升被拒 → HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },
    {
      name: 'aw_optimization_judge',
      description: '优化 step 落判定(判定与执行分离)。{ id, verdict: keep|rollback|uncertain, reason }。',
      inputSchema: obj({ id: s('优化记录 id'), verdict: s('keep | rollback | uncertain'), reason: s('判定理由') }, ['id', 'verdict', 'reason']),
      run: async (args, state) => {
        const { id, ...body } = args
        const r = await apiCall(state, 'POST', `/api/workshop/dcw/optimizations/${id}/judge`, body)
        if (!r.ok) return fail(`判定失败 → HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },

    // ── 插件 ──
    {
      name: 'aw_plugin_list',
      description: '插件管理清单(含启停状态/路由/装载失败 failures)。热重载验证入口。',
      inputSchema: obj(),
      run: rest('GET', '/api/workshop/plugins'),
    },
    {
      name: 'aw_plugin_toggle',
      description: '启用/停用插件(写 plugins-state.json,宿主 ~1s 热重载,无需重启)。{ name, enabled }。',
      inputSchema: obj({ name: s('插件名'), enabled: s('true=启用 false=停用', 'boolean') }, ['name', 'enabled']),
      run: async (args, state) => {
        const action = args.enabled ? 'enable' : 'disable'
        const r = await apiCall(state, 'POST', `/api/workshop/plugins/${encodeURIComponent(args.name)}/${action}`, {})
        if (!r.ok) return fail(`${action} 失败 → HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },

    // ── 逃生舱 ──
    {
      name: 'aw_request',
      description: '通用平台 REST 调用(逃生舱:覆盖工具面未覆盖的端点,如 aml/datasets、aml/jobs、optimizations 查询)。path 必须以 /api/ 开头。',
      inputSchema: obj({
        method: s('GET | POST | PATCH | PUT | DELETE'),
        path: s('路径,必须 /api/ 开头,可含 query'),
        body: s('请求体对象', 'object'),
        auth: s('是否携带鉴权(缺省 true)', 'boolean'),
      }, ['method', 'path']),
      run: async (args, state) => {
        const path = String(args.path ?? '')
        if (!path.startsWith('/api/')) return fail('path 必须以 /api/ 开头(本工具只访问平台 API,不代理任意外网)。')
        if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(String(args.method).toUpperCase())) return fail(`不支持的 method: ${args.method}`)
        const r = await apiCall(state, String(args.method).toUpperCase(), path, args.body, { auth: args.auth !== false })
        if (!r.ok) return fail(`${args.method} ${path} → HTTP ${r.status}: ${r.message}`)
        return ok(r.data)
      },
    },
  ]
  return defs
}

let _defs = null
/** 工具面(模块级缓存;测试可直接读) */
export function TOOL_DEFS() {
  if (!_defs) _defs = buildToolDefs()
  return _defs
}

// ── JSON-RPC(MCP stdio,逐行)──

/** 处理一条 JSON-RPC 消息;通知返回 null */
export async function handleMessage(state, msg) {
  const { id, method, params } = msg ?? {}
  const isRequest = id !== undefined && id !== null
  const respond = result => (isRequest ? { jsonrpc: '2.0', id, result } : null)
  const respondError = (code, message) => (isRequest ? { jsonrpc: '2.0', id, error: { code, message } } : null)

  try {
    switch (method) {
      case 'initialize':
        return respond({
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'aw-industrial-mcp', title: 'AgentWorkShop industrial MCP', version: '1.0.0' },
        })
      case 'notifications/initialized':
      case 'initialized':
        return null
      case 'ping':
        return respond({})
      case 'tools/list':
        return respond({
          tools: TOOL_DEFS().map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        })
      case 'tools/call': {
        const name = params?.name
        if (!name) return respondError(-32602, 'tools/call 缺少 name')
        // 开关门禁:停用时仅放行 aw_status(自诊断),其余工具一律拒绝
        if (name !== 'aw_status' && !isMcpEnabled(state)) {
          return respond({ content: [{ type: 'text', text: MCP_DISABLED_TEXT }], isError: true })
        }
        const def = TOOL_DEFS().find(t => t.name === name)
        if (!def) return respondError(-32602, `未知工具: ${name}`)
        try {
          const result = await def.run(params?.arguments ?? {}, state)
          return respond(result)
        }
        catch (err) {
          // 工具执行异常按 MCP 约定返回 isError 结果(不中断回合)
          return respond(fail(`工具执行异常(${name}): ${err?.message ?? err}`))
        }
      }
      default:
        return respondError(-32601, `方法不存在: ${method}`)
    }
  }
  catch (err) {
    return respondError(-32603, err?.message ?? String(err))
  }
}

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

/**
 * MCP 集成开关(系统设置 → MCP 集成 → 启动 MCP 集成;mcp.enabled,live 键)。
 * 3s TTL 缓存:设置页切换后 ≤3s 传导到本服务,无需重启。
 */
const MCP_DISABLED_TEXT = 'MCP 集成已停用:请到平台「系统设置 → MCP 集成」打开「启动 MCP 集成」,或为 MCP 进程设置环境变量 AW_MCP_ENABLED=true。'
export function isMcpEnabled(state) {
  const now = Date.now()
  if (!state._mcpEnabledCache || now - state._mcpEnabledCache.at > 3000) {
    state._mcpEnabledCache = { at: now, value: readMcpEnabled({ cwd: state.cwd, env: state.env }) }
  }
  return state._mcpEnabledCache.value
}

/** stdio 主循环(直接执行本文件时启动) */
export function runStdio() {
  const state = createState()
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try {
      msg = JSON.parse(trimmed)
    }
    catch {
      return // 非 JSON 行忽略(防御宿主 stderr 混流)
    }
    handleMessage(state, msg)
      .then((out) => {
        if (out) write(out)
      })
      .catch((err) => {
        write({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: err?.message ?? String(err) } })
      })
  })
  process.stdin.on('end', () => process.exit(0))
  process.stdout.on('error', () => process.exit(0))
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  runStdio()
}
