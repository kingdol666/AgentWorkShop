/**
 * Preset(工业场景 Channel 模板)E2E:
 * 1. 内置工业场景模板补种存在(涂布/挤出),场景 prompt 含场景/分工/纪律三要素
 * 2. instantiate → channel 场景落库 + 成员装配(lead+工艺+数据)
 * 3. 场景注入管道:channel.scenarioPrompt = 模板值(instantiated channel 逐字携带)
 * 4. omp 活体:worker 依据注入场景回答(质量目标 ±2% 等仅存在于 preset 的事实)
 * 运行:dev(3000) 就绪后 node scripts/_dbg-preset-e2e.mjs
 */
const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let pass = 0
const fails = []
const ok = (m) => { pass++; console.log(`  PASS ${m}`) }
const fail = (m) => { fails.push(m); console.error(`  FAIL ${m}`) }
const assert = (cond, m) => (cond ? ok(m) : fail(m))
const jpost = (u, b) => fetch(ROOT + u, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }).then(r => r.json())
const jget = (u) => fetch(ROOT + u, { headers: H }).then(r => r.json())
const jdel = (u) => fetch(ROOT + u, { method: 'DELETE', headers: H }).then(r => r.json())

const TEMPLATES = [
  { id: 'chtpl-preset-optical-film', keys: ['光学薄膜涂布产线', '团队分工', '作业纪律', '生产主管', '工艺工程师', '数据分析师', '±2%'] },
  { id: 'chtpl-preset-extrusion', keys: ['挤出流延产线', '团队分工', '作业纪律', '熔体压力', '数据分析师', '±3%'] },
]

