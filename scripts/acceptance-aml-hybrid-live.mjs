const base = 'http://127.0.0.1:3000'

async function api(path, opts = {}) {
  const response = await fetch(base + path, opts)
  const json = await response.json().catch(() => null)
  return { status: response.status, ok: response.ok, json }
}

const reg = await api('/api/workshop/users/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: `aml-hybrid-live-${Date.now().toString(36)}` }),
})
const token = reg.json?.data?.token
if (!token) throw new Error('register failed')
const headers = { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' }

const tplRes = await api('/api/workshop/channel-templates', { headers })
const templates = tplRes.json?.data ?? []
const tpl = templates.find(x => x.id === 'chtpl-hybrid-twin-mpc-default')
if (!tpl) throw new Error('hybrid template missing')

const inst = await api(`/api/workshop/channel-templates/${tpl.id}/instantiate`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    name: 'AML Hybrid Live Acceptance',
    toolProfile: 'hybrid_twin',
    scene: {
      sceneId: 'injection-hold-control',
      sceneVersion: '1.0.0',
      lineId: 'line-injection-01',
      productId: 'product-injection-a',
      recipeId: 'recipe-injection-a',
    },
    objective: { objectiveId: 'weight-quality', targets: { weight: 32.5 } },
    controlPolicy: 'recommendation_only',
  }),
})
const worker = inst.json?.data?.agents?.find(x => x.role === 'worker')
if (!worker) throw new Error('worker missing')

async function invoke(tool, args) {
  const response = await api('/api/workshop/agent-tools/invoke', {
    method: 'POST',
    headers,
    body: JSON.stringify({ agentId: worker.id, tool, args }),
  })
  console.log(tool, response.status, JSON.stringify(response.json).slice(0, 1200))
  return response
}

const scene = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  createdBy: 'live',
  sceneId: 'injection-hold-control',
  sceneVersion: '1.0.0',
  lineId: 'line-injection-01',
  productId: 'product-injection-a',
  recipeId: 'recipe-injection-a',
  phases: ['holding'],
  controls: [{ id: 'hold_pressure', role: 'control', physicalMeaning: '保压压力', unit: 'bar', min: 50, max: 90, maxStep: 2 }],
  states: [{ id: 'melt_temperature', nodeId: 'daq-melt-temperature', role: 'state', physicalMeaning: '熔体温度', unit: 'degC' }],
  disturbances: [],
  observations: [{ id: 'weight', nodeId: 'daq-part-weight', role: 'target', physicalMeaning: '重量', unit: 'g' }],
  guards: [],
  constraints: [{ id: 'weight', kind: 'hard_range', min: 31, max: 34 }],
  physicsProfileId: 'injection-greybox-v1',
  objectiveProfileIds: ['weight-quality'],
  writePolicy: { minNodeIntervalSec: 60, minLineActionIntervalSec: 60, maxActionsPerRun: 3, maxDeltaPerAction: { hold_pressure: 2 } },
}
const now = Date.now()
const samples = [
  { nodeId: 'daq-part-weight', at: now - 1000, value: 32.3, sequence: '1' },
  { nodeId: 'daq-melt-temperature', at: now - 1000, value: 247, sequence: '1' },
]
const snapshot = await invoke('twin_snapshot_create', {
  scene_json: scene,
  channel_id: inst.json.data.channelId,
  phase: 'holding',
  controls: { hold_pressure: 65 },
  states: { melt_temperature: 247 },
  samples,
})
const snapshotText = snapshot.json?.data?.result?.text ?? snapshot.json?.result?.text ?? ''
const snapshotId = (snapshotText.match(/snapshot_id:\s*([^\n]+)/) || [])[1]?.trim()
await invoke('mpc_optimize', {
  scene_json: scene,
  baseline_controls: { hold_pressure: 65 },
  model_ready: false,
  horizon_steps: 4,
})
console.log(JSON.stringify({ channelId: inst.json.data.channelId, workerId: worker.id, snapshotId, dcwWrites: 0, verdict: 'recommendation-only' }))
