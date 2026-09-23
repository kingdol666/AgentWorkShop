/**
 * AML 页面共享常量:服务端中文数据 ↔ i18n 词典的映射,以及作业状态集合。
 * 纯数据 + 纯函数,不依赖 Vue —— 页面、composable 与子组件共用同一份。
 */
import type { AmlModelRow, AmlModelStage } from './types'

/** 服务端 blocker 是中文数据:已知固定文案映射 i18n,未知(动态 reason)原样透传 */
export const AML_BLOCKER_KEYS: Record<string, string> = {
  '训练环境(./aml/.venv)尚未创建:请在「运行环境」面板点击「创建训练环境」': 'aml.blockerVenv',
  'Python 解释器不可用': 'aml.blockerPython',
}

/** 数据根来源按 amlRootMode 翻译(amlRootSource 是服务端中文标签) */
export const AML_ROOT_SOURCE_KEYS: Record<string, string> = {
  env: 'aml.rootSourceEnv',
  repo: 'aml.rootSourceRepo',
  home: 'aml.rootSourceHome',
}

/** uv 来源的中文标签(排障:是配置指定、项目本地装的,还是系统 PATH 上的) */
export const AML_UV_SOURCE_LABELS: Record<string, string> = {
  config: 'aml.python.uvBin',
  project: './aml/tools',
  state: './aml/runtime/uv.json',
  path: 'PATH',
}

/** 作业状态 → i18n 键 */
export const AML_JOB_STATUS_KEYS: Record<string, string> = {
  queued: 'aml.k1amlx100', provisioning: 'aml.k1amlx101', training: 'aml.k1amlx102',
  evaluating: 'aml.k1amlx103', done: 'aml.k1amlx104', failed: 'aml.k1amlx105',
  cancelled: 'aml.k1amlx106', timeout: 'aml.k1amlx107', interrupted: 'aml.k1amlx108',
}

/** 实验状态 → i18n 键 */
export const AML_EXP_STATUS_KEYS: Record<string, string> = {
  running: 'aml.k1amlx119', gates_passed: 'aml.k1amlx080', gates_failed: 'aml.k1amlx081', failed: 'aml.k1amlx105',
}

/** 未终态(仍在队列/供给/训练/评估)的作业状态 */
const ACTIVE_JOB_STATUSES: string[] = ['queued', 'provisioning', 'training', 'evaluating']
/** 已终态(不会再有推进)的作业状态 */
const TERMINAL_JOB_STATUSES: string[] = ['done', 'failed', 'cancelled', 'timeout', 'interrupted']
/** 允许重试的终态 */
const RETRYABLE_JOB_STATUSES: string[] = ['failed', 'timeout', 'interrupted']

export function isActiveStatus(s: string): boolean {
  return ACTIVE_JOB_STATUSES.includes(s)
}
export function isTerminalStatus(s: string): boolean {
  return TERMINAL_JOB_STATUSES.includes(s)
}
export function canRetry(s: string): boolean {
  return RETRYABLE_JOB_STATUSES.includes(s)
}

/** 当前阶段可晋升到的目标阶段(每项带自己的 i18n 键与两段确认话术) */
export function promoteActionOf(m: AmlModelRow): Array<{ to: Exclude<AmlModelStage, 'candidate'>, key: string }> {
  if (m.stage === 'candidate') return [{ to: 'shadow', key: 'aml.k1amlx128' }, { to: 'production', key: 'aml.k1amlx129' }]
  if (m.stage === 'shadow') return [{ to: 'production', key: 'aml.k1amlx129' }, { to: 'retired', key: 'aml.k1amlx130' }]
  if (m.stage === 'production') return [{ to: 'retired', key: 'aml.k1amlx130' }]
  return []
}
