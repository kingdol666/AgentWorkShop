<script setup lang="ts">
/**
 * 运行环境面板:uv 检测 / 一键安装 / ./aml/.venv 供给 / 资产根与磁盘 / 元数据↔实体对账。
 * 「展开任务日志」是纯呈现开关,就地持有;动作一律 emit 回页面(轮询与状态收敛在页面侧)。
 */
import { ref } from 'vue'
import { useAmlFormat } from '../../pages/aml/composables/useAmlFormat'
import type { AmlEnvStatus, AmlInventory } from '../../pages/aml/types'

defineProps<{
  env: AmlEnvStatus
  inventory: AmlInventory | null
  envBusy: boolean
  uvText: string
  uvSourceText: string
  blockerText: string
  rootSourceLabel: string
}>()

defineEmits<{
  recheck: []
  installUv: []
  createVenv: [force: boolean]
  prune: []
}>()

const envOpen = ref(false)
const { shortId } = useAmlFormat()
</script>

<template>
  <section class="aw-tile zone env-zone">
    <div class="zone-head">
      <h2>{{ $t('aml.k1amlx162') }}</h2>
      <div class="zone-actions">
        <button
          class="mini-btn"
          :disabled="envBusy"
          @click="$emit('recheck')"
        >
          {{ $t('aml.k1amlx175') }}
        </button>
        <button
          class="mini-btn"
          @click="envOpen = !envOpen"
        >
          {{ envOpen ? $t('aml.k1amlx181') : $t('aml.k1amlx180') }}
        </button>
      </div>
    </div>

    <!-- 前置条件未满足 → 醒目提示 + 直接给修复入口(不让用户等作业失败才知道) -->
    <div
      v-if="!env.preflight.canRunJobs"
      class="infra-banner"
    >
      <span class="i-tabler-alert-triangle" />
      <span class="txt">
        {{ $t('aml.k1amlx178') }}:<b class="mono">{{ blockerText }}</b>
      </span>
    </div>

    <div class="env-grid">
      <!-- uv:未安装才显示一键安装按钮 -->
      <div
        class="env-card"
        :class="env.uv.ok ? 'ok' : 'bad'"
      >
        <div class="ec-head">
          <span :class="env.uv.ok ? 'i-tabler-circle-check' : 'i-tabler-alert-triangle'" />
          <b>{{ $t('aml.k1amlx163') }}</b>
          <span class="ec-state">{{ uvText }}</span>
        </div>
        <p
          v-if="env.uv.ok"
          class="ec-detail mono"
        >
          {{ env.uv.path }}<template v-if="uvSourceText">
            · {{ uvSourceText }}
          </template>
        </p>
        <p
          v-else
          class="ec-detail"
        >
          {{ $t('aml.k1amlx177') }}
        </p>
        <div class="ec-actions">
          <button
            v-if="!env.uv.ok"
            class="mini-btn primary"
            :disabled="envBusy"
            :title="$t('aml.k1amlx176')"
            @click="$emit('installUv')"
          >
            <span class="i-tabler-download" />
            {{ env.task?.kind === 'install-uv' && env.task.status === 'running' ? $t('aml.k1amlx167') : $t('aml.k1amlx166') }}
          </button>
        </div>
      </div>

      <!-- .venv 训练环境 -->
      <div
        class="env-card"
        :class="env.venv.ready ? 'ok' : 'bad'"
      >
        <div class="ec-head">
          <span :class="env.venv.ready ? 'i-tabler-circle-check' : 'i-tabler-alert-triangle'" />
          <b>{{ $t('aml.k1amlx168') }}</b>
          <span class="ec-state">{{ env.venv.ready ? $t('aml.k1amlx007') : $t('aml.k1amlx008') }}</span>
        </div>
        <p class="ec-detail mono">
          {{ env.venv.dir }}
          <template v-if="env.venv.ready">
            · {{ env.venv.sizeMb }} MB
          </template>
        </p>
        <div class="ec-actions">
          <button
            class="mini-btn primary"
            :disabled="envBusy || !env.python.ok"
            :title="env.python.ok ? '' : (env.python.reason ?? '')"
            @click="$emit('createVenv', false)"
          >
            <span class="i-tabler-plus" />
            {{ env.task?.kind === 'create-venv' && env.task.status === 'running' ? $t('aml.k1amlx170') : $t('aml.k1amlx168') }}
          </button>
          <button
            v-if="env.venv.ready"
            class="mini-btn"
            :disabled="envBusy"
            @click="$emit('createVenv', true)"
          >
            {{ $t('aml.k1amlx169') }}
          </button>
        </div>
      </div>

      <!-- 资产根与磁盘 -->
      <div class="env-card">
        <div class="ec-head">
          <span class="i-tabler-folder" />
          <b>{{ $t('aml.k1amlx171') }}</b>
        </div>
        <p class="ec-detail mono">
          {{ env.amlRoot }}
        </p>
        <p class="ec-detail dim">
          {{ $t('aml.k1amlx201') }}
        </p>
        <p class="ec-detail">
          {{ $t('aml.k1amlx174') }}:
          <b class="mono">{{ env.disk.usedMb }} / {{ env.disk.quotaMb }} MB</b>
          <span class="dim"> · {{ rootSourceLabel }}</span>
        </p>
      </div>

      <!-- 元数据 ↔ 实体对账 -->
      <div
        class="env-card"
        :class="inventory == null ? '' : (inventory.ok ? 'ok' : 'bad')"
      >
        <div class="ec-head">
          <span :class="inventory?.ok === false ? 'i-tabler-alert-triangle' : 'i-tabler-database'" />
          <b>{{ $t('aml.k1amlx182') }}</b>
          <span
            v-if="inventory"
            class="ec-state"
          >{{ inventory.ok ? $t('aml.k1amlx183') : $t('aml.k1amlx184') }}</span>
        </div>
        <p
          v-if="inventory"
          class="ec-detail mono"
        >
          {{ $t('aml.k1amlx011') }} {{ inventory.counts.datasets }}/{{ inventory.entities.datasets }}
          · {{ $t('aml.k1amlx010') }} {{ inventory.counts.jobs }}/{{ inventory.entities.jobs }}
          · {{ $t('aml.k1amlx012') }} {{ inventory.counts.models }}/{{ inventory.entities.models }}
        </p>
        <ul
          v-if="inventory && inventory.issues.length > 0"
          class="ec-issues mono"
        >
          <li
            v-for="is in inventory.issues.slice(0, 5)"
            :key="`${is.kind}:${is.id}:${is.problem}`"
            :title="is.detail"
          >
            <span class="tag">{{ is.problem === 'entity_missing' ? $t('aml.k1amlx185') : is.problem === 'orphan_dir' ? $t('aml.k1amlx186') : $t('aml.k1amlx187') }}</span>
            {{ is.kind }} {{ shortId(is.id) }}
          </li>
        </ul>
        <div class="ec-actions">
          <button
            v-if="inventory && inventory.issues.some(i => i.problem === 'orphan_dir')"
            class="mini-btn"
            @click="$emit('prune')"
          >
            <span class="i-tabler-trash" />
            {{ $t('aml.k1amlx188') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 环境任务进度(安装 uv / 建 venv 都是分钟级动作,必须可见可等) -->
    <div
      v-if="env.task && envOpen"
      class="env-task"
    >
      <div class="et-head mono">
        <span :class="env.task.status === 'running' ? 'i-tabler-loader-2 spin' : env.task.status === 'done' ? 'i-tabler-circle-check' : 'i-tabler-alert-triangle'" />
        <b>{{ env.task.kind }}</b>
        <span class="dim">{{ env.task.status }}</span>
        <span
          v-if="env.task.status === 'running'"
          class="dim"
        >· {{ $t('aml.k1amlx179') }}</span>
      </div>
      <pre class="et-log mono">{{ env.task.log.slice(-40).join('\n') }}</pre>
      <p
        v-if="env.task.error"
        class="err"
      >
        {{ env.task.error }}
      </p>
    </div>
  </section>
</template>

<style scoped src="../../pages/aml/styles.css"></style>
