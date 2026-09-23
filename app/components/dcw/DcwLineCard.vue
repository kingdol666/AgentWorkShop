<script setup lang="ts">
/**
 * 产线卡片 —— 总览栅格的最小单元。
 * 运行态由父级以 props 下发(server 权威),卡片自身不持有任何副本:
 * 编辑/删除/快捷启停一律 emit 回页面,卡片保持纯呈现。
 */
import type { LineCard } from '../../pages/dcw/types'
import type { LineRunState, RecipeView } from '#shared/dcw-protocol'

defineProps<{
  card: LineCard
  state: LineRunState
  /** 本产线可选配方(继承自产品;页内派生后下发) */
  recipes: RecipeView[]
  quickBusy: string
}>()

const emit = defineEmits<{
  edit: [card: LineCard]
  remove: [card: LineCard]
  start: [card: LineCard]
  stop: [card: LineCard]
}>()

/** 待机卡的配方选择(逐线记忆;归属页面的 quickPick)。
 *  类型允许 undefined:父级用 `Record<string, string>` 逐线下发,未选过的那条线本来就没有值
 *  (noUncheckedIndexedAccess 下索引结果是 string | undefined),模板里已有 `!pick` 兜底。 */
const pick = defineModel<string | undefined>('pick')
</script>

<template>
  <div
    class="line-card aw-liftable"
    :class="{ idle: !state.active }"
    :style="{ '--lc': card.line.color }"
  >
    <div class="lc-head">
      <span class="lc-dot" />
      <b class="lc-name">{{ card.line.name }}</b>
      <span
        class="lc-state"
        :class="{ on: state.active }"
      >{{ state.active ? $t('dcw.k1eox1el055') : $t('dcw.k149r6y7059') }}</span>
      <button
        class="lc-act"
        :title="$t('common.edit')"
        @click="emit('edit', card)"
      >
        <span class="i-tabler-pencil" />
      </button>
      <button
        class="lc-act danger"
        :title="$t('dcw.k3xakp026')"
        @click="emit('remove', card)"
      >
        <span class="i-tabler-trash" />
      </button>
    </div>
    <small
      v-if="state.active"
      class="lc-run mono"
    >{{ state.productName }} · {{ state.recipeName }} · {{ $t('dcw.k3zz0f052') }} {{ state.taggedSamples }}</small>
    <small
      v-else
      class="lc-run dim"
      :class="{ ph: !card.line.description }"
    >{{ card.line.description || $t('dcw.k18moyq1056') }}</small>
    <div class="lc-stats mono">
      <span>{{ $t('dcw.k45uio011') }} <b>{{ card.nodes }}</b></span>
      <span>{{ $t('dcw.k3waz1012') }} <b>{{ card.products }}</b></span>
      <span>{{ $t('dcw.k48grv013') }} <b>{{ card.recipes }}</b></span>
    </div>
    <div class="lc-ctl">
      <template v-if="!state.active">
        <select
          v-model="pick"
          class="inp"
          :disabled="recipes.length === 0"
          :title="$t('dcw.k1dhaby4003')"
        >
          <option value="">
            {{ recipes.length ? $t('dcw.kutxzsz057') : $t('dcw.k1elczt9060') }}
          </option>
          <option
            v-for="r in recipes"
            :key="r.id"
            :value="r.id"
            :disabled="r.params.length === 0"
          >
            {{ r.name }}({{ r.params.length }})
          </option>
        </select>
        <button
          class="pill-btn"
          :disabled="quickBusy === card.line.id || !pick"
          @click="emit('start', card)"
        >
          {{ $t('dcw.k149b4vg014') }}
        </button>
      </template>
      <button
        v-else
        class="pill-btn stop"
        :disabled="quickBusy === card.line.id"
        @click="emit('stop', card)"
      >
        {{ $t('dcw.k148rclf015') }}
      </button>
    </div>
    <NuxtLink
      class="lc-manage"
      :to="`/dcw/${card.line.id}`"
    >
      {{ $t('dcw.k1fwqw5g016') }}
    </NuxtLink>
  </div>
</template>
