import { onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { narrowFetch } from '@/app/stores/workshop/narrow-fetch'
import { useUserStore } from '@/app/stores/workshop/user'
import { apiErrorMessage } from '@/app/utils/api-error'

/** 登录门的三个凭据入口:邮箱密码登录 / 注册 / API Token */
export type AuthTab = 'register' | 'login' | 'token'

/**
 * 工作台总览页的登录门(全局用户系统;用户 token = 管理 API 凭证)。
 *
 * 状态与副作用都留在**页面 setup 期**:本 composable 由页面直接调用,子组件
 * (components/workshop/workbench/AuthGate)只收发 props/emits ——
 * needsSetup 的 onMounted 探测因此仍只在页面实例上注册一次,与拆分前一致。
 * 探测失败/未登录时的呈现规则(静默回落常规登录门)也原样保留。
 */
export function useWorkbenchAuth() {
  const { t } = useI18n()
  const userStore = useUserStore()

  // ===== 登录门（全局用户系统）=====
  const authTab = ref<AuthTab>('login')
  const authName = ref('')
  const authEmail = ref('')
  const authPassword = ref('')
  const authTokenInput = ref('')
  const authLoading = ref(false)

  // 首启初始化:系统尚无管理员 → 登录门切换为"注册管理员"模式(首个注册账号自动成为 admin)
  const needsSetup = ref(false)
  onMounted(async () => {
    try {
      const res = await narrowFetch<{ code: number, data?: { needsSetup: boolean } }>('/api/users/setup-status')
      if (res.code === 0 && res.data?.needsSetup) {
        needsSetup.value = true
        authTab.value = 'register'
      }
    }
    catch { /* 探测失败按常规登录门呈现 */ }
  })

  const doRegister = async (): Promise<void> => {
    if (!authName.value.trim()) {
      message.warning(t('wsHome.k1vnhyks019'))
      return
    }
    if (!authEmail.value.trim()) {
      message.warning(t('wsHome.k8ieqzj020'))
      return
    }
    if (authPassword.value.length < 6) {
      message.warning(t('wsHome.ksx73ra021'))
      return
    }
    authLoading.value = true
    try {
      const user = await userStore.register(authName.value, authEmail.value, authPassword.value)
      message.success(needsSetup.value ? t('wsHome.adminCreated', { p0: user.name }) : t('wsHome.k1mbatbh030', { p0: user.name }))
      needsSetup.value = false
      authName.value = ''
      authEmail.value = ''
      authPassword.value = ''
    }
    catch (e) {
      message.error(apiErrorMessage(e))
    }
    finally {
      authLoading.value = false
    }
  }
  const doLogin = async (): Promise<void> => {
    if (!authEmail.value.trim()) {
      message.warning(t('wsHome.k8ieqzj020'))
      return
    }
    authLoading.value = true
    try {
      const user = await userStore.login(authEmail.value, authPassword.value)
      message.success(t('wsHome.kwixbdl031', { p0: user.name }))
      needsSetup.value = false
      authPassword.value = ''
    }
    catch (e) {
      message.error(apiErrorMessage(e))
    }
    finally {
      authLoading.value = false
    }
  }
  const doLoginWithToken = async (): Promise<void> => {
    authLoading.value = true
    try {
      const user = await userStore.loginWithToken(authTokenInput.value)
      message.success(t('wsHome.kwixbdl031', { p0: user.name }))
      needsSetup.value = false
      authTokenInput.value = ''
    }
    catch (e) {
      message.error(apiErrorMessage(e))
    }
    finally {
      authLoading.value = false
    }
  }
  const doLogout = (): void => {
    userStore.logout()
    message.success(t('wsHome.k3ngm6p022'))
  }

  return {
    userStore,
    authTab,
    authName,
    authEmail,
    authPassword,
    authTokenInput,
    authLoading,
    needsSetup,
    doRegister,
    doLogin,
    doLoginWithToken,
    doLogout,
  }
}
