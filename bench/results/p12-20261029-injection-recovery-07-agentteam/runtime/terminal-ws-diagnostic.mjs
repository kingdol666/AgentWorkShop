const pids = JSON.parse(process.env.P12_DIAGNOSTIC_PIDS)
const token = process.env.P12_DIAGNOSTIC_TOKEN
async function read(pid) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:3119/api/system/monitor/terminal/ws?pid=${pid}&token=${encodeURIComponent(token)}`)
    const out = { pid, init: null, typeCounts: {}, responses: [], errors: [], hostToolCalls: [], uiRequestCount: 0 }
    const timer = setTimeout(() => finish(), 3500)
    const finish = () => { clearTimeout(timer); try { ws.close() } catch {}; resolve(out) }
    ws.onmessage = event => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.type === 'term.init') out.init = { meta: msg.meta, alive: msg.alive, running: msg.running, streaming: msg.streaming, lastSeq: msg.lastSeq }
      if (msg.type === 'term.frames') for (const item of msg.frames) {
        const f = item.frame ?? {}
        out.typeCounts[f.type] = (out.typeCounts[f.type] ?? 0) + 1
        if (f.type === 'response') out.responses.push({ seq: item.seq, command: f.command, success: f.success, error: f.error })
        if (f.type === 'prompt_result' || f.type === '__error__' || f.type === 'error') out.errors.push({ seq: item.seq, type: f.type, error: f.error ?? f.message ?? f })
        if (f.type === 'host_tool_call' || f.type === 'tool_execution_start') out.hostToolCalls.push({ seq: item.seq, type: f.type, toolName: f.toolName, isError: f.isError })
        if (f.type === 'extension_ui_request') out.uiRequestCount++
      }
      if (msg.type === 'term.error') { out.error = { code: msg.code, message: msg.message }; finish() }
      if (msg.type === 'term.frames') finish()
    }
    ws.onerror = () => { out.error ??= { message: 'websocket error' }; finish() }
  })
}
const result = await Promise.all(pids.map(read))
console.log(JSON.stringify(result))