async function main() {
  console.log('== 1. 内置工业场景模板(补种幂等) ==')
  const list = (await jget('/api/workshop/channel-templates')).data
  const items = Array.isArray(list) ? list : list?.templates ?? []
  for (const want of TEMPLATES) {
    const t = items.find(x => x.id === want.id)
    if (!t) { fail(`模板缺失: ${want.id}`); continue }
    assert(t.isBuiltin === true && t.visibility === 'public', `${t.name}: 内置公共(owner NULL/public)`)
    for (const k of want.keys) {
      assert((t.scenarioPrompt || '').includes(k), `${t.name}: 场景含「${k}」`)
    }
    const members = Array.isArray(t.members) ? t.members : []
    assert(members.length === 3, `${t.name}: 成员=3(lead+工艺+数据), 实际 ${members.length}`)
    const workers = members.filter(m => m.role === 'worker')
    assert(workers.length === 2 && workers.every(m => m.inline?.harness === 'omp'), `${t.name}: 2 个内联 omp worker(带专长)`)
  }

  console.log('== 2. instantiate → channel 场景落库 + 成员装配 ==')
  const tplFull = items.find(x => x.id === TEMPLATES[0].id)
  const inst = await jpost(`/api/workshop/channel-templates/${TEMPLATES[0].id}/instantiate`, { name: '涂布产线优化组(Preset E2E)' })
  const channelId = inst.data?.channelId
  if (!channelId) { fail(`实例化失败: ${JSON.stringify(inst).slice(0, 150)}`); process.exit(1) }
  assert(inst.data.agentCount === 3, `实例化装配 3 成员(实际 ${inst.data.agentCount})`)
  try {
    const chList = (await jget('/api/workshop/channels')).data
    const ch = (Array.isArray(chList) ? chList : chList?.channels ?? []).find(c => c.id === channelId)
    assert(!!ch, '实例化 channel 存在')
    assert(ch.scenarioPrompt === tplFull.scenarioPrompt, 'channel.scenarioPrompt 逐字携带模板场景(注入源就位)')
    const agents = (await jget(`/api/workshop/channels/${channelId}/agents`)).data
    const arr = Array.isArray(agents) ? agents : agents?.agents ?? []
    assert(arr.length === 3, `channel 成员 3(实际 ${arr.length})`)
    const lead = arr.find(a => a.role === 'lead')
    assert(!!lead, 'lead 就位(tpl-default-lead)')
    const workerNames = arr.filter(a => a.role === 'worker').map(a => a.name).sort().join('/')
    assert(workerNames.includes('工艺工程师') && workerNames.includes('数据分析师'), `worker 名册: ${workerNames}`)

    console.log('== 3. 场景注入验证(contextPrefix 组装面) ==')
    // factory 组装 config.scenarioPrompt ← channel.scenarioPrompt(manager.ts 组装逻辑,已由既有 E2E 覆盖);
    // 这里做 tsx 直读的同源断言:OmpRpcAgentImpl 携带场景 config 时 prefix 含场景三要素
    const { OmpRpcAgentImpl } = await import('../server/services/workshop/agents/omp-agent.ts')
    const sim = new OmpRpcAgentImpl({ agentId: 'preset-probe-x', name: '工艺工程师', role: 'worker', channelId, scenarioPrompt: tplFull.scenarioPrompt })
    const prefix = await sim.contextPrefix()
    assert(prefix.includes('Scenario Brief') && prefix.includes('光学薄膜涂布产线'), 'omp 首段注入场景 preset')
    assert(prefix.includes('±2%') && prefix.includes('作业纪律'), '场景质量目标与纪律进入 prompt')
    const at = prefix.indexOf('Scenario Brief')
    const rosterAt = prefix.indexOf('## Your Team')
    assert(at >= 0 && (rosterAt === -1 || at < rosterAt), '场景段位于名册之前(最高优先级;探针无 workspace 时名册段缺省)')

    console.log('== 4. omp 活体:worker 引用仅存在于 preset 的事实 ==')
    // worker(内联模板实例)未获得任何其他场景信息;回答质量目标只能来自注入的场景段
    const task = (await jpost(`/api/workshop/channels/${channelId}/tasks`, {
      title: '场景认知自检',
      parts: [{ text: '请把本题派发给任一 worker 成员作答(勿自行作答)。题目:不要调用任何工具,仅依据你系统上下文中的「Scenario Brief/产线场景」回答:1) 本团队服务的产线名称与产品;2) 涂层厚度均匀性的质量目标数值;3) 团队三个角色各自的职责(一句话/角色);4) 作业纪律的第一条。逐项作答。' }],
    })).data
    const taskId = task.task?.id ?? task.id
    const artifact = await waitTaskArtifact(channelId, taskId)
    assert(artifact.includes('涂布'), 'omp 引用产线场景(涂布)')
    assert(artifact.includes('2%'), 'omp 引用质量目标 ±2%(仅存在于 preset)')
    assert(artifact.includes('主管') || artifact.includes('lead'), 'omp 复述 lead 职责')
    assert(artifact.includes('数据先行') || artifact.includes('先看数'), 'omp 复述作业纪律')
  }
  finally {
    await jdel(`/api/workshop/channels/${channelId}`).catch(() => {})
  }

  console.log(`\n===== Preset E2E: ${pass} PASS / ${fails.length} FAIL =====`)
  if (fails.length) { fails.forEach(m => console.error(' -', m)); process.exitCode = 1 }
  process.exit(process.exitCode ?? 0)
}

async function waitTaskArtifact(channelId, taskId, maxMs = 300_000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    await sleep(4000)
    const res = (await jget(`/api/workshop/channels/${channelId}/tasks`)).data
    const tasks = Array.isArray(res) ? res : res?.tasks ?? []
    const related = tasks.filter(t => t.id === taskId || t.parentId === taskId)
    if (related.length === 0) continue
    if (!related.every(t => ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state))) continue
    const text = related
      .flatMap(t => (t.artifacts ?? []).map(a => (a.parts ?? []).map(p => p.text ?? '').join(' ')))
      .join('\n')
    if (related.some(t => t.state !== 'COMPLETED')) fail(`omp 任务非正常收口: ${related.map(t => `${t.title}=${t.state}`).join(',')}`)
    return text
  }
  fail('omp 任务等待超时')
  return ''
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })
