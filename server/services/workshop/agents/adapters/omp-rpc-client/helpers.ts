/**
 * OmpRpcClient 的模块级纯工具/常量(原 server/services/workshop/agents/adapters/omp-rpc-client.ts 类外声明,含类体之后与类无关的部分)。
 */

export const STDERR_CAP = 1024 * 1024
export const STDOUT_LINE_CAP = 8 * 1024 * 1024
/** chunk 重组缓冲 TTL(残缺分片 30s 后清理,base64 大 payload 不永久驻留) */
export const CHUNK_TTL_MS = 30_000

/**
 * OmpRpcClient — omp RPC 子进程的完整客户端。
 *
 * 用法:
 *   const client = new OmpRpcClient({ command: 'omp' })
 *   await client.start()
 *   client.onEvent(event => ...)
 *   client.onHostToolCall(async req => { ... return { text } })
 *   await client.send({ type: 'set_host_tools', tools: [...] })
 *   const resp = await client.send({ type: 'prompt', message: '...' })
 *   await client.dispose()
 */

export interface RpcChunkFrame {
  type: 'rpc_chunk'
  chunkId: string
  index: number
  count: number
  byteLength: number
  data: string
}

export interface HostToolCallFrame {
  type: 'host_tool_call'
  id: string
  toolCallId: string
  toolName: string
  arguments: Record<string, unknown>
}
