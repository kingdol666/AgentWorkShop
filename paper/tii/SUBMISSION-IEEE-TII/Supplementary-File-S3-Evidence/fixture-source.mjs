#!/usr/bin/env node
/**
 * Deterministic OMP-RPC transport fixture for the registered `omp` adapter.
 *
 * This is deliberately not an LLM, planner, or harness decision. It emits the
 * single recipe_trial call supplied by the isolated E2E driver, then records
 * the shared-dispatch result returned by AgentWorkShop over OMP-RPC stdio.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const args = process.argv.slice(2)
const valueFor = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const scene = valueFor('--scene')
const recipeId = valueFor('--recipe-id')
const nodeId = valueFor('--node-id')
const value = Number(valueFor('--value'))
const traceRootArg = valueFor('--trace-root')
const tracePathArg = valueFor('--trace-path')
const traceRoot = traceRootArg ? resolve(traceRootArg) : ''
const tracePath = tracePathArg ? resolve(tracePathArg) : ''
const relativeTracePath = traceRoot && tracePath ? relative(traceRoot, tracePath) : ''
const expectedTracePath = traceRoot && ['cast-film', 'annealing'].includes(scene)
  ? resolve(traceRoot, `fixture-${scene}.json`)
  : ''

if (!['cast-film', 'annealing'].includes(scene)
  || !recipeId
  || !nodeId
  || !Number.isFinite(value)
  || !traceRoot
  || !tracePath
  || isAbsolute(relativeTracePath)
  || relativeTracePath === '..'
  || relativeTracePath.startsWith(`..${sep}`)
  || tracePath !== expectedTracePath) {
  process.stderr.write('fixture arguments incomplete\n')
  process.exit(64)
}

const trace = {
  fixture: 'deterministic-local-omp-rpc-transport',
  decisionSource: 'predeclared-test-vector; not an LLM or harness decision',
  scene,
  hostToolCalls: [],
  hostToolResults: [],
}
mkdirSync(dirname(resolve(tracePath)), { recursive: true })
writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8')

let input = ''
let promptCount = 0
let callCount = 0
let awaitingToolResult = null

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function persist() {
  writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8')
}

function response(frame, data = {}) {
  send({ type: 'response', id: frame.id, command: frame.type, success: true, data })
}

function onFrame(frame) {
  if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return

  if (frame.type === 'host_tool_result') {
    if (awaitingToolResult && frame.id === awaitingToolResult.id) {
      trace.hostToolResults.push({
        id: frame.id,
        result: frame.result ?? null,
        receivedAt: new Date().toISOString(),
      })
      awaitingToolResult = null
      persist()
      send({ type: 'agent_end', isTerminal: true, messages: [] })
    }
    return
  }

  if (frame.type === 'prompt') {
    promptCount += 1
    if (promptCount !== 1 || callCount !== 0) {
      trace.protocolError = 'expected exactly one prompt and one host_tool_call per scene'
      persist()
      send({ type: 'agent_end', isTerminal: true, messages: [] })
      return
    }

    callCount += 1
    const id = `paper-${scene}-${Date.now().toString(36)}`
    const toolCallId = `${id}-tc`
    const toolCall = {
      type: 'host_tool_call',
      id,
      toolCallId,
      toolName: 'recipe_trial',
      arguments: {
        recipe_id: recipeId,
        params: [{ node_id: nodeId, value }],
        hypothesis: `Deterministic simulator integration check for ${scene}; apply one bounded candidate and verify the device ACK/readback.`,
      },
    }
    trace.hostToolCalls.push({
      id,
      toolCallId,
      toolName: toolCall.toolName,
      arguments: toolCall.arguments,
      emittedAt: new Date().toISOString(),
    })
    awaitingToolResult = { id }
    persist()
    send(toolCall)
    return
  }

  if (frame.type === 'set_host_tools' || frame.type === 'set_auto_compaction' || frame.type === 'get_state') {
    response(frame, frame.type === 'get_state'
      ? { sessionId: `paper-fixture-${scene}`, model: { contextWindow: 8192 } }
      : {})
    return
  }

  if (typeof frame.id === 'string' && frame.type !== 'host_tool_cancel') {
    response(frame, {})
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  const lines = input.split('\n')
  input = lines.pop() ?? ''
  for (const line of lines) {
    const text = line.trim()
    if (!text) continue
    try {
      onFrame(JSON.parse(text))
    }
    catch (error) {
      trace.protocolError = error instanceof Error ? error.message : String(error)
      persist()
    }
  }
})
process.stdin.on('end', () => {
  trace.stdinClosedAt = new Date().toISOString()
  persist()
})
process.on('uncaughtException', (error) => {
  trace.protocolError = error instanceof Error ? error.message : String(error)
  persist()
  process.exitCode = 70
})

send({ type: 'ready' })
