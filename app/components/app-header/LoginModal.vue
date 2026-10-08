<script setup lang="ts">
/**
 * 全局登录对话框 —— 主应用壳(仪表盘/数采/产线/写控…)的唯一登录入口。
 *
 * 复用 AuthGate(与 /workshop 登录门同一表单源:登录/注册/API Token 三页签 +
 * 首启"注册管理员"自动切换),状态机在本组件:needsSetup / allowRegistration
 * 探测、三个凭据入口、成功后关框并整页刷新(cookie 已在,重挂载即真实数据)。
 * 打开关在 workshop.authUi store:访客菜单 / 401 拦截器 / 登出 / 匿名横幅 四路触发。
 */
import { message } from 'ant-design-vue'
import AuthGate from '@/app/components/workshop/workbench/AuthGate.vue'
import type { AuthTab } from '@/app/pages/workshop/composables/useWorkbenchAuth'
import { narrowFetch } from '@/app/stores/workshop/narrow-fetch'
import { useUserStore } from '@/app/stores/workshop/user'
import { useAuthUiStore } from '@/app/stores/workshop/auth-ui'

const authUi = useAuthUiStore()
const userStore = useUserStore()

const tab = ref<AuthTab>('login')
const name = ref('')
const email = ref('')
const password = ref('')
const tokenInput = ref('')
const loading = ref(false)
/** 首启(无活跃管理员):切换为"注册管理员"模式 */
const needsSetup = ref(false)
/** 自助注册闸门(security.allowRegistration=false 且首管理员就位 → 隐藏注册页签) */
const allowRegister = ref(true)

// 探测首启/注册闸门:挂载即探一次 + 每次打开再探(公开端点;瞬时失败重试 2 次)
const probeGate = async (): Promise<void> => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await narrowFetch<{ code: number, data?: { needsSetup: boolean, allowRegistration?: boolean } }>('/api/users/setup-status')
      needsSetup.value = res.data?.needsSetup === true
      allowRegister.value = res.data?.allowRegistration !== false
      if (needsSetup.value) tab.value = 'register'
      else if (!allowRegister.value) tab.value = 'login'
      return
    }
    catch {
      if (attempt < 3) await new Promise(r => setTimeout(r, 800))
    }
  }
}
onMounted(() => {
  void probeGate()
})
watch(() => authUi.open, (open) => {
  if (!open) return
  loading.value = false
  tab.value = 'login'
  void probeGate()
})

const fail = (err: unknown): void => {
  message.error(err instanceof Error ? err.message : String(err))
}
const succeed = (nameText: string): void => {
  message.success(`${nameText} 登录成功`)
  authUi.closeLogin()
  // 整页刷新:当前页在匿名态挂载(数据为 0),cookie 已写入,重载即真实数据 —— 免逐页接线
  setTimeout(() => window.location.reload(), 400)
}

const doLogin = async (): Promise<void> => {
  loading.value = true
  try {
    const u = await userStore.login(email.value, password.value)
    succeed(u.name)
  }
  catch (err) { fail(err) }
  finally { loading.value = false }
}
const doRegister = async (): Promise<void> => {
  loading.value = true
  try {
    const u = await userStore.register(name.value, email.value, password.value)
    succeed(u.name)
  }
  catch (err) { fail(err) }
  finally { loading.value = false }
}
const doToken = async (): Promise<void> => {
  loading.value = true
  try {
    const u = await userStore.loginWithToken(tokenInput.value)
    succeed(u.name)
  }
  catch (err) { fail(err) }
  finally { loading.value = false }
}
</script>

<template>
  <a-modal
    :open="authUi.open"
    :footer="null"
    :width="480"
    :closable="true"
    :mask-closable="true"
    :body-style="{ padding: '8px 8px 0' }"
    destroy-on-close
    @cancel="authUi.closeLogin()"
  >
    <AuthGate
      v-model:active-tab="tab"
      v-model:name="name"
      v-model:email="email"
      v-model:password="password"
      v-model:token-input="tokenInput"
      :loading="loading"
      :needs-setup="needsSetup"
      :allow-register="allowRegister"
      @login="doLogin"
      @register="doRegister"
      @login-with-token="doToken"
    />
  </a-modal>
</template>

<style scoped>
/* AuthGate 根为页面级登录门设计(8vh 顶部留白);在对话框内收拢 */
:deep(.auth-gate) {
  padding-top: 4px;
}
:deep(.auth-card) {
  box-shadow: none;
}
</style>
