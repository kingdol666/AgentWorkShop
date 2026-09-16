/**
 * Purpose-built ENGLISH-locale fixture for the IEEE TII Figure 2 walkthrough.
 *
 * The shared production instance is full of Chinese-named test data; we must NOT
 * rename or delete anything. Instead this script creates a small additive fixture
 * with English entity names via the platform's own REST API, so the four
 * walkthrough screenshots contain English strings only:
 *
 *   - line      "Cast-film line A"
 *   - DAQ nodes  mock + a real Modbus-TCP node on the PLC simulator, one line
 *   - device     "Die-head heater" twin, bound by a DCW node with a 150-200 C window
 *   - agents     English lead + workers on the `omp` harness
 *   - team       "Cast-film control team" (lead + 2 workers)
 *
 * Idempotent: re-running reuses rows with the same names. Prints a JSON summary.
 *
 * Usage: NO_PROXY='127.0.0.1,localhost' node scripts/seed-walkthrough-fixture.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3005'

const login = async (e, p) =>
  (await (await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: p }) })).json()).data.token

const T = await login('admin@awshop.local', 'admin123')

const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${T}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || j.code !== 0) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
  return j.data
}
const get = p => api('GET', p)
const post = (p, b) => api('POST', p, b)

// ── 1. production line ────────────────────────────────────────────────────
const LINE_NAME = 'Cast-film line A'
const lines = (await get('/api/workshop/dcw/lines')).lines
let line = lines.find(l => l.name === LINE_NAME)
if (!line) line = (await post('/api/workshop/dcw/lines', { name: LINE_NAME, color: '#f4c542' })).line
console.log(`line    : ${line.id}  ${line.name}`)

// ── 2. DAQ nodes on that line (mock + real Modbus-TCP share one loop) ─────
const daq = await get('/api/workshop/daq')
const haveNode = n => daq.nodes.find(x => x.name === n)
const mkNode = async (spec) => {
  const existing = haveNode(spec.name)
  if (existing) return existing
  return (await post('/api/workshop/daq', { enabled: true, intervalMs: 1000, lineId: line.id, ...spec })).node
}

const nTemp = await mkNode({
  name: 'Melt temperature', templateRef: 'daq-temp-tc', driver: 'mock',
  unit: '\u00B0C', decimals: 1, min: 150, max: 200, warnLow: 155, warnHigh: 195,
})
const nSpeed = await mkNode({
  name: 'Line speed', templateRef: 'daq-line-encoder', driver: 'mock',
  unit: 'm/min', decimals: 0, min: 280, max: 360, warnLow: 290, warnHigh: 350,
})
const nPress = await mkNode({
  name: 'Melt pressure', templateRef: 'daq-pressure-tx', driver: 'mock',
  unit: 'MPa', decimals: 2, min: 0.6, max: 1.2, warnLow: 0.65, warnHigh: 1.15,
})
// real Modbus-TCP against the PLC simulator's "extruder" slave (melt-temp @ 40001)
const nModbus = await mkNode({
  name: 'Die-head temperature', templateRef: 'daq-temp-tc', driver: 'modbus-tcp',
  unit: '\u00B0C', decimals: 2, min: 0, max: 400, warnLow: 150, warnHigh: 260,
  driverConfig: { host: '127.0.0.1', port: 16040, unitId: 1, register: 40001, dataType: 'float32', byteOrder: 'big' },
})
console.log(`daq     : temp=${nTemp.id} speed=${nSpeed.id} pressure=${nPress.id} modbus=${nModbus.id}`)

// ── 3. device twin + DCW control node with a recipe window ────────────────
const twins = (await get('/api/workshop/device-twins')).twins
let twin = twins.find(t => t.name === 'Die-head heater')
if (!twin) twin = (await post('/api/workshop/device-twins', { name: 'Die-head heater', kind: 'device', controls: ['setpoint'] })).twin
console.log(`twin    : ${twin.id}  ${twin.name}`)

const dcw = await get('/api/workshop/dcw')
let dcwNode = dcw.nodes.find(n => n.name === 'Die-head setpoint')
if (!dcwNode) {
  dcwNode = (await post('/api/workshop/dcw', {
    name: 'Die-head setpoint', templateRef: 'dcw-temp-sp', driver: 'mock',
    unit: '\u00B0C', decimals: 1, min: 150, max: 200,
    holdIntervalMs: 5000, readIntervalMs: 5000, enabled: true,
    lineId: line.id, deviceIds: [twin.id],
  })).node
}
console.log(`dcw     : ${dcwNode.id}  ${dcwNode.name}  bound=${twin.id}  window=${dcwNode.min}-${dcwNode.max}`)

// ── 4. English agents + team (one lead, harness-backed workers) ───────────
const teams0 = await get('/api/workshop/teams')
let team = teams0.find(t => t.name === 'Cast-film control team')
if (!team) team = await post('/api/workshop/teams', { name: 'Cast-film control team', description: 'Cast-film process lead plus DAQ and modelling workers.', visibility: 'public' })

const teamId = team.id
const existingTeam = (await get('/api/workshop/teams')).find(t => t.id === teamId)
const memberNames = new Set((existingTeam?.members ?? []).map(m => m.name))

const AGENTS = [
  { name: 'Cast-film process lead', harness: 'omp', role: 'lead' },
  { name: 'DAQ engineer', harness: 'omp', role: 'worker' },
  { name: 'Model trainer', harness: 'omp', role: 'worker' },
]
for (const a of AGENTS) {
  if (memberNames.has(a.name)) continue
  const agent = await post('/api/workshop/agents', { name: a.name, harness: a.harness, visibility: 'public' })
  await post(`/api/workshop/teams/${teamId}/members`, { agentId: agent.id, role: a.role })
}
const finalTeam = (await get('/api/workshop/teams')).find(t => t.id === teamId)
console.log(`team    : ${teamId}  ${finalTeam.name}  members=${(finalTeam.members ?? []).map(m => `${m.role}:${m.name}:${m.harness}`).join(', ')}`)

// ── 5. start the line so DAQ acquisition is genuinely live ────────────────
// DAQ sampling is gated on an active per-line batch (recipe run). Without a run
// the nodes report `offline` and the panel-1 claim "share one acquisition loop"
// would be untrue. Create a product + recipe carrying one setpoint param and
// start the line; idempotent via the line's active-run flag.
const lineStates = (await get('/api/workshop/dcw/lines')).states
const alreadyRunning = lineStates.find(s => s.lineId === line.id && s.active)
if (alreadyRunning) {
  console.log(`run     : already active ${alreadyRunning.runId}`)
}
else {
  const dcwState = await get('/api/workshop/dcw')
  let product = (dcwState.products ?? []).find(p => p.name === 'Cast-film roll')
  if (!product) product = (await post('/api/workshop/dcw/products', { name: 'Cast-film roll', lineId: line.id })).product
  let recipe = (dcwState.recipes ?? []).find(r => r.name === 'Cast-film recipe' && r.lineId === line.id)
  if (!recipe) {
    recipe = (await post('/api/workshop/dcw/recipes', {
      productId: product.id,
      name: 'Cast-film recipe',
      description: 'Cast-film line A baseline recipe.',
      params: [{ nodeId: dcwNode.id, value: 178, min: 150, max: 200 }],
      daqWindows: [{ nodeId: nTemp.id, min: 150, max: 200 }],
    })).recipe
  }
  await post(`/api/workshop/dcw/lines/${line.id}/start`, { recipeId: recipe.id })
  console.log(`run     : started with recipe ${recipe.id} (${recipe.name})`)
}

console.log('\nFIXTURE ' + JSON.stringify({ lineId: line.id, lineName: line.name, modbusNodeId: nModbus.id, dcwNodeId: dcwNode.id, twinId: twin.id, teamId }))
