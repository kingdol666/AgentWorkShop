import { existsSync, realpathSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
async function stopOwnedSimulator(pid, root) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('simulator cleanup requires a known PID')
  const commandPath = `/proc/${pid}/cmdline`
  const verifyOwner = () => {
    const command = readFileSync(commandPath, 'utf8').replaceAll('\0', ' ').replaceAll('\\', '/')
    if (!command.toLowerCase().includes(root.replaceAll('\\', '/').toLowerCase()) || !command.toLowerCase().includes('/src/server/index.ts')) {
      throw new Error('refusing to stop a simulator PID without its private root and source entry')
    }
  }
  try { verifyOwner() }
  catch (error) { if (error?.code === 'ENOENT') return; throw error }
  try { process.kill(pid, 'SIGTERM') }
  catch (error) { if (error?.code === 'ESRCH') return; throw error }
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    try { process.kill(pid, 0) }
    catch { return }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  verifyOwner()
  process.kill(pid, 'SIGKILL')
  const killUntil = Date.now() + 3000
  while (Date.now() < killUntil) {
    try { process.kill(pid, 0) }
    catch { return }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`simulator PID ${pid} could not be stopped`)
}

async function main() {
  const command = args[0]
  if (command !== 'start') throw new Error('Usage: approval-ablation-simulator.mjs start --sim-base URL --sim-root DIR --scene-id ID --episode-id ID --arm ON|OFF|preflight')
  const base = flag('sim-base') ?? ''
  const root = resolve(flag('sim-root') ?? '')
  const sceneId = flag('scene-id') ?? 'injection'
  const episodeId = flag('episode-id') ?? ''
  const arm = flag('arm') ?? ''
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(episodeId) || !['ON', 'OFF', 'preflight'].includes(arm)) throw new Error('a run-qualified episode and arm are required')
  const port = Number(new URL(base).port)
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(base) || port === 4010 || port < 1024 || port > 65535) {
    throw new Error('SIM_BASE must be an explicit non-default loopback service URL')
  }
  const runId = process.env.AW_AGENTTEAM_RUN_ID ?? ''
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(runId)) throw new Error('a run-qualified simulator identity is required')
  const runRoot = resolve(process.env.A1_RUN_ROOT ?? join(repo, 'bench', 'results', `${runId}-approval-ablation`))
  const expectedRoot = resolve(runRoot, 'runtime', 'episodes', episodeId, arm, 'simulator')
  if (root !== expectedRoot) throw new Error('simulator root must exactly match the run/episode/arm-private runtime directory')
  const simulatorSource = resolve(flag('sim-dir') ?? join(repo, 'plc-node-simulator'))
  if (!existsSync(join(simulatorSource, 'src', 'server', 'index.ts')) || !existsSync(join(simulatorSource, 'node_modules', 'tsx', 'package.json'))) {
    throw new Error('simulator source or its local tsx dependency is missing')
  }
  process.env.SIM_BASE = base
  process.env.SIM_PORT = String(port)
  process.env.SIM_SHADOW_DIR = root
  process.env.SIM_DIR = simulatorSource
  process.env.NO_PROXY = '127.0.0.1,localhost,[::1]'
  process.env.no_proxy = process.env.NO_PROXY
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[key]

  const { ensureSimulator } = await import('../lib/sim.mjs')
  const { ensureScenarioLine, SCENARIOS } = await import('../lib/scenarios.mjs')
  if (!SCENARIOS[sceneId]) throw new Error(`unsupported simulator scenario ${sceneId}`)
  const started = await ensureSimulator({ log: message => process.stderr.write(`${message}\n`) })
  if (!started.started || resolve(started.dir) !== root) {
    if (Number.isSafeInteger(started.pid)) await stopOwnedSimulator(started.pid, root)
    throw new Error(`private simulator start failed: ${started.reason ?? 'unexpected root'}`)
  }
  try {
    const scene = await ensureScenarioLine(SCENARIOS[sceneId])
    if (!scene?.verified?.devices || scene.verified.devices !== scene.blueprint.nodes.length) throw new Error('private simulator scenario did not qualify')
    const configPath = join(root, 'data', 'config.json')
    let dataConfigSha256 = ''
    if (existsSync(configPath)) {
      const { createHash } = await import('node:crypto')
      dataConfigSha256 = createHash('sha256').update(readFileSync(configPath)).digest('hex')
    }
    process.stdout.write(`${JSON.stringify({
      simulator_pid: started.pid,
      simulator_root: realpathSync(root),
      sim_base: base,
      scene_id: sceneId,
      episode_id: episodeId,
      arm,
      verified: scene.verified,
      scene_blueprint_sha256: (await import('node:crypto')).createHash('sha256').update(JSON.stringify(scene.blueprint)).digest('hex'),
      data_config_sha256: dataConfigSha256,
    })}\n`)
  }
  catch (error) {
    try { await stopOwnedSimulator(started.pid, root) }
    catch (cleanupError) { throw new Error(`${error instanceof Error ? error.message : String(error)}; simulator cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, { cause: cleanupError }) }
    throw error
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
