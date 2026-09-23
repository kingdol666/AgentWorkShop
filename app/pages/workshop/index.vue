<script setup lang="ts">
/**
 * Workspace 总览(用户级隔离):
 * - 未登录 → 注册/登录门(用户 token = 管理 API 凭证)
 * - 已登录 → workspace 卡片墙(服务端持久化;按用户隔离)+ 实时状态徽标
 *
 * 本页只做编排:登录门状态与动作在 ./composables/useWorkbenchAuth,workspace 加载 /
 * channel 订阅 / 新建 / 删除 / 卡片摘要在 ./composables/useWorkbenchWorkspaces,
 * 展示件在 components/workshop/workbench/**;样式随各自的标记进组件
 * (scoped 编译成 .x[data-v-<scopeId>],不能外移成公共 css)。
 *
 * ⚠️ 两个 composable 都必须在**页面 setup 期**调用(各一次):useWorkshopWs 的心跳
 * onMounted、needsSetup 的 onMounted 探测、channel 订阅的 watch 都注册在页面实例上。
 * 把这些调用挪进子组件会让副作用跟随子组件的挂载时机注册,页面也不再持有订阅引用计数。
 */
import AuthGate from '@/app/components/workshop/workbench/AuthGate.vue'
import CreateWorkspaceModal from '@/app/components/workshop/workbench/CreateWorkspaceModal.vue'
import WorkbenchHead from '@/app/components/workshop/workbench/WorkbenchHead.vue'
import WorkspaceCard from '@/app/components/workshop/workbench/WorkspaceCard.vue'
import WorkspaceEmpty from '@/app/components/workshop/workbench/WorkspaceEmpty.vue'
import { useWorkbenchAuth } from './composables/useWorkbenchAuth'
import { useWorkbenchWorkspaces } from './composables/useWorkbenchWorkspaces'

const { t } = useI18n()

definePageMeta({ layout: 'default' })

const {
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
} = useWorkbenchAuth()
const { wsStore, ready, createOpen, createName, createLoading, create, remove, channelSummary } = useWorkbenchWorkspaces()

/** 卡片两个入口(摘要行 / 底部主按钮)共用同一跳转 */
const openWorkspace = (id: string): void => {
  navigateTo(`/workshop/w/${id}`)
}

useHead({ title: () => t('titles.workshop') })
</script>

<template>
  <div class="page">
    <!-- 登录门 -->
    <AuthGate
      v-if="!userStore.isLoggedIn"
      v-model:active-tab="authTab"
      v-model:name="authName"
      v-model:email="authEmail"
      v-model:password="authPassword"
      v-model:token-input="authTokenInput"
      :loading="authLoading"
      :needs-setup="needsSetup"
      @register="doRegister"
      @login="doLogin"
      @login-with-token="doLoginWithToken"
    />

    <!-- 工作区(已登录) -->
    <template v-else>
      <WorkbenchHead
        :user-name="userStore.user?.name"
        @logout="doLogout"
        @new-workspace="createOpen = true"
      />

      <a-spin :spinning="!ready">
        <div class="grid">
          <WorkspaceCard
            v-for="ws in wsStore.workspaces"
            :key="ws.id"
            :workspace="ws"
            :channels="channelSummary(ws.channelIds)"
            @open="openWorkspace"
            @remove="remove"
          />

          <WorkspaceEmpty
            v-if="wsStore.workspaces.length === 0 && ready"
            @create="createOpen = true"
          />
        </div>
      </a-spin>

      <CreateWorkspaceModal
        v-model:open="createOpen"
        v-model:name="createName"
        :loading="createLoading"
        @ok="create"
      />
    </template>
  </div>
</template>

<style scoped>
.page { padding: 4px; }

/* 卡片/空态/页头/登录门的规则都随各自的标记搬进了 components/workshop/workbench/*
   (scoped 编译成 .x[data-v-<scopeId>],样式必须与拥有该元素的标记同址);
   这里只剩页面自己的外壳类。 */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}
</style>
