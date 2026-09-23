/**
 * OpenCodeAgentImpl 的模块级纯工具/常量(原 server/services/workshop/agents/opencode-agent.ts 类外声明,含类体之后与类无关的部分)。
 */
import { createLogger } from '../../logger'
import { createServer } from 'node:net'

export const log = createLogger('workshop.opencode')

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export const DEFAULT_PERMISSION = [
  { permission: 'edit', pattern: '*', action: 'ask' },
  { permission: 'bash', pattern: '*', action: 'ask' },
  { permission: 'webfetch', pattern: '*', action: 'ask' },
]

/** 取一个空闲 TCP 端口(绑定即弃,竞态窗口小;opencode serve 自身再绑定) */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('无可用端口'))))
    })
  })
}
