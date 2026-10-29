#!/usr/bin/env node
/**
 * 生产投产验收(2026-10-29)— 验收实例 3350 供给:
 * admin 注册 → token 落盘(D:/tmp/aw-demo-token.txt,e2e-idd-results 约定路径)→
 * 注塑产线供给(bench 注入场景,真实 PLC 模拟器 4010)→ 「注塑产线作业-demo」频道
 * (omp lead + 工艺优化 worker)→ diag/rag 双插件配置(真实 IDD 3210 / RAG 8771)。
 * 幂等:重复运行复用既有对象。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3350'
process.env.NO_PROXY = '127.0.0.1,localhost'

const step = (name, ok, detail = '') => console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : ' — ' + String(detail).slice(0, 300)}`)

async function api(method, path, body, token, timeoutMs = 120000) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  return { status: r.status, j: await r.json().catch(() => ({})) }
}
const data = r => r.j?.data ?? r.j

// 1) admin 注册(首注册即 admin;已存在则登录)
let reg = await api('POST', '/api/users/register', { noStore: true, body: undefined } && undefined, undefined, 1).catch(() => null) // noop 占位防误调
reg = await fetch(BASE + '/api/users/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'prod-admin', email: 'prod-acc@test.local', password: 'Prod#Acc#2026' }) }).then(r => r.json()).catch(() => ({}))
let admin = reg?.data?.token ?? ''
if (!admin) {
  const login = await fetch(BASE + '/api/users/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'prod-acc@test.local', password: 'Prod#Acc#2026' }) }).then(r => r.json()).catch(() => ({}))
  admin = login?.data?.token ?? ''
}
step('admin 注册/登录', Boolean(admin), JSON.stringify(reg).slice(0, 160))
writeFileSync('D:/tmp/aw-demo-token.txt', admin)

// 2) 开自助注册(id 侧套件可能要普通用户)
await api('PATCH', '/api/system/settings', { override: { 'security.allowRegistration': true } }, admin)

// 3) 注塑产线供给(bench 装载场景 + 建线开跑)
const { spawnSync } = await import('node:child_process')
const prov = spawnSync('node', ['scripts/_provision-injection-line.mjs', 'prod1'], {
  cwd: 'D:/codes/ABO/AgentWorkShop', encoding: 'utf8', timeout: 180000,
  env: { ...process.env, AW_BASE: BASE, AW_ADMIN_EMAIL: 'prod-acc@test.local', AW_ADMIN_PASS: 'Prod#Acc#2026', SIM_BASE: 'http://127.0.0.1:4010', NO_PROXY: '127.0.0.1,localhost' },
  windowsHide: true,
})
const provOk = /建线完成/.test(prov.stdout ?? '')
step('注塑产线供给(bench 注入场景)', provOk, (prov.stdout ?? '').slice(-300))

// 4) 频道:omp lead + 工艺优化 worker(名字含「工艺优化」供注塑闭环套件发现)
const lines = data(await api('GET', '/api/workshop/dcw/lines', undefined, admin))
const lineArr = Array.isArray(lines) ? lines : lines?.lines ?? []
const line = lineArr.find(l => /injection|注塑/.test(l.name)) ?? lineArr[0]
step('目标产线在位', Boolean(line?.id), lineArr.map(l => l.name).join(',').slice(0, 120))
const lineId = line.id

let chans = data(await api('GET', '/api/workshop/channels', undefined, admin))
chans = Array.isArray(chans) ? chans : chans?.channels ?? []
let ch = chans.find(c => c.name === '注塑产线作业-demo')
if (!ch) {
  const cr = await api('POST', '/api/workshop/channels', {
    name: '注塑产线作业-demo',
    lineId,
    scenarioPrompt: '注塑产线演示频道:工艺参数监视、优化建议、诊断与知识协同。',
    leadAgent: { name: '注塑demo-线长', harness: 'omp', config: { rpcMode: 'rpc', args: ['--no-tools'] } },
  }, admin)
  const channelId = cr.j?.data?.channelId
  step('频道创建', Boolean(channelId), JSON.stringify(cr.j).slice(0, 200))
  await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    name: '注塑工艺优化-worker', role: 'worker', harness: 'omp', config: { rpcMode: 'rpc', args: ['--no-tools'] },
  }, admin)
  chans = data(await api('GET', '/api/workshop/channels', undefined, admin))
  chans = Array.isArray(chans) ? chans : chans?.channels ?? []
  ch = chans.find(c => c.name === '注塑产线作业-demo')
}
step('演示频道在位(lead+工艺优化 worker)', Boolean(ch?.id), ch?.id ?? '')

// 5) 双插件配置(真实 IDD/RAG)
const iddTokenFile = 'D:/tmp/idd-token-ralph-20261029.txt'
const ragTokenFile = 'D:/tmp/rag-token-ralph-20261029.txt'
const iddToken = existsSync(iddTokenFile) ? readFileSync(iddTokenFile, 'utf8').trim() : ''
const ragToken = existsSync(ragTokenFile) ? readFileSync(ragTokenFile, 'utf8').trim() : ''
const patch = await api('PATCH', '/api/system/settings', { override: {
  'plugins.diag-bridge.base_url': 'http://127.0.0.1:3210',
  ...(iddToken ? { 'plugins.diag-bridge.token': iddToken } : {}),
  'plugins.diag-bridge.results_enabled': true,
  'plugins.diag-bridge.results_allow_annotate': true,
  'plugins.rag-bridge.base_url': 'http://127.0.0.1:8771',
  'plugins.rag-bridge.web_url': 'http://127.0.0.1:6789',
  ...(ragToken ? { 'plugins.rag-bridge.token': ragToken } : {}),
} }, admin)
step('diag/rag 插件配置', patch.status === 200, `status=${patch.status}`)

// 6) IDD token 落 e2e-idd-results 约定路径 + 有效性验证
if (iddToken) writeFileSync('D:/tmp/idd-token.txt', iddToken)
const iddCheck = await fetch('http://127.0.0.1:3210/api/external/v1/capabilities', { headers: { authorization: `Bearer ${iddToken}` }, signal: AbortSignal.timeout(10000) }).then(r => r.status).catch(() => 0)
step('IDD token 对 3210 有效', iddCheck === 200, `status=${iddCheck}`)

// 7) 插件面/工具面快查
const pl = data(await api('GET', '/api/workshop/plugins', undefined, admin))
const rows = Array.isArray(pl) ? pl : pl?.plugins ?? []
step('插件全启用且无错误(11 只)', rows.length >= 10 && rows.every(p => p.enabled && !p.error), `n=${rows.length} err=${rows.filter(p => p.error).map(p => p.name).join(',')}`)
const tools = data(await api('GET', '/api/workshop/tools', undefined, admin))
const toolRows = Array.isArray(tools) ? tools : tools?.tools ?? []
step('工具注册表全 available(builtin+plugin)', toolRows.length >= 120 && toolRows.every(t => t.available !== false), `n=${toolRows.length} unavail=${toolRows.filter(t => t.available === false).length}`)
console.log('\n供给完成: BASE=' + BASE)
