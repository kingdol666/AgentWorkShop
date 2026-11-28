<script setup lang="ts">
/**
 * 图谱关系详情/编辑抽屉：事实、极性、置信、有效窗口、证据（memory/claim/intervention）。
 */
import { computed, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { apiErrorMessage } from '@/app/utils/api-error'
import { memoryGraphApi, type GraphEdgeDetail } from '~/pages/memory/api'

const props = defineProps<{
  open: boolean
  channelId: string
  detail: GraphEdgeDetail | null
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
const form = reactive({
  relation: 'relates_to',
  relationLabel: '',
  fact: '',
  polarity: 'positive',
  confidence: 0.5,
  validFrom: '',
  validTo: '',
  status: 'active',
  locked: false,
})

const relations = [
  'mentions', 'relates_to', 'causes', 'affects', 'supports', 'contradicts',
  'supersedes', 'derived_from', 'part_of', 'used_for', 'precedes',
  'has_parameter', 'uses_recipe', 'observed_in', 'co_occurs',
]

const edge = computed(() => props.detail?.edge ?? null)

watch(() => props.detail, (detail) => {
  if (!detail) return
  const e = detail.edge
  form.relation = e.relation
  form.relationLabel = e.relationLabel
  form.fact = e.fact
  form.polarity = e.polarity
  form.confidence = e.confidence
  form.validFrom = e.validFrom ?? ''
  form.validTo = e.validTo ?? ''
  form.status = e.status
  form.locked = e.locked
  editing.value = false
}, { immediate: true })

async function save(): Promise<void> {
  if (!edge.value) return
  saving.value = true
  try {
    await memoryGraphApi.updateEdge(props.channelId, edge.value.id, {
      expectedRevision: edge.value.revision,
      relation: form.relation,
      relationLabel: form.relationLabel,
      fact: form.fact,
      polarity: form.polarity,
      confidence: form.confidence,
      status: form.status,
      locked: form.locked,
      validFrom: form.validFrom || null,
      validTo: form.validTo || null,
    })
    message.success(t(gkey('edgeSaved')))
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

async function reject(): Promise<void> {
  if (!edge.value) return
  try {
    await memoryGraphApi.rejectEdge(props.channelId, edge.value.id, {
      expectedRevision: edge.value.revision,
      reason: t(gkey('manualReject')),
    })
    message.success(t(gkey('rejectedMsg')))
    emit('refresh')
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}

async function restore(): Promise<void> {
  if (!edge.value) return
  try {
    await memoryGraphApi.restoreEdge(props.channelId, edge.value.id)
    message.success(t(gkey('restoredActiveMsg')))
    emit('refresh')
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}

async function remove(): Promise<void> {
  if (!edge.value) return
  try {
    await memoryGraphApi.deleteEdge(props.channelId, edge.value.id, t(gkey('manualDelete')))
    message.success(t(gkey('softDeletedMsg')))
    emit('update:open', false)
    emit('refresh')
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}
</script>

<template>
  <a-drawer
    :open="open"
    :width="620"
    placement="right"
    :title="t(gkey('edgeDetail'))"
    @close="emit('update:open', false)"
  >
    <div data-testid="memory-graph-edge-drawer">
      <a-spin :spinning="loading || saving">
        <template v-if="detail && edge">
          <a-descriptions
            :column="2"
            size="small"
            bordered
          >
            <a-descriptions-item
              :label="t(gkey('colSrc'))"
              :span="2"
            >
              {{ detail.source?.canonicalName || edge.srcId }}
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('relation'))">
              {{ edge.relation }}<span v-if="edge.relationLabel && edge.relationLabel !== edge.relation">（{{ edge.relationLabel }}）</span>
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('colDst'))">
              {{ detail.target?.canonicalName || edge.dstId }}
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('polarity'))">
              {{ edge.polarity }}
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('colStatus'))">
              <a-tag :color="edge.status === 'active' ? 'green' : edge.status === 'provisional' ? 'orange' : 'default'">
                {{ edge.status }}
              </a-tag>
              <a-tag
                v-if="edge.locked"
                color="blue"
              >
                {{ t(gkey('lockedLabel')) }}
              </a-tag>
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('confidenceWeight'))">
              {{ edge.confidence.toFixed(2) }} / {{ edge.weight.toFixed(2) }}
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('source'))">
              {{ edge.authorKind }} · {{ edge.sourceKind }}
            </a-descriptions-item>
            <a-descriptions-item
              :label="t(gkey('validWindow'))"
              :span="2"
            >
              {{ edge.validFrom || '—' }} → {{ edge.validTo || t(gkey('now')) }}
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
              data-testid="memory-graph-edge-edit"
              @click="editing = true"
            >
              {{ t(gkey('edit')) }}
            </a-button>
            <a-button
              v-else
              size="small"
              type="primary"
              :loading="saving"
              data-testid="memory-graph-edge-save"
              @click="save"
            >
              {{ t(gkey('save')) }}
            </a-button>
            <a-popconfirm
              v-if="edge.status !== 'rejected'"
              :title="t(gkey('rejectConfirm'))"
              :ok-text="t(gkey('rejectEdge'))"
              :cancel-text="t('memoryCenter.cancel')"
              @confirm="reject"
            >
              <a-button
                size="small"
                danger
              >
                {{ t(gkey('rejectEdge')) }}
              </a-button>
            </a-popconfirm>
            <a-button
              v-else
              size="small"
              @click="restore"
            >
              {{ t(gkey('restore')) }}
            </a-button>
            <a-popconfirm
              :title="t(gkey('softDeleteEdgeConfirm'))"
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
            <a-form-item :label="t(gkey('relation'))">
              <a-select
                v-model:value="form.relation"
                :options="relations.map(r => ({ value: r, label: r }))"
              />
            </a-form-item>
            <a-form-item :label="t(gkey('originalLabel'))">
              <a-input v-model:value="form.relationLabel" />
            </a-form-item>
            <a-form-item :label="t(gkey('fact'))">
              <a-textarea
                v-model:value="form.fact"
                :rows="3"
                :maxlength="600"
              />
            </a-form-item>
            <a-form-item :label="t(gkey('polarity'))">
              <a-select
                v-model:value="form.polarity"
                :options="['positive', 'negative', 'neutral'].map(p => ({ value: p, label: p }))"
              />
            </a-form-item>
            <a-form-item :label="t(gkey('colConfidence'))">
              <a-input-number
                v-model:value="form.confidence"
                :min="0"
                :max="1"
                :step="0.05"
                style="width: 100%"
              />
            </a-form-item>
            <a-form-item :label="t(gkey('colStatus'))">
              <a-select
                v-model:value="form.status"
                :options="['active', 'provisional', 'rejected', 'superseded', 'retired'].map(s => ({ value: s, label: s }))"
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
            class="fact"
          >
            {{ edge.fact || t(gkey('noFact')) }}
          </div>

          <a-divider>{{ t(gkey('evidenceDivider'), { n: detail.evidence.length }) }}</a-divider>
          <a-list
            size="small"
            :data-source="detail.evidence"
          >
            <template #renderItem="{ item }">
              <a-list-item>
                <div>
                  <a @click="emit('open-memory', item.memoryId)">{{ item.memoryId }}</a>
                  <div
                    v-if="item.claimId"
                    class="muted"
                  >
                    claim {{ item.claimId }}<span v-if="item.interventionId"> · intervention {{ item.interventionId }}</span>
                  </div>
                  <div
                    v-if="item.quote"
                    class="muted"
                  >
                    “{{ item.quote }}”
                  </div>
                </div>
                <span class="muted">{{ t(gkey('colConfidence')) }} {{ item.confidence.toFixed(2) }}</span>
              </a-list-item>
            </template>
          </a-list>
          <template v-if="detail.claims.length">
            <a-divider>{{ t(gkey('structuredClaims')) }}</a-divider>
            <a-table
              size="small"
              :pagination="false"
              :columns="[
                { title: 'claim', dataIndex: 'claimId', key: 'claimId' },
                { title: 'verdict', dataIndex: 'verdict', key: 'verdict' },
                { title: 'effect', dataIndex: 'effect', key: 'effect' },
                { title: 'CI', key: 'ci' },
              ]"
              :data-source="detail.claims"
              row-key="claimId"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'ci'">
                  {{ record.ciLow ?? '—' }} … {{ record.ciHigh ?? '—' }}
                </template>
              </template>
            </a-table>
          </template>
        </template>
        <a-empty
          v-else
          :description="t(gkey('pickEdge'))"
        />
      </a-spin>
    </div>
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
.fact {
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
