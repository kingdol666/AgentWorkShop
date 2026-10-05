// AML 闭环端到端 v2(双断点修复后):discover→compile→freeze→snapshot→mpc
const B = 'http://localhost:3001'
const TOK = (await (await fetch(`${B}/api/users/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'visual@awshop.local', password: 'Visual2026' }),
})).json()).data?.token
const H = { 'authorization': `Bearer ${TOK}`, 'content-type': 'application/json' }
const LEAD = '8e5ce1b7-43ee-41f2-b9e7-b6a6346085d9'
const CH = 'cfaba720-8b36-4db3-b0ba-4301910a2bc6'
const invoke = async (tool, args, trim = 550) => {
  const r = await (await fetch(`${B}/api/workshop/agent-tools/invoke`, { method: 'POST', headers: H, body: JSON.stringify({ agentId: LEAD, tool, args }) })).json()
  const t = String(r.data?.result?.text ?? r.message ?? '')
  console.log(`\n### ${tool} code=${r.code}\n` + t.slice(0, trim))
  return { t, r }
}

// ① discover:配方绑定控制量应已展开
const d = await invoke('twin_scene_discover', { line_id: 'ln-83cfc594' })
const controlsOk = /"control":\s*[1-9]/.test(d.t) || d.t.includes('ScrewSpeedSP')
console.log('① discover 控制量:', controlsOk ? '✅ ≥1(配方展开生效)' : '❌ 仍为 0')

// ② compile
const c = await invoke('twin_scene_compile', {
  scene_id: 'scene-line2-pressure-v2', line_id: 'ln-83cfc594', recipe_id: 'rc-8f9cb3d9',
  prompt: '控制量 ScrewSpeedSP(dw-38f145fe);状态 MeltPressure(dn-121838ac);目标泵压稳态控制',
}, 400)
const hash = /contract[_ ]?hash[":\s]+([a-f0-9]{8,64})/i.exec(c.t)?.[1]
const ver = /scene[_ ]?version[":\s]+([\w.-]+)/i.exec(c.t)?.[1] ?? 'v1'
console.log('② hash:', hash ?? '(从输出提取失败,尝试透传)')

// ③ freeze
await invoke('twin_scene_freeze', {
  scene_id: 'scene-line2-pressure-v2', scene_version: ver,
  confirmation: 'USER_CONFIRMED_SCENE_CONTRACT', approved_by: 'terminal-test',
}, 400)

// ④ snapshot(auto_daq)
const s = await invoke('twin_snapshot_create', { auto_daq: true, channel_id: CH, phase: 'steady' }, 450)
const snapId = /snap-[a-z0-9-]+/i.exec(s.t)?.[0]
console.log('④ snapshot_id =', snapId ?? '(未获取)')

// ⑤ MPC
if (snapId) {
  await invoke('mpc_optimize', { snapshot_id: snapId, baseline_controls: { ScrewSpeedSP: 130 }, horizon_steps: 3 }, 800)
}
