<script setup lang="ts">
/**
 * 登录门(未登录态):注册 / 登录 / API Token 三入口 + 首启"注册管理员"文案切换。
 *
 * 无状态展示件:表单字段经 v-model 回流页面(useWorkbenchAuth 持有唯一副本),
 * 三个提交动作只上报点击 —— 校验/提示/加载态都在页面那一层,与拆分前一致
 * (needsSetup 探测是页面 onMounted 副作用,不下沉到这里)。
 */
import type { AuthTab } from '@/app/pages/workshop/composables/useWorkbenchAuth'

defineProps<{
  /** 提交中(按钮 loading) */
  loading: boolean
  /** 系统尚无管理员:切换为"注册管理员"文案并隐藏登录/Token 页签 */
  needsSetup: boolean
}>()

/** 注意:必须把 defineEmits 的返回值赋给 emit —— 模板里的 `emit(...)` 才解析得到(setup 绑定) */
const emit = defineEmits<{
  register: []
  login: []
  loginWithToken: []
}>()

const activeTab = defineModel<AuthTab>('activeTab', { required: true })
const name = defineModel<string>('name', { required: true })
const email = defineModel<string>('email', { required: true })
const password = defineModel<string>('password', { required: true })
const tokenInput = defineModel<string>('tokenInput', { required: true })

/** a-tabs 的 active-key 载荷是 string | number;本组件只有三个 key(见下方 a-tab-pane),原样收下 */
const onTabChange = (key: string | number): void => {
  activeTab.value = key as AuthTab
}
</script>

<template>
  <div class="auth-gate aw-orbs">
    <a-card class="auth-card">
      <p class="aw-kicker">
        agentworkshop / sign in
      </p>
      <h2>{{ needsSetup ? $t('wsHome.setupTitle') : $t('wsHome.kr0vzqu008') }}</h2>
      <p class="sub">
        {{ needsSetup
          ? $t('wsHome.setupSub')
          : $t('wsHome.normalSub') }}
      </p>
      <a-tabs
        :active-key="activeTab"
        @update:active-key="onTabChange"
      >
        <a-tab-pane
          v-if="!needsSetup"
          key="login"
          :tab="$t('wsHome.tabLogin')"
        >
          <a-space
            direction="vertical"
            style="width: 100%"
          >
            <a-input
              v-model:value="email"
              type="email"
              :placeholder="$t('wsHome.k48h2c001')"
              @keydown.enter="emit('login')"
            />
            <a-input-password
              v-model:value="password"
              :placeholder="$t('wsHome.k3yvgs002')"
              @keydown.enter="emit('login')"
            />
            <a-button
              type="primary"
              block
              :loading="loading"
              @click="emit('login')"
            >
              {{ $t('wsHome.k43kol009') }}
            </a-button>
            <p class="hint">
              {{ $t('wsHome.k17x74cj010') }}
            </p>
          </a-space>
        </a-tab-pane>
        <a-tab-pane
          key="register"
          :tab="needsSetup ? $t('wsHome.tabRegAdmin') : $t('wsHome.tabRegUser')"
        >
          <a-space
            direction="vertical"
            style="width: 100%"
          >
            <a-input
              v-model:value="name"
              :placeholder="$t('wsHome.kwgbai9003')"
            />
            <a-input
              v-model:value="email"
              type="email"
              :placeholder="$t('wsHome.kizjkbo004')"
            />
            <a-input-password
              v-model:value="password"
              :placeholder="$t('wsHome.kh3cqfn005')"
              @keydown.enter="emit('register')"
            />
            <a-button
              type="primary"
              block
              :loading="loading"
              @click="emit('register')"
            >
              {{ needsSetup ? $t('wsHome.setupCta') : $t('wsHome.k1so6a0v011') }}
            </a-button>
            <p class="hint">
              {{ $t('wsHome.k1r0a4u3012') }}
            </p>
          </a-space>
        </a-tab-pane>
        <a-tab-pane
          v-if="!needsSetup"
          key="token"
          :tab="$t('wsHome.tabToken')"
        >
          <a-space
            direction="vertical"
            style="width: 100%"
          >
            <a-input-password
              v-model:value="tokenInput"
              :placeholder="$t('wsHome.k15qunld006')"
              @keydown.enter="emit('loginWithToken')"
            />
            <a-button
              type="primary"
              block
              :loading="loading"
              @click="emit('loginWithToken')"
            >
              {{ $t('wsHome.k43kol009') }}
            </a-button>
          </a-space>
        </a-tab-pane>
      </a-tabs>
    </a-card>
  </div>
</template>

<style scoped>
/* 登录门的规则从 app/pages/workshop/index.vue 逐字搬来(这些元素现在归本组件所有,
   scoped 编译成 .x[data-v-<scopeId>],样式必须与标记同址)。
   .sub 在 WorkbenchHead.vue 另有一份同样的拷贝给页头描述用 —— 有意重复,不要合并成公共 css。 */
.auth-gate {
  display: flex;
  justify-content: center;
  padding-top: 8vh;
}

/* 登录卡:open-tag auth 声部(hairline-strong + 柔投影 + serif 标题) */
.auth-card {
  position: relative;
  width: 420px;
  max-width: 92vw;
  padding: 26px 26px 18px;
  border: 1px solid var(--line-strong) !important;
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-float);
}

.auth-card :deep(h2) {
  margin: 0 0 6px;
  font-family: var(--font-display);
  font-size: 26px;
}

.sub { margin: 0 0 14px; font-size: 12.5px; color: var(--ink-faint); }
.hint { margin: 8px 0 0; font-size: 11px; color: var(--ink-faint); }
</style>
