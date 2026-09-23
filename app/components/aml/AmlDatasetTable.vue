<script setup lang="ts">
/**
 * 数据集快照表:注册表 + 行内展开(清洗报告/滞后估计/run 概览)+ 新建入口。
 * 展开态、详情缓存与备注编辑态由页面下发(备注编辑框与模型表共用同一条状态)。
 */
import { useAmlFormat } from '../../pages/aml/composables/useAmlFormat'
import type { AmlDatasetRow, DsDetail } from '../../pages/aml/types'

defineProps<{
  datasets: AmlDatasetRow[]
  expandedDs: string
  dsDetails: Record<string, DsDetail>
  noteEditing: string
}>()

defineEmits<{
  toggle: [id: string]
  reload: []
  create: []
  editNote: [id: string, note: string]
  saveNote: [id: string]
  cancelNote: []
  remove: [id: string, confirmText: string]
}>()

/** 行内备注草稿:与模型表共享同一个编辑槽,值经 v-model 回流页面 */
const noteDraft = defineModel<string>('noteDraft', { required: true })

const { fmtTime, fmtNum, fmtPct, shortId } = useAmlFormat()
</script>

<template>
  <section class="aw-tile zone">
    <div class="zone-head">
      <h2>
        <span class="i-tabler-database" />
        {{ $t('aml.k1amlx016') }}
        <b class="mono cnt">{{ datasets.length }}</b>
      </h2>
      <div class="zone-actions">
        <button
          class="mini-btn"
          @click="$emit('reload')"
        >
          {{ $t('aml.k1amlx017') }}
        </button>
        <button
          class="pill-btn"
          @click="$emit('create')"
        >
          <span class="i-tabler-plus" />
          {{ $t('aml.k1amlx018') }}
        </button>
      </div>
    </div>
    <div
      v-if="datasets.length"
      class="tbl-scroll"
    >
      <table class="tbl tbl-datasets">
        <thead>
          <tr>
            <th>{{ $t('aml.k1amlx020') }}</th>
            <th>{{ $t('aml.k1amlx021') }}</th>
            <th>{{ $t('aml.k1amlx022') }}</th>
            <th class="num">
              {{ $t('aml.k1amlx023') }}
            </th>
            <th class="num">
              {{ $t('aml.k1amlx024') }}
            </th>
            <th>{{ $t('aml.k1amlx025') }}</th>
            <th>{{ $t('aml.k1amlx026') }}</th>
          </tr>
        </thead>
        <tbody>
          <template
            v-for="d in datasets"
            :key="d.id"
          >
            <tr
              class="row-main"
              :class="{ open: expandedDs === d.id }"
              @click="$emit('toggle', d.id)"
            >
              <td class="mono dim">
                {{ fmtTime(d.createdAt) }}
              </td>
              <td class="mono">
                {{ shortId(d.productId) }}
              </td>
              <td class="mono">
                {{ shortId(d.recipeId) }}
              </td>
              <td class="mono num">
                {{ d.rowCount }}
              </td>
              <td class="mono num">
                {{ d.runIds.length }}
              </td>
              <td>
                {{ d.createdBy }}<small
                  class="kind"
                  :class="d.createdByKind"
                >{{ d.createdByKind === 'agent' ? 'Agent' : $t('aml.k1amlx049') }}</small>
              </td>
              <td
                class="note-cell"
                @click.stop
              >
                <div
                  v-if="noteEditing === d.id"
                  class="note-edit"
                >
                  <input
                    v-model="noteDraft"
                    :placeholder="$t('aml.k1amlx189')"
                    @keyup.enter="$emit('saveNote', d.id)"
                    @keyup.esc="$emit('cancelNote')"
                  >
                  <button
                    class="mini-btn"
                    @click="$emit('saveNote', d.id)"
                  >
                    {{ $t('aml.k1amlx191') }}
                  </button>
                  <button
                    class="mini-btn"
                    @click="$emit('cancelNote')"
                  >
                    {{ $t('aml.k1amlx202') }}
                  </button>
                </div>
                <span
                  v-else
                  class="note-text"
                >
                  <span
                    class="note"
                    :title="d.note"
                  >{{ d.note || '--' }}</span>
                  <span
                    class="i-tabler-pencil edit-i"
                    :title="$t('aml.k1amlx189')"
                    @click="$emit('editNote', d.id, d.note)"
                  />
                  <span
                    class="i-tabler-trash edit-i"
                    :title="$t('aml.k1amlx190')"
                    @click="$emit('remove', d.id, $t('aml.k1amlx198'))"
                  />
                </span>
              </td>
            </tr>
            <tr
              v-if="expandedDs === d.id"
              class="detail-row"
            >
              <td colspan="7">
                <div
                  v-if="dsDetails[d.id]?.loading"
                  class="dim pad"
                >
                  {{ $t('aml.k1amlx030') }}
                </div>
                <div
                  v-else-if="dsDetails[d.id]?.error"
                  class="err pad"
                >
                  {{ $t('aml.k1amlx031') }}:{{ dsDetails[d.id]?.error }}
                </div>
                <div
                  v-else-if="dsDetails[d.id]?.report"
                  class="det-grid"
                >
                  <div>
                    <p class="det-title">
                      {{ $t('aml.k1amlx027') }}
                    </p>
                    <table class="sub-tbl">
                      <thead>
                        <tr>
                          <th>{{ $t('aml.k1amlx033') }}</th>
                          <th>{{ $t('aml.k1amlx034') }}</th>
                          <th class="num">
                            {{ $t('aml.k1amlx035') }}
                          </th>
                          <th class="num">
                            {{ $t('aml.k1amlx036') }}
                          </th>
                          <th class="num">
                            {{ $t('aml.k1amlx037') }}
                          </th>
                          <th class="num">
                            {{ $t('aml.k1amlx038') }}
                          </th>
                          <th class="num">
                            {{ $t('aml.k1amlx039') }}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          v-for="s in dsDetails[d.id]?.report?.nodeSummaries"
                          :key="s.nodeId"
                        >
                          <td class="mono">
                            {{ s.nodeId }}
                          </td>
                          <td>
                            <small class="role-chip">{{ s.role }}</small>
                          </td>
                          <td class="mono num">
                            {{ fmtPct(s.cleanedRatio) }}
                          </td>
                          <td class="mono num">
                            {{ fmtPct(s.missingRatio) }}
                          </td>
                          <td class="mono num">
                            {{ fmtNum(s.mean, 3) }}
                          </td>
                          <td class="mono num">
                            {{ fmtNum(s.std, 3) }}
                          </td>
                          <td class="mono num">
                            {{ fmtNum(s.min, 2) }}~{{ fmtNum(s.max, 2) }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div>
                    <p class="det-title">
                      {{ $t('aml.k1amlx028') }}
                    </p>
                    <table
                      v-if="dsDetails[d.id]?.report?.lagEstimates.length"
                      class="sub-tbl"
                    >
                      <thead>
                        <tr>
                          <th>{{ $t('aml.k1amlx040') }}</th>
                          <th>{{ $t('aml.k1amlx041') }}</th>
                          <th class="num">
                            {{ $t('aml.k1amlx042') }}
                          </th>
                          <th class="num">
                            {{ $t('aml.k1amlx043') }}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          v-for="l in dsDetails[d.id]?.report?.lagEstimates"
                          :key="`${l.controlId}->${l.targetId}`"
                        >
                          <td class="mono">
                            {{ l.controlId }}
                          </td>
                          <td class="mono">
                            {{ l.targetId }}
                          </td>
                          <td class="mono num">
                            {{ l.lagSteps }}
                          </td>
                          <td class="mono num">
                            {{ fmtNum(l.corr, 3) }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <p
                      v-else
                      class="dim"
                    >
                      {{ $t('aml.k1amlx032') }}
                    </p>
                    <p class="det-title">
                      {{ $t('aml.k1amlx029') }}
                    </p>
                    <p class="mono dim run-line">
                      {{ $t('aml.k1amlx044') }}
                      <b>{{ dsDetails[d.id]?.report?.runsUsed.length ?? 0 }}</b>
                      · {{ $t('aml.k1amlx045') }}
                      <b>{{ dsDetails[d.id]?.report?.runsDropped.length ?? 0 }}</b>
                      · {{ $t('aml.k1amlx046') }}
                      <b>{{ dsDetails[d.id]?.report?.windowCount.train }}/{{ dsDetails[d.id]?.report?.windowCount.val }}/{{ dsDetails[d.id]?.report?.windowCount.test }}</b>
                    </p>
                    <p
                      v-for="r in dsDetails[d.id]?.report?.runsDropped"
                      :key="r.runId"
                      class="mono drop-line"
                    >
                      ✗ {{ shortId(r.runId) }} — {{ r.reason }}
                    </p>
                  </div>
                </div>
                <p
                  v-else
                  class="dim pad"
                >
                  {{ $t('aml.k1amlx047') }}
                </p>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <p
      v-else
      class="empty"
    >
      {{ $t('aml.k1amlx019') }}
    </p>
  </section>
</template>

<style scoped src="../../pages/aml/styles.css"></style>
