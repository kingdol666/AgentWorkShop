// 下发两个优化任务(并行,不同工况不同 GOAL)
const B = 'http://localhost:3001'
const TOK = (await (await fetch(`${B}/api/users/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'visual@awshop.local', password: 'Visual2026' }),
})).json()).data?.token
const H = { 'authorization': `Bearer ${TOK}`, 'content-type': 'application/json' }
const api = async (m, u, b) => {
  const r = await fetch(B + u, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) })
  return r.json()
}

const taskA = await api('POST', '/api/workshop/channels/06e6880e-7f6a-4d86-9dd1-088944468b90/tasks', {
  title: '工况A·熔体温度提档达标(GOAL 3min均值 ≥202.5℃)',
  description: [
    '当前工况:产线运行中(配方 演示配方1,zone1-SP=190℃,已稳定)。你绑定 dn-0183240d(熔体温度,℃)与 dn-a41c49cc(晶点计数)。',
    '目标(GOAL):dn-0183240d 最近 3 分钟窗均值 ≥ 202.5℃,且 dn-a41c49cc 晶点计数不触发越限报警(护栏)。',
    '手段:配方 rc-bbab24bc 的参数 dw-679bb3d2(zone1-SP,当前 190,单步 ≤5)。',
    '作业纪律:',
    '1. 先 daq_query 观察 ≥2 个采样窗(引用具体均值/时间窗)再提案;',
    '2. recipe_propose 提交整包方案:每参数必带 basis(引用点位/时间窗/数值)与 exp_ref;方案名说清意图;',
    '3. 配方为 manual 模式:等人工审批,批准附言与拒绝意见都要逐字吸收;',
    '4. 每步执行后等约 4 分钟工艺惯性,再 daq_query 复测判读;达标用 complete_task 交付:各步 SP→均值对照表 + 结论;',
    '5. 若观察到数据异常漂移(工况可能变化),如实报告所见数值,按新工况重新评估 —— 严禁编造或沿用旧工况结论。',
  ].join('\n'),
  assigneeId: '80dc9b41-6ae3-4dce-a185-21537f0ad7c7',
  fromLabel: '产线专家',
})
console.log('TaskA', taskA.code, taskA.data?.id ?? taskA.message)

const taskB = await api('POST', '/api/workshop/channels/28ab0e17-ac4d-4275-b76b-d068aa395f51/tasks', {
  title: '工况B·泵压下调(GOAL 3min均值 ≤15.8 MPa)',
  description: [
    '当前工况:产线运行中(配方 演示配方2 v4,screw-SP=139rpm,泵压约 16.7 MPa)。你绑定 dn-121838ac(MeltPressure,MPa)。',
    '目标(GOAL):dn-121838ac 最近 3 分钟窗均值 ≤ 15.8 MPa(下游切换低粘度牌号,需要降泵送压力),同时保持波动 std ≤ 0.5。',
    '手段:配方 rc-8f9cb3d9 的参数 dw-38f145fe(ScrewSpeedSP,当前 139,单步 ≤3,量程 50~200)。',
    '作业纪律:',
    '1. 先 daq_query 观察 ≥2 个采样窗(引用具体均值/时间窗)再提案;',
    '2. recipe_propose 提交整包方案:每参数必带 basis(引用点位/时间窗/数值)与 exp_ref;',
    '3. 配方为 manual 模式:等人工审批,批准附言与拒绝意见都要逐字吸收;',
    '4. 每步执行后等约 4 分钟工艺惯性,再 daq_query 复测;达标用 complete_task 交付:screw→压力对照表 + 波动统计(std)+ 结论;',
    '5. 上一轮经验(配方版本史 rc-8f9cb3d9):screw 125→16.1 / 130→16.4 / 136→16.7 / 139→16.73 MPa,可作 exp_ref 先验,但必须用本轮实测校准。',
  ].join('\n'),
  assigneeId: '45995e22-9629-45d3-ad1a-4aba82d28aa2',
  fromLabel: '产线专家',
})
console.log('TaskB', taskB.code, taskB.data?.id ?? taskB.message)
