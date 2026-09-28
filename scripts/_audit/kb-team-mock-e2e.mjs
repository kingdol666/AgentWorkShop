#!/usr/bin/env node
/**
 * scripts/_audit/kb-team-mock-e2e.mjs —— 知识库集成 Channel + lead→worker 节点委派(mock 阶段验收)。
 *
 * 覆盖(无 LLM 依赖):
 *  1) 模板知识库能力面:chtpl-generic-optimize-default / chtpl-aml-optimization-default 标记 knowledgeBaseCapable;
 *  2) 实例化 enableKnowledgeBase=true → 频道插件开关含 rag-bridge=on,场景提示词含 KB 作业段;
 *  3) 实例化 enableKnowledgeBase=false → rag-bridge=off;缺省 → 无显式行(平台默认);
 *  4) 委派 REST:lead 绑定面内节点授予 worker(grantedByAgentId 溯源);
 *  5) fail-closed:越面授予 403 / 授予 lead 自己 400;
 *  6) 执行中授予:worker 有在飞任务时仍可被授予新节点;
 *  7) 撤销:收回授予的节点;非 lead 授予且 lead 不持有的绑定不被误撤。
 *
 * 用法:AW_BASE=http://127.0.0.1:3456 node scripts/_audit/kb-team-mock-e2e.mjs
 * 前置:全新实例(首注册即 admin)。脚本自行注册 admin 账号并搭一条 mock 产线。
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3456'
const ADMIN = { email: process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local', password: process.env.AW_ADMIN_PASSWORD ?? 'Awshop@123!' }

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}
const section = t => console.log(`\n━━━ ${t} ━━━`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, { body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

const TAG = `kbmock-${new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '')}`

async function main() {
  section('S0 管理员就绪(全新实例首注册即 admin)')
  const reg = await api('POST', '/api/users/register', { body: { ...ADMIN, name: 'kb-mock-admin' } })
  const token = reg.json?.data?.token ?? (await api('POST', '/api/users/login', { body: { email: ADMIN.email, password: ADMIN.password } })).json?.data?.token
  ok('管理员 token 可用', Boolean(token))
  const auth = { token }

  section('S1 模板知识库能力面')
  const tplList = (await api('GET', '/api/workshop/channel-templates', auth)).json?.data ?? []
  const generic = tplList.find(t => t.id === 'chtpl-generic-optimize-default')
  const optTpl = tplList.find(t => t.id === 'chtpl-aml-optimization-default')
  ok('内置模板存在「通用闭环优化频道(标准)」', Boolean(generic), generic?.name)
  ok('通用模板标记 knowledgeBaseCapable', generic?.knowledgeBaseCapable === true)
  ok('工艺优化通道标记 knowledgeBaseCapable', optTpl?.knowledgeBaseCapable === true)
  ok('其他模板不带该标记', tplList.find(t => t.id === 'chtpl-default-fullstack')?.knowledgeBaseCapable !== true)

  section('S2 实例化:enableKnowledgeBase=true → rag-bridge 开 + KB 作业段')
  const inst1 = (await api('POST', '/api/workshop/channel-templates/chtpl-generic-optimize-default/instantiate', { body: { name: `${TAG}-kb-on`, enableKnowledgeBase: true }, ...auth })).json?.data
  ok('通用频道实例化成功', Boolean(inst1?.channelId), `agents=${inst1?.agentCount}`)
  const ch1 = (await api('GET', `/api/workshop/channels/${inst1.channelId}`, auth)).json?.data
  ok('场景提示词含知识库作业段', String(ch1?.scenarioPrompt ?? '').includes('知识库集成') && String(ch1?.scenarioPrompt ?? '').includes('kb_agent'))
  const plug1 = (await api('GET', `/api/workshop/channels/${inst1.channelId}/plugins`, auth)).json?.data
  const rb1 = (Array.isArray(plug1?.plugins) ? plug1.plugins : plug1 ?? []).find?.(p => p?.name === 'rag-bridge')
    ?? (Array.isArray(plug1) ? plug1 : []).find(p => p?.name === 'rag-bridge')
  ok('频道插件开关含 rag-bridge=on', Boolean(rb1 && rb1.enabled !== false), JSON.stringify(rb1 ?? plug1 ?? {}).slice(0, 120))
  const members1 = (await api('GET', `/api/workshop/channels/${inst1.channelId}/agents`, auth)).json?.data ?? []
  ok('频道含 lead + worker', members1.some(m => m.role === 'lead') && members1.filter(m => m.role === 'worker').length >= 2, `members=${members1.length}`)

  section('S3 实例化:enableKnowledgeBase=false 与缺省行为')
  const inst2 = (await api('POST', '/api/workshop/channel-templates/chtpl-aml-optimization-default/instantiate', { body: { name: `${TAG}-kb-off`, enableKnowledgeBase: false }, ...auth })).json?.data
  const plug2 = (await api('GET', `/api/workshop/channels/${inst2.channelId}/plugins`, auth)).json?.data
  const flat2 = Array.isArray(plug2?.plugins) ? plug2.plugins : (Array.isArray(plug2) ? plug2 : [])
  ok('显式 false → rag-bridge=off', flat2.some(p => p?.name === 'rag-bridge' && p.enabled === false), JSON.stringify(flat2).slice(0, 120))
  const inst3 = (await api('POST', '/api/workshop/channel-templates/chtpl-aml-optimization-default/instantiate', { body: { name: `${TAG}-kb-default` }, ...auth })).json?.data
  const plug3 = (await api('GET', `/api/workshop/channels/${inst3.channelId}/plugins`, auth)).json?.data
  const flat3 = Array.isArray(plug3?.plugins) ? plug3.plugins : (Array.isArray(plug3) ? plug3 : [])
  const rb3 = flat3.find(p => p?.name === 'rag-bridge')
  ok('缺省 → rag-bridge 保持平台默认(未被显式停用)', !rb3 || rb3.enabled !== false, JSON.stringify(flat3).slice(0, 120))

  section('S4 搭 mock 产线(建线 + 模板 + 数采/数控节点)')
  const line = (await api('POST', '/api/workshop/dcw/lines', { body: { name: `KBMock线-${TAG}`, description: 'kb-team mock e2e' }, ...auth })).json?.data
  const lineId = line?.line?.id ?? line?.id
  ok('建线成功', Boolean(lineId), lineId)
  const dcwTpl = (await api('POST', '/api/workshop/dcw/templates', { body: { name: `kbmock-sp-tpl-${TAG}`, ch: '温度设定', unit: '℃', min: 150, max: 220, decimals: 1 }, ...auth })).json?.data
  const daqTpl = (await api('POST', '/api/workshop/daq/templates', { body: { name: `kbmock-temp-tpl-${TAG}`, ch: '温度', unit: '℃', min: 0, max: 300, decimals: 1 }, ...auth })).json?.data
  const dcwTplRef = dcwTpl?.template?.key ?? dcwTpl?.key
  const daqTplRef = daqTpl?.template?.key ?? daqTpl?.key
  ok('节点模板创建成功', Boolean(dcwTplRef) && Boolean(daqTplRef), `dcw=${dcwTplRef} daq=${daqTplRef}`)
  const dcw = (await api('POST', '/api/workshop/dcw', { body: { name: `kbmock-sp-${TAG}`, templateRef: dcwTplRef, driver: 'mock', unit: '℃', min: 150, max: 220, stepLimit: 5, lineId }, ...auth })).json
  const daq = (await api('POST', '/api/workshop/daq', { body: { name: `kbmock-temp-${TAG}`, templateRef: daqTplRef, driver: 'mock', intervalMs: 1000, publishIntervalMs: 0, lineId }, ...auth })).json
  const dcwId = dcw?.data?.node?.id
  const daqId = daq?.data?.node?.id
  ok('数采/数控节点创建成功', Boolean(daqId) && Boolean(dcwId), `daq=${daqId} dcw=${dcwId}`)

  section('S5 lead 绑定 + 委派核心面')
  const lead = members1.find(m => m.role === 'lead')
  const worker = members1.find(m => m.role === 'worker')
  const b1 = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: lead.id, nodeId: dcwId, kind: 'dcw', mode: 'manual' }, ...auth })
  const b2 = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: lead.id, nodeId: daqId, kind: 'daq', mode: 'auto' }, ...auth })
  ok('lead 绑定 dcw+daq 成功', b1.status === 200 && b2.status === 200, `dcw=${b1.status} daq=${b2.status}`)

  const grant = await api('POST', '/api/workshop/agent-tools/bindings/grant', { body: { channelId: inst1.channelId, agentId: worker.id, nodeIds: [dcwId, daqId] }, ...auth })
  ok('委派授予成功(整单)', grant.status === 200, JSON.stringify(grant.json?.data ?? grant.json).slice(0, 120))
  const granted = grant.json?.data?.granted ?? []
  ok('授予绑定带 lead 溯源', granted.length === 2 && granted.every(g => g.grantedByAgentId === lead.id), `n=${granted.length}`)
  ok('dcw 委派缺省随 lead 的 manual 模式', granted.find(g => g.kind === 'dcw')?.mode === 'manual')
  const workerBindings = (await api('GET', `/api/workshop/agent-tools/bindings?agentId=${worker.id}`, auth)).json?.data
  const wbFlat = Array.isArray(workerBindings) ? workerBindings : (workerBindings?.bindings ?? [])
  ok('worker 绑定面已含委派节点', wbFlat.some(b => b.nodeId === dcwId) && wbFlat.some(b => b.nodeId === daqId), `n=${wbFlat.length}`)

  section('S6 fail-closed:越面授予 / 授予 lead 自己')
  const bad = await api('POST', '/api/workshop/agent-tools/bindings/grant', { body: { channelId: inst1.channelId, agentId: worker.id, nodeIds: [`ghost-${TAG}`] }, ...auth })
  const badCode = bad.json?.code ?? bad.json?.data?.code
  ok('越面授予被拒(403 DELEGATION_NOT_OWNED)', bad.status === 403 && badCode === 'DELEGATION_NOT_OWNED', `status=${bad.status} code=${badCode}`)
  const self = await api('POST', '/api/workshop/agent-tools/bindings/grant', { body: { channelId: inst1.channelId, agentId: lead.id, nodeIds: [dcwId] }, ...auth })
  ok('授予 lead 自己被拒(400)', self.status === 400, `status=${self.status}`)

  section('S7 执行中授予(worker 有在飞任务时仍可授权)')
  const task = (await api('POST', `/api/workshop/channels/${inst1.channelId}/tasks`, { body: { title: `巡检-${TAG}`, description: '读取授权节点并汇报(委派执行中授予验证)', assigneeId: worker.id }, ...auth })).json?.data
  ok('worker 根任务已创建', Boolean(task?.id), task?.id)
  await sleep(500)
  const midGrant = await api('POST', '/api/workshop/agent-tools/bindings/grant', { body: { channelId: inst1.channelId, agentId: worker.id, nodeIds: [dcwId], mode: 'auto' }, ...auth })
  ok('执行中授予成功(模式覆盖 auto)', midGrant.status === 200, JSON.stringify(midGrant.json?.data ?? {}).slice(0, 100))
  await api('POST', `/api/workshop/channels/${inst1.channelId}/tasks/${task.id}/cancel`, { ...auth }).catch(() => {})

  section('S8 撤销')
  const revoke = await api('POST', '/api/workshop/agent-tools/bindings/revoke', { body: { channelId: inst1.channelId, agentId: worker.id, nodeIds: [daqId] }, ...auth })
  const results = revoke.json?.data?.results ?? []
  ok('撤销 daq 委派成功', revoke.status === 200 && results.every(r => r.revoked), JSON.stringify(results).slice(0, 100))
  const afterRevoke = (await api('GET', `/api/workshop/agent-tools/bindings?agentId=${worker.id}`, auth)).json?.data
  const arFlat = Array.isArray(afterRevoke) ? afterRevoke : (afterRevoke?.bindings ?? [])
  ok('撤销后 worker 不再持有该节点', !arFlat.some(b => b.nodeId === daqId), `剩余=${arFlat.length}`)

  console.log(`\n════ 结果: ${pass} PASS / ${fails.length} FAIL ════`)
  if (fails.length) {
    console.log('失败项:')
    for (const f of fails) console.log(`  - ${f}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('E2E 致命异常:', err)
  process.exit(1)
})
