const pids = JSON.parse(process.env.P12_DIAGNOSTIC_PIDS)
const base = process.env.P12_DIAGNOSTIC_BASE
const token = process.env.P12_DIAGNOSTIC_TOKEN
async function read(pid) {
  return new Promise(resolve => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/system/monitor/terminal/ws?pid=${pid}&token=${encodeURIComponent(token)}`)
    const out = { pid, init: null, typeCounts: {}, responses: [], errors: [], hostToolCalls: [] }
    const finish = () => { clearTimeout(timer); try { ws.close() } catch {}; resolve(out) }
    const timer = setTimeout(finish, 5000)
    ws.onmessage = event => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.type === 'term.init') out.init = { meta: msg.meta, alive: msg.alive, running: msg.running, streaming: msg.streaming, lastSeq: msg.lastSeq }
      if (msg.type === 'term.frames') for (const item of msg.frames) {
        const f = item.frame ?? {}
        out.typeCounts[f.type] = (out.typeCounts[f.type] ?? 0) + 1
        if (f.type === 'response') out.responses.push({ seq: item.seq, command: f.command, success: f.success })
        if (f.type === 'prompt_result' || f.type === '__error__' || f.type === 'error') {
          const e = f.error ?? f.message ?? null
          const raw = typeof e === 'string' ? e : JSON.stringify(e ?? {})
          const match = raw.match(/n_keep.{0,100}/i) ?? raw.match(/n_ctx.{0,100}/i)
          out.errors.push({ seq: item.seq, error_type: typeof e, error_keys: e && typeof e === 'object' ? Object.keys(e) : [], summary: match ? match[0] : 'provider/terminal error; details omitted' })
        }
        if (f.type === 'host_tool_call' || f.type === 'tool_execution_start') out.hostToolCalls.push({ seq: item.seq, type: f.type, toolName: f.toolName, isError: f.isError })
      }
      if (msg.type === 'term.error') { out.terminalError = msg.code ?? 'websocket error'; finish() }
      if (msg.type === 'term.frames') finish()
    }
    ws.onerror = () => { out.terminalError ??= 'websocket error'; finish() }
  })
}
const results = await Promise.all(pids.map(read))
console.log(JSON.stringify(results))
