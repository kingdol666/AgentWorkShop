/**
 * 本人 token 列表:快照加载 / 登出即清空 / 吊销。
 *
 * 列表是服务端快照,全页只有这一份(tokens);页面把它下发给列表组件,组件只读。
 * 吊销当前会话 token 时 revokeToken 已触发登出跳转,这里不再重查(与原页面一致)。
 */
import { ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useUserStore } from '@/app/stores/workshop/user'
import type { TokenMeta } from '@/app/stores/workshop/user'

export function useTokensList() {
  const { t: tt } = useI18n()
  const userStore = useUserStore()

  const tokens = ref<TokenMeta[]>([])
  const loading = ref(false)

  const load = async (): Promise<void> => {
    if (!userStore.isLoggedIn) return
    loading.value = true
    try {
      tokens.value = await userStore.listTokens()
    }
    catch (e) {
      message.error(e instanceof Error ? e.message : tt('tokens.k19jvk54013'))
    }
    finally {
      loading.value = false
    }
  }

  watch(() => userStore.isLoggedIn, (ok) => {
    if (ok) {
      void load()
    }
    else {
      tokens.value = []
    }
  }, { immediate: true })

  const doRevoke = (t: { id?: string }): void => {
    const tokenId = t.id
    if (!tokenId) return
    const isCurrent = tokenId === userStore.user?.tokenId
    void (async () => {
      try {
        await userStore.revokeToken(tokenId)
        message.success(tt('tokens.k3n64kh016'))
        if (isCurrent) return // revokeToken 已触发登出跳转
        await load()
      }
      catch (e) {
        message.error(apiErrorMessage(e))
      }
    })()
  }

  return { tokens, loading, load, doRevoke }
}
