<script setup lang="ts">
/**
 * 仪表盘 Hero —— 产线运营中枢横幅 + LIVE 实况仪表簇。
 * 纯呈现:读数由页面下发(权威在 server 的 daq/dcw 流),组件不取数、不订阅。
 */
defineProps<{
  /** 站点运行模式(config.yml -> mode;Kicker 里的身份后缀) */
  mode: string
  linesActive: number
  linesTotal: number
  samplesStored: number
  alarmCount: number
}>()

const { t } = useI18n()
</script>

<template>
  <!-- Hero:产线运营中枢(校准仪表台母题;右侧 LIVE 实况仪表簇) -->
  <section class="hero aw-bench aw-bench--marked aw-stagger">
    <div class="hero-main">
      <p class="aw-bench-kicker">
        {{ t('home.kicker') }} · {{ mode }}
      </p>
      <h1 class="hero-title">
        {{ t('home.heroTitle') }}
        <span class="aw-serif-accent-italic">{{ t('home.heroAccent') }}</span>
      </h1>
      <p class="hero-sub">
        {{ t('home.heroSub') }}
      </p>
      <div class="hero-acts">
        <button
          class="aw-pill im"
          @click="navigateTo('/town')"
        >
          <span class="i-tabler-map-2 im-pop" />
          {{ t('home.ctaTown') }}
        </button>
        <button
          class="aw-pill outline im"
          @click="navigateTo('/dcw')"
        >
          <span class="i-tabler-route im-pop" />
          {{ t('home.ctaLine') }}
        </button>
      </div>
    </div>

    <!-- 实况仪表簇:LIVE 徽标 + 三条带刻度的读数行(读数比句子更快被扫到) -->
    <div class="hero-live">
      <span class="live-badge"><span class="live-dot" />{{ t('home.live') }}</span>
      <dl class="live-rows">
        <div class="live-row">
          <dt>{{ t('home.kpi.lines') }}</dt>
          <dd class="mono">
            <b>{{ linesActive }}</b><small>/{{ linesTotal }}</small>
          </dd>
        </div>
        <div class="live-row">
          <dt>{{ t('home.kpi.samples') }}</dt>
          <dd class="mono">
            <b>{{ samplesStored }}</b>
          </dd>
        </div>
        <div
          class="live-row"
          :class="{ 'is-alarm': alarmCount > 0 }"
        >
          <dt>{{ t('home.kpi.alarms') }}</dt>
          <dd class="mono">
            <b>{{ alarmCount }}</b>
          </dd>
        </div>
      </dl>
    </div>
    <!-- 仪表刻度母题(控制室仪器读数;纯装饰,零动画) -->
    <div
      class="hero-scale"
      aria-hidden="true"
    />
  </section>
</template>

<style scoped>
/* ---------- Hero:中枢横幅 + LIVE 实况(基座 = aw-bench,此处只写专属节奏) ---------- */
.hero {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--gap-block);
  padding: 30px 34px 32px;
  overflow: hidden;
}
/* 仪表刻度母题:底部细刻度尺(控制室仪器读数;纯装饰零动画,两端淡出) */
.hero-scale {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 9px;
  pointer-events: none;
  background:
    repeating-linear-gradient(90deg, color-mix(in srgb, var(--ink) 26%, transparent) 0 1px, transparent 1px 120px),
    repeating-linear-gradient(90deg, color-mix(in srgb, var(--ink) 11%, transparent) 0 1px, transparent 1px 24px);
  opacity: 0.55;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent);
}
.hero-main {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 620px;
}
.hero-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 36px;
  font-weight: 400;
  line-height: 1.12;
  letter-spacing: -0.015em;
  color: var(--ink);
}
.hero-sub {
  max-width: 54ch;
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-faint);
}
.hero-acts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 4px;
}
/* 实况仪表簇:左缘一道品牌刻度,与画布分节同语言 */
.hero-live {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 224px;
  padding: 15px 18px 13px;
  background: var(--frost-bg);
  border: 1px solid var(--glass-line);
  border-left: 2px solid var(--accent);
  border-radius: 0 var(--radius-panel-sm) var(--radius-panel-sm) 0;
}
.live-badge {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  width: fit-content;
  padding: 2px 10px;
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--tone-success-dot);
  border: 1px solid color-mix(in srgb, var(--tone-success-dot) 45%, transparent);
  border-radius: var(--radius-pill);
}
.live-dot {
  width: 6px;
  height: 6px;
  background: var(--tone-success-dot);
  border-radius: 50%;
}
@media (prefers-reduced-motion: no-preference) {
  .live-dot { animation: livePulse 1.6s ease-in-out infinite; }
}
@keyframes livePulse {
  0%, 100% { box-shadow: 0 0 3px var(--tone-success-dot); }
  50% { box-shadow: 0 0 9px var(--tone-success-dot); }
}
.live-rows {
  display: flex;
  flex-direction: column;
  margin: 0;
}
.live-row {
  display: flex;
  gap: 16px;
  align-items: baseline;
  justify-content: space-between;
  padding: 7px 0;
  border-top: 1px solid var(--divider-hair);
}
.live-row:first-child { padding-top: 2px; border-top: 0; }
.live-row dt {
  font-size: 11.5px;
  color: var(--ink-faint);
}
.live-row dd {
  margin: 0;
  font-size: 13.5px;
  color: var(--ink);
}
.live-row dd b { font-weight: 500; }
.live-row dd small { font-size: 11px; color: var(--ink-faint); }
.live-row.is-alarm dt,
.live-row.is-alarm dd { color: var(--tone-danger-dot); }

@media (max-width: 640px) {
  .hero { padding: 24px 20px; }
  .hero-title { font-size: 28px; }
}
</style>
