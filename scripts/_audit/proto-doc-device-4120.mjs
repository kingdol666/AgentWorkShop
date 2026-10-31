#!/usr/bin/env node
/**
 * 2026-10-31 文档驱动虚拟验证用设备端(HTTP)。
 * 端点:
 *   GET  /health   → {ok}
 *   GET  /pv       → {value, ts}        箱体温度 PV(24.5~25.5 正弦)
 *   GET  /sp       → {setpoint, ts}     当前设定值(供 DAQ 回读)
 *   POST /sp       → {setpoint}         写入设定值(供 DCW HTTP 驱动下发)
 *   GET  /profile  → {points[64], ts}   壁厚轮廓(2.5mm 附近)
 * 仅监听 127.0.0.1:4120;无认证(虚拟验证专用)。
 */
import http from 'node:http'

const PORT = Number(process.env.DOC_DEVICE_PORT ?? 4120)
const started = Date.now()
let setpoint = 25

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, ts: Date.now() })
  if (req.method === 'GET' && url.pathname === '/pv') {
    const t = (Date.now() - started) / 1000
    return send(res, 200, { value: Number((25 + Math.sin(t * 0.2) * 0.5).toFixed(3)), ts: Date.now() })
  }
  if (req.method === 'GET' && url.pathname === '/sp') return send(res, 200, { setpoint, ts: Date.now() })
  if (req.method === 'POST' && url.pathname === '/sp') {
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      const j = JSON.parse(raw || '{}')
      const v = Number(j.setpoint)
      if (Number.isFinite(v)) setpoint = v
    }
    catch { /* 非法 JSON:保持原值,仍返回当前值供排查 */ }
    return send(res, 200, { ok: true, setpoint, ts: Date.now() })
  }
  if (req.method === 'GET' && url.pathname === '/profile') {
    const t = (Date.now() - started) / 1000
    const points = Array.from({ length: 64 }, (_, i) =>
      Number((2.5 + Math.sin(i / 8 + t * 0.1) * 0.02 + Math.sin(i / 3) * 0.005).toFixed(4)))
    return send(res, 200, { points, ts: Date.now() })
  }
  return send(res, 404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[proto-doc-device] ready http://127.0.0.1:${PORT}`)
})
