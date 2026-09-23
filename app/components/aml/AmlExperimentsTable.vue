<script setup lang="ts">
/**
 * 实验排行榜:选数据集 → 谱系表(变更说明/父实验/G1/G2/门禁态),最优行高亮。
 * 数据集选择经 v-model 回流页面(选中即触发重新拉取)。
 */
import { useAmlFormat } from '../../pages/aml/composables/useAmlFormat'
import type { AmlDatasetRow, AmlExperiment } from '../../pages/aml/types'

defineProps<{
  datasets: AmlDatasetRow[]
  experiments: AmlExperiment[]
  bestExpId: string
  expError: string
}>()

defineEmits<{
  reload: []
}>()

/** 选中的数据集 id(页面持有,选择即落回页面状态) */
const expDatasetId = defineModel<string>('expDatasetId', { required: true })

const { fmtTime, fmtNum, shortId, expStatusLabel } = useAmlFormat()
</script>

<template>
  <section class="aw-tile zone">
    <div class="zone-head">
      <h2>
        <span class="i-tabler-trophy" />
        {{ $t('aml.k1amlx109') }}
        <b class="mono cnt">{{ experiments.length }}</b>
      </h2>
      <div class="zone-actions">
        <select
          v-model="expDatasetId"
          class="inp-sel"
          @change="$emit('reload')"
        >
          <option value="">
            {{ $t('aml.k1amlx111') }}
          </option>
          <option
            v-for="d in datasets"
            :key="d.id"
            :value="d.id"
          >
            {{ shortId(d.id) }} · {{ shortId(d.recipeId) }}
          </option>
        </select>
        <button
          class="mini-btn"
          :disabled="!expDatasetId"
          @click="$emit('reload')"
        >
          {{ $t('aml.k1amlx017') }}
        </button>
      </div>
    </div>
    <div
      v-if="experiments.length"
      class="tbl-scroll"
    >
      <table class="tbl tbl-exp">
        <thead>
          <tr>
            <th>{{ $t('aml.k1amlx113') }}</th>
            <th>{{ $t('aml.k1amlx020') }}</th>
            <th>{{ $t('aml.k1amlx114') }}</th>
            <th>{{ $t('aml.k1amlx115') }}</th>
            <th
              class="num"
              :title="$t('aml.k1amlx121')"
            >
              {{ $t('aml.k1amlx116') }}
            </th>
            <th
              class="num"
              :title="$t('aml.k1amlx122')"
            >
              {{ $t('aml.k1amlx117') }}
            </th>
            <th>{{ $t('aml.k1amlx118') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="e in experiments"
            :key="e.id"
            :class="{ best: e.id === bestExpId }"
          >
            <td class="mono">
              <span
                v-if="e.id === bestExpId"
                class="best-tag"
              >{{ $t('aml.k1amlx120') }}</span>
              {{ shortId(e.id) }}
            </td>
            <td class="mono dim">
              {{ fmtTime(e.createdAt) }}
            </td>
            <td class="note-cell">
              <span
                class="note"
                :title="e.changeNote"
              >{{ e.changeNote || '--' }}</span>
            </td>
            <td class="mono dim">
              {{ e.parentExperimentId ? shortId(e.parentExperimentId) : '--' }}
            </td>
            <td class="mono num">
              {{ fmtNum(e.metrics?.oneStepTest?.nrmse) }}
            </td>
            <td class="mono num">
              {{ fmtNum(e.metrics?.rolloutTest?.nrmse) }}
            </td>
            <td>
              <span
                class="st-pill"
                :class="e.status"
              >{{ expStatusLabel(e.status) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p
      v-else
      class="empty"
    >
      {{ expDatasetId ? $t('aml.k1amlx112') : $t('aml.k1amlx110') }}
    </p>
    <p
      v-if="expError"
      class="err pad"
    >
      {{ expError }}
    </p>
  </section>
</template>

<style scoped src="../../pages/aml/styles.css"></style>
