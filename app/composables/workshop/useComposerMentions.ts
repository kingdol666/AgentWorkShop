/**
 * Composer @提及补全:候选过滤、光标前 "@词" 探测、选中后改写文本与目标。
 * 只提供行为,不新建共享状态 —— input / mentionCandidates / mode / toAgentId
 * 全部由调用方(Composer.vue)注入,避免二次实例化出两份独立状态。
 */
import { computed, nextTick, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { AepChatMention } from '#shared/workshop-protocol'

/** chat = 群聊(默认);task/message = 既有直发路径(owner 显式选择) */
export type ComposerMode = 'chat' | 'task' | 'message'

export interface MentionCandidate {
  key: string
  type: 'agent' | 'user'
  id: string
  name: string
  role: string
  state?: 'idle' | 'busy' | 'stopped'
}

export function useComposerMentions(ctx: {
  input: Ref<string>
  mentionCandidates: ComputedRef<MentionCandidate[]>
  mode: Ref<ComposerMode>
  toAgentId: Ref<string>
}) {
  const { input, mentionCandidates, mode, toAgentId } = ctx

  // ===== @提及自动补全(任务/消息/群聊三模式通用) =====
  const mentionOpen = ref(false)
  const mentionQuery = ref('')
  const mentionHi = ref(0)
  /** 光标前未闭合的 "@词"(无空格断开才算进行中) */
  const detectMention = (): void => {
    const el = document.activeElement as HTMLTextAreaElement | null
    const text = el?.value ?? input.value
    const caret = el?.selectionStart ?? text.length
    const upto = text.slice(0, caret)
    const m = /(^|\s)@([^\s@]*)$/.exec(upto)
    if (!m) {
      mentionOpen.value = false
      return
    }
    mentionQuery.value = m[2] ?? ''
    mentionOpen.value = mentionFiltered.value.length > 0
    mentionHi.value = 0
  }
  const mentionFiltered = computed(() => {
    const q = mentionQuery.value.toLowerCase()
    return mentionCandidates.value.filter(c => !q || c.name.toLowerCase().includes(q)).slice(0, 8)
  })
  const pickMention = (idx: number): void => {
    const c = mentionFiltered.value[idx]
    if (!c) return
    const el = document.activeElement as HTMLTextAreaElement | null
    const text = el?.value ?? input.value
    const caret = el?.selectionStart ?? text.length
    const upto = text.slice(0, caret)
    const m = /(^|\s)@([^\s@]*)$/.exec(upto)
    const cut = m ? caret - (m[2]?.length ?? 0) : caret
    const next = `${text.slice(0, cut)}${c.name} ${text.slice(caret)}`
    input.value = next
    // 仅直发模式改写目标;群聊模式**不设默认目标**(路由完全由文本里的 @ 决定)
    if (c.type === 'agent' && mode.value !== 'chat') toAgentId.value = c.id
    mentionOpen.value = false
    nextTick(() => {
      const pos = cut + c.name.length + 1
      el?.setSelectionRange(pos, pos)
      el?.focus()
    })
  }
  const onMentionKeydown = (ev: KeyboardEvent): boolean => {
    if (!mentionOpen.value) return false
    if (ev.key === 'ArrowDown') {
      ev.preventDefault()
      mentionHi.value = Math.min(mentionHi.value + 1, mentionFiltered.value.length - 1)
      return true
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault()
      mentionHi.value = Math.max(mentionHi.value - 1, 0)
      return true
    }
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      ev.preventDefault()
      pickMention(mentionHi.value)
      return true
    }
    if (ev.key === 'Escape') {
      mentionOpen.value = false
      return true
    }
    return false
  }

  const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  /**
   * 文本 → mentions(稳定 ID)。服务端会**重新解析**文本,这里只是意图提示:
   *  - 只认候选名单里的名字,最长名优先(@worker10 不会被 @worker1 抢先命中);
   *  - '@' 前必须是行首/空白,后必须是行尾/空白/标点,避免 @alice 命中 @alice2。
   */
  const parseMentions = (text: string): AepChatMention[] => {
    const out: AepChatMention[] = []
    const seen = new Set<string>()
    const sorted = [...mentionCandidates.value].sort((a, b) => b.name.length - a.name.length)
    for (const c of sorted) {
      const re = new RegExp(`(^|[\\s(])@${escapeRegExp(c.name)}(?=$|[\\s,.。,:;!?)\\]])`, 'm')
      if (!re.test(text)) continue
      const key = `${c.type}:${c.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ type: c.type, id: c.id, label: c.name })
    }
    return out
  }

  return {
    mentionOpen,
    mentionQuery,
    mentionHi,
    mentionFiltered,
    detectMention,
    pickMention,
    onMentionKeydown,
    escapeRegExp,
    parseMentions,
  }
}
