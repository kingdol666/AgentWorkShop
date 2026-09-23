<script setup lang="ts">
/**
 * 监控页页头:标题 + 视图范围徽标(本人/全量) + 自动刷新开关 + 手动刷新按钮。
 *
 * 纯呈现:快照范围、loading、开关值都由页面下发 —— 轮询与 5s 定时器只在
 * useMonitorData 里注册一次,这里只把开关变化与点击冒泡回页面。
 */
defineProps<{
  /** 视图范围(user = 本人资源 | admin = 全量);快照未到位时为 undefined */
  scope?: 'user' | 'admin'
  /** 手动刷新按钮的 loading(与自动刷新共用同一份 loading) */
  loading: boolean
}>()

const autoRefresh = defineModel<boolean>('autoRefresh', { required: true })

defineEmits<{
  /** 手动刷新一次快照 */
  refresh: []
}>()

const { t } = useI18n()
</script>

<template>
  <div class="aw-page-head">
    <div>
      <p class="aw-kicker">
        {{ t('menu.system') }} / runtime ledger
      </p>
      <h1>
        {{ t('monitor.title') }}
        <a-tag
          :color="scope === 'admin' ? 'volcano' : 'blue'"
          class="scope-tag"
        >
          <span :class="scope === 'admin' ? 'i-tabler-shield-check' : 'i-tabler-user'" />
          {{ scope === 'admin' ? $t('monitor.k16zpmg9002') : $t('monitor.k1dzryry003') }}
        </a-tag>
      </h1>
    </div>
    <div class="head-right">
      <a-switch
        v-model:checked="autoRefresh"
        size="small"
      />
      <span class="toggle-label">{{ t('monitor.autoRefresh') }}</span>
      <a-button
        size="small"
        :loading="loading"
        @click="$emit('refresh')"
      >
        <template #icon>
          <span class="i-tabler-refresh" />
        </template>
        {{ t('monitor.refresh') }}
      </a-button>
    </div>
  </div>
</template>

<style scoped>
.head-right {
  display: flex;
  gap: 10px;
  align-items: center;
}

.scope-tag {
  margin-left: 10px;
  font-size: 11.5px;
  vertical-align: 3px;
}

.toggle-label {
  font-size: 12.5px;
  color: var(--ink-soft);
}

/* 窄屏(≤899px):页头右侧操作组换行 + 标签字号收边。原页面里它与
   MonitorStatGrid 的 .stat-updated 同属一个 @media 899 块,拆组件时随各自标记走。 */
@media (max-width: 899px) {
  .head-right {
    flex-wrap: wrap;
    gap: 8px;
  }

  .toggle-label {
    font-size: 13px;
  }
}
</style>
