<script setup lang="ts">
/**
 * API Token 管理页 —— 当前用户对自己 token 的 CRUD。
 * 身份源:全局用户系统(/api/users/tokens);未登录经由 auth-gate 引导回登录门。
 *
 * 页面只做编排:列表与行内明文在 pages/tokens/composables/*,创建/重命名/一次性明文回显
 * 也各自收在同一个目录的组合式函数里;区块与弹窗在 components/tokens/*
 * (页面私有子组件刻意不放 app/pages —— 该目录下任何 .vue 都会被当成路由)。
 * ⚠️ 创建响应里的明文全应用只有一份(useTokenCreate 的 createdRaw),回显弹窗是纯呈现。
 */
import { useUserStore } from '@/app/stores/workshop/user'
// 页面是 app/pages/tokens.vue(**文件**,不是目录),composable 放在同名的 app/pages/tokens/ 目录里,
// 故相对路径要带一级 `tokens/`(写成 './composables/…' 会解析到 app/pages/composables,tsc 报 TS2307)
import { useTokensList } from './tokens/composables/useTokensList'
import { useTokenCreate } from './tokens/composables/useTokenCreate'
import { useTokenRename } from './tokens/composables/useTokenRename'
import { useTokenReveal } from './tokens/composables/useTokenReveal'
import TokensAuthGate from '~/components/tokens/TokensAuthGate.vue'
import TokensPageHead from '~/components/tokens/TokensPageHead.vue'
import TokensTable from '~/components/tokens/TokensTable.vue'
import TokenCreateModal from '~/components/tokens/TokenCreateModal.vue'
import TokenOnceModal from '~/components/tokens/TokenOnceModal.vue'
import TokenRenameModal from '~/components/tokens/TokenRenameModal.vue'

const { t: tt } = useI18n()

definePageMeta({ layout: 'default' })

const userStore = useUserStore()

// ===== 列表快照 + 行内明文(各自唯一持有,组件只读)=====
const { tokens, loading, load, doRevoke } = useTokensList()
const { revealedPlain, revealingId, copyId, toggleRowReveal, copyRow } = useTokenReveal()

// ===== 创建(含一次性明文回显)/ 重命名:成功后各自重查同一份列表 =====
const {
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
} = useTokenCreate({ onCreated: load })
const { renameOpen, renameLabel, renameLoading, openRename, doRename } = useTokenRename({ onRenamed: load })

useHead({ title: () => tt('titles.tokens') })
</script>

<template>
  <div class="page">
    <!-- 未登录:引导回 workshop 登录门 -->
    <TokensAuthGate v-if="!userStore.isLoggedIn" />

    <template v-else>
      <TokensPageHead
        :user-name="userStore.user?.name"
        :has-current-token="!!userStore.user?.tokenId"
        @issue="createOpen = true"
      />

      <TokensTable
        :rows="tokens"
        :loading="loading"
        :current-token-id="userStore.user?.tokenId"
        :revealed-plain="revealedPlain"
        :revealing-id="revealingId"
        :copy-id="copyId"
        @rename="openRename"
        @revoke="doRevoke"
        @reveal="toggleRowReveal"
        @copy="copyRow"
      />

      <TokenCreateModal
        v-model:open="createOpen"
        v-model:label="createLabel"
        :loading="createLoading"
        @submit="doCreate"
      />

      <TokenOnceModal
        :open="createdRaw !== ''"
        :raw="createdRaw"
        :masked="masked"
        :revealed="revealed"
        :copied="copied"
        :label="lastCreatedLabel"
        @toggle="toggleReveal"
        @copy="copyCreated"
        @dismiss="dismissCreated"
      />

      <TokenRenameModal
        v-model:open="renameOpen"
        v-model:label="renameLabel"
        :loading="renameLoading"
        @submit="doRename"
      />
    </template>
  </div>
</template>

<style scoped>
.page { padding: 4px; }
</style>
