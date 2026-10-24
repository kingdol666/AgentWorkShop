#!/usr/bin/env node
/**
 * aw-mcp-bridge.mjs —— AgentWorkShop 全量 host tools 的 stdio MCP 桥。
 *
 * 被 codex(config.toml [mcp_servers.aw])/ dsh(profile MCP 配置)/ opencode
 * (POST /mcp 运行时注册)作为本地 MCP server 拉起,把平台的 host tool 面
 * (host-tools.json + 插件工具,与 omp set_host_tools 同源)以 MCP 工具注入引擎;
 * 工具调用经 HTTP 回程落到 /api/workshop/agent-tools/*(agent token 鉴权)→
 * manager.invokeHostTool → impl.dispatchHostTool(共享 host-tool-bridge)。
 *
 * 环境变量(由各 harness impl 装配时注入):
 *   AW_BASE_URL      平台地址(如 http://127.0.0.1:3000)
 *   AW_AGENT_ID      agent 实例 id(channel_agents.id)
 *   AW_AGENT_TOKEN   agent token(channel_agents.token;鉴权事实源)
 *   AW_MCP_TOOL_TIMEOUT_MS  工具调用 HTTP 超时(默认 200000;poll_messages 可阻塞 180s)
 *
 * 协议:MCP stdio(JSON-RPC 2.0,逐行)。实现刻意零依赖 —— 本脚本由外部引擎
 * 子进程拉起,不得假设仓库 node_modules 的解析路径。
 */
import { createInterface } from 'node:readline'
import { toolSignature as bridgeSignature } from './aw-mcp-signature.mjs'

const BASE_URL = (process.env.AW_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
const AGENT_ID = process.env.AW_AGENT_ID ?? ''
const AGENT_TOKEN = process.env.AW_AGENT_TOKEN ?? ''
const TOOL_TIMEOUT_MS = Number(process.env.AW_MCP_TOOL_TIMEOUT_MS ?? 200_000)
const LIST_TTL_MS = 10_000

if (!AGENT_ID || !AGENT_TOKEN) {
  process.stderr.write('[aw-mcp-bridge] 缺少 AW_AGENT_ID / AW_AGENT_TOKEN 环境变量\n')
  process.exit(1)
}

/** 工具面缓存(短 TTL:插件热注册 10s 内传导;失败时沿用旧表) */
let toolCache = { at: 0, tools: [] }
let clientReady = false
let lastToolSignature = ''
/** WP6:最近一次成功响应的 ETag(带 If-None-Match 轮询,无变更时服务端回 304 空体) */
let lastEtag = ''
/** 合法空表也必须落地(C14):首轮成功拉取后置 true,空表不再被旧表掩盖 */
let baselineReady = false

/** 签名覆盖完整定义(name/label/description/parameters + per-agent 描述),schema-only 变更也触发刷新 */
function toolSignature(tools) {
  return bridgeSignature(tools)
}

async function fetchTools(force = false) {
  if (!force && baselineReady && Date.now() - toolCache.at < LIST_TTL_MS) return toolCache.tools
  const headers = { 'x-aw-agent-token': AGENT_TOKEN }
  if (lastEtag) headers['if-none-match'] = lastEtag
  const res = await fetch(`${BASE_URL}/api/workshop/agent-tools/list?agentId=${encodeURIComponent(AGENT_ID)}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  })
  // 304:工具面未变化,沿用缓存(仍需刷新 at,避免每轮都打网络)
  if (res.status === 304) {
    toolCache = { at: Date.now(), tools: toolCache.tools }
    return toolCache.tools
  }
  if (!res.ok) throw new Error(`tools/list HTTP ${res.status}`)
  const etag = res.headers.get('etag') ?? ''
  if (etag) lastEtag = etag
  const body = await res.json()
  const tools = body?.data?.tools ?? []
  // 区分 HTTP 失败与合法空数组:合法空数组必须覆盖缓存(否则解绑后旧工具永远残留)
  if (Array.isArray(tools)) {
    toolCache = { at: Date.now(), tools }
    baselineReady = true
  }
  return toolCache.tools
}

// MCP 工具面变更通知:每 10s 拉一次真实清单,名称/描述变化即通知客户端重新 list。
// 引擎是否响应由客户端决定;执行面的 Channel 闸门不依赖该通知。
const listChangedTimer = setInterval(async () => {
  if (!clientReady) return
  try {
    const tools = await fetchTools(true)
    const sig = toolSignature(tools)
    // baselineReady 之后任何变化(含变空)都通知;首轮只建立基线
    if (lastToolSignature && sig !== lastToolSignature) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`)
    }
    lastToolSignature = sig
  }
  catch { /* 网络抖动:保留旧表,下一轮再试 */ }
}, 10_000)
listChangedTimer.unref?.()

