<script setup lang="ts">
/**
 * 未登录门:没有 token 时不发请求(useMonitorData.poll 自带 token 判空),
 * 只把用户引到 /workshop 登录。
 *
 * 纯呈现,无状态、无样式需求(卡片的 .aw-panel 只作为"页面里的一张面板"标记)。
 */
const { t } = useI18n()
</script>

<template>
  <a-card class="aw-panel">
    <a-result :title="t('monitor.needLogin')">
      <template #extra>
        <a-button
          type="primary"
          @click="navigateTo('/workshop')"
        >
          {{ t('monitor.goLogin') }}
        </a-button>
      </template>
    </a-result>
  </a-card>
</template>
