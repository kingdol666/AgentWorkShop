<script setup lang="ts">
/**
 * ChannelToolSettings —— Channel 级工具选择器(设置弹窗内嵌)。
 *
 * - all: 全部合格工具启用,只记录被取消勾选的工具(deny-list)
 * - selected: 只启用勾选工具(allow-list;新工具默认不启用)
 * - 硬规则排除的工具置灰并展示原因,不能通过本开关打开
 * - 保存独立提交,不随弹窗其他字段的 OK 一起保存
 */
import { computed, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useWorkshopApi, type ChannelToolDto, type ChannelToolViewDto } from '@/app/composables/workshop/useWorkshopApi'
import { apiErrorMessage } from '@/app/utils/api-error'

const props = defineProps<{ channelId: string }>()
const { t } = useI18n()
const api = useWorkshopApi()

const view = ref<ChannelToolViewDto | null>(null)
const loading = ref(false)
const saving = ref(false)
const query = ref('')
const sourceFilter = ref<'all' | 'builtin' | 'plugin'>('all')
const statusFilter = ref<'all' | 'effective' | 'disabled' | 'blocked'>('all')
const mode = ref<'all' | 'selected'>('all')
const checked = reactive<Record<string, boolean>>({})
let initialSignature = ''

function hardBlocked(tool: ChannelToolDto): boolean {
  return !tool.eligibility.lead.eligible && !tool.eligibility.worker.eligible
}

function canToggle(tool: ChannelToolDto): boolean {
  return tool.available && !hardBlocked(tool)
}

function rowChecked(tool: ChannelToolDto): boolean {
  return checked[tool.name] === true
}

function effectiveDraft(tool: ChannelToolDto): { lead: boolean, worker: boolean } {
  const on = rowChecked(tool) && tool.available && !hardBlocked(tool)
  return {
    lead: on && tool.eligibility.lead.eligible,
    worker: on && tool.eligibility.worker.eligible,
  }
}

function signature(): string {
  const tools = view.value?.tools.map(tool => [tool.name, rowChecked(tool)]) ?? []
  return JSON.stringify({ mode: mode.value, tools })
}

const dirty = computed(() => Boolean(view.value) && signature() !== initialSignature)

const coreDisabled = computed(() => {
  if (!view.value) return false
  const core = new Set(['report_progress', 'complete_task', 'poll_messages'])
  return view.value.tools.some(tool => core.has(tool.name) && !rowChecked(tool))
})

function reasonText(tool: ChannelToolDto): string {
  if (!tool.available) return t('channelTools.unavailable')
  const reason = tool.eligibility.lead.reason !== 'OK' ? tool.eligibility.lead.reason : tool.eligibility.worker.reason
  const map: Record<string, string> = {
    ROLE_DENIED: t('channelTools.reasonRole'),
    PROFILE_DENIED: t('channelTools.reasonProfile'),
    WRITE_GUARD: t('channelTools.reasonWrite'),
    PLUGIN_DISABLED: t('channelTools.reasonPlugin'),
    CHANNEL_PLUGIN_DISABLED: t('channelTools.reasonChannelPlugin'),
    UNAVAILABLE: t('channelTools.unavailable'),
  }
  return map[reason] ?? tool.eligibility.lead.message ?? reason
}

const filtered = computed(() => {
  const list = view.value?.tools ?? []
  const q = query.value.trim().toLowerCase()
  return list.filter((tool) => {
    if (sourceFilter.value !== 'all' && tool.source !== sourceFilter.value) return false
    if (statusFilter.value === 'blocked' && !hardBlocked(tool)) return false
    if (statusFilter.value === 'disabled' && rowChecked(tool)) return false
    if (statusFilter.value === 'effective' && !(effectiveDraft(tool).lead || effectiveDraft(tool).worker)) return false
    if (!q) return true
    return `${tool.name} ${tool.label} ${tool.description} ${tool.plugin ?? ''}`.toLowerCase().includes(q)
  })
})

function applyDraft(next: ChannelToolViewDto): void {
  view.value = next
  mode.value = next.mode
  for (const tool of next.tools) {
    // selected 模式下硬规则阻止的工具不勾选(显式 allow-list 不能含永不合格项)
    checked[tool.name] = next.mode === 'selected'
      ? tool.channelEnabled && !hardBlocked(tool)
      : tool.channelEnabled
  }
  initialSignature = signature()
}

async function load(): Promise<void> {
  if (!props.channelId) return
  loading.value = true
  try {
    const res = await api.listChannelTools(props.channelId)
    if (res?.data) applyDraft(res.data)
  }
  catch (e) {
    message.error(apiErrorMessage(e, t('channelTools.loadFail')))
  }
  finally {
    loading.value = false
  }
}

