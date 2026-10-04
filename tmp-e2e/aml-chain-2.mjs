// AML batch2: snapshot(显式 scene_json)→ mpc_optimize → twin_bayes_optimize
const B = 'http://localhost:3001'
const TOK = (await (await fetch(`${B}/api/users/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'visual@awshop.local', password: 'Visual2026' }),
})).json()).data?.token
const H = { 'authorization': `Bearer ${TOK}`, 'content-type': 'application/json' }
const LEAD = '8e5ce1b7-43ee-41f2-b9e7-b6a6346085d9'
const invoke = async (tool, args, trim = 700) => {
  const r = await (await fetch(`${B}/api/workshop/agent-tools/invoke`, { method: 'POST', headers: H, body: JSON.stringify({ agentId: LEAD, tool, args }) })).json()
  const t = String(r.data?.result?.text ?? r.message ?? '')
  console.log(`\n### ${tool} code=${r.code}\n` + t.slice(0, trim))
  return { t, r }
}
// 真实样本:dn-121838ac 最近 3 分钟
const now = Date.now()
const q = await (await fetch(`${B}/api/workshop/daq/dn-121838ac/samples?from=${now - 180000}&to=${now}&bucketMs=15000`, { headers: H })).json()
const pts = q.data?.points ?? []
const samples = pts.map(p => ({ nodeId: 'dn-121838ac', at: new Date(p.at).toISOString(), value: Number(p.avg.toFixed(3)) }))
console.log('真实样本点:', samples.length, '最新均值:', pts.length ? pts[pts.length - 1].avg.toFixed(2) : 'n/a')
const scene = {
  schemaVersion: 1, createdAt: new Date().toISOString(), createdBy: 'terminal-test',
  sceneId: 'scene-line2-pressure-manual', sceneVersion: 'v1', lineId: 'ln-83cfc594', recipeId: 'rc-8f9cb3d9',
  phases: ['steady'],
  controls: [{ id: 'ScrewSpeedSP', nodeId: 'dw-38f145fe', role: 'control', physicalMeaning: '泵送螺杆转速设定(唯一控制量;升速升压)', unit: 'rpm', min: 50, max: 200, maxStep: 3 }],
  states: [{ id: 'MeltPressure', nodeId: 'dn-121838ac', role: 'target', physicalMeaning: '熔体泵送压力', unit: 'MPa' }],
  disturbances: [], observations: [], guards: [], constraints: [],
  physicsProfileId: 'thermal-demo-v1', objectiveProfileIds: [],
  writePolicy: { minNodeIntervalSec: 60, minLineActionIntervalSec: 60, maxActionsPerRun: 6, maxDeltaPerAction: { ScrewSpeedSP: 3 } },
  objective: { target: 'MeltPressure 3min 均值进入 15.5~16.0', weights: { deviation: 1, effort: 0.05 } },
}
const snap = await invoke('twin_snapshot_create', {
  scene_json: scene, channel_id: 'cfaba720-8b36-4db3-b0ba-4301910a2bc6', phase: 'steady',
  controls: { ScrewSpeedSP: 130 }, states: { 'dn-121838ac': pts.length ? Number(pts[pts.length - 1].avg.toFixed(3)) : 15.9 },
  samples,
}, 500)
const snapId = /snap-[a-z0-9-]+/i.exec(snap.t)?.[0]
console.log('snapshot_id =', snapId)
if (snapId) {
  await invoke('mpc_optimize', { snapshot_id: snapId, scene_json: scene, baseline_controls: { ScrewSpeedSP: 130 }, horizon_steps: 3 }, 900)
  await invoke('twin_bayes_optimize', { snapshot_id: snapId, scene_json: scene, baseline_controls: { ScrewSpeedSP: 130 }, rounds: 4, candidates_per_round: 6 }, 1100)
}
