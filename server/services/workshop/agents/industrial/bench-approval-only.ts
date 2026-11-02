import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

type TrialTarget = { id: string, driver: string, driverConfig: Record<string, unknown> }
type TrialParam = { node_id: string, value: number }
type PilotArm = 'ON' | 'OFF'
type PilotCase = 'legal-approved' | 'legal-rejected' | 'out-of-range-approved'
type Qualification = {
  schema_version: 2
  run_id: string
  episode_id: string
  arm: 'OFF'
  case: PilotCase
  aw_home: string
  aw_base: string
  sim_base: string
  simulator_root: string
  simulator_pid: number
  line_id: string
  recipe_id: string
  actor_id: string
  hypothesis: string
  params: TrialParam[]
  configuration_sha256: string
  fixture_sha256: string
  manifest_sha256: string
  expires_at_utc: string
  nodes: Array<{ node_id: string, driver: string, driver_config_sha256: string, host?: string, port?: number }>
}

type Manifest = {
  schema_version: 'a1-approval-pilot-v1'
  run_id: string
  study_type: 'descriptive-pilot'
  configuration_sha256: string
  network_isolation: { mode: 'docker-network-none', loopback_only: true }
  episodes: Array<{
    episode_id: string
    case: PilotCase
    arm_order: PilotArm[]
    actor_id: string
    line_id: string
    recipe_id: string
    hypothesis: string
    params: TrialParam[]
    fixture_sha256: string
  }>
}

export type ApprovalOnlyTrialReceipt = {
  approval_bypassed: true
  run_id: string
  episode_id: string
  arm: 'OFF'
  case: PilotCase
  invocation_id: string
  configuration_sha256: string
  fixture_sha256: string
}

type TrialCheckInput = {
  stage: 'approval' | 'dispatch'
  invocationId: string
  actorId: string
  recipeId: string
  line: { id: string, simulated?: boolean } | undefined
  nodes: TrialTarget[]
  hypothesis: string
  params: TrialParam[]
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Digest of the exact actor, recipe, target driver configuration, candidate and rationale. */
export function approvalOnlyFixtureSha256(input: Omit<TrialCheckInput, 'stage' | 'invocationId'>): string {
  const projection = {
    schema_version: 1,
    actor_id: input.actorId,
    line_id: input.line?.id ?? '',
    recipe_id: input.recipeId,
    hypothesis: input.hypothesis,
    params: input.params.map(param => ({ node_id: param.node_id, value: Number(param.value) })).sort((a, b) => a.node_id.localeCompare(b.node_id)),
    nodes: input.nodes.map(node => ({
      node_id: node.id,
      driver: node.driver,
      driver_config_sha256: sha256(stableJson(node.driverConfig)),
    })).sort((a, b) => a.node_id.localeCompare(b.node_id)),
  }
  return sha256(stableJson(projection))
}

function loopbackUrl(raw: string | undefined, label: string): URL {
  const url = new URL(raw ?? '')
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error(`${label} must be an explicit loopback service URL`)
  }
  return url
}

function targetEndpoint(node: TrialTarget): { host: string, port: number } {
  let host: string
  let port: number
  if (node.driver === 'opcua') {
    const endpoint = new URL(String(node.driverConfig.endpoint ?? ''))
    if (endpoint.protocol !== 'opc.tcp:' || endpoint.username || endpoint.password) throw new Error('unsupported OPC UA simulator endpoint')
    host = endpoint.hostname
    port = Number(endpoint.port)
  }
  else if (node.driver === 'modbus-tcp') {
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
  if (process.platform === 'win32') {
    const rows = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024 })
      .split(/\r?\n/).map(line => line.trim().split(/\s+/))
      .filter(parts => parts[0] === 'TCP' && parts[3]?.toUpperCase() === 'LISTENING' && parts[1]?.endsWith(`:${port}`))
    if (!rows.length || rows.some(parts => Number(parts[4]) !== pid || !['127.0.0.1', '[::1]'].includes(parts[1]!.slice(0, -(String(port).length + 1))))) {
      throw new Error(`listener ownership or loopback binding is unverified for port ${port}`)
    }
    return
  }
  if (process.platform !== 'linux') throw new Error('listener ownership verification is supported only on Windows or Linux')
  const output = execFileSync('ss', ['-ltnpH'], { encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024 })
  const matching = output.split(/\r?\n/).filter(line => line.trim().split(/\s+/)[3]?.endsWith(`:${port}`))
  if (!matching.length || matching.some((line) => {
    const parts = line.trim().split(/\s+/)
    const local = parts[3]?.slice(0, -(String(port).length + 1))
    const owners = [...line.matchAll(/pid=(\d+)/g)].map(match => Number(match[1]))
    return !['127.0.0.1', '[::1]'].includes(local ?? '') || owners.length !== 1 || owners[0] !== pid
  })) {
    throw new Error(`listener ownership or loopback binding is unverified for port ${port}`)
  }
}

