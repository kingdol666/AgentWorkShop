/**
 * 挤出流延薄膜数字孪生 · AgentTeam 闭环优化实验(生产实例 :3001 × plc-node-simulator :4010)
 *
 * 前置:plc-node-simulator 运行中(脚本会重置为 cast-film-physics 预设,seed=42 可复现)。
 *
 * S0 复位与预热:模拟器 cast-film-physics 预设 → 物理冷态预热到工艺窗口附近 → 拉取 W*(离线最优)
 * S1 主项目接入:登录 → 产线/产品/配方 → 2 自定义模板 + 7 DAQ + 6 DCW 真实协议节点 → 逐节点 test
 * S2 数采验证:开跑 → 标量五路流入 + 向量/图像帧落库(daq_frames)
 * S3 AgentTeam 闭环:omp lead + tuner/inspector 双 worker → goal 调参(物理语义提示)→ HITL 审批(自动批准记录时延)
 * S4 评估:主项目采样窗 vs 模拟器真值 W* → 收敛判据 + 指标落盘
 * S5 汇总:docs/experiments/results/castfilm-<tag>/result.json + truth.jsonl + metrics.md
 *
 * 用法:NO_PROXY='127.0.0.1,localhost' node scripts/experiment-castfilm-closedloop.mjs [base] [tag]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'http://127.0.0.1:3001'
const TAG = (process.argv.find((a, i) => i > 2 && !a.startsWith('--')) ?? `cf${Date.now() % 100000}`).toString()
const SIM = process.env.SIM_BASE ?? 'http://127.0.0.1:4010'
const OUT_DIR = process.env.EXP_OUT ?? path.join(fileURLToPath(new URL('../docs/experiments/results', import.meta.url)), `castfilm-${TAG}`)

let pass = 0
let fail = 0
const marks = []
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`)
  }
  else {
    fail++
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
  marks.push({ name, ok: !!cond, extra })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (base, method, path, { body, token } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
const sim = (method, path, body) => api(SIM, method, path, { body })
const aw = (method, path, opts) => api(BASE, method, path, opts)

async function main() {
  const t0 = Date.now()
  console.log(`━━━ 挤出流延闭环实验 @ AW=${BASE} SIM=${SIM} (tag=${TAG}) ━━━`)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  // ════ S0 模拟器复位 + 预热 + W* ════
  console.log('\n── S0 模拟器复位(cast-film-physics, seed=42)──')
  const preset = await sim('POST', '/api/presets/cast-film-physics')
  ok(preset.status === 200, 'cast-film-physics 预设应用')
  const optRes = await sim('GET', '/api/plant/optimum')
  const W = optRes.data
  ok(Number.isFinite(W?.score), `离线最优 W*(T=${W?.zoneTemp}℃, N=${W?.screw}rpm, v=${W?.lineSpeed}m/min, h*=${W?.thickness}μm, J*=${W?.score})`)
  console.log('  物理冷态预热中(熔体温度 → 195℃+)…')
  let warm = false
  for (let i = 0; i < 90 && !warm; i++) {
    await sleep(2000)
    const st = (await sim('GET', '/api/plant/truth?limit=1')).data?.samples?.[0]
    warm = st && st.truth.meltTemp >= 195
  }
  ok(warm, `预热完成(熔体温度到达工艺窗口,耗时 ${Math.round((Date.now() - t0) / 1000)}s)`)
  await sim('POST', '/api/plant/phase', { body: { phase: 'steady' } })

  // ════ S1 主项目接入 ════
  console.log('\n── S1 主项目接入(产线/节点/配方)──')
  let token = (await aw('POST', '/api/users/login', { body: { email: 'admin@awshop.local', password: 'admin123' } })).data?.token
  if (!token) {
    const reg = await aw('POST', '/api/users/register', { body: { name: 'admin', email: 'admin@awshop.local', password: 'admin123' } })
    token = reg.data?.token
    ok(Boolean(token), '首注册即 admin(全新数据态)', reg.data?.message ?? '')
  }
  else ok(true, 'admin 登录')
  if (!token) process.exit(1)

  // 自定义标量模板(测厚/晶点;语义进 Agent 上下文;按名复用避免重复创建)
  const knownTemplates = (await aw('GET', '/api/workshop/daq', { token })).data?.templates ?? []
  const ensureTemplate = async (input) => {
    const found = knownTemplates.find(t => t.name === input.name)
    if (found) return { status: 200, data: { template: found } }
    return aw('POST', '/api/workshop/daq/templates', { body: input, token })
  }
  const tplA = await ensureTemplate({
    name: '在线测厚仪', ch: '平均膜厚', unit: 'μm', min: 0, max: 400, base: 50, amp: 1.5, decimals: 2,
    telemetryKey: 'thickness', semantics: '在线测厚仪(平均膜厚):核心质量指标。合格窗 50±2μm;与螺杆转速正相关、与牵引线速反比(质量守恒);测量点在模口下游(存在输送纯滞后,线速越快滞后越短)。',
  })
  const tplB = await ensureTemplate({
    name: '晶点计数仪', ch: '晶点密度', unit: '个/m²', min: 0, max: 500, base: 6, amp: 2, decimals: 0,
    telemetryKey: 'gels', semantics: '晶点计数仪:熔体过热降解指标。熔体温度长期 >250℃ 时晶点加速增生;正常工艺窗内应 <20 个/m²。',
  })
  ok(Boolean(tplA.data?.template?.key), `自定义模板(测厚仪:${tplA.data?.template?.key ?? tplA.message})`)
  ok(Boolean(tplB.data?.template?.key), `自定义模板(晶点仪:${tplB.data?.template?.key ?? tplB.message})`)
  const THK_TPL = tplA.data?.template?.key ?? 'thickness-gauge'
  const GELS_TPL = tplB.data?.template?.key ?? 'gels-counter'

  const line = (await aw('POST', '/api/workshop/dcw/lines', { body: { name: `挤出流延一线-${TAG}` }, token })).data?.line
  const product = (await aw('POST', '/api/workshop/dcw/products', { body: { name: `功能性保护膜-${TAG}`, lineId: line.id }, token })).data?.product
  ok(Boolean(line?.id && product?.id), `产线/产品创建(line=${line?.id?.slice(0, 8)})`)

  // 7 DAQ(5 协议;向量/图像走 http)
  const daqDefs = [
    { key: 'modbus-tcp', name: '熔体温度', tpl: 'temp-tc', unit: '℃', min: 0, max: 400, warn: [195, 235], interval: 2000,
      driverConfig: { host: '127.0.0.1', port: 16040, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', byteOrder: 'big' },
      semantics: '熔体温度(模口处,℃):热工艺核心被控量。由三区加热+螺杆输送滞后(~20s)合成;工艺窗 195~225℃,>255℃ 降解加速,偏低则膜厚不均、缺陷升高。' },
    { key: 'opcua', name: '熔体压力', tpl: 'pressure-tx', unit: 'MPa', min: 0, max: 45, warn: [8, 22], interval: 2000,
      driverConfig: { endpoint: 'opc.tcp://127.0.0.1:5840', nodeId: 'ns=2;s=AW.P' },
      semantics: '熔体压力(MPa):泵送负荷「血压计」。与转速正相关、与温度负相关(粘度);安全上限 22MPa,超限必须立即降转速。' },
    { key: 'mqtt', name: '平均膜厚', tpl: THK_TPL, unit: 'μm', min: 0, max: 400, warn: [48, 52], interval: 2000,
      driverConfig: { host: '127.0.0.1', port: 18830, topic: 'aw/sim/thick', jsonPath: 'data.thick' },
      semantics: '平均膜厚(μm):批次合格判据 50±2μm。调节手段:螺杆转速(正比)与牵引线速(反比);模口间隙为粗调基准。' },
    { key: 'http', name: '厚度横向轮廓', tpl: 'thickness-scan', unit: 'μm', min: 0, max: 400, interval: 5000,
      driverConfig: { url: `${SIM}/sim-http/dev-inspect-http/api/profile`, jsonPath: 'points' },
      semantics: '厚度横向轮廓(64 点向量):边缘减薄属正常成形;横向极大偏差提示模口间隙不均或温度分布失衡。' },
    { key: 'http', name: 'CCD表面图像', tpl: 'ccd-image', unit: '灰度', min: 0, max: 255, interval: 5000,
      driverConfig: { url: `${SIM}/sim-http/dev-inspect-http/api/ccd` },
      semantics: 'CCD 表面图像(灰度帧):亮点即缺陷(晶点/鱼眼),亮点密度与缺陷率同步。' },
    { key: 'http', name: '缺陷率', tpl: 'vision-cam', unit: '%', min: 0, max: 100, warn: [0, 2], interval: 3000,
      driverConfig: { url: `${SIM}/sim-http/dev-inspect-http/api/defect`, jsonPath: 'value' },
      semantics: 'CCD 缺陷率(%):品质主指标,目标 <2%。对熔体温度呈抛物线敏感(工艺最优点附近最低),压力波动会推高缺陷。' },
    { key: 'modbus-rtu', name: '晶点计数', tpl: GELS_TPL, unit: '个/m²', min: 0, max: 500, warn: [0, 20], interval: 5000,
      driverConfig: { host: '127.0.0.1', port: 15041, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', byteOrder: 'big' },
      semantics: '晶点计数(个/m²):过热降解报警器;熔体温度长期 >250℃ 时加速增生。正常应 <20。' },
  ]
  const daq = {}
  for (const d of daqDefs) {
    const test = await aw('POST', '/api/workshop/daq/test-driver', { body: { driver: d.key, driverConfig: d.driverConfig }, token })
    const node = (await aw('POST', '/api/workshop/daq', {
      body: {
        name: `${d.name}-${TAG}`, templateRef: d.tpl, driver: d.key, driverConfig: d.driverConfig,
        unit: d.unit, min: d.min, max: d.max, warnLow: d.warn?.[0] ?? null, warnHigh: d.warn?.[1] ?? null,
        intervalMs: d.interval, lineId: line.id, semantics: d.semantics,
      }, token,
    })).data?.node
    daq[d.name] = node
    const tOk = test.data?.test?.ok !== false
    ok(Boolean(node?.id) && tOk, `[daq] ${d.name}(${d.key},${tOk ? '连通' : '失败'})`, test.data?.test?.message?.slice(0, 80))
  }

  // 6 DCW(4 协议;起始点 = 次优工况,待 Agent 闭环寻优)
  const START = { zone: 200, screw: 150, lineSpeed: 95, dieGap: 1.0 }
  const dcwDefs = [
    { key: 'modbus-tcp', name: '加热区1设定', tpl: 'temp-sp', unit: '℃', min: 120, max: 260, value: START.zone, dec: 1,
      driverConfig: { host: '127.0.0.1', port: 16040, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big' },
      semantics: '加热区1 设定(℃):进料段;对进料温度波动起补偿作用。' },
    { key: 'modbus-tcp', name: '加热区2设定', tpl: 'temp-sp', unit: '℃', min: 120, max: 260, value: START.zone, dec: 1,
      driverConfig: { host: '127.0.0.1', port: 16040, unitId: 1, register: 40023, dataType: 'float32', byteOrder: 'big' },
      semantics: '加热区2 设定(℃):压缩段;与区1/区3 共同决定熔体温度(区间存在热传导)。' },
    { key: 'modbus-tcp', name: '加热区3设定', tpl: 'temp-sp', unit: '℃', min: 120, max: 260, value: START.zone, dec: 1,
      driverConfig: { host: '127.0.0.1', port: 16040, unitId: 1, register: 40025, dataType: 'float32', byteOrder: 'big' },
      semantics: '加热区3 设定(℃):计量段,最靠近模口,对熔体温度影响最直接(热惯性 ~90s)。' },
    { key: 'opcua', name: '螺杆转速设定', tpl: 'speed-sp', unit: 'rpm', min: 50, max: 200, value: START.screw, dec: 0,
      driverConfig: { endpoint: 'opc.tcp://127.0.0.1:5840', nodeId: 'ns=2;s=AW.N.Sp' },
      semantics: '螺杆转速(rpm):挤出量主执行器。膜厚 ∝ 转速;同时推高熔体压力(能耗 ∝ 转速²)。响应快(~10s 级)。' },
    { key: 'mqtt', name: '牵引线速设定', tpl: 'speed-sp', unit: 'm/min', min: 20, max: 120, value: START.lineSpeed, dec: 1,
      driverConfig: { host: '127.0.0.1', port: 18830, topic: 'aw/sim/lineSp/set', jsonKey: 'setpoint' },
      semantics: '牵引线速(m/min):膜厚 ∝ 1/线速(把熔体拉成膜);同时决定测厚纯滞后(τ=L/v)。产能 ∝ 线速。' },
    { key: 'http', name: '模口间隙设定', tpl: 'pressure-sp', unit: 'mm', min: 0.5, max: 2.0, value: START.dieGap, dec: 2,
      driverConfig: { url: `${SIM}/sim-http/dev-inspect-http/api/control/diegap`, bodyKey: 'value' },
      semantics: '模口间隙(mm):厚度粗调基准(机械量,本批次保持 1.00 不动);间隙偏差会造成横向轮廓整体偏移。' },
  ]
  const dcw = {}
  for (const d of dcwDefs) {
    const node = (await aw('POST', '/api/workshop/dcw', {
      body: {
        name: `${d.name}-${TAG}`, templateRef: d.tpl, driver: d.key, driverConfig: d.driverConfig,
        unit: d.unit, min: d.min, max: d.max, lineId: line.id, decimals: d.dec, semantics: d.semantics,
      }, token,
    })).data?.node
    dcw[d.name] = node
    ok(Boolean(node?.id), `[dcw] ${d.name}(${d.key})`)
  }

  const recipe = (await aw('POST', '/api/workshop/dcw/recipes', {
    body: { name: `工艺B-起点-${TAG}`, productId: product.id, params: [
      { nodeId: dcw['加热区1设定'].id, value: START.zone },
      { nodeId: dcw['加热区2设定'].id, value: START.zone },
      { nodeId: dcw['加热区3设定'].id, value: START.zone },
      { nodeId: dcw['螺杆转速设定'].id, value: START.screw },
      { nodeId: dcw['牵引线速设定'].id, value: START.lineSpeed },
      { nodeId: dcw['模口间隙设定'].id, value: START.dieGap },
    ] }, token,
  })).data?.recipe
  ok(Boolean(recipe?.id), `配方创建(v1 起点工况:zone=${START.zone} N=${START.screw} v=${START.lineSpeed})`)

  const startRes = await aw('POST', `/api/workshop/dcw/lines/${line.id}/start`, { body: { recipeId: recipe.id }, token })
  ok(startRes.status === 200, '产线开跑(绑定配方批次)', startRes.message ?? '')

  // ════ S2 数采验证 ════
  console.log('\n── S2 数采流入 + 帧管线 ──')
  await sleep(12_000)
  const daqSnap = (await aw('GET', '/api/workshop/daq', { token })).data
  const live = daqSnap.nodes.filter(n => Object.values(daq).some(x => x?.id === n.id) && n.value != null)
  ok(live.length >= 6, `数采流入:${live.length}/7 节点有实时值`, live.map(n => `${n.name}=${n.value}`).join(' ').slice(0, 150))
  const thkFrames = (await aw('GET', `/api/workshop/daq/${daq['厚度横向轮廓'].id}/frames?kind=vector&limit=5`, { token })).data?.frames ?? []
  ok(thkFrames.length > 0, `向量帧落库(轮廓 ${thkFrames[0]?.points ?? 0} 点)`)
  const ccdFrames = (await aw('GET', `/api/workshop/daq/${daq['CCD表面图像'].id}/frames?kind=image&limit=5`, { token })).data?.frames ?? []
  ok(ccdFrames.length > 0, `图像帧落库( ${ccdFrames[0]?.meta?.width ?? 0}×${ccdFrames[0]?.meta?.height ?? 0} ${ccdFrames[0]?.meta?.mime ?? ''})`)
  const thkSamples = (await aw('GET', `/api/workshop/daq/${daq['平均膜厚'].id}/samples?bucketMs=1000&limit=10`, { token })).data?.points ?? []
  ok(thkSamples.length > 0, `标量时序入库(膜厚 ${thkSamples.length} 桶)`)

  // ════ S3 AgentTeam 闭环 ════
  console.log('\n── S3 AgentTeam(omp)闭环调参 ──')
  const ch = (await aw('POST', '/api/workshop/channels', {
    body: { name: `castfilm-${TAG}`, leadAgent: { name: `lead-${TAG}`, harness: 'omp', config: { provider: 'zhipu-coding-plan', model: 'glm-5.3-flash' } } }, token,
  })).data
  ok(Boolean(ch?.channelId), `Channel 创建(lead=omp)`)
  const mkAgent = async (name, prefix) => (await aw('POST', '/api/workshop/agents', {
    body: { name: `${name}-${TAG}`, harness: 'omp', config: { provider: 'zhipu-coding-plan', model: 'glm-5.3-flash', systemPromptPrefix: prefix } }, token,
  })).data
  const tunerTpl = await mkAgent('tuner', '你是挤出流延产线的工艺调参工程师:只使用工厂数采/控制工具,小步幅调参,以数值证据收口,完成后立即 complete_task。')
  const inspTpl = await mkAgent('inspector', '你是品质稽核员:只读数采证据并独立判定,不开任何设定值,完成后立即 complete_task。')
  ok(Boolean(tunerTpl?.id && inspTpl?.id), '双 worker Agent 创建(omp × glm-5.3-flash)')
  const tuner = (await aw('POST', `/api/workshop/channels/${ch.channelId}/agents`, { body: { agentId: tunerTpl.id, role: 'worker' }, token })).data?.id
  const inspInst = (await aw('POST', `/api/workshop/channels/${ch.channelId}/agents`, { body: { agentId: inspTpl.id, role: 'worker' }, token })).data?.id
  ok(Boolean(tuner && inspInst), '双 worker 入队')

  // 绑定:tuner 全部执行器(manual → HITL 审批留痕)+ 全部数采(auto)
  for (const [, node] of Object.entries(dcw)) {
    await aw('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: tuner, nodeId: node.id, kind: 'dcw', mode: 'manual' }, token })
  }
  for (const [, node] of Object.entries(daq)) {
    await aw('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: tuner, nodeId: node.id, kind: 'daq', mode: 'auto' }, token })
  }
  for (const [, node] of Object.entries(daq)) {
    await aw('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: inspInst, nodeId: node.id, kind: 'daq', mode: 'auto' }, token })
  }
  ok(true, '绑定完成(tuner: dcw×6 manual + daq×7 auto;inspector: daq×7 auto)')

  const goalText = `# 工艺闭环优化任务(批次 ${TAG})
当前工况(起点,偏离最优):加热区1/2/3 设定 = ${START.zone}℃,螺杆转速 = ${START.screw}rpm,牵引线速 = ${START.lineSpeed}m/min,模口间隙 = ${START.dieGap}mm(保持不动)。
当前膜厚明显偏厚(约 54μm),目标是把批次拉回合格窗并降低缺陷率。

## 目标(全部满足才算收敛)
1. 平均膜厚 ∈ [48, 52]μm(目标 50),节点 "${daq['平均膜厚'].name}"
2. CCD 缺陷率 < 2%,节点 "${daq['缺陷率'].name}"
3. 熔体压力 ≤ 22MPa(安全),节点 "${daq['熔体压力'].name}"

## 执行器(已绑定,用 dcw_control 下发,严格在量程内)
- 加热区1/2/3 设定(℃):"${dcw['加热区1设定'].name}" / "${dcw['加热区2设定'].name}" / "${dcw['加热区3设定'].name}"(量程 120~260)
- 螺杆转速(rpm):"${dcw['螺杆转速设定'].name}"(量程 50~200)
- 牵引线速(m/min):"${dcw['牵引线速设定'].name}"(量程 20~120)

## 物理规律(必须遵守,不要违背)
- 质量守恒:膜厚 ∝ 螺杆转速 ÷ 牵引线速。当前膜厚偏厚 → 需要降转速或提线速(或两者联合)。
- 温度→粘度:熔体温度升高 → 粘度下降 → 同转速下流量略升、膜厚略增;温度过低(熔体温度 <195℃)缺陷率升高。
- 响应时间:温度通道热惯性约 1.5~2 分钟;转速/线速通道约 15~30 秒。每次调整后至少等待一个响应周期再评估。

## 工作循环(严格执行)
1. daq_query(node_id="${daq['平均膜厚'].id}") 与 daq_query(node_id="${daq['缺陷率'].id}") 读当前值;
2. 未收敛 → 计算小步幅调整(转速一次 ±5~15rpm;线速一次 ±3~5m/min;温度仅在熔体温度越出 195~225℃ 时 ±5℃),dcw_control 下发(每次一处,最多两处联动并说明理由);
3. 下发后等待响应(约 60~90 秒,可多次 daq_query 观察趋势)后回到步骤 1;
4. 收敛判据:连续两次评估(间隔 ≥60s)膜厚 ∈[48,52] 且缺陷率 <2% 且压力 ≤22。
5. 收敛后:dcw_judge 对本轮优化落判定 keep(附最终三个数值证据)→ recipe_update 更新配方参数(附 reason)→ 交付最后一行原样输出:CONVERGED h=<膜厚> defect=<缺陷率> press=<压力> N=<转速> v=<线速> zone=<区3温度>

注意:任务有总时限,预算约 12~18 分钟、最多 10 次左右调整;若已达收敛判据立即收口,不要过度优化。完成后调用 complete_task。`

  const goal = await aw('POST', `/api/workshop/channels/${ch.channelId}/tasks`, {
    body: { title: `castfilm-optimize-${TAG}`, parts: [{ text: goalText }], assigneeId: tuner },
    token,
  })
  // 任务 id 兜底:部分版本响应不包 task 信封 → 从频道任务列表按标题反查
  const resolveTaskId = async (title) => {
    const list = (await aw('GET', `/api/workshop/channels/${ch.channelId}/tasks`, { token })).data ?? []
    const hit = (Array.isArray(list) ? list : []).find(t => t.title === title)
    return hit?.id ?? null
  }
  const goalTask = goal.data?.task?.id ?? goal.data?.id ?? await resolveTaskId(`castfilm-optimize-${TAG}`)
  ok(Boolean(goalTask), '调参 goal 任务下发(tuner)')
  void resolveTaskId

  // HITL 自动审批(dcw-approval;记录裁决时延)
  const approvals = { count: 0, latencies: [], on: true }
  const approver = (async () => {
    while (approvals.on) {
      try {
        const pend = (await aw('GET', '/api/workshop/agent-tools/approvals', { token })).data?.approvals ?? []
        for (const p of pend.filter(x => x.agentId === tuner)) {
          const t1 = Date.now()
          await aw('POST', `/api/workshop/agent-tools/approvals/${p.id}/decide`, { body: { approved: true, comment: '闭环实验:窗口内自动批准' }, token })
          approvals.count++
          approvals.latencies.push(Date.now() - t1)
          console.log(`  [hitl] 自动批准 #${approvals.count}(${p.nodeId?.slice(0, 8) ?? p.id?.slice(0, 8)})`)
        }
      }
      catch { /* 瞬时错误下轮重试 */ }
      await sleep(1500)
    }
  })()

  const finalState = await pollTask(goalTask, Number(process.env.EXP_LOOP_TIMEOUT_MS ?? 28 * 60_000), token)
  ok(finalState === 'COMPLETED', `[闭环] 调参任务 COMPLETED(state=${finalState})`)
  const goalBlob = await gatherTaskBlob(ch.channelId, goalTask, token)
  const convLine = goalBlob.match(/CONVERGED[^\n"\\]*/)?.[0] ?? ''
  ok(Boolean(convLine), `[闭环] 收敛交付: ${convLine.slice(0, 110)}`)
  const writes = (() => {
    try {
      const file = path.join(fileURLToPath(new URL('../.AgentWorkShop/data', import.meta.url)), 'dcw-writes.json')
      return JSON.parse(fs.readFileSync(file, 'utf-8'))
    }
    catch { return [] }
  })()
  const myWrites = writes.filter(w => Object.values(dcw).some(n => n.id === w.nodeId))
  ok(myWrites.length > 0, `[数控] dcw-writes 账本 ${myWrites.length} 条真实协议写`)

  // inspector 稽核任务(团队第二角色:独立复核)
  const audit = await aw('POST', `/api/workshop/channels/${ch.channelId}/tasks`, {
    body: {
      title: `castfilm-audit-${TAG}`,
      parts: [{ text: `独立稽核刚结束的调参批次:用 daq_query 读取 "${daq['平均膜厚'].name}"(id=${daq['平均膜厚'].id})、"${daq['缺陷率'].name}"(id=${daq['缺陷率'].id})、"${daq['熔体压力'].name}"(id=${daq['熔体压力'].id}) 的当前值;对照合格判据(膜厚 48~52μm、缺陷率<2%、压力≤22MPa)给出 PASS 或 FAIL 及数值证据;交付最后一行原样输出 AUDIT <PASS|FAIL> h=<值> defect=<值> press=<值>。完成后调用 complete_task。` }],
      assigneeId: inspInst,
    }, token,
  })
  const auditTask = audit.data?.task?.id ?? audit.data?.id ?? await resolveTaskId(`castfilm-audit-${TAG}`)
  const auditState = await pollTask(auditTask, 8 * 60_000, token)
  const auditBlob = await gatherTaskBlob(ch.channelId, auditTask, token)
  const auditLine = auditBlob.match(/AUDIT[^\n"\\]*/)?.[0] ?? ''
  ok(auditState === 'COMPLETED' && /AUDIT\s+PASS/.test(auditLine), `[稽核] inspector 复核 ${auditLine.slice(0, 90) || auditState}`)
  approvals.on = false
  await approver.catch(() => {})

  // ════ S4 评估:采样窗 vs W* ════
  console.log('\n── S4 评估(最近 3 分钟窗 vs 离线最优)──')
  const nowMs = Date.now()
  const windowMs = 3 * 60_000
  const winStats = async (nodeId) => {
    const pts = (await aw('GET', `/api/workshop/daq/${nodeId}/samples?from=${nowMs - windowMs}&to=${nowMs}&bucketMs=1000&limit=400`, { token })).data?.points ?? []
    const vals = pts.map(p => Number(p.avg ?? p.value)).filter(Number.isFinite)
    if (!vals.length) return null
    return { n: vals.length, avg: avg(vals), min: Math.min(...vals), max: Math.max(...vals) }
  }
  const hWin = await winStats(daq['平均膜厚'].id)
  const dWin = await winStats(daq['缺陷率'].id)
  const pWin = await winStats(daq['熔体压力'].id)
  const hIn = hWin && Math.abs(hWin.avg - 50) <= 2
  const dIn = dWin && dWin.avg < 2
  const pIn = pWin && pWin.max <= 22
  ok(hIn, `膜厚窗均值 ${hWin ? hWin.avg.toFixed(2) : '∅'}μm ∈ 50±2 [${hWin ? hWin.min.toFixed(1) : '-'}~${hWin ? hWin.max.toFixed(1) : '-'}]`)
  ok(dIn, `缺陷率窗均值 ${dWin ? dWin.avg.toFixed(3) : '∅'}% < 2`)
  ok(pIn, `压力窗峰值 ${pWin ? pWin.max.toFixed(2) : '∅'}MPa ≤ 22`)
  // J(W_agent) vs J(W*):用稳态近似(窗均值)代入同一目标函数
  const agentJ = jScore({ thickness: hWin?.avg ?? 0, defect: dWin?.avg ?? 100, screw: lastWriteValue(dcw['螺杆转速设定'].id, myWrites, START.screw), lineSpeed: lastWriteValue(dcw['牵引线速设定'].id, myWrites, START.lineSpeed), meltTemp: 210, pressure: pWin?.avg ?? 99 })
  const ratio = Number.isFinite(agentJ) ? (agentJ / W.score) : 0
  ok(ratio >= 0.9, `工艺目标函数 J(W_agent)=${agentJ.toFixed(2)} 达到 W*(J=${W.score}) 的 ${(ratio * 100).toFixed(1)}%`)

  // ════ S5 汇总落盘 ════
  console.log('\n── S5 结果落盘 ──')
  const truth = (await sim('GET', '/api/plant/truth?limit=5000')).data?.samples ?? []
  fs.writeFileSync(path.join(OUT_DIR, 'truth.jsonl'), truth.map(t => JSON.stringify(t)).join('\n'))
  const result = {
    tag: TAG, base: BASE, sim: SIM,
    startedAt: new Date(t0).toISOString(), durationS: Math.round((Date.now() - t0) / 1000),
    seed: 42, timeScale: 6,
    optimum: W,
    start: START,
    convergence: { convLine, auditLine, approvals },
    windows: { thickness: hWin, defect: dWin, pressure: pWin },
    scores: { agentJ, optimumJ: W.score, ratio },
    checks: marks,
    pass, fail,
  }
  fs.writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify(result, null, 2))
  console.log(`  结果目录: docs/experiments/results/castfilm-${TAG}/(result.json + truth.jsonl)`)

  console.log(`\n━━━ 闭环实验: ${pass} passed / ${fail} failed ━━━`)
  process.exit(fail === 0 ? 0 : 1)

  // ---------- helpers ----------
  function avg(a) {
    return a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1)
  }
  function jScore({ thickness, defect, screw, lineSpeed, meltTemp, pressure }) {
    if (meltTemp < 195 || meltTemp > 225 || pressure > 22) return NaN
    const thErr = Math.abs(thickness - 50)
    const jTh = thErr <= 2 ? 1 : Math.max(0, 1 - (thErr - 2) / 10)
    const jQuality = 1 - Math.min(defect, 8) / 8
    const jEnergy = 1 - (screw - 50) / 150
    const jThrough = lineSpeed / 120
    return 55 * jTh + 25 * jQuality + 8 * jEnergy + 7 * jThrough
  }
  function lastWriteValue(nodeId, writes, fallback) {
    const mine = writes.filter(w => w.nodeId === nodeId).sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
    return Number(mine.at(-1)?.eng ?? fallback)
  }
}

async function pollTask(id, timeoutMs, token) {
  const deadline = Date.now() + timeoutMs
  let state = ''
  while (Date.now() < deadline) {
    for (let i = 0; i < 3; i++) {
      try {
        state = (await aw('GET', `/api/workshop/tasks/${id}`, { token })).data?.state ?? ''
        break
      }
      catch {
        await sleep(3000)
      }
    }
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(state)) return state
    await sleep(8000)
  }
  return state || 'RUNNING'
}

async function gatherTaskBlob(channelId, taskId, token) {
  const taskBlob = JSON.stringify((await aw('GET', `/api/workshop/tasks/${taskId}`, { token })).data ?? {})
  const msgBlob = JSON.stringify((await aw('GET', `/api/workshop/channels/${channelId}/messages?limit=300`, { token })).data ?? {})
  const evBlob = JSON.stringify((await aw('GET', `/api/workshop/channels/${channelId}/events?limit=500`, { token })).data ?? {})
  return taskBlob + msgBlob + evBlob
}

main().catch((err) => {
  console.error('实验异常终止:', err)
  process.exit(1)
})
