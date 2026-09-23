/**
 * 创建 Token + 一次性明文回显。
 *
 * ⚠️ 明文只在创建响应里出现一次 —— 全应用只有 createdRaw 这一份副本:
 * 回显弹窗(components/tokens/TokenOnceModal.vue)是纯呈现,只读页面下发的 props,
 * 既不复制明文也不各自再算一份掩码。掩码/眼睛切换/复制/关闭清空的语义与原页面逐字一致。
 */
import { computed, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useUserStore } from '@/app/stores/workshop/user'
import { useTokenClipboard } from './useTokenClipboard'

export interface TokenCreateDeps {
  /** 创建成功后的重查(页面接 useTokensList 的 load) */
  onCreated: () => Promise<void>
}

export function useTokenCreate(deps: TokenCreateDeps) {
  const { t: tt } = useI18n()
  const userStore = useUserStore()
  const { copyText } = useTokenClipboard()

  // ===== 创建 =====
  const createOpen = ref(false)
  const createLabel = ref('')
  const createLoading = ref(false)
  const createdRaw = ref('')
  const lastCreatedLabel = ref('')

  const doCreate = async (): Promise<void> => {
    createLoading.value = true
    try {
      const res = await userStore.createToken(createLabel.value)
      createdRaw.value = res.token
      lastCreatedLabel.value = createLabel.value
      createOpen.value = false
      createLabel.value = ''
      await deps.onCreated()
    }
    catch (e) {
      message.error(apiErrorMessage(e))
    }
    finally {
      createLoading.value = false
    }
  }

  // ===== 新 token 明文回显:默认掩码,眼睛切换显示,一键复制 =====
  const revealed = ref(false)
  const copied = ref(false)
  const masked = computed(() => {
    const raw = createdRaw.value
    if (!raw) return ''
    return `${raw.slice(0, 6)}${'•'.repeat(Math.max(12, raw.length - 10))}${raw.slice(-4)}`
  })
  const toggleReveal = (): void => {
    revealed.value = !revealed.value
  }

  const copyCreated = async (): Promise<void> => {
    if (await copyText(createdRaw.value)) {
      copied.value = true
      setTimeout(() => {
        copied.value = false
      }, 1600)
    }
    else {
      message.error(tt('tokens.kjtcn2h017'))
    }
  }

  /** 关闭回显:明文与两个显示态一起清空(明文不留在内存里) */
  const dismissCreated = (): void => {
    createdRaw.value = ''
    revealed.value = false
    copied.value = false
  }

  return {
    createOpen,
    createLabel,
    createLoading,
    createdRaw,
    lastCreatedLabel,
    masked,
    revealed,
    copied,
    doCreate,
    toggleReveal,
    copyCreated,
    dismissCreated,
  }
}
