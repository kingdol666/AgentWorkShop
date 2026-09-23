<script setup lang="ts">
/**
 * 预测控制台:production 模型 → ioSpec → history JSON 粘贴 → forecast 表。
 * 只读消费模型注册表,表单/结果/在飞状态都自持(useAmlPredict),与页面其余区块无耦合。
 */
import { useAmlPredict } from '../../pages/aml/composables/useAmlPredict'
import { useAmlFormat } from '../../pages/aml/composables/useAmlFormat'
import type { AmlModelRow } from '../../pages/aml/types'

const props = defineProps<{
  models: AmlModelRow[]
}>()

const {
  productionModels,
  predModelId,
  predModel,
  predHistory,
  predControls,
  predSteps,
  predBusy,
  predError,
  predResult,
  onPullLatest,
  doPredict,
} = useAmlPredict(() => props.models)

const { fmtNum, shortId } = useAmlFormat()
</script>

<template>
  <section class="aw-tile zone">
    <div class="zone-head">
      <h2>
        <span class="i-tabler-chart-line" />
        {{ $t('aml.k1amlx133') }}
      </h2>
      <select
        v-if="productionModels.length"
        v-model="predModelId"
        class="inp-sel"
      >
        <option value="">
          {{ $t('aml.k1amlx134') }}
        </option>
        <option
          v-for="m in productionModels"
          :key="m.id"
          :value="m.id"
        >
          {{ shortId(m.id) }} · {{ shortId(m.recipeId) }}
        </option>
      </select>
    </div>
    <template v-if="productionModels.length">
      <div
        v-if="predModel?.ioSpec"
        class="pc-body"
      >
        <p class="det-title">
          {{ $t('aml.k1amlx136') }}
        </p>
        <div class="io-grid mono">
          <span class="io-item">{{ $t('aml.k1amlx140') }} <b>{{ predModel.ioSpec.historySteps }}</b></span>
          <span class="io-item">{{ $t('aml.k1amlx141') }} <b>{{ predModel.ioSpec.horizonSteps }}</b></span>
          <span class="io-item">{{ $t('aml.k1amlx142') }} <b>{{ predModel.ioSpec.beatMs }}ms</b></span>
          <span
            class="io-item"
            :title="predModel.ioSpec.allNodes.join(', ')"
          >{{ $t('aml.k1amlx137') }}({{ predModel.ioSpec.allNodes.length }}) <b>{{ predModel.ioSpec.allNodes.map(n => shortId(n)).join(', ') }}</b></span>
          <span
            class="io-item"
            :title="predModel.ioSpec.controlNodes.join(', ')"
          >{{ $t('aml.k1amlx138') }} <b>{{ predModel.ioSpec.controlNodes.map(n => shortId(n)).join(', ') }}</b></span>
          <span
            class="io-item"
            :title="predModel.ioSpec.targetNodes.join(', ')"
          >{{ $t('aml.k1amlx139') }} <b>{{ predModel.ioSpec.targetNodes.map(n => shortId(n)).join(', ') }}</b></span>
        </div>
        <div class="pc-form">
          <label class="pc-field">
            <span>{{ $t('aml.k1amlx143') }}</span>
            <textarea
              v-model="predHistory"
              class="inp area"
              rows="5"
              :placeholder="$t('aml.k1amlx144')"
            />
          </label>
          <div class="pc-side">
            <button
              class="ghost-btn"
              @click="onPullLatest"
            >
              <span class="i-tabler-download" />
              {{ $t('aml.k1amlx145') }}
            </button>
            <label class="pc-field">
              <span>{{ $t('aml.k1amlx156') }}</span>
              <textarea
                v-model="predControls"
                class="inp area"
                rows="3"
                :placeholder="'[[…]]'"
              />
            </label>
            <label class="pc-field">
              <span>{{ $t('aml.k1amlx147') }}</span>
              <input
                v-model.number="predSteps"
                type="number"
                min="1"
                class="inp"
              >
            </label>
            <button
              class="pill-btn"
              :disabled="predBusy || !predHistory.trim()"
              @click="doPredict"
            >
              {{ predBusy ? $t('aml.k1amlx149') : $t('aml.k1amlx148') }}
            </button>
          </div>
        </div>
        <p class="hint dim">
          {{ $t('aml.k1amlx146') }}
        </p>
        <p
          v-if="predError"
          class="err"
        >
          {{ predError }}
        </p>
        <template v-if="predResult">
          <p class="det-title">
            {{ $t('aml.k1amlx150') }}
          </p>
          <table class="sub-tbl">
            <thead>
              <tr>
                <th class="num">
                  {{ $t('aml.k1amlx151') }}
                </th>
                <th class="num">
                  {{ $t('aml.k1amlx152') }}
                </th>
                <th
                  v-for="(n, i) in predResult.targetNodes"
                  :key="n"
                  class="num"
                >
                  {{ shortId(n) }}<small
                    v-if="i === 0"
                    class="dim"
                  > ({{ $t('aml.k1amlx041') }})</small>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, ri) in predResult.forecast"
                :key="ri"
              >
                <td class="mono num">
                  {{ ri + 1 }}
                </td>
                <td class="mono num dim">
                  {{ fmtNum(((ri + 1) * predResult.beatMs) / 1000, 1) }}
                </td>
                <td
                  v-for="(v, ci) in row"
                  :key="ci"
                  class="mono num"
                >
                  {{ fmtNum(v, 3) }}
                </td>
              </tr>
            </tbody>
          </table>
          <p class="mono dim gate-detail">
            {{ $t('aml.k1amlx155') }}:{{ predResult.assumptions }}
          </p>
        </template>
      </div>
      <p
        v-else
        class="empty"
      >
        {{ $t('aml.k1amlx134') }}
      </p>
    </template>
    <p
      v-else
      class="empty"
    >
      {{ $t('aml.k1amlx135') }}
    </p>
  </section>
</template>

<style scoped src="../../pages/aml/styles.css"></style>
