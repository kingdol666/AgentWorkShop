/**
 * 行内重命名弹窗的开合与提交。
 *
 * 草稿(renameLabel)与目标行 id 由这里持有;成功后关窗、重查列表、再提示成功
 * (顺序与原页面一致 —— 提示落在列表刷新之后);失败时弹窗保持打开、输入不丢。
 */
import { ref } from 'vue'
import { message } from 'ant-design-vue'
import { useUserStore } from '@/app/stores/workshop/user'

export interface TokenRenameDeps {
  /** 重命名成功后的重查(页面接 useTokensList 的 load) */
  onRenamed: () => Promise<void>
}

export function useTokenRename(deps: TokenRenameDeps) {
  const { t: tt } = useI18n()
  const userStore = useUserStore()

  // ===== 重命名 =====
  const renameOpen = ref(false)
  const renameId = ref('')
  const renameLabel = ref('')
  const renameLoading = ref(false)

  const doRename = async (): Promise<void> => {
    if (!renameLabel.value.trim()) {
      message.warning(tt('tokens.k169z26g014'))
      return
    }
    renameLoading.value = true
    try {
      await userStore.renameToken(renameId.value, renameLabel.value)
      renameOpen.value = false
      await deps.onRenamed()
      message.success(tt('tokens.k3n9aij015'))
    }
    catch (e) {
      message.error(apiErrorMessage(e))
    }
    finally {
      renameLoading.value = false
    }
  }

  // openRename 放宽为结构化类型以兼容 a-table 的 record
  const openRename = (t: { id?: string, label?: string }): void => {
    renameId.value = t.id ?? ''
    renameLabel.value = t.label ?? ''
    renameOpen.value = true
  }

  return { renameOpen, renameLabel, renameLoading, openRename, doRename }
}
