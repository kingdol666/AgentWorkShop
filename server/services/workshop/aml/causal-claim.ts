/**
 * 因果断言质量门(科学探索计划 P6):识别"无证据锚的因果叙述",供 KB 入库审批卡标记。
 * 背景事故:一条"变厚由瓶坯/熔体温度驱动"的叙述无证据锚、不可追溯,进了 KB 之后
 * 被下游 Agent 当事实检索之后 —— 知识污染。处置口径:**不禁止写入**,但必须
 *  (a) 在审批卡显式标注 anecdotal; (b) 建议补 intervention:/ontology: 引用;
 *  (c) 审核人可见"这条没有证据"。检索侧降权属 KB 侧能力(rag-bridge),本模块只给标记。
 */

export interface CausalClaimAssessment {
  /** 文本是否包含因果措辞 */
  isCausal: boolean
  /** 是否带可追溯引用(intervention:/ontology:/pexp:/evidence:) */
  hasEvidenceRef: boolean
  /** 命中的引用 */
  refs: string[]
  /** 因果断言但无引用 → 仅供叙述(anecdotal),检索应降权 */
  anecdotal: boolean
  reasons: string[]
}

const CAUSAL_PATTERNS: Array<{ re: RegExp, label: string }> = [
  { re: /导致|引起|造成|驱动|使得|促使|影响(?:了|着)/, label: '中文因果动词' },
  { re: /因为[^。]{0,40}所以|由于[^。]{0,40}(因此|导致|使)/, label: '中文因果句式' },
  { re: /降低|提升|增加|减少|改善|恶化|下调|上调|下降|上升[^。]{0,30}(厚度|重量|良率|偏差|缺陷|壁厚|克重)/, label: '指标变化断言' },
  { re: /(厚度|重量|良率|偏差|缺陷|壁厚|克重)[^。]{0,30}(变化|波动|升高|降低|变大|变小)/, label: '指标响应断言' },
  { re: /\b(causes?|caused by|drives?|driven by|leads? to|results? in|due to|because of)\b/i, label: 'English causal' },
  { re: /\b(reduces?|increases?|improves?|degrades?)\b[^.]{0,40}\b(thickness|weight|yield|deviation|defect)\b/i, label: 'English metric claim' },
]

const EVIDENCE_REF_PATTERNS: Array<{ re: RegExp, label: string }> = [
  { re: /\bintv[_-][a-z0-9-]+/i, label: 'intervention' },
  { re: /\bpexp-[a-z0-9-]+/i, label: 'experiment-plan' },
  { re: /\bev-[a-z0-9-]+/i, label: 'evidence' },
  { re: /\bont-[a-z0-9_-]+@?\d*/i, label: 'ontology' },
  { re: /(证据|evidence)\s*[:：]\s*\S+/, label: 'evidence-label' },
  { re: /(干预|experiment|台账)\s*(id|记录)\s*[:：]\s*\S+/i, label: 'ledger-ref' },
]

/**
 * 评估一段待入 KB 的文本。判定顺序:有因果措辞 → 才看引用;
 * 非因果叙述不受本门约束(如纯读取事实/流程说明)。
 */
export function assessCausalClaim(text: string): CausalClaimAssessment {
  const body = String(text ?? '')
  const causalHits = CAUSAL_PATTERNS.filter(p => p.re.test(body)).map(p => p.label)
  const refs = EVIDENCE_REF_PATTERNS.filter(p => p.re.test(body)).map(p => matchOf(p.re, body)).filter(Boolean)
  const isCausal = causalHits.length > 0
  const hasEvidenceRef = refs.length > 0
  const anecdotal = isCausal && !hasEvidenceRef
  const reasons: string[] = []
  if (isCausal) reasons.push(`命中因果措辞(${causalHits.join('/')})`)
  if (isCausal && hasEvidenceRef) reasons.push(`带可追溯引用(${refs.join(', ')})`)
  if (anecdotal) reasons.push('因果断言无证据锚:仅按叙述(anecdotal)对待,检索应降权;建议补 intervention:<id>/ontology:<id>@<version> 引用')
  return { isCausal, hasEvidenceRef, refs, anecdotal, reasons }
}

function matchOf(re: RegExp, text: string): string {
  const m = text.match(re)
  return m ? m[0].slice(0, 80) : ''
}

/** KB 入库审批卡的标注段(无因果 → 空数组) */
export function causalClaimLines(a: CausalClaimAssessment): string[] {
  if (!a.isCausal) return []
  return a.anecdotal
    ? [`[证据质量] ⚠ 无证据锚的因果断言(anecdotal):${a.reasons.join(';')}`]
    : [`[证据质量] 因果断言带引用(${a.refs.join(', ')}),可按证据等级采用`]
}
