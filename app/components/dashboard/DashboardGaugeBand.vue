<script setup lang="ts">
/**
 * 仪表盘量规统计带 —— 一排 6 格仪表读数(KPI)。
 * 纯呈现:读数由页面下发,组件不取数;列数按可用宽度收敛靠 .aw-gauge-band 的 --cols。
 */
defineProps<{
  linesActive: number
  linesTotal: number
  dcwOnline: number
  dcwTotal: number
  daqOnline: number
  daqTotal: number
  samplesStored: number
  writeRate: number
  alarmCount: number
}>()

const { t } = useI18n()
</script>

<template>
  <!-- 量规统计带:一块仪表盘,不是一排各自为政的卡(底部量程刻度是签名) -->
  <div class="aw-gauge-band aw-stagger">
    <div class="aw-gauge">
      <span class="aw-gauge-label">{{ t('home.kpi.lines') }}</span>
      <span class="aw-gauge-value">
        <span class="aw-readout">{{ linesActive }}<small>/{{ linesTotal }}</small></span>
      </span>
    </div>
    <div class="aw-gauge">
      <span class="aw-gauge-label">{{ t('home.kpi.dcwNodes') }}</span>
      <span class="aw-gauge-value">
        <span class="aw-readout">{{ dcwOnline }}<small>/{{ dcwTotal }}</small></span>
      </span>
    </div>
    <div class="aw-gauge">
      <span class="aw-gauge-label">{{ t('home.kpi.daqNodes') }}</span>
      <span class="aw-gauge-value">
        <span class="aw-readout">{{ daqOnline }}<small>/{{ daqTotal }}</small></span>
      </span>
    </div>
    <div class="aw-gauge">
      <span class="aw-gauge-label">{{ t('home.kpi.samples') }}</span>
      <span class="aw-gauge-value">
        <span class="aw-readout">{{ samplesStored }}</span>
      </span>
    </div>
    <div class="aw-gauge">
      <span class="aw-gauge-label">{{ t('home.kpi.writeRate') }}</span>
      <span class="aw-gauge-value">
        <span class="aw-readout">{{ writeRate }}<small>%</small></span>
      </span>
    </div>
    <div
      class="aw-gauge"
      :class="{ 'is-alarm': alarmCount > 0 }"
    >
      <span class="aw-gauge-label">{{ t('home.kpi.alarms') }}</span>
      <span class="aw-gauge-value">
        <span class="aw-readout">{{ alarmCount }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
/* ---------- 量规统计带:列数按可用宽度收敛(6 → 3 → 2,永不挤成一条) ---------- */
.aw-gauge-band {
  --cols: 6;
  margin-bottom: var(--gap-block);
}
@media (max-width: 1240px) {
  .aw-gauge-band { --cols: 3; }
}
@media (max-width: 720px) {
  .aw-gauge-band { --cols: 2; }
}
</style>
