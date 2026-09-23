/**
 * 列表行明文的查看与复制(明文经 reveal 接口按需拉取,仅存内存,刷新即隐)。
 *
 * ⚠️ 行明文的唯一持有者是这里的 revealedPlain:页面把它下发给列表组件
 * (components/tokens/TokensTable.vue),组件只读不存、也不各自缓存一份。
 * 眼睛切换(遮回/展开)与复制都不改变另一方的显示状态 —— 与原页面语义一致。
 */
import { ref } from 'vue'
import { message } from 'ant-design-vue'
import { useUserStore } from '@/app/stores/workshop/user'
import type { TokenMeta } from '@/app/stores/workshop/user'
import { useTokenClipboard } from './useTokenClipboard'

/** 掩码映射里是否已存有该行明文(切换动作与列表显示共用同一判据) */
export function isRevealedIn(map: Record<string, string>, id: string): boolean {
  return id in map
}

export function useTokenReveal() {
  const { t: tt } = useI18n()
  const userStore = useUserStore()
  const { copyText } = useTokenClipboard()

  const revealedPlain = ref<Record<string, string>>({})
  const revealingId = ref('')
  const copyId = ref('')

  /** 眼睛切换:已明文 → 遮回;否则拉取存档明文(懒加载,不自动展开) */
  const toggleRowReveal = async (t: TokenMeta): Promise<void> => {
    if (isRevealedIn(revealedPlain.value, t.id)) {
      Reflect.deleteProperty(revealedPlain.value, t.id)
      return
    }
    if (!t.hasPlain) {
      message.warning(tt('tokens.kkpgzo8018'))
      return
    }
    revealingId.value = t.id
    try {
      const plain = await userStore.revealToken(t.id)
      if (plain) revealedPlain.value[t.id] = plain
    }
    catch (e) {
      message.error(e instanceof Error ? e.message : tt('tokens.k1gj9ls019'))
    }
    finally {
      revealingId.value = ''
    }
  }

  /** 行复制:优先用已展开明文,否则先静默拉取存档明文再复制(不改变显示状态) */
  const copyRow = async (t: TokenMeta): Promise<void> => {
    const cached = revealedPlain.value[t.id]
    let text: string | null = cached ?? null
    if (!text) {
      if (!t.hasPlain) {
        message.warning(tt('tokens.kr5ovor020'))
        return
      }
      revealingId.value = t.id
      try {
        text = await userStore.revealToken(t.id)
      }
      catch (e) {
        message.error(e instanceof Error ? e.message : tt('tokens.kubtby5021'))
        return
      }
      finally {
        revealingId.value = ''
      }
    }
    if (text && await copyText(text)) {
      copyId.value = t.id
      setTimeout(() => {
        copyId.value = ''
      }, 1600)
    }
    else {
      message.error(tt('tokens.kgkfcr0022'))
    }
  }

  return { revealedPlain, revealingId, copyId, toggleRowReveal, copyRow }
}
