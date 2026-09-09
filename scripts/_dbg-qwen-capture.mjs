/**
 * qwen 请求捕获探针:本地 HTTP 服务器记录 qwen 发出的 OpenAI 请求(路径+body.model)。
 * 运行:node scripts/_dbg-qwen-capture.mjs
 */
import { createServer } from 'node:http'

const hits = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    let model = ''
    try { model = JSON.parse(body).model ?? '' } catch { /* 忽略 */ }
    hits.push({ path: req.url, model, auth: req.headers.authorization?.slice(0, 20) })
    console.log(`[hit] ${req.method} ${req.url} model=${model} auth=${req.headers.authorization?.slice(0, 24)}`)
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'capture-ok', code: '400' } }))
  })
})
server.listen(45678, '127.0.0.1', () => console.log('capture server on 45678'))
setTimeout(() => { console.log('hits:', JSON.stringify(hits)); process.exit(0) }, 45000)
