import { readFileSync, writeFileSync } from 'node:fs'
const p = 'scripts/_audit/wwtp-staged-live.mjs'
let t = readFileSync(p, 'utf8')
const R = [
  // 证据目录
  ["join(REPO, 'docs/audit/evidence/2026-11-08-skill-staged-cal3')", "join(REPO, 'docs/audit/evidence/2026-11-08-e2e-wwtp')"],
  // S0-2 标签
  ["step('S0-2', '现场上下文(一区温度SP)'", "step('S0-2', '现场上下文(鼓风机频率SP)'"],
  // W2 方向: +2 Hz(升曝气降氨氮); 去掉 emergency
  ['const targetW2 = Math.min(850, Math.max(700, Number((preTrialVal - 8).toFixed(1))))', 'const targetW2 = Math.min(50, Math.max(20, Number((preTrialVal + 2).toFixed(1))))'],
  ['hypothesis: `W2 依据 W1 结论:一区温度 ${preTrialVal.toFixed(1)}→${targetW2}(Δ-8),HITL 逐动作审批`, emergency: true }', 'hypothesis: `W2 依据 W1 结论:鼓风机频率 ${preTrialVal.toFixed(1)}→${targetW2}(Δ+2),HITL 逐动作审批` }'],
  ['  const targetW2 = Number((cur0 - 8).toFixed(1))', '  // targetW2 已在 W2 块上方固化(argsW2)'],
  // W1 文案
  ['`W1 诊断结论(${new Date().toISOString().slice(0, 16)}):基于 5 分钟窗实测序列——抗拉强度均值 ${meanTensile.toFixed(1)} MPa、样本标准差 ${stdTensile.toFixed(1)}(规格 480±20);一区炉温与强度的 Pearson 相关 r=${Number.isFinite(corr) ? corr.toFixed(3) : \'NA\'}(n=${corrN},桶 5s)。${Math.abs(corr) >= 0.5 ? \'呈现中强相关,支持温度主导假设\' : \'相关性弱,温度非唯一主导因素,需更多窗口数据\'}。建议 W2 做单变量小步治理试验(≤10℃,两次调整间隔 ≥300s 已由配方 opIntervalMs 平台强制),W3 以完结批次建数据集,W4 探索档有界激励。`',
   '`W1 诊断结论(${new Date().toISOString().slice(0, 16)}):基于 5 分钟窗实测序列——出水氨氮均值 ${meanTensile.toFixed(2)} mg/L、样本标准差 ${stdTensile.toFixed(2)}(一级A ≤5,当前超标);DO 与氨氮的 Pearson 相关 r=${Number.isFinite(corr) ? corr.toFixed(3) : \'NA\'}(n=${corrN},桶 5s)。${corr <= -0.4 ? \'中强负相关,支持曝气主导假设\' : corr >= 0.4 ? \'正相关,与预期方向相反,需复核\' : \'相关性弱,DO 非唯一主导因素,需更多窗口数据\'}。建议 W2 做单变量小步治理试验(鼓风机 +2Hz,步限 2,两次调整间隔 ≥300s 已由配方 opIntervalMs 平台强制),W3 以完结批次建数据集,W4 探索档有界激励。`'],
  ['  const w1Text = `W1 诊断结论', '  const w1Text = `W1 诊断结论'],
  // W2 结论文案
  ['一区温度SP 经 write_intent(owner 批准)+ HITL 逐动作审批后下发', '鼓风机频率SP 经 write_intent(owner 批准)+ HITL 逐动作审批后下发'],
  // W3 判据: DO 方向性(PV 惯性 τ≈40s)
  ['step(\'W3-t3\', \'W3 治理后数据在场(治理时刻后炉温实测窗;PV 惯性 τ≈75s 容差放宽)\', sTreat.length >= 8 && Number.isFinite(meanTreat) && Math.abs(meanTreat - targetW2) <= 4.0,\n    `治理后窗均值=${Number.isFinite(meanTreat) ? meanTreat.toFixed(1) : \'?\'}℃(n=${sTreat.length},SP 治理值=${targetW2},PV 滞后容差 4.0)`)',
   'step(\'W3-t3\', \'W3 治理后数据在场(治理后 DO 窗实测,方向性判据)\', sTreat.length >= 8 && Number.isFinite(meanTreat) && Number.isFinite(preTreatDo) && meanTreat > preTreatDo,\n    `治理后 DO 窗均值=${Number.isFinite(meanTreat) ? meanTreat.toFixed(2) : \'?\'} mg/L(n=${sTreat.length}) vs 试验前 DO 均值 ${Number.isFinite(preTreatDo) ? preTreatDo.toFixed(2) : \'?\'}(升曝气→DO 应上行;τ≈40s)`);'],
  // W3 文案
  ['收口含治理后时段的批次(run close,零设备写,治理值 ${targetW2} 保持)', '收口含治理后时段的批次(run close,零设备写,鼓风机治理值 ${targetW2}Hz 保持)'],
  ['(control=一区炉温,target=抗拉强度)', '(control=DO,target=出水氨氮)'],
  // W4 步长/界限/文案
  ["control_node_id: SP1, target_node_id: DAQ.tensile, direction: 'up', step: stepW4, settle_seconds: 60,", "control_node_id: SP1, target_node_id: DAQ.tensile, direction: 'up', step: stepW4, settle_seconds: 60,"],
  ['  const stepW4 = 6', '  const stepW4 = 1.5'],
  ['hypothesis: `W4 探索档有界激励(模型绑定前探索阶段;非模型驱动):一区温度上行 ${stepW4}℃,有界 [700,850],步限 10℃`,', 'hypothesis: `W4 探索档有界激励(模型绑定前探索阶段;非模型驱动):鼓风机频率上行 ${stepW4}Hz,有界 [20,50],步限 2`,'],
  ['Math.abs(after4 - before - stepW4) <= 0.5 && after4 >= 700 && after4 <= 850 && stepW4 <= 10', 'Math.abs(after4 - before - stepW4) <= 0.3 && after4 >= 20 && after4 <= 50 && stepW4 <= 2'],
  ['`before=${before} after=${Number.isFinite(after4) ? after4.toFixed(1) : \'?\'} Δ=+${stepW4} bound=[700,850] stepLimit=10`', '`before=${before} after=${Number.isFinite(after4) ? after4.toFixed(1) : \'?\'} Δ=+${stepW4}Hz bound=[20,50] stepLimit=2`'],
  ['W4 自主优化结论(如实口径):aml_optimization 探索档(**模型绑定前的探索阶段,非模型驱动**;Channel goal 由后续 W3 数据集+训练补齐),对一区温度SP执行有界上行激励', 'W4 自主优化结论(如实口径):aml_optimization 探索档(**模型绑定前的探索阶段,非模型驱动**;Channel goal 由后续 W3 数据集+训练补齐),对鼓风机频率SP执行有界上行激励'],
  ['设备 ${before}→${Number.isFinite(after4) ? after4.toFixed(1) : \'?\'}℃;', '设备 ${before}→${Number.isFinite(after4) ? after4.toFixed(1) : \'?\'}Hz;'],
  // 数据集 control/target 文本
  ['(control=一区炉温,target=抗拉强度,60min 窗)', '(control=DO,target=出水氨氮)'],
  // 产品 id 由配方推导(替换硬编码)
  ["line_id: LINE, product_id: 'pd-c607e962', recipe_id: RECIPE,", "line_id: LINE, product_id: productId, recipe_id: RECIPE,"],
]
let miss = 0
for (const [a, b] of R) {
  if (!t.includes(a)) { console.log('MISS:', a.slice(0, 70)); miss++; continue }
  t = t.split(a).join(b)
}
// 在 S0-2 后补 preTreatDo 捕获与 productId 解析
t = t.replace(
  "  await api('PATCH', '/api/system/settings', { override: { 'dcw.rollback_stale_ms': 60000 } })",
  "  const sDoPre = await daqSeries(DAQ.zone1, Date.now() - 60_000, Date.now(), 2000)\n  const preTreatDo = sDoPre.length ? sDoPre.reduce((a, b) => a + b.v, 0) / sDoPre.length : Number.NaN\n  const productId = ((await api('GET', '/api/workshop/dcw')).data?.recipes ?? []).find(x => x.id === RECIPE)?.productId ?? ''\n  await api('PATCH', '/api/system/settings', { override: { 'dcw.rollback_stale_ms': 60000 } })",
)
writeFileSync(p, t)
console.log('done, miss =', miss)
