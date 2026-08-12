// ============================================================
// 生产启动入口（配置驱动）
// 从根目录 config.yml 读取 server.prod.port / server.host，
// 注入为 Nitro node-server 识别的 PORT / HOST 环境变量后启动产物。
// ============================================================
import { readFileSync } from 'node:fs'
import YAML from 'js-yaml'

const raw = YAML.load(readFileSync(new URL('../config.yml', import.meta.url), 'utf8'))

const host = raw?.server?.host ?? '0.0.0.0'
const prodPort = raw?.server?.prod?.port ?? 3000

// 环境变量优先，其次 config.yml，最后兜底默认值
process.env.HOST = process.env.HOST || process.env.NITRO_HOST || host
process.env.PORT = process.env.PORT || process.env.NITRO_PORT || String(prodPort)
process.env.NITRO_HOST = process.env.HOST
process.env.NITRO_PORT = process.env.PORT

console.log(`[config.yml] 生产服务启动 -> http://${process.env.HOST}:${process.env.PORT}`)

await import('../.output/server/index.mjs')
