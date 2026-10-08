<script setup lang="ts">
import type { MenuProps } from 'ant-design-vue'
import { useUserStore } from '@/app/stores/workshop/user'
import { useAuthUiStore } from '@/app/stores/workshop/auth-ui'

const { t } = useI18n()
const userStore = useUserStore()
const authUi = useAuthUiStore()

// 用户铭牌:真实身份(workshop 用户系统;未登录 = 访客)
const userInitial = computed(() => (userStore.user?.name ?? '?').trim().charAt(0).toUpperCase())
const userName = computed(() => userStore.user?.name ?? t('header.guest'))
const userRole = computed(() => (userStore.isLoggedIn ? userStore.user?.role ?? 'user' : 'anonymous'))

interface AvatarMenuEntry {
  key: string
  label: string
  icon?: string
  danger?: boolean
  divider?: boolean
}

const avatarItems = computed<AvatarMenuEntry[]>(() => {
  const items: AvatarMenuEntry[] = []
  // 访客首项 = 登录(F2 修复:主壳此前无任何登录入口)
  if (!userStore.isLoggedIn) {
    items.push({ key: 'login', icon: 'i-tabler-login', label: t('header.login') })
  }
  items.push(
    { key: 'tokens', icon: 'i-tabler-key', label: t('menu.tokens') },
    { key: 'settings', icon: 'i-tabler-adjustments', label: t('menu.settings') },
  )
  if (userStore.isLoggedIn) {
    items.push({ key: 'd-logout', label: '', divider: true })
    items.push({ key: 'logout', icon: 'i-tabler-logout', label: t('header.logout'), danger: true })
  }
  return items
})

const onAvatarMenu: MenuProps['onClick'] = async ({ key }) => {
  if (key === 'login') {
    authUi.openLogin('manual')
  }
  else if (key === 'settings') {
    navigateTo('/settings')
  }
  else if (key === 'tokens') {
    navigateTo('/tokens')
  }
  else if (key === 'logout') {
    await userStore.logout()
    // 登出后留在当前页并弹出登录门(匿名态数据已隔离为 0,顺手给出进门通道)
    authUi.openLogin('anonymous')
  }
}
</script>

<template>
  <a-dropdown>
    <div class="user-chip">
      <!-- 用户身份(session 异步解析)仅客户端可知:SSR 渲染中性占位,挂载后填充
           —— 消除 hydration mismatch(unhead dispose 噪音的根因) -->
      <ClientOnly>
        <span class="user-initial aw-avatar">{{ userInitial }}</span>
        <span class="user-meta">
          <span class="user-name">{{ userName }}</span>
          <span class="user-role">{{ userRole }}</span>
        </span>
        <template #fallback>
          <span class="user-initial aw-avatar">·</span>
          <span class="user-meta">
            <span class="user-name">·</span>
            <span class="user-role">·</span>
          </span>
        </template>
      </ClientOnly>
    </div>
    <template #overlay>
      <a-menu @click="onAvatarMenu">
        <template
          v-for="item in avatarItems"
          :key="item.key"
        >
          <a-menu-divider v-if="item.divider" />
          <a-menu-item
            v-else
            :key="item.key"
            :danger="item.danger"
          >
            <span
              :class="item.icon"
              class="mr-2"
            />
            {{ item.label }}
          </a-menu-item>
        </template>
      </a-menu>
    </template>
  </a-dropdown>
</template>

<style scoped>
/* 操作者铭牌:头像 + 双行 */
.user-chip {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 42px;
  margin-left: 4px;
  padding: 0 12px 0 8px;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  transition: border-color 0.16s ease, background 0.16s ease;
}

.user-chip:hover {
  border-color: var(--line);
  background: var(--hover-tint);
}

.user-initial {
  width: 28px;
  height: 28px;
  font-size: 12px;
}

.user-meta {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}

.user-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--app-text, var(--ink));
  letter-spacing: 0.01em;
}

.user-role {
  font-family: var(--font-mono);
  /* 8.5px 是"看得见读不了"的下限之外(实测常驻被审计标红);
     角色是身份信息,不是装饰刻度,抬到 9.5px 仍保持铭牌声部 */
  font-size: 9.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--app-text-secondary, var(--ink-faint));
}

@media (max-width: 639px) {
  .user-chip {
    height: 38px;
    padding: 0 6px;
  }

  .user-meta {
    display: none;
  }
}
</style>
