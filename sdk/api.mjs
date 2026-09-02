// ============================================================
// AgentWorkShop SDK — 平台 REST 客户端
// ------------------------------------------------------------
// SDK 作为项目服务的 client:对平台 REST 面(/api/**)的类型化轻封装。
// 三个使用形态:
//   1) 插件内:   ctx.api.lines.list()          —— 宿主注入(自环 origin)
//   2) 外部脚本: createPlatformClient({ baseUrl, token }).daq.nodes()
//   3) 浏览器:   createPlatformClient({ baseUrl: '' })  同源相对路径
// 资源方法返回原始 JSON body(data 字段已解包);4xx/5xx 抛错(含 status)。
// ============================================================

export function createPlatformClient({ baseUrl = '', token, logger, timeoutMs = 10000 } = {}) {
  // baseUrl 支持函数(延迟解析):插件宿主的监听端口在 nitro listen 钩子后才确定
  const resolveBase = () => String(typeof baseUrl === 'function' ? baseUrl() : (baseUrl ?? '')).replace(/\/+$/, '')
  let authToken = token ?? null

  async function call(method, path, body, opt = {}) {
    const base = resolveBase()
    const headers = { accept: 'application/json', ...(opt.headers ?? {}) }
    if (authToken) headers.authorization = `Bearer ${authToken}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(opt.timeoutMs ?? timeoutMs),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      const err = new Error(json?.message ?? `HTTP ${res.status} ${path}`)
      err.status = res.status
      err.body = json
      if (logger) logger.warn(`API ${method} ${path} → ${res.status}`)
      throw err
    }
    // 平台统一信封 { code, message, data } → 解包 data;非信封原样返回
    return json && typeof json === 'object' && 'data' in json ? json.data : json
  }

  const resource = root => ({
    list: (query = {}) => call('GET', `${root}${toQuery(query)}`),
    get: id => call('GET', `${root}/${id}`),
    create: body => call('POST', root, body),
    update: (id, patch) => call('PATCH', `${root}/${id}`, patch),
    remove: id => call('DELETE', `${root}/${id}`),
  })

  const client = {
    /** 底层调用(任意平台路径;自动带 token 与信封解包) */
    call,
    get: (path, query = {}) => call('GET', `${path}${toQuery(query)}`),
    post: (path, body) => call('POST', path, body),
    patch: (path, body) => call('PATCH', path, body),
    delete: path => call('DELETE', path),
    setToken: (t) => {
      authToken = t ?? null
      return client
    },
    /** 平台健康(免鉴权) */
    ping: () => call('GET', '/api/plugins/manifest'),

    // ---- 业务资源面 ----
    users: {
      ...resource('/api/users'),
      login: (email, password) => call('POST', '/api/users/login', { email, password }),
      me: () => call('GET', '/api/users/me'),
    },
    lines: {
      ...resource('/api/workshop/dcw/lines'),
      start: (id, recipeId = '') => call('POST', `/api/workshop/dcw/lines/${id}/start`, { recipeId }),
      stop: id => call('POST', `/api/workshop/dcw/lines/${id}/stop`),
    },
    products: resource('/api/workshop/dcw/products'),
    recipes: resource('/api/workshop/dcw/recipes'),
    dcwNodes: resource('/api/workshop/dcw'),
    daqNodes: {
      ...resource('/api/workshop/daq'),
      alarms: () => call('GET', '/api/workshop/daq/alarms'),
    },
    templates: {
      daq: () => call('GET', '/api/workshop/daq').then(d => d?.templates ?? []),
      dcw: () => call('GET', '/api/workshop/dcw').then(d => d?.templates ?? []),
    },
    twins: resource('/api/workshop/device-twins'),
    teams: resource('/api/workshop/teams'),
    agents: resource('/api/workshop/agents'),
    channels: resource('/api/workshop/channels'),
    plugins: {
      manifest: () => call('GET', '/api/plugins/manifest'),
    },
  }
  return client
}

function toQuery(query) {
  const entries = Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (!entries.length) return ''
  return `?${new URLSearchParams(Object.fromEntries(entries.map(([k, v]) => [k, String(v)]))).toString()}`
}

export default createPlatformClient
