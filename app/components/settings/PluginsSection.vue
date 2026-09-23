<script setup lang="ts">
/**
 * 插件清单区:清单 / 启停(admin) / 健康检测;未登录时只留一条提示。
 * 单根约束:app/pages/** 下的 .vue 受 vue/no-multiple-template-root 约束,
 * 整块插件区的标题/说明/注入槽留在 RuntimePane,这里仅剩「登录提示 / 清单」这一对
 * v-if/v-else,正好构成规则允许的根链(不额外加包裹元素,渲染出的 DOM 与拆分前一致)。
 * 插件态由 RuntimePane 的 providePluginAdmin 下发,经 usePluginAdminContext 取同一份。
 */
import { usePluginAdminContext } from '@/app/composables/workshop/usePluginAdmin'
import { useUserStore } from '@/app/stores/workshop/user'

const { t } = useI18n()
const userStore = useUserStore()
const {
  plugins,
  pluginsLoading,
  hasHealthRoute,
  checkPluginHealth,
  isCheckingHealth,
  healthOf,
  isToggling,
  togglePlugin,
} = usePluginAdminContext()
</script>

<template>
  <div
    v-if="!userStore.isLoggedIn"
    class="identity-note"
  >
    {{ t('plugins.needLogin') }}
  </div>
  <a-spin
    v-else
    :spinning="pluginsLoading"
  >
    <div
      v-for="p in plugins"
      :key="p.name"
      class="plugin-row"
      :class="{ off: p.enabled === false }"
    >
      <div class="plugin-main">
        <div class="rt-title">
          <span class="aw-mono">{{ p.name }}</span>
          <span
            v-if="p.version"
            class="rt-tag"
          >v{{ p.version }}</span>
          <span
            v-if="p.builtin"
            class="rt-tag src-runtime"
          >{{ t('plugins.builtin') }}</span>
          <span
            v-if="p.error"
            class="rt-tag restart"
          >{{ p.error }}</span>
        </div>
        <div class="rt-sub">
          {{ p.description || '—' }}
        </div>
      </div>
      <div class="rt-ctrl">
        <span
          v-if="isCheckingHealth(p.name)"
          class="plugin-health faint"
        >
          <span class="i-tabler-loader-2 spin" />
          {{ t('plugins.healthChecking') }}
        </span>
        <span
          v-else-if="healthOf(p.name)"
          class="plugin-health"
          :class="healthOf(p.name)!.ok ? 'ok' : 'bad'"
        >
          <span :class="healthOf(p.name)!.ok ? 'i-tabler-circle-check' : 'i-tabler-alert-circle'" />
          {{ healthOf(p.name)!.ok ? t('plugins.healthOk') : `${t('plugins.healthBad')}: ${healthOf(p.name)!.reason ?? ''}` }}
        </span>
        <button
          v-if="hasHealthRoute(p)"
          class="aw-pill outline rt-reset"
          @click="checkPluginHealth(p)"
        >
          <span class="i-tabler-heartbeat" />
          {{ t('plugins.healthCheck') }}
        </button>
        <button
          class="switch"
          :class="{ on: p.enabled !== false }"
          role="switch"
          :aria-checked="p.enabled !== false"
          :disabled="isToggling(p.name)"
          @click="togglePlugin(p, p.enabled === false)"
        >
          <span class="knob" />
        </button>
      </div>
    </div>
    <div
      v-if="plugins.length === 0 && !pluginsLoading"
      class="identity-note"
    >
      {{ t('plugins.empty') }}
    </div>
  </a-spin>
</template>

<style scoped>
/* 药丸开关(ink on 态) */
.switch {
  position: relative;
  flex: none;
  width: 42px;
  height: 25px;
  padding: 0;
  cursor: pointer;
  background: var(--line-strong);
  border: 0;
  border-radius: var(--radius-pill);
  transition: background 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}

.switch .knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 19px;
  height: 19px;
  background: var(--paper-raised);
  border-radius: 50%;
  box-shadow: 0 1px 2px rgb(12 10 9 / 25%);
  transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}

.switch.on {
  background: var(--accent);
}

.switch.on .knob {
  transform: translateX(17px);
}

@media (prefers-reduced-motion: reduce) {
  .switch,
  .switch .knob {
    transition: none;
  }
}

.identity-note {
  margin: 14px 0 0;
  font-size: 12.5px;
  color: var(--ink-faint);
}

.rt-main {
  min-width: 0;
}

.rt-title {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--ink-soft);
}

.rt-sub {
  max-width: 46ch;
  margin-top: 3px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-faint);
}

.rt-tag {
  padding: 1px 7px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--ink-faint);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
}

.rt-tag.src-runtime {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

.rt-tag.restart {
  color: #c9963f;
  border-color: rgb(201 150 63 / 45%);
}

.rt-ctrl {
  display: flex;
  flex: none;
  gap: 8px;
  align-items: center;
}

.rt-reset {
  padding: 4px 9px;
  font-size: 12px;
}

/* ============ 插件管理 ============ */
.plugin-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 13px 0;
  border-bottom: 1px solid var(--line);
  transition: opacity var(--transition-fast);
}

.plugin-row.off {
  opacity: 0.55;
}

.plugin-main {
  min-width: 0;
}

.plugin-health {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  max-width: 320px;
  font-size: 12.5px;
  line-height: 1.4;
}

.plugin-health.ok {
  color: #2e9e6b;
}

.plugin-health.bad {
  color: #c2554a;
}

.plugin-health.faint {
  color: var(--ink-faint);
}

.plugin-health .spin {
  animation: plugin-spin 0.9s linear infinite;
}

@keyframes plugin-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .plugin-health .spin {
    animation: none;
  }
}

@media (max-width: 768px) {
  .plugin-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
}

@media (max-width: 899px) {
  /* 正文说明文字窄屏抬到 13px 地板 */
  .rt-sub,
  .identity-note,
  .plugin-health {
    font-size: 13px;
  }
}
</style>
