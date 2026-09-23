import { message } from 'ant-design-vue'
import type { AepHitlItem, AepHitlQuestion } from '#shared/workshop-protocol'
import { useHitlStore, type HitlAnswerPayload } from '@/app/stores/workshop/hitl'
import { useChatStore } from '@/app/stores/workshop/chat'

/**
 * HITL 待办应答(页头铃标下拉里的提问/审批控件:形态判定 + 答案草稿 + 提交)。
 *
 * 草稿态(qSingle/qMulti/qFree)必须只有一份,所以本 composable **只允许在
 * HitlBell.vue 的 setup() 里实例化一次**;Pinia store 是单例,可在任意组件重复取用。
 */
export function useHitlAnswer() {
  const { t } = useI18n()
  const hitl = useHitlStore()
  const chat = useChatStore()

  /**
   * 可应答 kind 白名单(**与 server/api/workshop/hitl/respond.post.ts 的 RESPONDABLE_KINDS 一致**)。
   * 旧实现只对 codex/opencode/dsh 三种渲染按钮,且把 omp-dialog 排除在外 ——
   * omp 的 ask 对话框因此只能进终端面板回答,页头看不到任何入口。
   */
  const HITL_KINDS: AepHitlItem['kind'][] = [
    'omp-dialog', 'dcw-approval', 'codex-approval', 'opencode-permission',
    'dsh-permission', 'claude-permission', 'qwen-permission', 'hermes-permission',
  ]
  const hitlKindLabel = (kind: AepHitlItem['kind']) => {
    switch (kind) {
      case 'omp-dialog': return t('appHeader.hitlKindOmp')
      case 'dcw-approval': return t('appHeader.hitlKindDcw')
      case 'codex-approval': return t('appHeader.hitlKindCodex')
      case 'opencode-permission': return t('appHeader.hitlKindOpencode')
      case 'dsh-permission': return t('appHeader.hitlKindDsh')
      case 'claude-permission': return 'claude 权限'
      case 'qwen-permission': return 'qwen 权限'
      case 'hermes-permission': return 'hermes 权限'
      default: return kind
    }
  }
  const hitlGo = (item: AepHitlItem) => {
    navigateTo({ path: '/monitor', query: { agentId: item.agentId, channelId: item.channelId } })
  }

  const permsKnown = (item: AepHitlItem): boolean => item.channelId in chat.permissions
  /**
   * 能否裁决:以服务端能力视图为准。
   * 例外:遗留无主 Channel(owner=NULL)的能力视图恒为 canApprove=false,但服务端
   * `hitl-decision.assertCanDecideHitlChannel` 对该类 Channel 保持旧口径
   * (getChannelForUser:任意登录用户可裁决,§13.2 兼容语义)—— 前端不能把服务端允许的
   * 操作藏起来,否则旧 Channel 的待办会变成"看得见、办不了"。
   */
  const canAnswer = (item: AepHitlItem): boolean => {
    const p = chat.permissions[item.channelId]
    if (!p) return false
    if (p.canApprove || p.isAdmin) return true
    return chat.settings[item.channelId]?.legacy === true
  }

  // ===== 形态判定:requestType 优先(kind 推定兜底) =====
  /**
   * 'question' = 答案是**内容**(自由文本/单选/多选/单选按钮组);
   * 'approval' = 答案是**是否放行**。
   * 现网各 adapter 尚未回填 requestType,故按 method 推定:select/input/editor 视为提问,
   * confirm(或缺省)视为授权 —— 与 adapter 的注册习惯一致(见各 agent registerHitl)。
   */
  const requestTypeOf = (item: AepHitlItem): 'question' | 'approval' => {
    if (item.requestType) return item.requestType
    if (item.questions && item.questions.length > 0) return 'question'
    if (item.method === 'input' || item.method === 'editor' || item.method === 'select') return 'question'
    return 'approval'
  }
  const isQuestion = (item: AepHitlItem): boolean => requestTypeOf(item) === 'question'
  /** opencode 权限支持引擎原生枚举(once/always/reject);其余引擎只认 confirmed 布尔 */
  const isNativeOptionApproval = (item: AepHitlItem): boolean =>
    item.kind === 'opencode-permission' && (item.options?.length ?? 0) > 0

  // ===== 答案草稿(按 item + 问题 id 分槽;切条目互不串) =====
  const qSingle = ref<Record<string, string>>({})
  const qMulti = ref<Record<string, string[]>>({})
  const qFree = ref<Record<string, string>>({})
  const itemKey = (item: AepHitlItem): string => `${item.kind}:${item.id}`
  const slotOf = (item: AepHitlItem, qid: string): string => `${itemKey(item)}:${qid}`
  const isChosen = (item: AepHitlItem, q: AepHitlQuestion, label: string): boolean =>
    q.multiSelect ? (qMulti.value[slotOf(item, q.id)] ?? []).includes(label) : qSingle.value[slotOf(item, q.id)] === label
  const chooseOption = (item: AepHitlItem, q: AepHitlQuestion, label: string): void => {
    const slot = slotOf(item, q.id)
    if (q.multiSelect) {
      const cur = qMulti.value[slot] ?? []
      qMulti.value = { ...qMulti.value, [slot]: cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label] }
    }
    else {
      qSingle.value = { ...qSingle.value, [slot]: label }
    }
  }
  /** 单问题答案:选项(多选以中文顿号连接)+ 补充自由文本 */
  const answerOf = (item: AepHitlItem, q: AepHitlQuestion): string => {
    const slot = slotOf(item, q.id)
    const picked = q.multiSelect ? (qMulti.value[slot] ?? []) : [qSingle.value[slot] ?? ''].filter(Boolean)
    const free = (qFree.value[slot] ?? '').trim()
    return [...picked.filter(Boolean), free].filter(Boolean).join('、')
  }

  /** 无 questions 的提问型条目合成为单题(选项来自 item.options;无选项 = 自由文本) */
  const PLAIN_QID = '__plain'
  const questionsOf = (item: AepHitlItem): AepHitlQuestion[] => {
    if (item.questions && item.questions.length > 0) return item.questions
    const opts = item.options?.map(o => ({ label: o }))
    return [{
      id: PLAIN_QID,
      question: item.message || item.detail || item.title,
      options: opts,
      multiSelect: false,
      freeText: !(opts && opts.length > 0),
    }]
  }

  /**
   * 统一应答入口(单点收敛 loading / 409 / 403 语义)。
   *
   * 提问型一律走结构化 `answers[]`(按问题 id 对齐):服务端按 `answers` 取答案并编码成
   * 引擎原生信封;此前把多问题手拼成 JSON 字符串塞进 `value` 是错的 —— 服务端只认
   * `answers`,拼 JSON 会被当作"单答案文本",逐题结果全空(答案静默丢失、接口仍返回 ok)。
   */
  const answer = async (item: AepHitlItem, payload: HitlAnswerPayload): Promise<void> => {
    const out = await hitl.answer(item, payload)
    if (out.ok) {
      message.success('已提交')
      return
    }
    if (out.code === 'ALREADY_RESOLVED') message.warning('已被他人处理')
    else if (out.code === 'APPROVAL_FORBIDDEN') message.warning(out.message || '无审批权限(该 Channel 策略不允许你决策)')
    else message.error(out.message)
  }

  const submitQuestion = async (item: AepHitlItem): Promise<void> => {
    const qs = questionsOf(item)
    // 逐题校验:任一题空白即拒绝提交 —— 服务端无法区分"用户留空"与"没问题",
    // 空答案会以"已提交"落地,属静默数据丢失
    const blank = qs.findIndex(q => !answerOf(item, q).trim())
    if (blank >= 0) {
      message.warning(`请先填写第 ${blank + 1} 题(${qs[blank]!.question || '未命名问题'})的答案`)
      return
    }
    await answer(item, { answers: qs.map((q, i) => ({ id: q.id || String(i), answer: answerOf(item, q) })) })
  }
  const submitApproval = async (item: AepHitlItem, confirmed: boolean): Promise<void> => {
    await answer(item, { confirmed })
  }
  const submitNativeOption = async (item: AepHitlItem, response: string): Promise<void> => {
    await answer(item, { response })
  }
  const submitCancel = async (item: AepHitlItem): Promise<void> => {
    await answer(item, { cancelled: true })
  }
  /** 审批策略人话(policy 由服务端冻结在条目上;缺省 = owner_only 语义) */
  const policyLabel = (item: AepHitlItem): string =>
    item.policy === 'any_member' ? '任一成员可决策' : item.policy ? '仅 owner 可决策' : ''

  return {
    HITL_KINDS,
    hitlKindLabel,
    hitlGo,
    permsKnown,
    canAnswer,
    requestTypeOf,
    isQuestion,
    isNativeOptionApproval,
    qSingle,
    qMulti,
    qFree,
    itemKey,
    slotOf,
    isChosen,
    chooseOption,
    answerOf,
    PLAIN_QID,
    questionsOf,
    answer,
    submitQuestion,
    submitApproval,
    submitNativeOption,
    submitCancel,
    policyLabel,
  }
}
