<script setup lang="ts">
import type { ConfigGroup } from '@/app/stores/runtime-config'
import RuntimeFieldRow from './RuntimeFieldRow.vue'
import { useSettingsGroupsContext } from '@/app/composables/workshop/useSettingsGroups'

defineProps<{ group: ConfigGroup }>()

const { t } = useI18n()
const rcStore = useRuntimeConfigStore()
const {
  groupLabel,
  groupSourceBadge,
  isCollapsed,
  toggleGroup,
  renamingId,
  renameDraft,
  commitRename,
  startRename,
  isAdmin,
  groupBusy,
  moveGroup,
  setGroupDefaultCollapsed,
  removeGroup,
} = useSettingsGroupsContext()
</script>

<template>
  <section
    class="rt-group"
    :class="{ 'collapsed': isCollapsed(group), 'grp-plugin': group.source === 'plugin' }"
  >
    <header
      class="rt-group-head"
      :role="group.collapsible ? 'button' : undefined"
      :tabindex="group.collapsible ? 0 : undefined"
      @click="toggleGroup(group)"
      @keydown.enter.prevent="toggleGroup(group)"
      @keydown.space.prevent="toggleGroup(group)"
    >
      <span
        v-if="group.collapsible"
        class="rt-caret"
        :class="isCollapsed(group) ? 'i-tabler-chevron-right' : 'i-tabler-chevron-down'"
      />
      <span
        v-if="group.icon"
        class="rt-group-icon"
        :class="group.icon"
      />
      <template v-if="renamingId === group.id">
        <input
          v-model="renameDraft"
          class="rt-rename aw-mono"
          @click.stop
          @keydown.enter.prevent="commitRename(group.id)"
          @keydown.esc.prevent="renamingId = ''"
        >
        <button
          class="mini-btn"
          @click.stop="commitRename(group.id)"
        >
          {{ t('settings.groups.ok') }}
        </button>
      </template>
      <h4
        v-else
        class="rt-group-title"
      >
        {{ groupLabel(group) }}
      </h4>
      <span class="rt-group-badge">{{ groupSourceBadge(group) }}</span>
      <span class="rt-group-fields">{{ t('settings.groups.fields', { p0: group.fieldCount ?? 0 }) }}</span>
      <span
        v-if="group.description"
        class="rt-group-desc"
      >{{ group.description }}</span>
      <!-- 分组操作(admin):插件声明的分组由插件权威,不提供改名/删除 -->
      <span
        v-if="isAdmin && group.source !== 'plugin'"
        class="rt-group-ops"
        @click.stop
      >
        <button
          class="mini-btn"
          :disabled="groupBusy === group.id"
          :title="t('settings.groups.moveUp')"
          @click="moveGroup(group.id, -1)"
        >
          <span class="i-tabler-arrow-up" />
        </button>
        <button
          class="mini-btn"
          :disabled="groupBusy === group.id"
          :title="t('settings.groups.moveDown')"
          @click="moveGroup(group.id, 1)"
        >
          <span class="i-tabler-arrow-down" />
        </button>
        <button
          class="mini-btn"
          :disabled="groupBusy === group.id"
          :title="t('settings.groups.rename')"
          @click="startRename(group)"
        >
          <span class="i-tabler-pencil" />
        </button>
        <button
          class="mini-btn"
          :disabled="groupBusy === group.id"
          :title="t('settings.groups.defaultCollapsed')"
          @click="setGroupDefaultCollapsed(group)"
        >
          <span :class="group.collapsed ? 'i-tabler-chevrons-down' : 'i-tabler-chevrons-up'" />
        </button>
        <button
          v-if="group.source === 'user'"
          class="mini-btn"
          :disabled="groupBusy === group.id"
          :title="t('settings.groups.delete')"
          @click="removeGroup(group)"
        >
          <span class="i-tabler-trash" />
        </button>
      </span>
    </header>

    <div
      v-show="!isCollapsed(group)"
      class="rt-group-body"
    >
      <p
        v-if="!(group.fieldCount ?? 0)"
        class="rt-group-empty"
      >
        {{ t('settings.groups.emptyHint') }}
      </p>
      <RuntimeFieldRow
        v-for="item in rcStore.fieldsOf(group.id)"
        :key="item.key"
        :item="item"
      />
    </div>
  </section>
</template>

<style scoped>
.rt-group {
  margin: 0 0 10px;
  background: var(--surface-glass);
  border: 1px solid var(--glass-line);
  border-radius: 10px;
}

/* 插件声明的分区:左侧一道强调色,与平台内置分区一眼可分 */
.rt-group.grp-plugin {
  border-left: 3px solid color-mix(in srgb, var(--tone-info-dot) 55%, transparent);
}

.rt-group-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 10px 14px;
  border-radius: 10px;
}

.rt-group.collapsed .rt-group-head {
  border-radius: 10px;
}

.rt-group-head[role='button'] {
  cursor: pointer;
}

.rt-group-head[role='button']:hover {
  background: var(--hover-tint);
}

.rt-caret {
  flex: none;
  font-size: 15px;
  color: var(--ink-faint);
}

.rt-group-icon {
  flex: none;
  font-size: 14px;
  color: var(--accent);
}

.rt-rename {
  width: 200px;
  padding: 2px 8px;
  font-size: 14px;
  color: var(--ink);
  background: var(--paper-deep);
  border: 1px solid var(--accent);
  border-radius: var(--radius-chip);
}

.rt-group-badge {
  flex: none;
  padding: 1px 7px;
  font-size: 11.5px;
  color: var(--ink-faint);
  border: 1px solid var(--glass-line);
  border-radius: 99px;
}

.rt-group.grp-plugin .rt-group-badge {
  color: var(--tone-info-dot);
  border-color: color-mix(in srgb, var(--tone-info-dot) 40%, transparent);
}

.rt-group-fields {
  flex: none;
  font-size: 11.5px;
  color: var(--ink-faint);
}

.rt-group-desc {
  min-width: 0;
  font-size: 11.5px;
  color: var(--ink-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rt-group-ops {
  display: flex;
  gap: 2px;
  align-items: center;
  margin-left: auto;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.rt-group-head:hover .rt-group-ops,
.rt-group-ops:focus-within {
  opacity: 1;
}

.rt-group-body {
  padding: 0 14px 6px;
  border-top: 1px solid var(--line);
}

.rt-group-empty {
  margin: 10px 0 4px;
  font-size: 12.5px;
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

@media (max-width: 899px) {
  /* 正文说明文字窄屏抬到 13px 地板 */
  .rt-group-empty {
    font-size: 13px;
  }

  .rt-group-desc {
    flex: 1 1 100%;
  }

  /* 手指命中区:分组操作按钮只有 24px 高 */
  .rt-group-ops .mini-btn,
  .rt-group-head .mini-btn {
    min-width: 40px;
    min-height: 40px;
    padding: 6px 10px;
  }
}

/* 无 hover 的设备(手机/平板):分组操作不能只在 hover 时才出现 */
@media (hover: none) {
  .rt-group-ops {
    opacity: 1;
  }
}
</style>
