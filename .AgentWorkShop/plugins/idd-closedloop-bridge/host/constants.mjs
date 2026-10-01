/** 常量与默认值（idd-closedloop-bridge） */

export const DEFAULT_BASE = 'http://127.0.0.1:3210'

export const MIN = 60 * 1000

export const SWEEP_INTERVAL_MS = 15 * 1000

/** 异步任务种类 → IDD 路由前缀（Workstream D 契约，见 plan industrial-closedloop-skills-v1） */
export const IDD_ROUTES = {
  sentinelWatch: '/api/sentinel/tasks',
  sentinelStatus: id => `/api/sentinel/tasks/${encodeURIComponent(id)}`,
  sentinelScreen: '/api/sentinel/screen',
  sentinelBaseline: '/api/sentinel/baseline',
  experienceActions: '/api/experience/actions',
  experienceAttribution: id => `/api/experience/attribution/${encodeURIComponent(id)}`,
  experienceRecommend: '/api/experience/recommend',
  experienceFeedback: '/api/experience/feedback',
  optimizerCampaign: '/api/optimizer/campaign',
  optimizerRound: '/api/optimizer/round',
  optimizerState: '/api/optimizer/state',
}

/** 工具 roles：lead/worker 均可用（对齐 diag-bridge） */
export const ROLES = ['lead', 'worker']
