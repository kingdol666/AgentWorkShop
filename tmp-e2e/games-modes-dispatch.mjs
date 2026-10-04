// 群聊游戏(猜数字 HITL question 流 / 海龟汤)+ Channel 三模式(goal/loop/pipeline)
const B = 'http://localhost:3001'
const TOK = (await (await fetch(`${B}/api/users/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'visual@awshop.local', password: 'Visual2026' }),
})).json()).data?.token
const H = { 'authorization': `Bearer ${TOK}`, 'content-type': 'application/json' }
const CH = '28ab0e17-ac4d-4275-b76b-d068aa395f51' // 线2频道(lead f46e6bc1 / worker 45995e22)
const WORKER = '45995e22-9629-45d3-ad1a-4aba82d28aa2'
const LEAD = 'f46e6bc1-51b2-46fd-b866-4ca7ffe790e9'
const post = t => fetch(`${B}/api/workshop/channels/${CH}/tasks`, { method: 'POST', headers: H, body: JSON.stringify(t) }).then(r => r.json())

const guess = await post({
  title: '群聊游戏·猜数字(1-100,HITL 问答)',
  description: '我心里有一个 1~100 的整数,你来猜。规则:调用 ask 工具向我提问,一次只报一个数字;我会回答「大了」「小了」「正确」之一。请用二分策略,猜中(收到「正确」)后立即 complete_task,交付:你猜的序列 + 每次我的答复。除 ask 外不要用其他工具。',
  assigneeId: WORKER, fromLabel: '主持人',
})
console.log('猜数字:', guess.code, guess.data?.id ?? guess.message)

const soup = await post({
  title: '群聊游戏·海龟汤(推理问答)',
  description: '海龟汤推理。汤面:男人走进海边餐厅,点了一碗海龟汤,喝了一口之后他起身回家自杀了,为什么?规则:用 ask 工具向我提出是非题(我只答「是」「不是」「无关」),每次 1~2 题,至少 6 轮;当你有足够把握时,先给出你推理的完整故事线,然后 complete_task 交付:关键问答记录 + 最终汤底。不要编造我的回答,只依据我实际答复推理。',
  assigneeId: WORKER, fromLabel: '出题人',
})
console.log('海龟汤:', soup.code, soup.data?.id ?? soup.message)

const pipeline = await post({
  title: '三模式验证·pipeline(取数→复核两阶段)',
  description: '阶段作业演示。',
  mode: 'pipeline',
  modeConfig: { stages: [
    { name: '取数', description: '用 daq_query 读取 dn-121838ac 最近 3 分钟数据,交付均值/min/max/std 统计(引用数值)。', assigneeId: WORKER },
    { name: '复核', description: '独立复算上游统计是否可信(自己再取一次数对比),给出 采信/存疑 结论。', assigneeId: LEAD },
  ] },
  fromLabel: '流程验证',
})
console.log('pipeline:', pipeline.code, pipeline.data?.id ?? pipeline.message)

const loop = await post({
  title: '三模式验证·loop(2 轮巡检)',
  description: '每轮:用 daq_query 读取 dn-121838ac 最新 1 分钟均值,一行汇报「第N轮=xx.xx MPa」。',
  mode: 'loop',
  modeConfig: { intervalMs: 60_000, maxIterations: 2 },
  assigneeId: WORKER, fromLabel: '流程验证',
})
console.log('loop:', loop.code, loop.data?.id ?? loop.message)

const goal = await post({
  title: '三模式验证·goal(单轮即达标)',
  description: '用 daq_query 读取 dn-121838ac 最近 2 分钟数据并交付一行结论(均值+std,引用数值)。',
  mode: 'goal',
  modeConfig: { goalCriteria: '交付物包含 dn-121838ac 的均值数值与 std' },
  assigneeId: WORKER, fromLabel: '流程验证',
})
console.log('goal:', goal.code, goal.data?.id ?? goal.message)
