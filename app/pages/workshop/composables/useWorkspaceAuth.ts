import { onMounted, ref, type Ref } from 'vue'
import { useUserStore } from '@/app/stores/workshop/user'
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'

/**
 * 控制台导航守卫 + workspace 服务端加载。
 *
 * SSR 阶段不判登录(会话恢复是客户端插件,服务端无登录态——同步踢回会把
 * 刷新/直达 URL 的已登录用户误弹回总览);客户端挂载后校验并按需加载。
 *
 * authReady:守卫通过后置位。拆分前它也**只有置位、没有消费方**(原页面里
 * 没有第二处引用,总览/town 页的同名变量是各自独立的实现),因此这里如实保留
 * 置位时机,调用方不接收返回值——不是为了新增能力,而是为了让守卫的形态
 * 在拆分前后逐字一致。
 */
export function useWorkspaceAuth(): { authReady: Ref<boolean> } {
  const userStore = useUserStore()
  const wsStore = useWorkspacesStore()

  const authReady = ref(false)
  onMounted(() => {
    if (!userStore.isLoggedIn) {
      navigateTo('/workshop')
      return
    }
    authReady.value = true
    if (!wsStore.loaded) wsStore.load().catch(() => {})
  })

  return { authReady }
}