export function assertLoopbackOnlyNetworkNamespace(interfaces: ReturnType<typeof networkInterfaces>): void {
  if (process.platform !== 'linux') throw new Error('approval-only trials require a Linux network namespace with verified no-egress isolation')
  const names = Object.keys(interfaces)
  const loopbackAddresses = interfaces.lo ?? []
  if (names.length !== 1 || names[0] !== 'lo' || loopbackAddresses.length === 0
    || loopbackAddresses.some(address => !address?.internal || !['127.0.0.1', '::1'].includes(address.address))) {
    throw new Error('approval-only trials require a loopback-only network namespace')
  }
  const routes = readFileSync('/proc/net/route', 'utf8').trim().split(/\r?\n/).slice(1)
  if (routes.some((line) => {
    const parts = line.trim().split(/\s+/)
    return parts[1] === '00000000' && parts[0] !== 'lo'
  })) throw new Error('approval-only network namespace has an IPv4 default route via a non-loopback interface')
  const routes6 = readFileSync('/proc/net/ipv6_route', 'utf8').trim().split(/\r?\n/)
  if (routes6.some((line) => {
    const parts = line.trim().split(/\s+/)
    return /^0{32}$/.test(parts[1] ?? '') && parts[2] === '00' && parts[0] !== 'lo'
  })) {
    throw new Error('approval-only network namespace has an IPv6 default route via a non-loopback interface')
  }
}

function configurationSha256(configuration: Record<string, unknown>): string {
  const projection = { ...configuration }
  delete projection.configuration_sha256
  return sha256(stableJson(projection))
}

function readRegularJson(path: string, label: string): { value: Record<string, unknown>, bytes: Buffer } {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
  const bytes = readFileSync(path)
  return { value: JSON.parse(bytes.toString('utf8')) as Record<string, unknown>, bytes }
}

function readClaim(path: string): Record<string, unknown> {
  return readRegularJson(path, 'approval-only one-shot claim').value
}

