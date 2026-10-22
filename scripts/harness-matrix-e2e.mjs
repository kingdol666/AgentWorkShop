#!/usr/bin/env node
/**
 * harness-matrix-e2e.mjs —— 14 引擎原生工具注入/任务派发矩阵。
 *
 * 每个 harness 独立建 Channel(lead=该引擎),派发一个只有通过平台注入的
 * host tools 才能完成的任务:
 *   1) report_progress(progress=50, note=harness id)
 *   2) complete_task(summary/deliverable 含 HARNESS-OK:<harness>)
 * 判定:
 *   - COMPLETED 且 deliverable 含 marker → PASS(证明工具注入 + HTTP 回程 +
 *     manager.invokeHostTool + workspace 完成链路真实生效);
 *   - FAILED/CANCELED/超时 → FAIL,并抓取 channel 事件/消息里的最后错误(人话)。
 *
 * 用法:
 *   AW_E2E_TOKEN=<admin token> node scripts/harness-matrix-e2e.mjs \
 *     [--base http://127.0.0.1:3001] [--harnesses omp,codex,...] \
 *     [--timeout 180000] [--concurrency 4] [--out evidence.json]
 *
 * 注意:token 只从环境变量读取;本脚本不写任何凭据。
 */
const args = process.argv.slice(2)
const argOf = (k, d = '') => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}
const BASE = argOf('--base', process.env.AW_BASE ?? 'http://127.0.0.1:3001')
const TOKEN = process.env.AW_E2E_TOKEN ?? process.env.AW_TOKEN ?? ''
const TIMEOUT = Number(argOf('--timeout', '180000'))
const CONCURRENCY = Math.max(1, Number(argOf('--concurrency', '4')))
const OUT = argOf('--out', '')
const ALL = ['mock', 'omp', 'opencode', 'codex', 'dsh', 'claude', 'gemini', 'copilot', 'cursor', 'crush', 'goose', 'qwen', 'pi', 'hermes']
const HARNESSES = (argOf('--harnesses', '') || ALL.join(',')).split(',').map(s => s.trim()).filter(Boolean)
/** 本机已验证可用的 provider/model(与 scripts/_dbg-multiharness-live-e2e.mjs 同源);
 *  `--configs '<json>'` 可按 harness 覆盖。空 config 的引擎走各自 CLI 本地鉴权。 */
