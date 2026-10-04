// 本轮测试:混合配方绑定 + 普通场景任务 + PLC+MES 混合协议任务
const B = 'http://localhost:3001'
const TOK = (await (await fetch(`${B}/api/users/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'visual@awshop.local', password: 'Visual2026' }),
})).json()).data?.token
const H = { 'authorization': `Bearer ${TOK}`, 'content-type': 'application/json' }

// ① worker A 补混合配方绑定(manual → 走 HITL)
const g = await (await fetch(`${B}/api/workshop/agent-tools/bindings`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ agentId: '80dc9b41-6ae3-4dce-a185-21537f0ad7c7', nodeId: 'rc-efd5991e', kind: 'recipe', mode: 'manual' }),
})).json()
console.log('混合配方绑定:', g.code, g.message ?? '')

// ② 普通场景任务(非工业协同)
const t1 = await (await fetch(`${B}/api/workshop/channels/28ab0e17-ac4d-4275-b76b-d068aa395f51/tasks`, {
  method: 'POST', headers: H,
  body: JSON.stringify({
    title: '普通任务·泵送单元运行观察简报',
    description: '不使用任何工业工具。基于你在本频道的历史作业经验(记忆/此前任务结论),撰写一份 300 字内的《泵送单元运行观察简报》:3 条运行观察 + 1 条维护建议,markdown 格式,complete_task 交付。',
    assigneeId: '45995e22-9629-45d3-ad1a-4aba82d28aa2',
    fromLabel: '主管',
  }),
})).json()
console.log('普通任务:', t1.code, t1.data?.id ?? t1.message)

// ③ PLC+MES 混合协议产线任务
const t2 = await (await fetch(`${B}/api/workshop/channels/06e6880e-7f6a-4d86-9dd1-088944468b90/tasks`, {
  method: 'POST', headers: H,
  body: JSON.stringify({
    title: '混合协议作业·PLC+MES 双路读数与混合配方下发',
    description: '本作业横跨两种协议:PLC(Modbus TCP 数采+写控)与 MES(REST API 读写点)。\n① 用 mes_catalog 查看可用 MES 点位,再用 mes_fetch 读取 MES 熔体压力点位最近数据(引用实测数值/时间);\n② 用 daq_query 读取 PLC 侧 dn-0183240d 最近 2 分钟均值(引用实测);\n③ 两侧证据齐备后,recipe_propose 提交混合配方 rc-efd5991e 的候选包:dw-679bb3d2(PLC 加热区1SP)当前值→+1.0 小步,dw-05f6ce78(MES 泵转速写点)→58 rpm;每参数必带 basis(引用对应协议的实测数据)与 exp_ref;\n④ 等人工批准后执行,并交付两侧协议各自的下发回执/读回值对照(z1 写入后 PLC 读回值、MES 泵转速写入后读回值)。',
    assigneeId: '80dc9b41-6ae3-4dce-a185-21537f0ad7c7',
    fromLabel: '产线专家',
  }),
})).json()
console.log('混合任务:', t2.code, t2.data?.id ?? t2.message)
