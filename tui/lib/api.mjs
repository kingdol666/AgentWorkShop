// ============================================================
// TUI REST 客户端 —— 统一信封 { code, message, data } 解包 + Bearer 注入。
// 与 sdk/api.mjs 同语义(轻量自包含:TUI 不依赖构建产物,保持 .mjs 直跑)。
// ============================================================

/**
 * 创建 API 客户端
 * @param {object} opts
 * @param {string} opts.baseUrl   形如 http://127.0.0.1:3000
 * @param {string} opts.token     用户 token(ut-*)
 */
export function createApi({ baseUrl, token, timeoutMs = 15_000 }) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '')
  // 动态 token:登录/运行中换凭据即时生效(避免实例化时闭包捕获 undefined)
  let currentToken = token ?? ''

  async function request(path, { method = 'GET', body, query } = {}) {
    const url = new URL(base + path)
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers: {
          ...(currentToken ? { authorization: `Bearer ${currentToken}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
      const json = await res.json().catch(() => null)
      if (!json || json.code === undefined) {
        throw new Error(`HTTP ${res.status}(响应非标准信封)`)
      }
      if (json.code !== 0) {
        const err = new Error(json.message ?? String(json.code))
        err.code = json.code
        throw err
      }
      return json.data
    }
    finally {
      clearTimeout(timer)
    }
  }

  return {
    request,
    /** 运行中更新凭据(登录后/换号) */
    setToken(t) {
      currentToken = t ?? ''
    },

    // ── 登录(无 token 引导;成功自动记住 token) ──
    async login(email, password) {
      const res = await request('/api/users/login', { method: 'POST', body: { email, password } })
      currentToken = res.token
      return res
    },
    get: (path, query) => request(path, { query }),
    post: (path, body) => request(path, { method: 'POST', body }),

    // ── channel/agent/task 管理面 ──
    listChannels: () => request('/api/workshop/channels'),
    createChannel: body => request('/api/workshop/channels', { method: 'POST', body }),
    listAgents: channelId => request(`/api/workshop/channels/${channelId}/agents`),
    addAgent: (channelId, body) => request(`/api/workshop/channels/${channelId}/agents`, { method: 'POST', body }),
    listTemplates: () => request('/api/workshop/agents'),
    listMessages: (channelId, limit = 50) => request(`/api/workshop/channels/${channelId}/messages`, { query: { limit } }),
    sendMessage: (channelId, body) => request(`/api/workshop/channels/${channelId}/messages`, { method: 'POST', body }),
    listTasks: channelId => request(`/api/workshop/channels/${channelId}/tasks`),
    submitTask: (channelId, body) => request(`/api/workshop/channels/${channelId}/tasks`, { method: 'POST', body }),

    // ── HITL 统一面(pending 响应为 { items: [...] },此处解包为数组) ──
    hitlPending: async (channelId) => {
      const data = await request('/api/workshop/hitl/pending', { query: channelId ? { channelId } : {} })
      return data?.items ?? []
    },
    hitlRespond: body => request('/api/workshop/hitl/respond', { method: 'POST', body }),
  }
}
