/**
 * 事件块壳层视图状态 — EventBlock 壳层与其 blocks/ 子组件(头像列/头部行)共用的派生逻辑。
 *
 * 由原 EventBlock.vue 的 script 迁出(职责与表达式逐行不变):块级展示值(时间/身份字幕/
 * 注意力档位/头像状态/类别元数据)与交互(头像点击 → Agent 抽屉、复制全文、引用到 Composer)。
 * 调用方传 getter(`() => props.block`):块对象本身是 reactive 的,流式增量照常驱动视图;
 * 每个调用方各持一份实例,只在本组件渲染读到该 computed 时才求值(computed 惰性)。
 */
import { computed, inject, ref, toValue } from 'vue'
import type { MaybeRefOrGetter } from 'vue'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useComposerBus } from '@/app/composables/workshop/useComposerBus'
import { KIND_META, buildStreamText, blockTier, agentHueColor, type EventBlock } from '@/app/composables/workshop/useEventBlocks'
import { formatLocalClock } from '@/app/composables/workshop/useLocalTime'

export function useEventBlockView(block: MaybeRefOrGetter<EventBlock>) {
  const entities = useEntitiesStore()
  const { quote } = useComposerBus()

  /** 块来源(getter 解引用;原 `props.block` 的全部读点改读此值) */
  const src = computed(() => toValue(block))
  const cid = computed(() => src.value.events[0]?.channelId ?? '')

  const time = computed(() => formatLocalClock(src.value.firstAt))
  const agentLabel = computed(() => {
    const id = src.value.agentId
    if (!id) return 'system'
    return entities.agentName(cid.value, id)
  })
  /**
   * 人类发送者名(a2a.message 且 from 空 + x-aw-from-label):
   * 头部以"用户章"呈现 —— Slack 声部里人也是会话一方。
   */
  const humanLabel = computed(() => {
    if (src.value.agentId) return null
    const e = src.value.events[0]
    if (!e || e.type !== 'a2a.message') return null
    const meta = (e.payload as { metadata?: Record<string, unknown> }).metadata ?? {}
    const label = meta['x-aw-from-label']
    return typeof label === 'string' && label ? label : null
  })
  /** 头像章首字母(名字或 id 首字符;system 用 cpu 图标) */
  const agentInitial = computed(() => {
    const id = src.value.agentId
    if (!id) return ''
    const name = entities.agentName(cid.value, id)
    return (name || id).charAt(0).toUpperCase()
  })

  /** 身份色(agentId 哈希 → 稳定色相;与泳道头/提及卡同一来源,全站不再另造配色) */
  const avColor = computed(() =>
    src.value.agentId ? agentHueColor(src.value.agentId) : undefined,
  )

  const meta = computed(() => KIND_META[src.value.kind])

  /** 头像点击 → 打开 Agent 抽屉(与 @pill 同入口) */
  const openAgent = inject<(target: { channelId: string, agentId: string }) => void>(
    'aw:open-agent',
    () => {},
  )
  const onAvatarClick = (): void => {
    if (src.value.agentId) openAgent({ channelId: cid.value, agentId: src.value.agentId })
  }

  /** 发送方身份字幕(open-tag msg-role):lead/worker · harness,agent 行的身份描述 */
  const roleLabel = computed(() => {
    const id = src.value.agentId
    if (!id) return ''
    const a = (entities.agents[cid.value] ?? []).find(x => x.agentId === id)
    if (!a) return 'agent'
    const role = a.role === 'lead' ? 'lead' : 'worker'
    const harness = a.harness ?? ''
    return harness ? `${role} · ${harness}` : role
  })

  /**
   * 注意力档位(open-tag deliveryTier 移植):terminal(终局产出)= 成功色左缘 +
   * 加重名字;attention(等待回应/错误)= 琥珀左缘 + 脉搏点;silent(过程噪声)=
   * 轻微收敛。视觉层级随"该不该打断人"伸缩,状态不只靠颜色(chip 文本仍在)。
   */
  const tier = computed(() => blockTier(src.value.events))

  /** 头像状态 pip(open-tag av-status 移植):agent 实时状态叠层(busy 暖橙呼吸/idle 静灰) */
  const agentState = computed(() => {
    const id = src.value.agentId
    if (!id) return null as 'idle' | 'busy' | 'stopped' | null
    const a = (entities.agents[cid.value] ?? []).find(x => x.agentId === id)
    return (a?.state ?? null) as 'idle' | 'busy' | 'stopped' | null
  })

  /** 流式运行指示(open-tag msg-agent-state 移植):未落定流块 + agent busy → "运行中" */
  const runningNow = computed(() =>
    src.value.kind === 'stream'
    && !src.value.settled
    && agentState.value === 'busy')

  /** 消费完整性观测:块首事件 seq + 块内事件数(浏览器测试对账用) */
  const firstSeq = computed(() => src.value.events[0]?.seq ?? 0)

  /** 工具条可用正文:流块取累计文本;路由块取消息 parts(供复制/引用) */
  const toolbarText = computed(() => {
    if (src.value.kind === 'stream') {
      const t = buildStreamText(src.value).trim()
      return t || null
    }
    if (src.value.kind === 'route') {
      const t = src.value.events
        .map((e) => {
          const parts = (e.payload as { parts?: Array<{ text?: string }> }).parts ?? []
          return parts.map(p => p.text ?? '').join('\n').trim()
        })
        .filter(Boolean)
        .join('\n')
      return t || null
    }
    return null
  })

  const copied = ref(false)
  const copyAll = async (): Promise<void> => {
    const t = toolbarText.value
    if (!t) return
    try {
      await navigator.clipboard.writeText(t)
      copied.value = true
      setTimeout(() => {
        copied.value = false
      }, 1400)
    }
    catch { /* 剪贴板不可用时静默 */ }
  }

  /** 引用到 Composer:块正文以 `> ` 前缀注入输入框 */
  const quoteToComposer = (): void => {
    const t = toolbarText.value
    if (t) quote(t)
  }

  return {
    cid,
    time,
    agentLabel,
    humanLabel,
    agentInitial,
    avColor,
    meta,
    roleLabel,
    tier,
    agentState,
    runningNow,
    firstSeq,
    toolbarText,
    copied,
    copyAll,
    quoteToComposer,
    onAvatarClick,
  }
}
