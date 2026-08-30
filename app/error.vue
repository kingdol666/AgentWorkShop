<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()

const { t } = useI18n()

const handleClear = () => clearError({ redirect: '/' })

const is404 = computed(() => props.error?.statusCode === 404)
</script>

<template>
  <div class="err-page aw-orbs">
    <div class="err-card">
      <div class="aw-kicker">
        {{ is404 ? 'not found' : 'runtime error' }}
      </div>
      <h1 class="err-code aw-display">
        {{ error?.statusCode ?? 500 }}
      </h1>
      <p class="err-message">
        {{ error?.message ?? t('error.lost') }}
      </p>
      <button
        class="aw-pill err-cta"
        @click="handleClear"
      >
        <span class="i-tabler-arrow-left" />
        {{ $t('error.backHome') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.err-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--paper);
}

.err-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
  max-width: 460px;
  padding: 40px 44px;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
}

.err-code {
  margin: 0;
  font-size: 72px;
  line-height: 1;
  color: var(--ink);
}

.err-message {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--ink-faint);
  word-break: break-word;
}

.err-cta {
  margin-top: 14px;
}
</style>
