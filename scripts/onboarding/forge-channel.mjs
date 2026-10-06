/**
 * scripts/onboarding/forge-channel.mjs —— 按场景锻造作业频道(skill 阶段4)。
 * 职责:模板实例化(或直建)→ 团队级插件开关 → Agent 绑定节点/配方(权限模型v2) →
 *      线域授权 → 种子任务派发。scenario 决定默认模板/治理档位/HITL 策略。
 * 输入 JSON:
 * {
 *   "scenario": "optimize" | "diagnose" | "tuning",
 *   "name": "注塑闭环优化频道",
 *   "lineId": "ln-xxxx",              // provision-line 输出
 *   "templateId": "chtpl-...",        // 可省:按 scenario 取默认
 *   "plugins": {"idd-closedloop-bridge": true, "rag-bridge": true},
 *   "bindings": [                      // agentRole: lead|worker:N(第N个worker,0起)
 *     {"agentRole":"worker:2","kind":"recipe","nodeId":"$RECIPE","mode":"manual"},
 *     {"agentRole":"worker:0","kind":"daq","nodeId":"$DAQ:熔体温度PV","mode":"auto"}
 *   ],
 *   "provision": {...},               // 可选:内联 provision-line 摘要,用于 $DAQ:名字/$RECIPE 引用
 *   "seedTask": {"title":"...","description":"...","budget_minutes":90}
 * }
 * 场景默认(可被 templateId 覆盖):
 *   optimize → chtpl-generic-optimize-default(4人闭环;controlPolicy=hitl_governed)
 *   diagnose → chtpl-line-doctor-default(零写只读档;recommendation_only)
 *   tuning   → chtpl-generic-optimize-default + 全部绑定强制 manual(小步长微调)
 * 用法:node scripts/onboarding/forge-channel.mjs <config.json|->
 */
import { api, login, ok, summary, readConfig, fingerprint, assertNotProtected } from './lib.mjs'

const DEFAULT_TEMPLATE = {
  optimize: 'chtpl-generic-optimize-default',
  diagnose: 'chtpl-line-doctor-default',
  tuning: 'chtpl-generic-optimize-default',
}
const DEFAULT_POLICY = { optimize: 'hitl_governed', diagnose: 'recommendation_only', tuning: 'hitl_governed' }

const cfg = await readConfig()
const tok = await login()
const scenario = cfg.scenario ?? 'optimize'
assertNotProtected(cfg.lineId, '目标产线')
const tag = fingerprint('CH', cfg.name)

// ---------- 1. 频道(模板实例化;同名指纹复用) ----------
const chList = await api('GET', '/api/workshop/channels', undefined, tok)
const chItems = chList.data?.items ?? chList.data ?? []
let channel = (Array.isArray(chItems) ? chItems : []).find(c => String(c.description ?? '').includes(tag))
  ?? (Array.isArray(chItems) ? chItems : []).find(c => c.name === cfg.name && c.lineId === cfg.lineId)
let channelId
if (channel) {
  channelId = channel.id
  ok('频道已存在(复用)', true, channelId)
}
else {
  const j = await api('POST', `/api/workshop/channel-templates/${cfg.templateId ?? DEFAULT_TEMPLATE[scenario]}/instantiate`, {
    name: cfg.name,
    bindLineId: cfg.lineId,
    controlPolicy: DEFAULT_POLICY[scenario],
  }, tok)
  channelId = j.data?.channelId
  ok(`模板实例化(${scenario})`, !!channelId, channelId ?? j.message ?? '')
}
if (!channelId) process.exit(1)

// ---------- 2. 团队级插件开关 ----------
const plugins = Object.entries(cfg.plugins ?? {}).filter(([, en]) => en).map(([name]) => ({ name, enabled: true }))
if (plugins.length) {
  const j = await api('PUT', `/api/workshop/channels/${channelId}/plugins`, { plugins }, tok)
  ok('插件开关', j.code === 0 || !!j.data, j.message ?? (plugins.map(p => p.name).join(',')))
}

// ---------- 3. Agent 绑定(成员实例 id;权限模型 v2) ----------
const members = await api('GET', `/api/workshop/channels/${channelId}/agents`, undefined, tok)
const agents = members.data ?? []
const workers = agents.filter(a => a.role === 'worker')
const resolveAgent = (role) => {
  if (role === 'lead') return agents.find(a => a.role === 'lead')?.id ?? agents.find(a => a.role === 'lead')?.agentId
  const idx = Number(String(role).split(':')[1] ?? 0)
  return workers[idx]?.id ?? workers[idx]?.agentId
}
const prov = cfg.provision ?? {}
const resolveNode = (ref) => {
  if (ref === '$RECIPE') return prov.recipeId
  if (String(ref).startsWith('$DAQ:')) return prov.daq?.[String(ref).slice(5)]
  if (String(ref).startsWith('$DCW:')) return prov.dcw?.[String(ref).slice(5)]
  return ref
}
for (const b of cfg.bindings ?? []) {
  const agentId = resolveAgent(b.agentRole)
  const nodeId = resolveNode(b.nodeId)
  if (!agentId || !nodeId) {
    ok(`绑定[${b.agentRole}→${b.nodeId}]`, false, `agentId=${agentId} nodeId=${nodeId}(检查 provision 摘要与 worker 序号)`)
    continue
  }
  const mode = scenario === 'tuning' && b.kind === 'recipe' ? 'manual' : (b.mode ?? 'manual') // 微调场景仅写面(配方)强制 manual,daq 只读绑定不受影响
  const j = await api('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId, kind: b.kind, mode }, tok)
  ok(`绑定[${b.agentRole}→${b.kind}:${String(b.nodeId).slice(0, 24)} mode=${mode}]`, !!j.data?.binding?.id || j.code === 0, j.data?.binding?.id ?? j.message ?? '')
}

// ---------- 4. 线域授权(权限 v3:频道成员可见/可操作) ----------
const userIds = [...new Set(agents.map(a => a.userId).filter(Boolean))]
for (const uid of userIds) {
  const j = await api('PUT', '/api/workshop/permissions', { userId: uid, grants: [{ lineId: cfg.lineId, mode: 'operate' }] }, tok)
  ok(`线域授权[${String(uid).slice(0, 8)}]`, j.code === 0 || !!j.data, j.message ?? '')
}

// ---------- 5. 种子任务(同题幂等:频道复用时不得重复派发) ----------
if (cfg.seedTask) {
  const existing = await api('GET', `/api/workshop/channels/${channelId}/tasks`, undefined, tok)
  const dup = (existing.data ?? []).find(t => t.title === cfg.seedTask.title)
  if (dup) {
    ok('种子任务已存在(同题跳过)', true, dup.id)
  }
  else {
    const j = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
      title: cfg.seedTask.title,
      description: cfg.seedTask.description,
      ...(cfg.seedTask.budget_minutes ? { budget_minutes: cfg.seedTask.budget_minutes } : {}),
    }, tok)
    ok('种子任务派发', !!j.data?.id, j.data?.id ?? j.message ?? '')
  }
}

console.log('\n' + JSON.stringify({ channelId, scenario }))
summary('频道锻造')
