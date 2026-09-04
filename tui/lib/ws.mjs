// ============================================================
// TUI WebSocket 客户端(原生 WebSocket,Node ≥22 全局可用)。
//  - connectAep  :/api/workshop/ws —— sub/unsub 多频道复用一条连接,
//                  lastSeq 断线续传 + 指数退避重连 + 15s 心跳
//                  (对齐 app/stores/workshop/connection.ts 语义)
//  - connectTerm :/api/system/monitor/terminal/ws?agentId= —— 单 agent
//                  终端镜像;NO_SESSION(lazy spawn 未启动)自动等待重试
// ============================================================

const httpToWs = base => String(base).replace(/^http/, 'ws').replace(/\/+$/, '')

/** AEP 事件流客户端 */
export function connectAep({ baseUrl, token, onEvent, onState }) {
  let ws = null
  let retry = 0
  let closedByUser = false
  const cursors = new Map()
  const subscribed = new Set()
  let heartbeat = null

  function connect() {
    const url = `${httpToWs(baseUrl)}/api/workshop/ws?token=${encodeURIComponent(token)}`
    onState?.('connecting', retry)
    ws = new WebSocket(url)
    ws.onopen = () => {
      retry = 0
      onState?.('open', 0)
      for (const id of subscribed) sendSub(id, cursors.get(id))
      heartbeat ??= setInterval(() => {
        try {
          ws?.send(JSON.stringify({ type: 'ping' }))
        }
        catch { /* 半开连接 → onclose 重连 */ }
      }, 15_000)
    }
    ws.onmessage = (ev) => {
      try {
        onEvent?.(JSON.parse(ev.data))
      }
      catch { /* 非 JSON 帧忽略 */ }
    }
    ws.onclose = () => {
      ws = null
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
      if (closedByUser) {
        onState?.('closed', 0)
        return
      }
      onState?.('closed', retry)
      const delay = Math.min(1000 * 2 ** retry, 10_000)
      retry += 1
      setTimeout(() => !closedByUser && connect(), delay)
    }
    ws.onerror = () => { /* onclose 兜底 */ }
  }

  function sendSub(channelId, lastSeq) {
    const frame = { type: 'sub', channelId, token }
    if (typeof lastSeq === 'number' && lastSeq > 0) frame.lastSeq = lastSeq
    ws?.send(JSON.stringify(frame))
  }

  return {
    subscribe(channelId, lastSeq) {
      subscribed.add(channelId)
      if (typeof lastSeq === 'number') cursors.set(channelId, lastSeq)
      if (ws?.readyState === WebSocket.OPEN) sendSub(channelId, cursors.get(channelId))
      else if (!ws) connect()
    },
    unsubscribe(channelId) {
      subscribed.delete(channelId)
      ws?.send(JSON.stringify({ type: 'unsub', channelId }))
    },
    /** 游标推进(onEvent 内按信封 seq 调用;重连续传依据) */
    cursor(channelId, seq) {
      if (Number.isFinite(seq) && seq > 0) cursors.set(channelId, seq)
    },
    close() {
      closedByUser = true
      if (heartbeat) clearInterval(heartbeat)
      ws?.close()
    },
  }
}

/** 终端镜像客户端(单 agent;返回句柄含 close/重试等待) */
export function connectTerm({ baseUrl, token, agentId, channelId, onMessage, onClose }) {
  let ws = null
  let closedByUser = false
  let retryTimer = null

  function connect() {
    const params = new URLSearchParams({ token, agentId })
    if (channelId) params.set('channelId', channelId)
    ws = new WebSocket(`${httpToWs(baseUrl)}/api/system/monitor/terminal/ws?${params}`)
    ws.onmessage = (ev) => {
      try {
        onMessage?.(JSON.parse(ev.data))
      }
      catch { /* 忽略坏帧 */ }
    }
    ws.onclose = (ev) => {
      ws = null
      if (closedByUser) return
      // NO_SESSION(4404):omp lazy spawn 未启动 —— 慢节奏重试,首个任务触发后自动接入
      const noSession = ev.code === 4404
      onClose?.(ev.code, ev.reason)
      retryTimer = setTimeout(connect, noSession ? 5000 : 2000)
    }
    ws.onerror = () => { /* onclose 兜底 */ }
  }

  connect()
  return {
    close() {
      closedByUser = true
      if (retryTimer) clearTimeout(retryTimer)
      ws?.close()
    },
  }
}
