<script setup lang="ts">
import type { SettingsDescriptor } from '@/app/stores/runtime-config'
import { useRuntimeConfigDraftContext } from '@/app/composables/workshop/useRuntimeConfigDraft'
import { useSettingsGroupsContext } from '@/app/composables/workshop/useSettingsGroups'

defineProps<{ item: SettingsDescriptor }>()

const { t } = useI18n()
const rcStore = useRuntimeConfigStore()
const { draft, markDirty, resetRuntimeKey } = useRuntimeConfigDraftContext()
const { itemLabel, sourceClass } = useSettingsGroupsContext()
</script>

<template>
  <div class="rt-row">
    <div class="rt-main">
      <div class="rt-title">
        {{ itemLabel(item) }}
        <span
          class="rt-tag"
          :class="sourceClass(rcStore.sourceOf(item.key))"
        >{{ rcStore.sourceOf(item.key) }}</span>
        <span
          class="rt-tag"
          :class="item.applies"
        >{{ item.applies === 'live' ? t('settings.runtime.live') : t('settings.runtime.restart') }}</span>
      </div>
      <div class="rt-sub">
        {{ item.description }}
      </div>
    </div>
    <div class="rt-ctrl">
      <a-input-number
        v-if="item.type === 'number'"
        v-model:value="(draft[item.key] as string | number | undefined)"
        :min="item.min"
        :max="item.max"
        @change="markDirty(item.key)"
      />
      <a-switch
        v-else-if="item.type === 'boolean'"
        v-model:checked="(draft[item.key] as string | number | boolean | undefined)"
        @change="markDirty(item.key)"
      />
      <a-select
        v-else-if="item.type === 'select'"
        v-model:value="(draft[item.key] as string | number | undefined)"
        style="width: 160px"
        :options="(item.options ?? []).map(o => ({ label: o, value: o }))"
        @change="markDirty(item.key)"
      />
      <span
        v-else-if="item.type === 'color'"
        class="rt-color"
      >
        <input
          type="color"
          :value="String(draft[item.key] ?? '#35e0a0')"
          @input="draft[item.key] = ($event.target as HTMLInputElement).value; markDirty(item.key)"
        >
        <a-input
          :value="String(draft[item.key] ?? '')"
          style="width: 110px"
          class="aw-mono"
          @change="draft[item.key] = ($event.target as HTMLInputElement).value; markDirty(item.key)"
        />
      </span>
      <a-input
        v-else
        v-model:value="(draft[item.key] as string | number | undefined)"
        style="width: 220px"
        @change="markDirty(item.key)"
      />
      <button
        class="aw-pill outline rt-reset"
        :title="t('settings.runtime.resetKey')"
        @click="resetRuntimeKey(item.key)"
      >
        <span class="i-tabler-rotate" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.rt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 11px 0;
  border-bottom: 1px solid var(--line);
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

.rt-tag.src-env {
  color: #c9963f;
  border-color: rgb(201 150 63 / 45%);
}

.rt-tag.live {
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

.rt-color {
  display: inline-flex;
  gap: 8px;
  align-items: center;
}

.rt-color input[type='color'] {
  width: 36px;
  height: 32px;
  padding: 2px;
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: 6px;
}

.rt-reset {
  padding: 4px 9px;
  font-size: 12px;
}

@media (max-width: 768px) {
  .rt-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
}

@media (max-width: 899px) {
  /* 正文说明文字窄屏抬到 13px 地板 */
  .rt-sub {
    font-size: 13px;
  }
}
</style>
