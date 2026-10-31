/**
 * 入口 —— 单进程:h3(API + HTTP 协议端点 + 静态前端) + WS(实时监视) + 五协议端点。
 * 端口:4010(env SIM_PORT);启动即恢复全部 enabled 设备。
 * Windows 注意:本机回环连接需 NO_PROXY=127.0.0.1,localhost(代理会劫持 fetch/net)。
 */
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createApp, createRouter, defineEventHandler, getRouterParam, toNodeListener, setResponseHeader,
} from 'h3'
import { WebSocketServer, type WebSocket } from 'ws'
import { loadConfig } from './store'
import { startAll, stopAll } from './runtime'
import { stopAllProtocols } from './protocols/registry'
import { createApi, bootNode } from './api'
import { addClient } from './bus'
import { serveById, writeHttpControl } from './protocols/http-endpoint'
import { startBroker } from './protocols/mqtt-broker'
import { startPlantModel, stopPlantModel } from './engine/plant-runtime'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.SIM_PORT ?? 4010)
const DIST = path.resolve(__dirname, '../../web/dist')

async function main(): Promise<void> {
  loadConfig()
  // 内置 mini MQTT broker(18830):MQTT 设备默认发布目标,不依赖外部基础设施
  try {
    await startBroker(Number(process.env.MQTT_BROKER_PORT ?? 18830))
  }
  catch (err) {
    console.error('[plc-node-simulator] 内置 broker 启动失败(可外连其他 broker):', (err as Error).message)
  }
  const app = createApp()
  const router = createApi()
  // h3 Router 运行时即 EventHandler(类型签名差异 cast)
  app.use('/api', router as never)

  // HTTP 协议端点:/sim-http/{deviceId}{path}(主项目 http 驱动拨入)。
  // GET = 采样(vector JSON / image PNG / 标量);POST = writable 控制端点。
  // 兜底 handler(注册序在 /api 之后),不依赖 h3 通配挂载语义。
  const HTTP_MIME: Record<string, string> = { json: 'application/json', text: 'text/plain', png: 'image/png' }
  app.use(defineEventHandler(async (event) => {
    const m = event.path.match(/^\/sim-http\/([^/?]+)(\/[^?]*)/)
    if (!m) return // 交还后续 handler(静态/404)
    const [, deviceId, p] = m
    let r
    if (event.node.req.method === 'POST') {
      const body = await new Promise<string>((resolve) => {
        const chunks: Buffer[] = []
        event.node.req.on('data', (c: Buffer) => chunks.push(c))
        event.node.req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      })
      r = writeHttpControl(deviceId!, p!, body)
    }
    else {
      r = serveById(deviceId!, p!)
    }
    setResponseHeader(event, 'content-type', HTTP_MIME[r.contentType]!)
    event.node.res.statusCode = r.status
    return r.body
  }))

  // 静态前端(web/dist 构建产物;开发期可无)
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  }
  if (fs.existsSync(DIST)) {
    app.use(defineEventHandler((event) => {
      const url = event.path === '/' ? '/index.html' : event.path
      // 防路径穿越:resolve 后必须仍位于 DIST 内(含分隔符边界),否则回落 SPA index
      const file = path.resolve(DIST, '.' + decodeURIComponent(url.split('?')[0] ?? '/index.html'))
      if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        const index = path.join(DIST, 'index.html')
        if (!fs.existsSync(index)) return
        setResponseHeader(event, 'content-type', MIME['.html']!)
        return fs.readFileSync(index)
      }
      const mime = MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream'
      setResponseHeader(event, 'content-type', mime)
      return fs.readFileSync(file)
    }))
  }

  const server = http.createServer(toNodeListener(app))

  // WS 实时监视
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, sock, head) => {
    if (req.url?.startsWith('/ws')) {
      wss.handleUpgrade(req, sock, head, (ws: WebSocket) => addClient(ws))
    }
    else sock.destroy()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // P12 experiments use a private local digital twin; never expose its API on LAN.
    server.listen(PORT, process.env.SIM_HOST ?? '127.0.0.1', () => resolve())
  })

  // 恢复全部 enabled 设备 + 工艺模型
  for (const node of loadConfig().nodes) {
    if (node.enabled) await bootNode(node)
  }
  startPlantModel()

  console.log(`[plc-node-simulator] 就绪 http://127.0.0.1:${PORT}(WS /ws;HTTP 端点 /sim-http/{deviceId}/**)`)

  const shutdown = async (): Promise<void> => {
    console.log('[plc-node-simulator] 退出中…')
    stopAll()
    stopPlantModel()
    await stopAllProtocols()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((err) => {
  console.error('[plc-node-simulator] 启动失败:', err)
  process.exit(1)
})
