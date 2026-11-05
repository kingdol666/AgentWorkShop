<script setup lang="ts">
/**
 * 统一三态块(空 / 加载 / 错误)—— 交互宪法 §2-3。
 * 空态复用 aw-empty 全局面板语言(main.css:1705,"空态是留白问题,不是插画问题");
 * 加载态 = 发丝线骨架扫掠(刻度线母题,CSS only,reduced-motion 静止);
 * 错误态 = tone-danger 文案 + 重试。目的:让"API 挂了"与"没有数据"全站可区分,
 * 替换各页 ad-hoc 的静默留白(useDashboardData.ts:58 catch 留空一类问题)。
 */
const props = withDefaults(defineProps<{
  state: 'loading' | 'empty' | 'error'
  title?: string
  hint?: string
  retry?: () => void
  /** 紧凑档:面板内嵌场景(卡片/抽屉)用,减少留白 */
  compact?: boolean
}>(), { compact: false })

const { t } = useI18n()

const titleText = computed(() => props.title
  ?? (props.state === 'loading'
    ? t('common.stateLoading')
    : props.state === 'error' ? t('common.stateError') : t('common.stateEmpty')))
const hintText = computed(() => props.hint
  ?? (props.state === 'error' ? t('common.stateErrorHint') : ''))
</script>

<template>
  <div
    v-if="state === 'loading'"
    class="aw-state-skeleton"
    :class="{ compact }"
    aria-busy="true"
  >
    <span class="sk-line w40" />
    <span class="sk-line w90" />
    <span class="sk-line w70" />
    <span class="sk-line w55" />
  </div>
  <div
    v-else
    class="aw-empty"
    :class="{ compact }"
    role="status"
  >
    <p class="aw-empty-title">
      {{ titleText }}
    </p>
    <p
      v-if="hintText"
      class="aw-empty-sub"
    >
      {{ hintText }}
    </p>
    <button
      v-if="state === 'error' && retry"
      class="pill-btn"
      @click="retry()"
    >
      {{ $t('common.stateRetry') }}
    </button>
  </div>
</template>

<style scoped>
.aw-empty.compact { padding: 28px 0; gap: 6px; }
.aw-state-skeleton {
  display: grid;
  gap: 10px;
  padding: 28px 0;
}
.aw-state-skeleton.compact { padding: 16px 0; gap: 7px; }
.sk-line {
  height: 10px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--hover-tint), var(--paper-tint), var(--hover-tint));
  background-size: 200% 100%;
  animation: sk-sweep 1.4s ease-in-out infinite;
}
.sk-line.w40 { width: 40%; }
.sk-line.w90 { width: 90%; }
.sk-line.w70 { width: 70%; }
.sk-line.w55 { width: 55%; }
@keyframes sk-sweep {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .sk-line { animation: none; }
}
</style>
