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
// 绑线频道默认 integrated:工业工具/四层限界/产线上下文按生产模式装配。
// (模板默认是 generic;只 bindLineId 不会切模式,曾导致锻造出的线频道被工业工具面拒绝。)
const desiredMode = cfg.channelMode ?? (cfg.lineId ? 'production_line_integrated' : 'generic')

// 工况上下文块(scene/promptVariables → 频道提示词)。创建时随模板一次写入;
// 复用频道才走 PATCH。避免“先建频道→再 PATCH prompt”触发 lead 重装导致 seed task 滞留。
const contextMarker = '## 工况上下文（文档自动接入）'
const contextLines = []
for (const obj of [cfg.scene, cfg.promptVariables]) {
  if (!obj || typeof obj !== 'object') continue
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && String(v).trim()) contextLines.push(`- ${k}: ${String(v).slice(0, 300)}`)
  }
}
const contextBlock = contextLines.length > 0
  ? `${contextMarker}\n${contextLines.join('\n')}\n\n> 以上上下文由工况文档/接入配置生成；写入仍受节点授权、量程/步长/60s 与 HITL 治理。`
  : ''

// ---------- 1. 频道(模板实例化;同名指纹复用) ----------
const chList = await api('GET', '/api/workshop/channels', undefined, tok)
const chItems = chList.data?.items ?? chList.data ?? []
let channel = (Array.isArray(chItems) ? chItems : []).find(c => String(c.description ?? '').includes(tag))
  ?? (Array.isArray(chItems) ? chItems : []).find(c => c.name === cfg.name && c.lineId === cfg.lineId)
let channelId
if (channel) {
  channelId = channel.id
  ok('频道已存在(复用)', true, channelId)
  if (cfg.lineId && channel.channelMode !== desiredMode) {
    const p = await api('PATCH', `/api/workshop/channels/${channelId}`, { channelMode: desiredMode }, tok)
    ok('复用频道模式对齐', p.code === 0 || !!p.data, `${channel.channelMode} → ${desiredMode} ${p.message ?? ''}`)
  }
}
else {
  const j = await api('POST', `/api/workshop/channel-templates/${cfg.templateId ?? DEFAULT_TEMPLATE[scenario]}/instantiate`, {
    name: cfg.name,
    channelMode: desiredMode,
    bindLineId: cfg.lineId,
    ...(contextBlock ? { scenarioPrompt: contextBlock } : {}),
    controlPolicy: DEFAULT_POLICY[scenario],
    ...(cfg.scene ? { scene: cfg.scene } : {}),
    ...(cfg.promptVariables ? { promptVariables: cfg.promptVariables } : {}),
  }, tok)
  channelId = j.data?.channelId
  ok(`模板实例化(${scenario})`, !!channelId, channelId ?? j.message ?? '')
}
if (!channelId) process.exit(1)

// ---------- 1b. 复用频道的工况上下文补齐 ----------
// 新建频道已在 instantiate 时携带 scenarioPrompt;只有复用频道才需要检查/补写。
if (contextBlock) {
  const ch = await api('GET', `/api/workshop/channels/${channelId}`, undefined, tok)
  const currentPrompt = String(ch?.data?.scenarioPrompt ?? ch?.data?.channel?.scenarioPrompt ?? '')
  if (!currentPrompt.includes(contextMarker)) {
    const p = await api('PATCH', `/api/workshop/channels/${channelId}`, {
      scenarioPrompt: `${currentPrompt}${currentPrompt ? '\n\n' : ''}${contextBlock}`,
    }, tok)
    ok('工况上下文写入频道(复用补齐)', p.code === 0 || !!p.data, p.message ?? `${contextLines.length} 项`)
  }
  else ok('工况上下文已存在(复用)', true, contextMarker)
}

// ---------- 2. 团队级插件开关(全量替换:未在配置中启用的已注册插件必须显式关闭) ----------
const wantedPlugins = new Set(Object.entries(cfg.plugins ?? {}).filter(([, en]) => en === true).map(([name]) => name))
const currentPlugins = await api('GET', `/api/workshop/channels/${channelId}/plugins`, undefined, tok)
const allPlugins = (currentPlugins?.data?.plugins ?? []).map(p => p.name)
const plugins = allPlugins.length > 0
  ? allPlugins.map(name => ({ name, enabled: wantedPlugins.has(name) }))
  : [...wantedPlugins].map(name => ({ name, enabled: true }))
