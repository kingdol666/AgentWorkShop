<script setup lang="ts">
/**
 * 图谱实体详情/编辑抽屉。
 * 人工权威：编辑/锁定/合并/软删/恢复；证据与提及可回指源记忆。
 */
import { computed, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { apiErrorMessage } from '@/app/utils/api-error'
import { memoryGraphApi, type GraphEntityDetail, type GraphNode } from '~/pages/memory/api'

const props = defineProps<{
  open: boolean
  channelId: string
  detail: GraphEntityDetail | null
  loading?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'refresh'): void
  (e: 'open-memory', id: string): void
}>()

const { t } = useI18n()
const gkey = (k: string): string => `memoryCenter.graph.${k}`

const editing = ref(false)
const saving = ref(false)
const mergeOpen = ref(false)
const mergeTarget = ref('')
const mergeOptions = ref<GraphNode[]>([])
const form = reactive({
  name: '',
  type: 'concept',
  aliases: '',
  summary: '',
  status: 'active',
  locked: false,
  validFrom: '',
  validTo: '',
})

const entity = computed(() => props.detail?.entity ?? null)
const entityTypes = [
  'concept', 'parameter', 'metric', 'device', 'node', 'recipe',
  'product', 'line', 'task', 'event', 'document', 'person',
]

watch(() => props.detail, (detail) => {
  if (!detail) return
  const e = detail.entity
  form.name = e.canonicalName
  form.type = e.entityType
  form.aliases = e.aliases.join(', ')
  form.summary = e.summary
  form.status = e.status
  form.locked = e.locked
  form.validFrom = e.validFrom ?? ''
  form.validTo = e.validTo ?? ''
  editing.value = false
  mergeOpen.value = false
  mergeTarget.value = ''
}, { immediate: true })

function beginEdit(): void {
  if (!entity.value) return
  editing.value = true
}

async function save(): Promise<void> {
  if (!entity.value) return
  saving.value = true
  try {
    await memoryGraphApi.updateEntity(props.channelId, entity.value.id, {
      expectedRevision: entity.value.revision,
      name: form.name.trim(),
      type: form.type,
      aliases: form.aliases.split(',').map(s => s.trim()).filter(Boolean),
      summary: form.summary,
      status: form.status,
      locked: form.locked,
      validFrom: form.validFrom || null,
      validTo: form.validTo || null,
    })
    message.success(t(gkey('entitySaved')))
    editing.value = false
    emit('refresh')
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    saving.value = false
  }
}

async function toggleLock(): Promise<void> {
  if (!entity.value) return
  saving.value = true
  try {
    await memoryGraphApi.updateEntity(props.channelId, entity.value.id, {
      expectedRevision: entity.value.revision,
      locked: !entity.value.locked,
    })
    message.success(entity.value.locked ? t(gkey('unlockedMsg')) : t(gkey('lockedMsg')))
    emit('refresh')
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    saving.value = false
  }
}

