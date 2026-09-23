<script setup lang="ts">
/**
 * 训练作业表:REST 快照 + WS 实时进度;展开 = 门禁逐项 + 日志尾随(活跃作业 5s 轮询)。
 * 实时投影后的行由页面下发,组件只做呈现与两段确认的回传。
 */
import { useAmlFormat } from '../../pages/aml/composables/useAmlFormat'
import type { AmlJobRow, JobDetail } from '../../pages/aml/types'

defineProps<{
  jobRows: Array<AmlJobRow & { live?: boolean }>
  expandedJob: string
  jobDetails: Record<string, JobDetail>
  confirmCancel: string
  cancelling: string
  confirmRetry: string
  retrying: string
}>()

defineEmits<{
  toggle: [id: string]
  reload: []
  cancel: [id: string]
  retry: [id: string]
  remove: [id: string, confirmText: string]
}>()

const { fmtTime, fmtNum, shortId, statusLabel, isActiveStatus, canRetry } = useAmlFormat()
</script>

<template>
  <section class="aw-tile zone">
    <div class="zone-head">
      <h2>
        <span class="i-tabler-brain" />
        {{ $t('aml.k1amlx074') }}
        <b class="mono cnt">{{ jobRows.length }}</b>
        <span
          v-if="jobRows.some(j => isActiveStatus(j.status))"
          class="live-dot"
          :title="$t('aml.k1amlx091')"
        />
      </h2>
      <button
        class="mini-btn"
        @click="$emit('reload')"
      >
        {{ $t('aml.k1amlx017') }}
      </button>
    </div>
    <div
      v-if="jobRows.length"
      class="tbl-scroll"
    >
      <table class="tbl tbl-jobs">
        <thead>
          <tr>
            <th>{{ $t('aml.k1amlx076') }}</th>
            <th>{{ $t('aml.k1amlx011') }}</th>
            <th>{{ $t('aml.k1amlx066') }}</th>
            <th>{{ $t('aml.k1amlx077') }}</th>
            <th>{{ $t('aml.k1amlx078') }}</th>
            <th class="prog-th">
              {{ $t('aml.k1amlx079') }}
            </th>
            <th>{{ $t('aml.k1amlx020') }}</th>
            <th class="right">
              {{ $t('aml.k1amlx127') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <template
            v-for="j in jobRows"
            :key="j.id"
          >
            <tr
              class="row-main"
              :class="{ open: expandedJob === j.id }"
              @click="$emit('toggle', j.id)"
            >
              <td class="mono">
                {{ shortId(j.id) }}
              </td>
              <td class="mono dim">
                {{ shortId(j.datasetId) }}
              </td>
              <td class="mono dim">
                {{ j.purpose }}
              </td>
              <td>
                <span
                  class="st-pill"
                  :class="j.status"
                >{{ statusLabel(j.status) }}</span>
              </td>
              <td class="mono dim">
                {{ j.stage || '--' }}
              </td>
              <td class="prog-cell">
                <span class="prog"><i
                  :style="{ width: `${Math.max(0, Math.min(100, j.progress))}%` }"
                  :class="{ done: j.status === 'done', bad: j.status === 'failed' }"
                /></span>
                <span class="mono prog-num">{{ Math.round(j.progress) }}%</span>
              </td>
              <td class="mono dim">
                {{ fmtTime(j.createdAt) }}
              </td>
              <td class="right acts">
                <button
                  v-if="isActiveStatus(j.status)"
                  class="mini-btn danger"
                  :disabled="cancelling === j.id"
                  @click.stop="$emit('cancel', j.id)"
                >
                  {{ confirmCancel === j.id ? $t('aml.k1amlx094') : (cancelling === j.id ? $t('aml.k1amlx093') : $t('aml.k1amlx071')) }}
                </button>
                <button
                  v-if="canRetry(j.status)"
                  class="mini-btn"
                  :disabled="retrying === j.id"
                  @click.stop="$emit('retry', j.id)"
                >
                  {{ confirmRetry === j.id ? $t('aml.k1amlx096') : $t('aml.k1amlx095') }}
                </button>
                <span
                  v-if="!isActiveStatus(j.status)"
                  class="i-tabler-trash edit-i"
                  :title="$t('aml.k1amlx190')"
                  @click.stop="$emit('remove', j.id, $t('aml.k1amlx200'))"
                />
              </td>
            </tr>
            <tr
              v-if="expandedJob === j.id"
              class="detail-row"
            >
              <td colspan="8">
                <div
                  v-if="jobDetails[j.id]?.loading"
                  class="dim pad"
                >
                  {{ $t('aml.k1amlx030') }}
                </div>
                <div
                  v-else-if="jobDetails[j.id]?.error"
                  class="err pad"
                >
                  {{ jobDetails[j.id]?.error }}
                </div>
                <div
                  v-else
                  class="det-grid"
                >
                  <div>
                    <p class="det-title">
                      {{ $t('aml.k1amlx083') }}
                    </p>
                    <table
                      v-if="jobDetails[j.id]?.gates?.checks.length"
                      class="sub-tbl"
                    >
                      <thead>
                        <tr>
                          <th>{{ $t('aml.k1amlx084') }}</th>
                          <th class="num">
                            {{ $t('aml.k1amlx085') }}
                          </th>
                          <th class="num">
                            {{ $t('aml.k1amlx086') }}
                          </th>
                          <th>{{ $t('aml.k1amlx118') }}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          v-for="g in jobDetails[j.id]?.gates?.checks"
                          :key="g.id"
                        >
                          <td>
                            <b class="mono gate-id">{{ g.id }}</b>
                            <small class="dim"> {{ g.name }}</small>
                          </td>
                          <td class="mono num">
                            {{ fmtNum(g.value) }}
                          </td>
                          <td class="mono num dim">
                            {{ fmtNum(g.threshold) }}
                          </td>
                          <td>
                            <span
                              class="verdict"
                              :class="g.pass ? 'pass' : 'fail'"
                            >{{ g.pass ? $t('aml.k1amlx087') : $t('aml.k1amlx088') }}</span>
                            <small class="dim gate-detail">{{ g.detail }}</small>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <p
                      v-else
                      class="dim"
                    >
                      {{ $t('aml.k1amlx082') }}
                    </p>
                    <p
                      v-if="jobDetails[j.id]?.metrics?.oneStepTest"
                      class="mono dim gate-detail"
                    >
                      {{ $t('aml.k1amlx099') }}: {{ $t('aml.k1amlx116') }} {{ fmtNum(jobDetails[j.id]?.metrics?.oneStepTest?.nrmse) }}
                      <template v-if="jobDetails[j.id]?.metrics?.rolloutTest">
                        · {{ $t('aml.k1amlx117') }} {{ fmtNum(jobDetails[j.id]?.metrics?.rolloutTest?.nrmse) }}
                      </template>
                    </p>
                    <p
                      v-if="j.error"
                      class="err gate-detail"
                    >
                      {{ $t('aml.k1amlx092') }}:{{ j.error }}
                    </p>
                  </div>
                  <div>
                    <p class="det-title">
                      {{ $t('aml.k1amlx089') }}
                      <span
                        v-if="isActiveStatus(j.status)"
                        class="mono live-hint"
                      >{{ $t('aml.k1amlx091') }}</span>
                    </p>
                    <pre class="logs">{{ (jobDetails[j.id]?.logs ?? []).join('\n') || $t('aml.k1amlx090') }}</pre>
                  </div>
                </div>
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
      {{ $t('aml.k1amlx075') }}
    </p>
  </section>
</template>

<style scoped src="../../pages/aml/styles.css"></style>
