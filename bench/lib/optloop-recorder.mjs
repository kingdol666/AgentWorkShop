/**
 * optloop-recorder.mjs —— 闭环寻优 Channel 录制器(每线一路)。
 *
 * 录四路,全部落 jsonl(逐行 JSON,事后可重放):
 *   timeline.jsonl   频道完整对话(轮询 /messages,增量去重)
 *   worker-stream.jsonl  omp worker 终端全帧流(/monitor/terminal/ws 按 pid 挂载)
 *   setpoints.jsonl  本线全部写控节点设定值曲线(轮询 /dcw,value/state)
 *   quality.jsonl    本线全部数采节点实测曲线(轮询 /daq,value/state,含质量 PV 与守卫)
 */
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function createOptRecorder({ BASE, token, channelId, lineId, traceDir, label }) {
  const H = { authorization: `Bearer ${token}` }
  mkdirSync(traceDir, { recursive: true })
  const files = {}
  for (const name of ['timeline.jsonl', 'worker-stream.jsonl', 'setpoints.jsonl', 'quality.jsonl']) {
    files[name] = join(traceDir, `${label}-${name}`)
    writeFileSync(files[name], '')
  }
  const w = (name, obj) => appendFileSync(files[name], JSON.stringify(obj) + '\n')

  let stopped = false
  let tapped = false
  let lastSeq = 0
  const seenMsg = new Set()
  const timers = []
  const state = { timelineRows: 0, wsFrames: 0, setpointSamples: 0, qualitySamples: 0, tappedPid: null }

  async function fetchJson(p) {
    try {
      const res = await fetch(BASE + p, { headers: H, signal: AbortSignal.timeout(20_000) })
      return await res.json()
    } catch { return null }
  }

  // ── 时间线 ──
  async function pollTimeline() {
    const j = await fetchJson(`/api/workshop/channels/${channelId}/messages?limit=30`)
    const arr = j?.data?.messages ?? j?.data ?? []
    for (const m of (Array.isArray(arr) ? arr : [])) {
      if (seenMsg.has(m.id)) continue
      seenMsg.add(m.id)
      state.timelineRows++
      w('timeline.jsonl', {
        at: m.createdAt, role: m.role,
        from: m.metadata?.['x-aw-from-label'] ?? m.metadata?.['x-aw-from-agent'] ?? 'system',
        to: m.metadata?.['x-aw-target-agent'] ?? 'channel',
        inReplyTo: m.metadata?.['x-aw-in-reply-to'] ?? null,
        text: (m.parts ?? []).map((p) => p.text ?? '').join('').slice(0, 2000),
      })
    }
  }

  // ── 设定值/质量曲线 ──
  async function pollCurves() {
    const now = new Date().toISOString()
    const d = await fetchJson('/api/workshop/dcw')
    for (const n of (d?.data?.nodes ?? [])) {
      if (n.lineId !== lineId) continue
      state.setpointSamples++
      w('setpoints.jsonl', { at: now, nodeId: n.id, name: n.name, value: n.value, unit: n.unit, state: n.state })
    }
    const q = await fetchJson('/api/workshop/daq')
    for (const n of (q?.data?.nodes ?? [])) {
      if (n.lineId !== lineId) continue
      state.qualitySamples++
      w('quality.jsonl', { at: now, nodeId: n.id, name: n.name, value: n.value, unit: n.unit, state: n.state })
    }
  }

  // ── worker 终端全帧 ──
  async function tryTap() {
    if (tapped || stopped) return
    const terms = await fetchJson(`/api/workshop/channels/${channelId}/terminals`)
    const arr = terms?.data ?? []
    const mine = (Array.isArray(arr) ? arr : []).find((t) => t.agentId && t.pid)
    if (!mine?.pid) return
    try {
      const res = await fetch(`${BASE}/api/workshop/channels/${channelId}/agents/${mine.agentId}`, { headers: H }).then((r) => r.json())
      if (res?.data?.enabled === 0) return
    } catch { }
    const ws = new globalThis.WebSocket(`${BASE.replace(/^http/, 'ws')}/api/system/monitor/terminal/ws?pid=${mine.pid}&token=${encodeURIComponent(token)}`)
    ws.addEventListener('open', () => { tapped = true; state.tappedPid = mine.pid })
    ws.addEventListener('message', (ev) => {
      state.wsFrames++
      appendFileSync(files['worker-stream.jsonl'], String(ev.data).slice(0, 4000) + '\n')
    })
    ws.addEventListener('error', () => { tapped = false })
  }

  return {
    state,
    files,
    /** 启动全部轮询 */
    start({ workerOnlyTap = true } = {}) {
      timers.push(setInterval(async () => { try { await pollTimeline() } catch { } }, 6000))
      timers.push(setInterval(async () => { try { await pollCurves() } catch { } }, 8000))
      timers.push(setInterval(() => { try { if (!workerOnlyTap || state.tappedPid === null) tryTap().catch(() => { }) } catch { } }, 8000))
    },
    stop() {
      stopped = true
      for (const t of timers) clearInterval(t)
    },
  }
}