async function remove(): Promise<void> {
  if (!entity.value) return
  try {
    await memoryGraphApi.deleteEntity(props.channelId, entity.value.id, t(gkey('manualDelete')))
    message.success(t(gkey('softDeletedMsg')))
    emit('update:open', false)
    emit('refresh')
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}

async function restore(): Promise<void> {
  if (!entity.value) return
  try {
    await memoryGraphApi.restoreEntity(props.channelId, entity.value.id)
    message.success(t(gkey('restoredMsg')))
    emit('refresh')
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}

async function openMerge(): Promise<void> {
  if (!entity.value) return
  mergeOpen.value = true
  try {
    const res = await memoryGraphApi.listEntities(props.channelId, {
      limit: 300,
      scopeKinds: [entity.value!.scopeKind],
      scopeKeys: [entity.value!.scopeKey],
      ...(entity.value!.scopeKind === 'global' ? { ownerUserId: entity.value!.ownerUserId } : {}),
    })
    mergeOptions.value = res.items.filter(e => e.id !== entity.value!.id && !e.mergedInto && !e.deletedAt)
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}

async function doMerge(): Promise<void> {
  if (!entity.value || !mergeTarget.value) return
  saving.value = true
  try {
    await memoryGraphApi.mergeEntity(props.channelId, entity.value.id, mergeTarget.value)
    message.success(t(gkey('mergedMsg')))
    mergeOpen.value = false
    emit('refresh')
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    saving.value = false
  }
}

async function unmerge(): Promise<void> {
  if (!entity.value) return
  saving.value = true
  try {
    await memoryGraphApi.unmergeEntity(props.channelId, entity.value.id)
    message.success(t(gkey('unmergedMsg')))
    emit('refresh')
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <a-drawer
    :open="open"
    :width="640"
    placement="right"
    :title="entity ? entity.canonicalName : t(gkey('entityDetail'))"
    @close="emit('update:open', false)"
  >
    <div data-testid="memory-graph-entity-drawer">
      <a-spin :spinning="loading || saving">
        <template v-if="detail && entity">
          <a-descriptions
            :column="2"
            size="small"
            bordered
          >
            <a-descriptions-item :label="t(gkey('colType'))">
              {{ entity.entityType }}
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('colStatus'))">
              <a-tag :color="entity.status === 'active' ? 'green' : entity.status === 'provisional' ? 'orange' : 'default'">
                {{ entity.status }}
              </a-tag>
              <a-tag
                v-if="entity.locked"
                color="blue"
              >
                {{ t(gkey('lockedLabel')) }}
              </a-tag>
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('colScope'))">
              {{ entity.scopeKind }}{{ entity.scopeKey ? ` · ${entity.scopeKey}` : '' }}
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('confidenceSalience'))">
              {{ entity.confidence.toFixed(2) }} / {{ entity.salience.toFixed(2) }}
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('source'))">
              {{ entity.authorKind }} · {{ entity.sourceKind }}
            </a-descriptions-item>
            <a-descriptions-item label="revision">
              r{{ entity.revision }}
            </a-descriptions-item>
            <a-descriptions-item
              :label="t(gkey('validWindow'))"
              :span="2"
            >
              {{ entity.validFrom || '—' }} → {{ entity.validTo || t(gkey('now')) }}
            </a-descriptions-item>
            <a-descriptions-item
              :label="t(gkey('community'))"
              :span="2"
            >
              {{ detail.community?.title || '—' }}
            </a-descriptions-item>
            <a-descriptions-item
              :label="t(gkey('alias'))"
              :span="2"
            >
              <a-tag
                v-for="a in detail.aliases"
                :key="a.id"
              >
                {{ a.alias }}
              </a-tag>
              <span v-if="detail.aliases.length === 0">—</span>
            </a-descriptions-item>
          </a-descriptions>

          <div class="section-actions">
            <a-button
              size="small"
              :disabled="!editing"
              @click="editing = false"
            >
              {{ t(gkey('cancelEdit')) }}
            </a-button>
            <a-button
              v-if="!editing"
              size="small"
              type="primary"
              data-testid="memory-graph-entity-edit"
              @click="beginEdit"
            >
              {{ t(gkey('edit')) }}
            </a-button>
            <a-button
              v-else
              size="small"
              type="primary"
              :loading="saving"
              data-testid="memory-graph-entity-save"
              @click="save"
            >
              {{ t(gkey('save')) }}
            </a-button>
            <a-button
              size="small"
              :loading="saving"
              @click="toggleLock"
            >
              {{ entity.locked ? t(gkey('unlock')) : t(gkey('lock')) }}
            </a-button>
            <a-button
              size="small"
              @click="openMerge"
            >
              {{ t(gkey('mergeTo')) }}
            </a-button>
            <a-button
              v-if="entity.mergedInto"
              size="small"
              :loading="saving"
              @click="unmerge"
            >
              {{ t(gkey('unmerge')) }}
            </a-button>
            <a-button
              v-if="entity.deletedAt"
              size="small"
              @click="restore"
            >
              {{ t(gkey('restore')) }}
            </a-button>
            <a-popconfirm
              v-else
              :title="t(gkey('softDeleteEntityConfirm'))"
              :ok-text="t(gkey('softDelete'))"
              :cancel-text="t('memoryCenter.cancel')"
              @confirm="remove"
            >
              <a-button
                size="small"
                danger
              >
                {{ t(gkey('softDelete')) }}
              </a-button>
            </a-popconfirm>
          </div>

          <a-form
            v-if="editing"
            layout="vertical"
            class="edit-form"
          >
            <a-form-item :label="t(gkey('name'))">
              <a-input
                v-model:value="form.name"
                :maxlength="200"
              />
            </a-form-item>
            <a-form-item :label="t(gkey('colType'))">
              <a-select
                v-model:value="form.type"
                :options="entityTypes.map(x => ({ value: x, label: x }))"
              />
            </a-form-item>
            <a-form-item :label="t(gkey('aliases'))">
              <a-input v-model:value="form.aliases" />
            </a-form-item>
            <a-form-item :label="t(gkey('summary'))">
              <a-textarea
                v-model:value="form.summary"
                :rows="3"
                :maxlength="2000"
              />
            </a-form-item>
            <a-form-item :label="t(gkey('colStatus'))">
              <a-select
                v-model:value="form.status"
                :options="['active', 'provisional', 'rejected', 'retired'].map(s => ({ value: s, label: s }))"
              />
            </a-form-item>
            <a-form-item :label="t(gkey('locked'))">
              <a-switch v-model:checked="form.locked" />
            </a-form-item>
            <a-form-item label="validFrom">
              <a-input
                v-model:value="form.validFrom"
                :placeholder="t(gkey('isoPlaceholder'))"
              />
            </a-form-item>
            <a-form-item label="validTo">
              <a-input
                v-model:value="form.validTo"
                :placeholder="t(gkey('isoPlaceholder'))"
              />
            </a-form-item>
          </a-form>
          <div
            v-else
            class="summary"
          >
            {{ entity.summary || t(gkey('noSummary')) }}
          </div>

          <a-divider>{{ t(gkey('mentionsDivider')) }}</a-divider>
          <a-list
            size="small"
            :data-source="detail.mentions"
          >
            <template #renderItem="{ item }">
              <a-list-item>
                <a @click="emit('open-memory', item.memoryId)">{{ item.memoryTitle || item.memoryId }}</a>
                <span class="muted">{{ item.memoryKind }} · {{ t(gkey('colConfidence')) }} {{ item.confidence.toFixed(2) }}</span>
              </a-list-item>
            </template>
          </a-list>

          <a-divider>{{ t(gkey('edgesDivider'), { n: detail.edges.length }) }}</a-divider>
          <a-list
            size="small"
            :data-source="detail.edges"
          >
            <template #renderItem="{ item }">
              <a-list-item>
                <span>
                  <a-tag>{{ item.direction === 'out' ? '→' : '←' }}</a-tag>
                  {{ item.relation }} · {{ item.other || '—' }}
                  <span
                    v-if="item.fact"
                    class="muted"
                  >：{{ item.fact }}</span>
                </span>
                <span class="muted">{{ item.status }} · {{ t(gkey('colConfidence')) }} {{ item.confidence.toFixed(2) }}</span>
              </a-list-item>
            </template>
          </a-list>
        </template>
        <a-empty
          v-else
          :description="t(gkey('pickNode'))"
        />
      </a-spin>
    </div>

    <a-modal
      v-model:open="mergeOpen"
      :title="t(gkey('mergeTitle'))"
      :confirm-loading="saving"
      :ok-text="t(gkey('confirmMerge'))"
      :cancel-text="t('memoryCenter.cancel')"
      @ok="doMerge"
    >
      <p class="muted">
        {{ t(gkey('mergeNote')) }}
      </p>
      <a-select
        v-model:value="mergeTarget"
        show-search
        :placeholder="t(gkey('pickTarget'))"
        style="width: 100%"
        :options="mergeOptions.map(e => ({ value: e.id, label: `${e.canonicalName}（${e.entityType}）` }))"
        :filter-option="(input: string, option: any) => String(option.label).toLowerCase().includes(input.toLowerCase())"
      />
    </a-modal>
  </a-drawer>
</template>

<style scoped>
.section-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}
.edit-form {
  margin-top: 8px;
}
.summary {
  white-space: pre-wrap;
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.6;
}
.muted {
  color: var(--ink-faint);
  font-size: 12px;
}
</style>