const DEFAULT_CONFIGS = {
  // omp / codex / claude / copilot 的 CLI 本地配置已验证可用,空 config 即走各自默认。
  opencode: { model: 'zhipuai-coding-plan/glm-5.3-flash' },
  dsh: { provider: 'ustc', model: 'glm-5.3-flash' },
  hermes: { provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free' },
}
const CONFIG_OVERRIDES = JSON.parse(argOf('--configs', '{}'))
const TAG = Date.now().toString(36)
const sleep = ms => new Promise(r => setTimeout(r, ms))

if (!TOKEN) {
  console.error('缺少 AW_E2E_TOKEN / AW_TOKEN(只从环境变量读取)')
  process.exit(1)
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

const textOfArtifacts = task => (task?.artifacts ?? [])
  .flatMap(a => a.parts ?? [])
  .map(p => String(p.text ?? ''))
  .join('\n')

async function failureDetail(channelId) {
  const [msgs, evs] = await Promise.all([
    api('GET', `/api/workshop/channels/${channelId}/messages?limit=80`).catch(() => null),
    api('GET', `/api/workshop/channels/${channelId}/events?limit=120`).catch(() => null),
  ])
  const lines = []
  for (const m of msgs?.data?.items ?? msgs?.data ?? []) {
    const text = String(m.text ?? m.content ?? m.summary ?? '').trim()
    if (text) lines.push(text)
  }
  for (const e of evs?.data?.items ?? evs?.data ?? []) {
    const text = String(e.message ?? e.error ?? e.payload?.message ?? e.payload?.error ?? '').trim()
    if (text) lines.push(text)
  }
  return lines.filter(Boolean).slice(-6).join(' | ').slice(0, 700)
}

async function runHarness(h) {
  const t0 = Date.now()
  const name = `hm-${h}-${TAG}`
  const rec = { harness: h, channelId: null, agentId: null, taskId: null, state: '', progress: null, deliverable: '', detail: '', pass: false, elapsedMs: 0 }
  try {
    const config = { ...(DEFAULT_CONFIGS[h] ?? {}), ...(CONFIG_OVERRIDES[h] ?? {}) }
    const ch = await api('POST', '/api/workshop/channels', {
      name,
      description: `harness-matrix-e2e ${h}`,
      leadAgent: { name: `hm-${h}`, harness: h, ...(Object.keys(config).length > 0 ? { config } : {}) },
    })
    rec.channelId = ch.data?.channelId ?? null
    rec.agentId = ch.data?.leadAgentId ?? null
    if (!rec.channelId) {
      rec.detail = `建 Channel 失败: ${ch.message ?? ch.code ?? ch.status}`
      return rec
    }
    const task = await api('POST', `/api/workshop/channels/${rec.channelId}/tasks`, {
      title: `hm-${h}-${TAG}`,
      description: `You must use the platform tools. First call report_progress with progress=50 and note="${h}". `
        + `Then call complete_task with summary="HARNESS-OK:${h}" and deliverable="HARNESS-OK:${h}". `
        + 'Do not ask the human anything; complete the task yourself.',
    })
    rec.taskId = task.data?.id ?? null
    if (!rec.taskId) {
      rec.detail = `派发任务失败: ${task.message ?? task.code ?? task.status}`
      return rec
    }
    const deadline = t0 + TIMEOUT
    while (Date.now() < deadline) {
      await sleep(3000)
      const st = await api('GET', `/api/workshop/tasks/${rec.taskId}`)
      rec.state = st.data?.state ?? rec.state
      rec.progress = st.data?.progress ?? rec.progress
      if (['COMPLETED', 'FAILED', 'CANCELED'].includes(rec.state)) break
    }
    if (rec.state === 'COMPLETED') {
      const st = await api('GET', `/api/workshop/tasks/${rec.taskId}`)
      rec.deliverable = textOfArtifacts(st.data)
      rec.pass = rec.deliverable.includes(`HARNESS-OK:${h}`)
      if (!rec.pass) rec.detail = `任务完成但交付物缺少 marker: ${rec.deliverable.slice(0, 160)}`
    }
    else {
      rec.detail = rec.state ? `任务终态 ${rec.state}` : '超时未到达终态'
      const extra = await failureDetail(rec.channelId)
      if (extra) rec.detail += ` | ${extra}`
    }
  }
  catch (err) {
    rec.detail = `异常: ${err instanceof Error ? err.message : String(err)}`
  }
  finally {
    rec.elapsedMs = Date.now() - t0
  }
  return rec
}

const results = []
let cursor = 0
async function worker() {
  while (cursor < HARNESSES.length) {
    const h = HARNESSES[cursor++]
    const r = await runHarness(h)
    results.push(r)
    console.log(`${r.pass ? 'PASS' : 'FAIL'} | ${h.padEnd(9)} | ${r.state || 'NO_STATE'} | ${(r.elapsedMs / 1000).toFixed(1)}s | ${r.deliverable.slice(0, 60) || r.detail.slice(0, 160)}`)
  }
}
console.log(`━━━ harness matrix @ ${BASE} (${HARNESSES.length} engines, concurrency=${CONCURRENCY}) ━━━`)
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, HARNESSES.length) }, worker))
results.sort((a, b) => ALL.indexOf(a.harness) - ALL.indexOf(b.harness))
const pass = results.filter(r => r.pass).length
console.log(`\n=== harness matrix: ${pass} PASS / ${results.length - pass} FAIL ===`)
if (OUT) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), base: BASE, timeoutMs: TIMEOUT, results }, null, 2))
  console.log(`evidence: ${OUT}`)
}
process.exit(pass === results.length ? 0 : 1)
