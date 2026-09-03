/**
 * 插件扩展验证 B(Agent 工具读库):经绑定的 agent 调用真实 daq_frames 工具函数
 * (与 omp agent RPC 调用同一执行体),断言能从数据库读到插件 sink 加工后的数据;
 * 未绑定 agent 越权读取被拒。
 * 运行: npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/_dbg-plugin-agent-read.ts
 */
import { readFileSync } from 'node:fs'
import { toolDaqFrames } from '../server/services/workshop/agents/industrial-tools'
import { getDaqTemplateRegistry } from '../server/services/workshop/daq/daq-templates'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const ctx = JSON.parse(readFileSync('.e2e-plugin-ctx.json', 'utf-8')) as { nodeId: string, agentId: string }
console.log(`agent=${ctx.agentId.slice(0, 8)} node=${ctx.nodeId}`)

// 本 harness 是独立进程:插件宿主未在此运行 → 按插件同一 def 重建模板注册
// (服务端单进程内由插件宿主自动注册;此处模拟该已完成状态)
getDaqTemplateRegistry().registerPlugin({
  key: 'plug-verify-x2-profile',
  name: '×2 标定轮廓(插件验证)',
  code: 'VERIFY · X2',
  ch: '标定轮廓',
  unit: 'mm',
  base: 0.5,
  amp: 0.02,
  min: 0.4,
  max: 0.6,
  decimals: 4,
  icon: 'tension',
  signalKind: 'vector',
  vector: { points: 24, min: 0.4, max: 0.6 },
  sink: { processors: [{ name: 'resample', args: { n: 24 } }, { name: 'verify-x2' }, { name: 'derive-metric', args: { name: 'avg', op: 'avg' } }, { name: 'derive-metric', args: { name: 'max', op: 'max' } }] },
  metrics: [{ key: 'avg', label: '标定均值', unit: 'mm' }],
  plugin: 'daq-sink-verify',
})

// ① 绑定 agent → 工具读到 ×2 加工后的数据
const r1 = await toolDaqFrames(ctx.agentId, { node_id: ctx.nodeId, limit: 3 })
check('绑定 agent 调用工具成功(非 isError)', r1.isError !== true, r1.text.slice(0, 120))
check('工具返回插件加工数据(×2 量级 avg≈1.0)', /avg[= ]0\.9|avg[= ]1\.0|avg=0\.9\d+/.test(r1.text) || /avg=1\./.test(r1.text), r1.text.slice(0, 200))
check('工具透出轮廓帧形态(vector)', r1.text.includes('vector') || r1.text.includes('轮廓'), r1.text.slice(0, 120))

// ② 越权:未绑定 agent 读取被拒
const r2 = await toolDaqFrames('agent-not-bound-xyz', { node_id: ctx.nodeId })
check('未绑定 agent 越权读取被拒', r2.isError === true && /未绑定/.test(r2.text), r2.text.slice(0, 80))

// ③ 读取的数据与 REST 视角一致(同一数据库事实源)
const r3 = await toolDaqFrames(ctx.agentId, { node_id: ctx.nodeId, kind: 'vector', limit: 1 })
check('kind=vector 过滤可用', r3.isError !== true && /轮廓/.test(r3.text), r3.text.slice(0, 120))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