function onModeChange(): void {
  const tools = view.value?.tools ?? []
  for (const tool of tools) {
    if (mode.value === 'all') {
      checked[tool.name] = true
    }
    else if (hardBlocked(tool) || !tool.available) {
      checked[tool.name] = false
    }
    else if (checked[tool.name] === undefined) {
      checked[tool.name] = true
    }
  }
}

function selectAll(): void {
  for (const tool of filtered.value) {
    if (canToggle(tool)) checked[tool.name] = true
  }
}

function selectNone(): void {
  for (const tool of filtered.value) checked[tool.name] = false
}

async function save(): Promise<void> {
  if (!view.value || saving.value) return
  saving.value = true
  try {
    const payload = view.value.tools.map(tool => ({
      name: tool.name,
      // selected: 硬规则阻止/不可用的显式项不勾选(服务端会 409);
      // all: 只提交“是否取消勾选”,enabled=true 不落库。
      enabled: mode.value === 'selected'
        ? rowChecked(tool) && tool.available && !hardBlocked(tool)
        : rowChecked(tool),
    }))
    const res = await api.putChannelTools(props.channelId, { mode: mode.value, tools: payload })
    if (res?.data) applyDraft(res.data)
    message.success(t('channelTools.saved'))
  }
  catch (e) {
    message.error(apiErrorMessage(e, t('channelTools.saveFail')))
  }
  finally {
    saving.value = false
  }
}

async function resetToDefault(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    const res = await api.resetChannelTools(props.channelId)
    if (res?.data) applyDraft(res.data)
    message.success(t('channelTools.resetDone'))
  }
  catch (e) {
    message.error(apiErrorMessage(e, t('channelTools.resetFail')))
  }
  finally {
    saving.value = false
  }
}

watch(() => props.channelId, () => {
  void load()
}, { immediate: true })
</script>

