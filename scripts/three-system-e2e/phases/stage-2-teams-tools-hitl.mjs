/**
 * Stage 2:双团队 + 工具链 + 跨通道 + HITL —— 原 L295–462
 * (由 scripts/three-system-e2e.mjs 按职责拆出;语句逐行原文搬运,仅跨模块引用/状态访问机械改写)
 *
 * 原来声明在块外的 leadA/toolInvoker/leadB/channelA/channelB 已移入 state.mjs(Stage 3/4 复用)。
 */
import { CH_A, CH_B, DCW_NODE, api, envelopeData, invoke, ok, resultText, sleep } from '../lib.mjs'
import {
  getChannelA,
  getChannelB,
  getLeadA,
  getLeadB,
  getLINE,
  getToolInvoker,
  getUserToken,
  setChannelA,
  setChannelB,
  setLeadA,
  setLeadB,
  setToolInvoker,
} from '../state.mjs'

export async function run() {
  console.log('\n── Stage 2 团队与工具链 ──')
  async function ensureChannel(name, leadName, execName) {
    const found = await api('GET', '/api/workshop/channels', { token: getUserToken() })
    const items = envelopeData(found) ?? []
    const hit = (Array.isArray(items) ? items : []).find(c => c?.name === name)
    let channelId = hit?.id ?? ''
    if (!channelId) {
      let created = await api('POST', '/api/workshop/channels', {
        token: getUserToken(),
        body: { name, description: `三系统集成示例团队(e2e 创建)`, leadAgent: { name: leadName, harness: 'mock' } },
      })
      if (!(created.status === 200 && envelopeData(created)?.channelId)) {
        // 同名频道被其他账号占用 → 加随机后缀重建(演示语义不变)
        name = `${name}-${Math.random().toString(36).slice(2, 6)}`
        created = await api('POST', '/api/workshop/channels', {
          token: getUserToken(),
          body: { name, description: `三系统集成示例团队(e2e 创建)`, leadAgent: { name: leadName, harness: 'mock' } },
        })
      }
      channelId = envelopeData(created)?.channelId ?? ''
    }
    const readMembers = async () => (envelopeData(await api('GET', `/api/workshop/channels/${channelId}/agents`, { token: getUserToken() })) ?? [])
    let members = await readMembers()
    // 每队配一个 omp「执行器」成员:REST 直调工具经共享 host-tool-bridge 分发,零 LLM 会话
    if (!members.some(m => m?.name === execName)) {
      await api('POST', `/api/workshop/channels/${channelId}/agents`, {
        token: getUserToken(),
        body: { name: execName, harness: 'omp', role: 'worker' },
      })
      members = await readMembers()
    }
    const lead = members.find(m => m?.role === 'lead')
    const exec = members.find(m => m?.name === execName)
    return { channelId, lead, exec, name }
  }
  const a = await ensureChannel(CH_A, '分析组长', '数据分析执行器')
  const b = await ensureChannel(CH_B, '控制组长', '控制执行器')
  setChannelA(a.channelId)
  setChannelB(b.channelId)
  setLeadA(a.lead)
  setLeadB(b.lead)
  const execA = a.exec
  const execB = b.exec
  const nameB = b.name ?? CH_B
  ok(Boolean(getChannelA() && getLeadA()?.id && getLeadA()?.token), `团队A「${a.name ?? CH_A}」就绪(lead=${getLeadA()?.name})`)
  ok(Boolean(getChannelB() && getLeadB()?.id && getLeadB()?.token), `团队B「${nameB}」就绪(lead=${getLeadB()?.name})`)
  ok(Boolean(execA?.id && execA?.token), '团队A 执行器(omp)就绪', execA?.name)
  ok(Boolean(execB?.id && execB?.token), '团队B 执行器(omp)就绪', execB?.name)
  setToolInvoker(execA ?? getLeadA())

  // 工具清单:5 工具可见 + 无 url/base_url/host 参数(SSRF 面)
  const listR = await api('GET', `/api/workshop/agent-tools/list?agentId=${getToolInvoker().id}`, { agent: getToolInvoker() })
  const tools = listR?.json?.tools ?? listR?.json?.data?.tools ?? []
  const toolNames = tools.map(t => t?.name)
  for (const t of ['diag_run', 'diag_status', 'kb_search', 'kb_store', 'kb_index']) {
    ok(toolNames.includes(t), `agent 工具清单含 ${t}`)
  }
  const bridge = tools.filter(t => ['diag_run', 'diag_status', 'kb_search', 'kb_store', 'kb_index'].includes(t?.name))
  const leak = bridge.some(t => Object.keys(t?.parameters?.properties ?? {}).some(k => /url|host/i.test(k)))
  ok(bridge.length === 5 && !leak, '桥接工具参数面无 url/host 注入口', `tools=${bridge.length}`)

  // DAQ 实时数据 → 快照导出
  let snap = await api('POST', '/api/plugins/diag-bridge/snapshot', {
    token: getUserToken(),
    body: { line: getLINE(), from_ms: Date.now() - 15 * 60_000, to_ms: Date.now() },
  })
  if (snap.json?.success === false) {
    snap = await api('POST', '/api/plugins/diag-bridge/snapshot', {
      token: getUserToken(),
      body: { line: getLINE(), from_ms: Date.now() - 120 * 60_000, to_ms: Date.now() },
    })
  }
  ok(snap.json?.success === true && snap.json?.rows > 0, 'DAQ 实时数采 → 快照 CSV 导出成功', `rows=${snap.json?.rows} nodes=${snap.json?.nodes} path=${snap.json?.csvPath}`)
  if (snap.json?.csvPath) {
    ok(String(snap.json.csvPath).startsWith('data/aw-snapshots/'), '快照落诊断服务 aw-snapshots 目录(相对路径)', snap.json.csvPath)
  }

  // KB 回环:kb_index 入库独特自然语句 → kb_search 命中(嵌入/分词对自然语句才可靠);kb_store 沉淀经验
  const marker = `三系统验证密语${Date.now().toString(36)}:青花瓷泵站三十七号叶片于黄昏完成校准`
  const idx = await invoke(getToolInvoker(), 'kb_index', { // rag 负载下事件循环停顿可达 60s+,放宽超时
    title: `三系统集成验证 ${Date.now().toString(36)}`,
    content: `# 三系统集成验证\n\n${marker}。\n\n本文由 three-system-e2e 经 rag-bridge 插件写入,验证 文档写盘 → 向量索引 → kb_search 检索 全链路。\n`,
    tags: ['e2e'],
  }, 120000)
  ok(resultText(idx).includes('已入库'), 'kb_index 文档入库成功', resultText(idx).slice(0, 80))
  let hit = ''
  for (let i = 0; i < 20; i++) { // 首次检索可能触发 BGE-M3 加载/异步索引落盘,放宽到 20×3s
    await sleep(3000)
    const s = await invoke(getToolInvoker(), 'kb_search', { query: marker }, 120000)
    hit = resultText(s)
    if (hit.includes(marker)) break
  }
  ok(hit.includes(marker), 'kb_search 检索命中刚入库文档', hit.split('\n')[1]?.slice(0, 90) ?? hit.slice(0, 90))

  const store = await invoke(getToolInvoker(), 'kb_store', {
    title: `e2e 经验:${marker} 快照导出前先确认产线在采样`,
    category: 'troubleshooting',
    problem: 'diag_run 报「时窗内无数采样本」',
    solution: '先查产线 LineRun 是否活动、节点 publishIntervalMs 是否在节拍上,再缩窗重试。',
    key_lessons: ['空窗先查打标窗口', 'bucket 5s 可对齐多节点'],
    tags: ['e2e', 'daq'],
  }, 120000)
  ok(resultText(store).includes('已沉淀'), 'kb_store 经验沉淀成功', resultText(store).slice(0, 80))

  // 跨通道:分析组长 → 控制组长(require_reply;用频道 ID 定向,避免跨账号同名频道歧义)
  const xmsg = await invoke(getLeadA(), 'send_cross_channel_message', {
    to_channel_id: getChannelB(),
    message: `分析组已完成 ${getLINE()} 最近时窗的数据诊断与知识检索;请控制组给出 ${DCW_NODE}(压力设定器)的控制策略建议。`,
    require_reply: true,
  }, 120000)
  ok(!xmsg.json?.result?.isError, '分析组长 → 控制组长 跨通道消息发送成功', resultText(xmsg).slice(0, 80))
  let landedB = ''
  for (let i = 0; i < 8; i++) {
    await sleep(1000)
    const msgs = await api('GET', `/api/workshop/channels/${getChannelB()}/messages`, { token: getUserToken() })
    const items = envelopeData(msgs)?.items ?? envelopeData(msgs) ?? []
    const arr = Array.isArray(items) ? items : (items?.messages ?? [])
    landedB = JSON.stringify(arr)
    if (landedB.includes('控制策略建议')) break
  }
  ok(landedB.includes('控制策略建议'), '跨通道消息落入控制组频道')

  // DCW(manual)→ HITL → 写回
  const dcwView = await api('GET', '/api/workshop/dcw', { token: getUserToken() })
  const dcwNodes = envelopeData(dcwView)?.nodes ?? []
  const node = dcwNodes.find(n => n?.id === DCW_NODE)
  ok(Boolean(node), `DCW 节点 ${DCW_NODE} 对授权用户可见`, `driver=${node?.driver} value=${node?.value}`)
  const target = Number(node?.value ?? 0)
  const bind = await api('POST', '/api/workshop/agent-tools/bindings', {
    token: getUserToken(),
    body: { agentId: execB.id, nodeId: DCW_NODE, kind: 'dcw', mode: 'manual' },
  })
  ok(bind.status === 200 && Boolean(envelopeData(bind)?.binding?.id), '控制执行器绑定 DCW 节点(manual)', bind.status === 200 ? `mode=${envelopeData(bind)?.binding?.mode}` : JSON.stringify(bind.json).slice(0, 120))
  ok(envelopeData(bind)?.binding?.mode === 'manual', '绑定模式确为 manual(审批路径生效前置)')

  const pendingInvoke = invoke(execB, 'dcw_control', {
    node_id: DCW_NODE,
    value: target,
    hypothesis: `依据分析组诊断结论与历史经验,维持设定值 ${target}(e2e 闭环演示)`,
  }, 300000)
  let approved = false
  let pendRaw = '[]'
  for (let i = 0; i < 15 && !approved; i++) {
    await sleep(2000)
    const pend = await api('GET', '/api/workshop/hitl/pending', { token: getUserToken() })
    const pd = envelopeData(pend)
    const arr = Array.isArray(pd) ? pd : (pd?.items ?? pd?.pending ?? [])
    pendRaw = JSON.stringify(arr)
    const item = arr.find(x => x?.kind === 'dcw-approval' && x?.agentId === execB.id)
    if (item?.id) {
      const resp = await api('POST', '/api/workshop/hitl/respond', {
        token: getUserToken(),
        body: { kind: 'dcw-approval', id: item.id, confirmed: true, comment: 'three-system-e2e 批准' },
      })
      approved = resp.status === 200
    }
  }
  const writeRes = await pendingInvoke
  ok(approved, 'HITL 待办出现并经 respond 批准', approved ? 'ok' : `pending=${pendRaw.slice(0, 200)}`)
  ok(resultText(writeRes).includes('下发成功'), 'dcw_control 经审批写回成功', resultText(writeRes).slice(0, 120))
}
