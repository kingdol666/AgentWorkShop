<script setup lang="ts">
/**
 * 仪表盘状态带 —— 取代旧的大幅装饰 Hero。
 * 只回答一件事:现在全线是否正常、要去哪里处理;读数交给下方的量规带。
 * 纯呈现:数据由页面下发,组件不取数。
 */
defineProps<{
  mode: string
  linesActive: number
  linesTotal: number
  alarmCount: number
}>()

const { t } = useI18n()
</script>

<template>
  <section class="status-band aw-stagger">
    <div class="sb-main">
      <p class="sb-kicker">
        {{ t('home.kicker') }} · {{ mode }}
      </p>
      <div class="sb-title-row">
        <h1 class="sb-title">
          {{ t('home.heroTitle') }}
          <span class="aw-serif-accent-italic">{{ t('home.heroAccent') }}</span>
        </h1>
        <span
          class="sb-state"
          :class="{ warn: alarmCount > 0 }"
          role="status"
          aria-live="polite"
        >
          <i aria-hidden="true" />
          {{ alarmCount > 0 ? t('home.shift.needAttention', { p0: alarmCount }) : t('home.shift.allNormal') }}
        </span>
      </div>
      <p class="sb-sub">
        {{ t('home.heroSub') }}
      </p>
    </div>

    <div class="sb-right">
      <span class="sb-live">
        <span
          class="live-dot"
          aria-hidden="true"
        />{{ t('home.live') }}
        <span class="sb-lines mono">{{ linesActive }}/{{ linesTotal }}</span>
      </span>
      <div class="sb-acts">
        <button
          class="aw-pill im"
          type="button"
          @click="navigateTo('/town')"
        >
          <span class="i-tabler-map-2 im-pop" />
          {{ t('home.ctaTown') }}
        </button>
        <button
          class="aw-pill outline im"
          type="button"
          @click="navigateTo('/dcw')"
        >
          <span class="i-tabler-route im-pop" />
          {{ t('home.ctaLine') }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.status-band {
  display: flex;
  gap: 20px;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  margin-bottom: var(--gap-block);
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
}

.sb-main { min-width: 0; }

.sb-kicker {
  margin: 0 0 3px;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: 0.08em;
  color: var(--ink-faint);
}

.sb-title-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: center;
}

.sb-title {
  margin: 0;
  font-size: 22px;
  font-weight: 650;
  line-height: 1.2;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.sb-state {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  height: 24px;
  padding: 0 8px;
  font-size: 11.5px;
  font-weight: 550;
  color: var(--tone-success-dot);
  background: var(--tone-success-bg);
  border: 1px solid color-mix(in srgb, var(--tone-success-dot) 28%, transparent);
  border-radius: var(--radius-pill);
}

.sb-state.warn {
  color: var(--tone-warning-dot);
  background: var(--tone-warning-bg);
  border-color: color-mix(in srgb, var(--tone-warning-dot) 30%, transparent);
}

.sb-state i {
  width: 6px;
  height: 6px;
  background: currentColor;
  border-radius: 50%;
}

.sb-sub {
  display: -webkit-box;
  max-width: 78ch;
  margin: 4px 0 0;
  overflow: hidden;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--ink-soft);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.sb-right {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
}

.sb-live {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--ink-faint);
}

.sb-lines {
  padding-left: 7px;
  margin-left: 2px;
  border-left: 1px solid var(--line);
  color: var(--ink-soft);
}

.live-dot {
  width: 6px;
  height: 6px;
  background: var(--tone-success-dot);
  border-radius: 50%;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone-success-dot) 14%, transparent);
}

.sb-acts {
  display: flex;
  gap: 6px;
  align-items: center;
}

@media (max-width: 980px) {
  .status-band {
    flex-direction: column;
    align-items: stretch;
  }

  .sb-right {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
}

@media (max-width: 640px) {
  .sb-title { font-size: 19px; }
  .sb-sub { display: none; }
  .sb-right { flex-wrap: wrap; gap: 10px; }
  /* 两枚入口各自半行,完整文案不再被 105px 的窄条裁掉 */
  .sb-acts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 100%;
  }
  .sb-acts .aw-pill {
    gap: 5px;
    justify-content: center;
    min-width: 0;
    padding: 8px 10px;
    font-size: 12.5px;
    white-space: nowrap;
  }
}
</style>