<template>
  <div class="ch-tools">
    <div class="ch-tools-head">
      <div>
        <div class="ch-tools-title">
          {{ $t('channelTools.sectionTitle') }}
        </div>
        <div class="ws-hint">
          {{ $t('channelTools.description') }}
        </div>
      </div>
      <a-button
        size="small"
        :loading="loading"
        @click="load"
      >
        {{ $t('channelTools.refresh') }}
      </a-button>
    </div>

    <a-spin :spinning="loading">
      <div class="ch-tools-mode">
        <a-radio-group
          v-model:value="mode"
          size="small"
          button-style="solid"
          @change="onModeChange"
        >
          <a-radio-button value="all">
            {{ $t('channelTools.modeAll') }}
          </a-radio-button>
          <a-radio-button value="selected">
            {{ $t('channelTools.modeSelected') }}
          </a-radio-button>
        </a-radio-group>
        <span class="ws-hint">{{ mode === 'all' ? $t('channelTools.modeAllHint') : $t('channelTools.modeSelectedHint') }}</span>
      </div>

      <div
        v-if="view"
        class="ch-tools-stats"
      >
        {{ $t('channelTools.stats', {
          total: view.stats.total,
          lead: view.stats.effectiveLead,
          worker: view.stats.effectiveWorker,
          disabled: view.stats.channelDisabled,
        }) }}
      </div>

      <div class="ch-tools-filters">
        <a-input-search
          v-model:value="query"
          size="small"
          allow-clear
          :placeholder="$t('channelTools.searchPlaceholder')"
        />
        <a-select
          v-model:value="sourceFilter"
          size="small"
          style="width: 132px"
          :options="[
            { value: 'all', label: $t('channelTools.sourceAll') },
            { value: 'builtin', label: $t('channelTools.sourceBuiltin') },
            { value: 'plugin', label: $t('channelTools.sourcePlugin') },
          ]"
        />
        <a-select
          v-model:value="statusFilter"
          size="small"
          style="width: 150px"
          :options="[
            { value: 'all', label: $t('channelTools.filterAll') },
            { value: 'effective', label: $t('channelTools.filterEffective') },
            { value: 'disabled', label: $t('channelTools.filterDisabled') },
            { value: 'blocked', label: $t('channelTools.filterBlocked') },
          ]"
        />
      </div>

      <div class="ch-tools-actions">
        <a-button
          size="small"
          @click="selectAll"
        >
          {{ $t('channelTools.selectAll') }}
        </a-button>
        <a-button
          size="small"
          @click="selectNone"
        >
          {{ $t('channelTools.selectNone') }}
        </a-button>
        <span
          v-if="dirty"
          class="ch-tools-dirty"
        >{{ $t('channelTools.dirty') }}</span>
      </div>

      <a-alert
        v-if="coreDisabled"
        type="warning"
        show-icon
        class="ch-tools-warn"
        :message="$t('channelTools.coreWarning')"
      />

      <div class="ch-tools-list">
        <div
          v-for="tool in filtered"
          :key="tool.name"
          class="ch-tool-row"
          :class="{ 'is-blocked': hardBlocked(tool), 'is-off': !rowChecked(tool) }"
        >
          <a-checkbox
            :checked="rowChecked(tool)"
            :disabled="!canToggle(tool)"
            @change="(e: any) => { checked[tool.name] = !!e.target.checked }"
          />
          <div class="ch-tool-main">
            <div class="ch-tool-name">
              <span class="aw-mono">{{ tool.name }}</span>
              <span class="ch-tool-label">{{ tool.label }}</span>
            </div>
            <div class="ch-tool-meta">
              <a-tag :color="tool.source === 'plugin' ? 'purple' : 'default'">
                {{ tool.source === 'plugin' ? $t('channelTools.sourcePlugin') : $t('channelTools.sourceBuiltin') }}
              </a-tag>
              <a-tag
                v-if="tool.plugin"
                color="geekblue"
              >
                {{ tool.plugin }}
              </a-tag>
              <a-tag
                v-if="tool.roles.length === 1"
                color="gold"
              >
                {{ $t('channelTools.leadOnly') }}
              </a-tag>
              <a-tag
                v-if="!tool.available"
                color="red"
              >
                {{ $t('channelTools.unavailable') }}
              </a-tag>
              <a-tag
                v-else-if="hardBlocked(tool)"
                color="orange"
              >
                {{ reasonText(tool) }}
              </a-tag>
              <span class="ch-tool-desc">{{ tool.description }}</span>
            </div>
          </div>
          <div class="ch-tool-eff">
            <span :class="{ on: effectiveDraft(tool).lead }">lead</span>
            <span :class="{ on: effectiveDraft(tool).worker }">worker</span>
          </div>
        </div>
        <div
          v-if="!filtered.length"
          class="ws-hint ch-tools-empty"
        >
          {{ $t('channelTools.noTools') }}
        </div>
      </div>

      <div class="ch-tools-footer">
        <a-button
          size="small"
          :disabled="!dirty"
          @click="load"
        >
          {{ $t('channelTools.undo') }}
        </a-button>
        <a-popconfirm
          :title="$t('channelTools.resetConfirm')"
          @confirm="resetToDefault"
        >
          <a-button
            danger
            size="small"
            :loading="saving"
          >
            {{ $t('channelTools.reset') }}
          </a-button>
        </a-popconfirm>
        <a-button
          type="primary"
          size="small"
          :loading="saving"
          :disabled="!dirty"
          @click="save"
        >
          {{ $t('channelTools.save') }}
        </a-button>
      </div>
    </a-spin>
  </div>
</template>

<style scoped>
.ch-tools {
  border: 1px solid var(--border, rgba(128, 128, 128, .25));
  border-radius: 10px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ch-tools-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.ch-tools-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 2px;
}
.ch-tools-mode {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ch-tools-stats {
  font-size: 12px;
  color: var(--ink-soft);
}
.ch-tools-filters {
  display: flex;
  gap: 8px;
  align-items: center;
}
.ch-tools-filters :deep(.ant-input-search) {
  flex: 1;
}
.ch-tools-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.ch-tools-dirty {
  font-size: 12px;
  color: #e6a23c;
}
.ch-tools-warn {
  margin: 0;
}
.ch-tools-list {
  max-height: 340px;
  overflow: auto;
  border: 1px solid var(--border, rgba(128, 128, 128, .2));
  border-radius: 8px;
}
.ch-tool-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border, rgba(128, 128, 128, .15));
}
.ch-tool-row:last-child {
  border-bottom: 0;
}
.ch-tool-row.is-off {
  opacity: .55;
}
.ch-tool-row.is-blocked {
  background: rgba(230, 162, 60, .05);
}
.ch-tool-main {
  flex: 1;
  min-width: 0;
}
.ch-tool-name {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.ch-tool-label {
  font-size: 12px;
  color: var(--ink-soft);
}
.ch-tool-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  align-items: center;
  margin-top: 3px;
}
.ch-tool-desc {
  flex: 1 1 100%;
  font-size: 11px;
  color: var(--ink-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-tool-eff {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 10px;
  color: var(--ink-faint);
  text-align: right;
}
.ch-tool-eff .on {
  color: #35e0a0;
}
.ch-tools-empty {
  padding: 16px;
  text-align: center;
}
.ch-tools-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
