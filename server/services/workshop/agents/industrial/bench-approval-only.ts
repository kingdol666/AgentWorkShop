import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

type TrialTarget = { id: string, driver: string, driverConfig: Record<string, unknown> }
type Qualification = {
  schema_version: number
  run_id: string
  aw_home: string
  aw_base: string
  sim_base: string
  simulator_root: string
  simulator_pid: number
  line_id: string
  recipe_id: string
  expires_at_utc: string
  nodes: Array<{ node_id: string, driver: string, driver_config_sha256: string, host?: string, port?: number }>
}

export type ApprovalOnlyTrialReceipt = { approval_bypassed: true, run_id: string }

function loopbackUrl(raw: string | undefined, label: string): URL {
  const url = new URL(raw ?? '')
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error(`${label} must be an explicit loopback service URL`)
  }
  return url
}

function targetEndpoint(node: TrialTarget): { host: string, port: number } | null {
  if (node.driver === 'mock') return null
  let host: string
  let port: number
  if (node.driver === 'opcua') {
    const endpoint = new URL(String(node.driverConfig.endpoint ?? ''))
    if (endpoint.protocol !== 'opc.tcp:' || endpoint.username || endpoint.password) throw new Error('unsupported OPC UA simulator endpoint')
    host = endpoint.hostname
    port = Number(endpoint.port)
  }
  else if (node.driver === 'modbus-tcp' || node.driver === 'modbus-rtu') {
    host = String(node.driverConfig.host ?? '')
    port = Number(node.driverConfig.port)
  }
  else throw new Error(`driver ${node.driver} is not permitted for approval-only trials`)
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('approval-only trials require loopback simulator driver endpoints')
  }
  return { host, port }
}

function assertListener(port: number, pid: number): void {
  const rows = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024 })
    .split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(parts => parts[0] === 'TCP' && parts[3]?.toUpperCase() === 'LISTENING' && parts[1]?.endsWith(`:${port}`))
  if (!rows.length || rows.some(parts => Number(parts[4]) !== pid || !['127.0.0.1', '[::1]'].includes(parts[1]!.slice(0, -(String(port).length + 1))))) {
    throw new Error(`simulator ownership or loopback binding is unverified for port ${port}`)
  }
}

/** This switch has no tool argument or UI setting. Its qualification file stays in
 * the disposable AW_HOME and must be renewed for each run before bypassing HITL. */
export function approvalOnlyTrialReceipt(input: {
  recipeId: string
  line: { id: string, simulated?: boolean } | undefined
  nodes: TrialTarget[]
}): ApprovalOnlyTrialReceipt | null {
  const requested = process.env.AW_BENCH_APPROVAL_ONLY
  if (requested == null || requested === '' || requested === '0') return null
  try {
    if (requested !== '1') throw new Error('AW_BENCH_APPROVAL_ONLY must be 1 or disabled')
    const runId = process.env.AW_AGENTTEAM_RUN_ID ?? ''
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(runId) || process.env.AW_BENCH_APPROVAL_ONLY_ACK !== runId) throw new Error('run confirmation mismatch')
    if (process.env.AW_MODE !== 'home' || (process.env.AW_BENCH_MODE && process.env.AW_BENCH_MODE !== '0')) throw new Error('home mode is required and AW_BENCH_MODE must be disabled')
    const rawHome = process.env.AW_HOME ?? ''
    if (!isAbsolute(rawHome)) throw new Error('an explicit isolated AW_HOME is required')
    const home = realpathSync(rawHome)
    if (basename(home) !== 'aw-home' || basename(dirname(home)) !== 'runtime' || !basename(dirname(dirname(home))).startsWith(runId)) {
      throw new Error('AW_HOME must be this run\'s runtime/aw-home directory')
    }
    const aw = loopbackUrl(process.env.AW_BASE, 'AW_BASE')
    const sim = loopbackUrl(process.env.SIM_BASE, 'SIM_BASE')
    if (Number(sim.port) === 4010 || Number(aw.port) === 3001) throw new Error('shared default service ports are forbidden')
    const qualificationPath = join(home, 'approval-only-qualification.json')
    if (!lstatSync(qualificationPath).isFile() || lstatSync(qualificationPath).isSymbolicLink()) throw new Error('qualification must be a regular run-private file')
    const q = JSON.parse(readFileSync(qualificationPath, 'utf8')) as Qualification
    const expiry = Date.parse(q.expires_at_utc)
    if (q.schema_version !== 1 || q.run_id !== runId || resolve(q.aw_home) !== home || q.aw_base !== aw.origin || q.sim_base !== sim.origin
      || !Number.isFinite(expiry) || expiry <= Date.now() || expiry - Date.now() > 3_600_000) throw new Error('qualification is mismatched or expired')
    if (!input.line?.simulated || q.line_id !== input.line.id || q.recipe_id !== input.recipeId || input.nodes.length !== 1 || !Array.isArray(q.nodes)) {
      throw new Error('the qualified simulated line, recipe and targets are required')
    }
    const endpoints = input.nodes.map((node) => {
      const allowed = q.nodes.filter(entry => entry.node_id === node.id)
      const hash = createHash('sha256').update(JSON.stringify(node.driverConfig)).digest('hex')
      if (allowed.length !== 1 || allowed[0]!.driver !== node.driver || allowed[0]!.driver_config_sha256 !== hash) throw new Error('target or driver configuration differs from qualification')
      const endpoint = targetEndpoint(node)
      if (endpoint && (allowed[0]!.host !== endpoint.host || allowed[0]!.port !== endpoint.port)) throw new Error('driver endpoint differs from qualification')
      return endpoint
    }).filter((endpoint): endpoint is { host: string, port: number } => endpoint !== null)
    if (endpoints.length) {
      if (process.platform !== 'win32') throw new Error('simulator PID verification is supported only on Windows')
      const simRoot = realpathSync(q.simulator_root)
      if (simRoot !== realpathSync(join(dirname(home), 'simulator')) || !Number.isInteger(q.simulator_pid) || q.simulator_pid <= 0) throw new Error('private simulator root/PID mismatch')
      const commandLine = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${q.simulator_pid}").CommandLine`], { encoding: 'utf8', timeout: 8000, maxBuffer: 64 * 1024 })
        .replaceAll('\\', '/').toLowerCase()
      if (!commandLine.includes(`${simRoot.replaceAll('\\', '/').toLowerCase()}/src/server/index.ts`)) throw new Error('simulator PID does not own this run\'s entry point')
      assertListener(Number(aw.port), process.pid)
      for (const port of new Set([Number(sim.port), ...endpoints.map(endpoint => endpoint.port)])) assertListener(port, q.simulator_pid)
    }
    return { approval_bypassed: true, run_id: runId }
  }
  catch (err) {
    throw new Error(`Approval-only trial refused: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
}