async function callTool(name, args) {
  const res = await fetch(`${BASE_URL}/api/workshop/agent-tools/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aw-agent-token': AGENT_TOKEN },
    body: JSON.stringify({ agentId: AGENT_ID, tool: name, args: args ?? {} }),
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = body?.message ?? body?.statusMessage ?? `HTTP ${res.status}`
    return { content: [{ type: 'text', text: `工具调用失败(${name}): ${detail}` }], isError: true }
  }
  const result = body?.data?.result ?? { text: '(空结果)' }
  return {
    content: [{ type: 'text', text: String(result.text ?? '') }],
    ...(result.isError ? { isError: true } : {}),
  }
}

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function respond(id, result) {
  write({ jsonrpc: '2.0', id, result })
}

function respondError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } })
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  }
  catch {
    return // 非 JSON 行忽略(MCP stdio 不应有;防御引擎 stderr 混流)
  }
  const { id, method, params } = msg
  const isRequest = id !== undefined && id !== null
  try {
    switch (method) {
      case 'initialize':
        respond(id, {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'aw-host-tools', title: 'AgentWorkShop host tools', version: '1.0.0' },
        })
        clientReady = true
        void fetchTools()
          .then((tools) => {
            lastToolSignature = toolSignature(tools)
          })
          .catch(() => { /* 初始化快照失败:下一轮轮询重试 */ })
        break
      case 'notifications/initialized':
      case 'initialized':
        clientReady = true
        break // 通知,无响应
      case 'ping':
        if (isRequest) respond(id, {})
        break
      case 'tools/list':
        fetchTools()
          .then((tools) => {
            respond(id, {
              tools: tools.map(t => ({
                name: t.name,
                description: t.description,
                inputSchema: t.parameters ?? { type: 'object', properties: {} },
              })),
            })
          })
          .catch((err) => {
            respondError(id, -32603, `tools/list 失败: ${err?.message ?? err}`)
          })
        break
      case 'tools/call': {
        const name = params?.name
        if (!name) {
          if (isRequest) respondError(id, -32602, 'tools/call 缺少 name')
          break
        }
        callTool(name, params?.arguments ?? {})
          .then((r) => {
            if (isRequest) respond(id, r)
          })
          .catch((err) => {
            // 工具执行 HTTP 异常:按 MCP 约定返回 isError 结果而非协议错误(不中断回合)
            if (isRequest) {
              respond(id, { content: [{ type: 'text', text: `工具调用异常(${name}): ${err?.message ?? err}` }], isError: true })
            }
          })
        break
      }
      default:
        if (isRequest) respondError(id, -32601, `方法不存在: ${method}`)
    }
  }
  catch (err) {
    if (isRequest) respondError(id, -32603, err?.message ?? String(err))
  }
})

// stdin EOF → 优雅退出(宿主引擎关闭 MCP 连接)
process.stdin.on('end', () => process.exit(0))
// stdout 断裂(引擎被杀)→ 退出,防僵尸
process.stdout.on('error', () => process.exit(0))
