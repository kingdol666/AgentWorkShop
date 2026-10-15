/**
 * 分析意图目录(diag-bridge 侧镜像)。
 *
 * ⚠️ 权威源在 IDD:`app/backend/src/engine/claude-client.mjs` 的 ANALYSIS_INTENTS
 * (每个意图 = 一个 skill 协议,buildIntentDirective 生成绑定指令,由 IDD 的 harness 执行)。
 * 本目录只是**调用面镜像**:给 diag_run 提供 enum 校验、中文标签与按情景的缺省提问模板
 * (数据分析业务语义在此注入,执行完全解耦在 IDD)。IDD 对未知意图 400 拒绝,不会静默降级。
 */

/** 各意图的缺省提问模板(按任务情景注入给 IDD harness 的业务提示词)。
 *  line=产线标识;win=可读时窗描述(缺省时可空)。 */
const QUESTION_TEMPLATES = {
  'deep-diagnosis': ({ line, win }) =>
    `${line} 产线${win}数据深度根因诊断:定位异常根因,给出证据链与修复建议`,
  'stability-report': ({ line, win }) =>
    `${line} 产线${win}运行稳定性报告:给出综合评分与等级、各参数稳态表现(均值/波动/趋势)、问题清单与运行建议;不需要根因分析`,
  'quick-screen': ({ line, win }) =>
    `${line} 产线${win}数据快速筛查:识别越限/漂移/冻结/卡死等异常,按严重度给出关注点清单,产出筛查报告与 HTML 看板;不做深度根因分析`,
  'doe-analysis': ({ line, win }) =>
    `${line} 产线${win}DOE 试验数据分析:识别因子与响应,给出因子效应、显著性判断与最优工况组合建议;若数据不含多因子试验结构,请在报告中明确说明数据局限`,
  'experience-mining': ({ line, win }) =>
    `${line} 产线${win}数据调参经验挖掘:总结可复用的调整经验(参数方向、幅度、生效条件与反例),按结构化经验条目输出,供知识库沉淀`,
  'optimizer-campaign': ({ line, win }) =>
    `${line} 产线${win}数据优化战役:基于数据确定优化目标与约束,执行寻优迭代并汇报每轮目标值变化,最终给出推荐工况与预期收益`,
}

/** 意图元数据(label 给审批卡/回执用;skill 仅供诊断对账,执行由 IDD 自主) */
export const ANALYSIS_INTENTS = {
  'deep-diagnosis': { label: '深度根因诊断', skill: 'industrial-analysis-auto', defaultPolicy: true },
  'stability-report': { label: '产线稳定报告', skill: 'industrial-line-stability-report' },
  'quick-screen': { label: '快速筛查', skill: 'industrial-sentinel' },
  'doe-analysis': { label: 'DOE 试验分析', skill: 'industrial-doe-analyzer' },
  'experience-mining': { label: '调参经验挖掘', skill: 'industrial-tuning-memory' },
  'optimizer-campaign': { label: '优化战役', skill: 'industrial-optimizer-loop' },
}

/** 归一化:空/未知 → null(空=缺省 deep-diagnosis 由 IDD 兜底;未知由调用方报错) */
export function resolveBridgeIntent(value) {
  const v = String(value ?? '').trim()
  if (!v) return 'deep-diagnosis'
  return Object.prototype.hasOwnProperty.call(ANALYSIS_INTENTS, v) ? v : null
}

export function intentLabel(intent) {
  return ANALYSIS_INTENTS[intent]?.label ?? intent
}

/** 按情景生成缺省提问(业务提示词注入点;caller 显式 question 优先) */
export function defaultQuestionFor(intent, { line, fromMs, toMs } = {}) {
  const tpl = QUESTION_TEMPLATES[intent] ?? QUESTION_TEMPLATES['deep-diagnosis']
  const win = fromMs && toMs && toMs > fromMs
    ? `${new Date(fromMs).toISOString().slice(0, 16)} ~ ${new Date(toMs).toISOString().slice(0, 16)} 时窗`
    : '该时窗'
  return tpl({ line: line || 'offline-data', win })
}

/** diag_run 参数面的 enum 说明(工具描述用;一行一意图) */
export function intentCatalogText() {
  return Object.entries(ANALYSIS_INTENTS)
    .map(([id, m]) => `${id}=${m.label}`)
    .join(';')
}
