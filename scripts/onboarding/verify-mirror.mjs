#!/usr/bin/env node
/**
 * scripts/onboarding/verify-mirror.mjs —— 镜像采集/导出正确性验收(只读)。
 *
 * 在模拟端点跑通后,用它回答“数据真的按文档值落库了吗?”:
 *   scalar: 窗口内有样本,且至少一个桶的 avg/min/max 命中期望值(容差内)
 *   vector: 窗口内有帧,点数/指标/首末点符合期望
 *   image : 窗口内有帧,objectKey/mime/宽高存在,内容端点返回非空字节
 *
 * 用法:
 *   node scripts/onboarding/verify-mirror.mjs --node dn-xxx --kind scalar \
 *     --expect '{"value":25.3,"tolerance":0.2}' [--window-ms 120000] [--json]
 *
 * 鉴权:--token / AW_TOKEN;缺省用 AW_EMAIL/AW_PASS 登录(默认 admin@awshop.local/admin123)。
 * 只读:不写库、不改节点、不触发采集控制。
 */
const args = process.argv.slice(2)
const flag = n => args.includes(`--${n}`)
const valueOf = (n) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}
const BASE = (valueOf('base') ?? process.env.AW_BASE ?? 'http://127.0.0.1:3001').replace(/\/+$/, '')
const NODE = valueOf('node') ?? ''
const KIND = (valueOf('kind') ?? 'scalar').toLowerCase()
const WINDOW_MS = Math.max(5000, Number(valueOf('window-ms') ?? 120000))
const MIN_SAMPLES = Math.max(1, Number(valueOf('min-samples') ?? 1))
const EXPECT = JSON.parse(valueOf('expect') ?? '{}')
const JSON_OUT = flag('json')

if (!NODE) {
  console.error('用法: node scripts/onboarding/verify-mirror.mjs --node <id> [--kind scalar|vector|image] [--expect <json>]')
  process.exit(2)
}
if (!['scalar', 'vector', 'image'].includes(KIND)) {
  console.error(`--kind 必须是 scalar|vector|image(收到 ${KIND})`)
  process.exit(2)
}

let token = valueOf('token') ?? process.env.AW_TOKEN ?? ''
const results = []
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: Boolean(cond), detail: String(detail).slice(0, 600) })
  if (!JSON_OUT) console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  return Boolean(cond)
}