if (plugins.length) {
  const j = await api('PUT', `/api/workshop/channels/${channelId}/plugins`, { plugins }, tok)
  ok('插件开关(未配置项显式关闭)', j.code === 0 || !!j.data,
    j.message ?? `启用=${plugins.filter(p => p.enabled).map(p => p.name).join(',') || '无'};停用=${plugins.filter(p => !p.enabled).length}项`)
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

// ---------- 3b. MES 取数授权配方(可见面 = dcw 存量绑定 ∪ 配方参数节点;kind='dcw' 绑定已废弃,
//              history-only mes 节点的正道 = 参数面授权配方,只取数不下发) ----------
if (Array.isArray(cfg.mesFetchGrants) && cfg.mesFetchGrants.length > 0) {
  const recipes = await api('GET', '/api/workshop/dcw/recipes', undefined, tok)
  const baseRecipe = (recipes.data?.recipes ?? []).find(r => r.id === prov.recipeId)
  for (const g of cfg.mesFetchGrants) {
    const agentId = resolveAgent(g.agentRole)
    const nodeIds = (g.nodeIds ?? []).map(resolveNode).filter(Boolean)
    if (!agentId || nodeIds.length === 0) {
      ok(`MES授权[${g.agentRole}]`, false, `agentId=${agentId} nodeIds=${nodeIds.length}`)
      continue
    }
    const grantName = g.name ?? `MES取数授权配方(${cfg.name})`
    const dup = (recipes.data?.recipes ?? []).find(r => r.name === grantName)
    let grantRecipeId = dup?.id
    if (grantRecipeId) {
      ok('MES授权配方复用', true, grantRecipeId)
    }
    else {
      const j = await api('POST', '/api/workshop/dcw/recipes', {
        name: grantName, productId: baseRecipe?.productId, lineId: cfg.lineId, opIntervalMs: 0,
        params: nodeIds.map(id => ({ nodeId: id, value: 0 })),
        reason: 'MES 直取节点可见面授权(仅取数面;不下发本配方)',
      }, tok)
      grantRecipeId = j.data?.recipe?.id ?? j.data?.id
      ok('MES授权配方', !!grantRecipeId, grantRecipeId ?? j.message ?? '')
    }
    if (grantRecipeId) {
      const b = await api('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId: grantRecipeId, kind: 'recipe', mode: 'manual' }, tok)
      ok(`MES授权绑定[${g.agentRole}→${nodeIds.length} 点]`, !!b.data?.binding?.id || b.code === 0, b.data?.binding?.id ?? b.message ?? '')
    }
  }
}

// ---------- 4. 线域授权(权限 v3:频道用户可见/可操作) ----------
// Agent 实例不是人类用户:授权主体必须取 channel.ownerUserId + 群成员 userIds。
// 旧实现从 /channels/:id/agents 取 userId,而该 DTO 不含 userId → 循环恒空转。
const chDetail = await api('GET', `/api/workshop/channels/${channelId}`, undefined, tok)
const ownerUserId = String(chDetail?.data?.ownerUserId ?? chDetail?.data?.channel?.ownerUserId ?? '')
let memberUserIds = []
try {
  const mr = await api('GET', `/api/workshop/channels/${channelId}/members`, undefined, tok)
  memberUserIds = (mr?.data?.members ?? []).map(m => String(m.userId ?? '')).filter(Boolean)
}
catch { /* 群聊未开启等场景:退回仅 owner 授权 */ }
const userIds = [...new Set([ownerUserId, ...memberUserIds].filter(Boolean))]
for (const uid of userIds) {
  const j = await api('PUT', '/api/workshop/permissions', { userId: uid, grants: [{ lineId: cfg.lineId, mode: 'operate' }] }, tok)
  ok(`线域授权[${String(uid).slice(0, 8)}]`, j.code === 0 || !!j.data, j.message ?? '')
}
ok('线域授权覆盖频道用户', userIds.length > 0, `users=${userIds.length}(owner+members)`)

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