function withClaimLock<T>(home: string, callback: () => T): T {
  const lockPath = join(home, 'approval-only-claim.lock')
  let fd: number
  try {
    fd = openSync(lockPath, 'wx', 0o600)
  }
  catch (err) {
    throw new Error(`approval-only qualification is busy or has a stale lock: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  try {
    writeFileSync(fd, `${process.pid}\n`, 'utf8')
    fsyncSync(fd)
    return callback()
  }
  finally {
    closeSync(fd)
    // A process crash may leave the exclusive lock behind; that intentionally fails closed.
    rmSync(lockPath, { force: true })
  }
}

function receiptOf(q: Qualification, invocationId: string): ApprovalOnlyTrialReceipt {
  return {
    approval_bypassed: true,
    run_id: q.run_id,
    episode_id: q.episode_id,
    arm: q.arm,
    case: q.case,
    invocation_id: invocationId,
    configuration_sha256: q.configuration_sha256,
    fixture_sha256: q.fixture_sha256,
  }
}

export function sameApprovalOnlyTrialReceipt(
  first: ApprovalOnlyTrialReceipt | null | undefined,
  second: ApprovalOnlyTrialReceipt | null | undefined,
): boolean {
  return Boolean(first && second
    && first.approval_bypassed === true && second.approval_bypassed === true
    && first.run_id === second.run_id
    && first.episode_id === second.episode_id
    && first.arm === 'OFF' && second.arm === 'OFF'
    && first.case === second.case
    && first.invocation_id === second.invocation_id
    && first.configuration_sha256 === second.configuration_sha256
    && first.fixture_sha256 === second.fixture_sha256)
}

function validate(input: TrialCheckInput): { q: Qualification, home: string, claimPath: string } {
  if (!input.invocationId || input.invocationId.length > 160) throw new Error('trusted invocation id is required')
  const runId = process.env.AW_AGENTTEAM_RUN_ID ?? ''
  const episodeId = process.env.AW_BENCH_APPROVAL_ONLY_EPISODE_ID ?? ''
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(runId) || process.env.AW_BENCH_APPROVAL_ONLY_ACK !== runId) throw new Error('run confirmation mismatch')
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(episodeId) || process.env.AW_BENCH_APPROVAL_ONLY_ARM !== 'OFF') throw new Error('episode or manifest arm confirmation mismatch')
  if (!/^[a-f0-9]{64}$/.test(process.env.AW_BENCH_APPROVAL_ONLY_MANIFEST_SHA256 ?? '')
    || !/^[a-f0-9]{64}$/.test(process.env.AW_BENCH_APPROVAL_ONLY_CONFIG_SHA256 ?? '')) throw new Error('manifest/configuration digest confirmation is invalid')
  if (process.env.AW_MODE !== 'home' || (process.env.AW_BENCH_MODE && process.env.AW_BENCH_MODE !== '0')) throw new Error('home mode is required and AW_BENCH_MODE must be disabled')

  const rawHome = process.env.AW_HOME ?? ''
  if (!isAbsolute(rawHome)) throw new Error('an explicit isolated AW_HOME is required')
  const home = realpathSync(rawHome)
  if (basename(home) !== 'aw-home' || basename(dirname(home)) !== 'OFF' || basename(dirname(dirname(home))) !== episodeId
    || basename(dirname(dirname(dirname(home)))) !== 'episodes'
    || basename(dirname(dirname(dirname(dirname(home))))) !== 'runtime'
    || basename(dirname(dirname(dirname(dirname(dirname(home)))))) !== `${runId}-approval-ablation`) {
    throw new Error('AW_HOME must be this run/episode OFF arm runtime directory')
  }
  if (resolve(rawHome) !== home) throw new Error('AW_HOME must not traverse a symlink')
  const runRoot = dirname(dirname(dirname(dirname(dirname(home)))))
  const expectedHome = join(runRoot, 'runtime', 'episodes', episodeId, 'OFF', 'aw-home')
  if (home !== realpathSync(expectedHome)) throw new Error('AW_HOME path does not match the qualified OFF episode')

  const aw = loopbackUrl(process.env.AW_BASE, 'AW_BASE')
  const sim = loopbackUrl(process.env.SIM_BASE, 'SIM_BASE')
  if (Number(sim.port) === 4010 || Number(aw.port) === 3001) throw new Error('shared default service ports are forbidden')

  const qualificationPath = join(home, 'approval-only-qualification.json')
  const { value: parsed } = readRegularJson(qualificationPath, 'approval-only qualification')
  const q = parsed as unknown as Qualification
  const expiry = Date.parse(q.expires_at_utc)
  if (q.schema_version !== 2 || q.run_id !== runId || q.episode_id !== episodeId || q.arm !== 'OFF'
    || resolve(q.aw_home) !== home || q.aw_base !== aw.origin || q.sim_base !== sim.origin
    || q.configuration_sha256 !== process.env.AW_BENCH_APPROVAL_ONLY_CONFIG_SHA256
    || q.manifest_sha256 !== process.env.AW_BENCH_APPROVAL_ONLY_MANIFEST_SHA256
    || !Number.isFinite(expiry) || expiry <= Date.now() || expiry - Date.now() > 10 * 60_000) {
    throw new Error('qualification is mismatched, expired, or not bound to this OFF episode')
  }
  if (!input.line?.simulated || q.line_id !== input.line.id || q.recipe_id !== input.recipeId || q.actor_id !== input.actorId
    || q.hypothesis !== input.hypothesis || input.nodes.length !== 1 || input.params.length !== 1 || !Array.isArray(q.nodes)) {
    throw new Error('the qualified simulated line, actor, recipe, candidate, and single target are required')
  }
  const sameParams = q.params.length === input.params.length && q.params.every((param, index) =>
    param.node_id === input.params[index]?.node_id && Number(param.value) === Number(input.params[index]?.value))
  if (!sameParams) throw new Error('candidate values differ from the qualified episode')

  const endpoints = input.nodes.map((node) => {
    const allowed = q.nodes.filter(entry => entry.node_id === node.id)
    const hash = sha256(stableJson(node.driverConfig))
    if (allowed.length !== 1 || allowed[0]!.driver !== node.driver || allowed[0]!.driver_config_sha256 !== hash) throw new Error('target or driver configuration differs from qualification')
    const endpoint = targetEndpoint(node)
    if (allowed[0]!.host !== endpoint.host || allowed[0]!.port !== endpoint.port) throw new Error('driver endpoint differs from qualification')
    return endpoint
  })
  const fixtureSha = approvalOnlyFixtureSha256(input)
  if (q.fixture_sha256 !== fixtureSha) throw new Error('actor/recipe/node/value/schema fixture digest mismatch')

  const { value: manifest, bytes: manifestBytes } = readRegularJson(join(runRoot, 'manifest.json'), 'A1 pilot manifest')
  const { value: configuration } = readRegularJson(join(runRoot, 'configuration.json'), 'A1 pilot configuration')
  if (sha256(manifestBytes) !== q.manifest_sha256 || configurationSha256(configuration) !== q.configuration_sha256
    || manifest.schema_version !== 'a1-approval-pilot-v1' || manifest.run_id !== runId
    || manifest.study_type !== 'descriptive-pilot' || manifest.configuration_sha256 !== q.configuration_sha256
    || stableJson(manifest.network_isolation) !== stableJson({ mode: 'docker-network-none', loopback_only: true })
    || configuration.run_id !== runId || configuration.configuration_sha256 !== q.configuration_sha256) {
    throw new Error('run manifest/configuration changed after episode qualification')
  }
  const registered = (manifest.episodes as Manifest['episodes'] | undefined)?.filter(row => row.episode_id === episodeId) ?? []
  if (registered.length !== 1) throw new Error('episode id is absent or duplicated in the frozen manifest')
  const row = registered[0]!
  if (row.case !== q.case || row.arm_order.length !== 2 || [...row.arm_order].sort().join(',') !== 'OFF,ON'
    || row.actor_id !== q.actor_id || row.line_id !== q.line_id
    || row.recipe_id !== q.recipe_id || row.hypothesis !== q.hypothesis || row.fixture_sha256 !== q.fixture_sha256
    || stableJson(row.params) !== stableJson(q.params)) throw new Error('episode qualification differs from its preregistered manifest row')

  assertLoopbackOnlyNetworkNamespace(networkInterfaces())
  const simRoot = realpathSync(q.simulator_root)
  if (simRoot !== realpathSync(join(runRoot, 'runtime', 'episodes', episodeId, 'OFF', 'simulator')) || !Number.isInteger(q.simulator_pid) || q.simulator_pid <= 0) {
    throw new Error('private simulator root/PID mismatch')
  }
  const commandLine = readFileSync(`/proc/${q.simulator_pid}/cmdline`, 'utf8').replaceAll('\0', ' ').replaceAll('\\', '/').toLowerCase()
  if (!process.kill(q.simulator_pid, 0)) throw new Error('simulator PID is not alive')
  if (!commandLine.includes(`${simRoot.replaceAll('\\', '/').toLowerCase()}/src/server/index.ts`)) throw new Error('simulator PID does not own this run\'s entry point')
  assertListener(Number(aw.port), process.pid)
  for (const port of new Set([Number(sim.port), ...endpoints.map(endpoint => endpoint.port)])) assertListener(port, q.simulator_pid)
  return { q, home, claimPath: join(home, 'approval-only-claim.json') }
}

/** Validate the fixed OFF episode at approval time, then require atomic one-shot dispatch consumption. */
export function approvalOnlyTrialReceipt(input: TrialCheckInput): ApprovalOnlyTrialReceipt | null {
  const requested = process.env.AW_BENCH_APPROVAL_ONLY
  if (requested == null || requested === '' || requested === '0') return null
  try {
    if (requested !== '1') throw new Error('AW_BENCH_APPROVAL_ONLY must be 1 or disabled')
    const { q, home, claimPath } = validate(input)
    return withClaimLock(home, () => {
      if (input.stage === 'approval') {
        const claim = {
          schema_version: 1,
          state: 'claimed',
          run_id: q.run_id,
          episode_id: q.episode_id,
          invocation_id: input.invocationId,
          arm: q.arm,
          case: q.case,
          configuration_sha256: q.configuration_sha256,
          fixture_sha256: q.fixture_sha256,
          claimed_at_utc: new Date().toISOString(),
        }
        const fd = openSync(claimPath, 'wx', 0o600)
        try {
          writeFileSync(fd, `${JSON.stringify(claim, null, 2)}\n`, 'utf8')
          fsyncSync(fd)
        }
        finally { closeSync(fd) }
      }
      else {
        const existing = readClaim(claimPath)
        if (existing.state !== 'claimed' || existing.run_id !== q.run_id || existing.episode_id !== q.episode_id
          || existing.arm !== 'OFF' || existing.invocation_id !== input.invocationId
          || existing.fixture_sha256 !== q.fixture_sha256 || existing.configuration_sha256 !== q.configuration_sha256) {
          throw new Error('dispatch does not match the claimed one-shot episode/invocation')
        }
        const consumedPath = join(home, 'approval-only-consumed.json')
        const consumed = {
          schema_version: 1,
          state: 'consumed-before-dispatch',
          run_id: q.run_id,
          episode_id: q.episode_id,
          invocation_id: input.invocationId,
          arm: q.arm,
          case: q.case,
          configuration_sha256: q.configuration_sha256,
          fixture_sha256: q.fixture_sha256,
          consumed_at_utc: new Date().toISOString(),
        }
        const fd = openSync(consumedPath, 'wx', 0o600)
        try {
          writeFileSync(fd, `${JSON.stringify(consumed, null, 2)}\n`, 'utf8')
          fsyncSync(fd)
        }
        finally { closeSync(fd) }
      }
      return receiptOf(q, input.invocationId)
    })
  }
  catch (err) {
    throw new Error(`Approval-only trial refused: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
}
