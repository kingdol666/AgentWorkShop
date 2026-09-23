<script setup lang="ts">
import RuntimeGroupSection from './RuntimeGroupSection.vue'
import PluginsSection from './PluginsSection.vue'
import { provideRuntimeConfigDraft } from '@/app/composables/workshop/useRuntimeConfigDraft'
import { provideSettingsGroups } from '@/app/composables/workshop/useSettingsGroups'
import { providePluginAdmin } from '@/app/composables/workshop/usePluginAdmin'

const props = defineProps<{ activeTab: string }>()

const { t } = useI18n()
const rcStore = useRuntimeConfigStore()
const { runtimeNotice, dirtyKeys, savingRuntime, saveRuntime, resetAllRuntime } = provideRuntimeConfigDraft()
const { allExpanded, groupFormOpen, groupForm, groupBusy, isAdmin, submitGroupForm, toggleAllGroups } = provideSettingsGroups()
// 插件态在本组件持有(标题/说明/注入槽要读 plugins.length),清单区由 PluginsSection 消费同一份
const { plugins } = providePluginAdmin(computed(() => props.activeTab))
</script>

<template>
  <div v-show="activeTab === 'runtime'">
    <h3 class="section-title">
      {{ t('settings.runtimeTab') }}
    </h3>
    <p class="section-desc">
      {{ t('settings.runtime.desc') }}
    </p>

    <a-alert
      v-if="runtimeNotice"
      :type="runtimeNotice.type"
      show-icon
      class="rt-notice"
      :message="runtimeNotice.text"
    />

    <!-- 分组工具条:一键展开/收起 + (admin) 新建分组 -->
    <div class="rt-groups-bar">
      <button
        class="aw-pill outline rt-groups-toggle"
        :title="t('settings.groups.toggleAll')"
        @click="toggleAllGroups"
      >
        <span :class="allExpanded ? 'i-tabler-chevrons-up' : 'i-tabler-chevrons-down'" />
        {{ allExpanded ? t('settings.groups.collapseAll') : t('settings.groups.expandAll') }}
      </button>
      <span class="rt-groups-count">{{ t('settings.groups.count', { p0: rcStore.groups.length }) }}</span>
      <button
        v-if="isAdmin"
        class="aw-pill outline rt-groups-add"
        @click="groupFormOpen = !groupFormOpen"
      >
        <span class="i-tabler-plus" />
        {{ t('settings.groups.newGroup') }}
      </button>
    </div>

    <!-- 新建分组(内联表单;id 由服务端按 label 派生,创建后即可用 API 归属字段) -->
    <div
      v-if="isAdmin && groupFormOpen"
      class="rt-group-form"
    >
      <a-input
        v-model:value="groupForm.label"
        :placeholder="t('settings.groups.namePlaceholder')"
        style="width: 220px"
        @press-enter="submitGroupForm"
      />
      <a-input
        v-model:value="groupForm.description"
        :placeholder="t('settings.groups.descPlaceholder')"
        style="width: 320px"
        @press-enter="submitGroupForm"
      />
      <a-checkbox v-model:checked="groupForm.collapsed">
        {{ t('settings.groups.defaultCollapsed') }}
      </a-checkbox>
      <button
        class="aw-pill primary"
        :disabled="!groupForm.label.trim() || groupBusy === 'create'"
        @click="submitGroupForm"
      >
        {{ groupBusy === 'create' ? '…' : t('settings.groups.create') }}
      </button>
      <button
        class="aw-pill outline"
        @click="groupFormOpen = false"
      >
        {{ t('settings.groups.cancel') }}
      </button>
    </div>

    <!-- 分组分区:顺序/标题/折叠态全部来自后端 groups 接口 -->
    <RuntimeGroupSection
      v-for="g in rcStore.groups"
      :key="g.id"
      :group="g"
    />

    <div class="rt-actions">
      <button
        class="aw-pill primary"
        :disabled="!dirtyKeys.size || savingRuntime"
        @click="saveRuntime"
      >
        <span class="i-tabler-device-floppy" />
        {{ savingRuntime ? '…' : t('settings.runtime.save') }}
      </button>
      <button
        class="aw-pill outline"
        @click="resetAllRuntime"
      >
        {{ t('settings.runtime.resetAll') }}
      </button>
      <span class="rt-path aw-mono">{{ rcStore.settingsPath }}</span>
    </div>

    <!-- 插件管理:清单 / 启停(admin) / 健康检测 -->
    <h4 class="rt-group-title plugin-group-title">
      {{ t('plugins.title') }}
    </h4>
    <p class="section-desc">
      {{ t('plugins.desc') }}
    </p>

    <PluginsSection />

    <!-- 插件 UI 注入区:client 面板经 ctx.ui.registerPanel({slot:'settings.plugins'}) 注入 -->
    <workshop-plugin-slot
      v-if="plugins.length"
      slot-name="settings.plugins"
    />
  </div>
</template>

<style scoped>
.section-title {
  margin: 0 0 4px;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 400;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.section-desc {
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-faint);
}

/* ============ 运行配置标签 ============ */
.rt-notice {
  margin: 0 0 14px;
}

/* ── 分组分区(后端 groups 接口驱动:顺序/标题/折叠态均来自服务端) ── */
.rt-groups-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 12px 0 10px;
}

.rt-groups-count {
  font-size: 11.5px;
  color: var(--ink-faint);
}

.rt-groups-add {
  margin-left: auto;
}

.rt-group-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 10px 12px;
  margin-bottom: 12px;
  background: var(--frost-bg);
  border: 1px solid var(--glass-line);
  border-radius: 10px;
}

.rt-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 18px;
}

.rt-path {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--ink-faint);
}

.rt-group-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 14.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--ink-soft);
}

/* 插件管理页的同名标题保留旧观感(独立于分组分区) */
.rt-group-title.plugin-group-title {
  margin: 20px 0 2px;
  font-size: 15px;
}

/* ============ 插件管理 ============ */
.plugin-group-title {
  margin-top: 30px;
  padding-top: 22px;
  border-top: 1px solid var(--line);
}

@media (max-width: 768px) {
  .rt-actions {
    flex-wrap: wrap;
  }
  .rt-path {
    margin-left: 0;
  }
}

@media (max-width: 899px) {
  /* 正文说明文字窄屏抬到 13px 地板 */
  .section-desc {
    font-size: 13px;
  }
}
</style>