async function api(method, path, body) {
  const headers = { accept: 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json?.message ?? ''}`)
  if (json && typeof json === 'object' && 'code' in json && json.code !== 0) {
    throw new Error(`${method} ${path} → code ${json.code} ${json.message ?? ''}`)
  }
  return json?.data ?? json
}

async function login() {
  if (token) return
  const email = process.env.AW_EMAIL ?? 'admin@awshop.local'
  const password = process.env.AW_PASS ?? 'admin123'
  const d = await api('POST', '/api/users/login', { email, password })
  token = d?.token ?? ''
  if (!token) throw new Error('登录失败:未拿到 token(可用 AW_TOKEN 覆盖)')
}

const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol

try {
  await login()
  const to = Date.now()
  const from = to - WINDOW_MS

  if (KIND === 'scalar') {
    const d = await api('GET', `/api/workshop/daq/${encodeURIComponent(NODE)}/samples?from=${from}&to=${to}&bucketMs=1000&limit=1000`)
    const points = d?.points ?? []
    const total = points.reduce((s, p) => s + (Number(p.cnt) || 0), 0)
    ok('scalar:窗口内有样本', total >= MIN_SAMPLES, `buckets=${points.length} samples=${total} window=${Math.round(WINDOW_MS / 1000)}s`)
    if (EXPECT.value !== undefined) {
      const tol = Number(EXPECT.tolerance ?? 0)
      const hit = points.some(p => near(Number(p.avg), Number(EXPECT.value), tol) || near(Number(p.min), Number(EXPECT.value), tol) || near(Number(p.max), Number(EXPECT.value), tol))
      ok('scalar:期望值命中', hit, `expect=${EXPECT.value}±${tol} observed=${points.slice(-4).map(p => p.avg).join(',')}`)
    }
    ok('scalar:时间戳单调', points.every((p, i) => i === 0 || Number(p.at) >= Number(points[i - 1].at)), `last=${points.at(-1)?.at ?? '-'}`)
  }
  else if (KIND === 'vector') {
    const d = await api('GET', `/api/workshop/daq/${encodeURIComponent(NODE)}/frames?from=${from}&to=${to}&kind=vector&limit=200`)
    const frames = d?.frames ?? []
    ok('vector:窗口内有帧', frames.length >= MIN_SAMPLES, `frames=${frames.length}`)
    const f = frames.at(-1)
    if (f) {
      if (EXPECT.points !== undefined) ok('vector:点数符合期望', (f.points?.length ?? 0) === Number(EXPECT.points), `expect=${EXPECT.points} actual=${f.points?.length}`)
      if (EXPECT.metrics && typeof EXPECT.metrics === 'object') {
        for (const [k, v] of Object.entries(EXPECT.metrics)) {
          ok(`vector:指标 ${k}`, near(Number(f.metrics?.[k]), Number(v), Number(EXPECT.tolerance ?? 0)), `expect=${v} actual=${f.metrics?.[k]}`)
        }
      }
      if (EXPECT.first !== undefined) ok('vector:首点符合期望', near(Number(f.points?.[0]), Number(EXPECT.first), Number(EXPECT.tolerance ?? 0)), `expect=${EXPECT.first} actual=${f.points?.[0]}`)
      if (EXPECT.last !== undefined) ok('vector:末点符合期望', near(Number(f.points?.at(-1)), Number(EXPECT.last), Number(EXPECT.tolerance ?? 0)), `expect=${EXPECT.last} actual=${f.points?.at(-1)}`)
    }
  }
  else {
    const d = await api('GET', `/api/workshop/daq/${encodeURIComponent(NODE)}/frames?from=${from}&to=${to}&kind=image&limit=20`)
    const frames = d?.frames ?? []
    ok('image:窗口内有帧', frames.length >= MIN_SAMPLES, `frames=${frames.length}`)
    const f = frames.at(-1)
    if (f) {
      ok('image:对象键存在', Boolean(f.meta?.objectKey), `objectKey=${f.meta?.objectKey ?? '-'}`)
      const mime = String(f.meta?.mime ?? '').toLowerCase()
      const raster = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif', 'image/tiff'])
      ok('image:MIME 为受支持的栅格类型', raster.has(mime), `mime=${mime}`)
      if (EXPECT.width) ok('image:宽度符合期望', Number(f.meta?.width) === Number(EXPECT.width), `expect=${EXPECT.width} actual=${f.meta?.width}`)
      if (EXPECT.height) ok('image:高度符合期望', Number(f.meta?.height) === Number(EXPECT.height), `expect=${EXPECT.height} actual=${f.meta?.height}`)
      if (f.contentUrl) {
        const res = await fetch(BASE + f.contentUrl, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(15000) })
        const buf = Buffer.from(await res.arrayBuffer())
        ok('image:内容端点返回非空字节', res.ok && buf.length > 0, `status=${res.status} bytes=${buf.length} type=${res.headers.get('content-type')}`)
      }
    }
  }
}
catch (err) {
  ok('请求/断言执行', false, err instanceof Error ? err.message : String(err))
}

const pass = results.filter(r => r.pass).length
const verdict = pass === results.length ? 'PASS' : 'FAIL'
if (JSON_OUT) {
  console.log(JSON.stringify({ suite: 'verify-mirror', node: NODE, kind: KIND, base: BASE, checks: results, verdict: `${verdict}(${pass}/${results.length})`, at: new Date().toISOString() }, null, 2))
}
else {
  console.log(`\n=== verify-mirror: ${pass}/${results.length} ${verdict} ===`)
}
process.exitCode = verdict === 'PASS' ? 0 : 1
// 不立即 process.exit:Windows 上 undici socket 关闭中强退会触发 libuv 断言
// (async.c UV_HANDLE_CLOSING)。设置 exitCode 后让事件循环自然退出。
