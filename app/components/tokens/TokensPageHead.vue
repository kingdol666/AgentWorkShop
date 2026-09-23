<script setup lang="ts">
/**
 * Token 页页头:aw-page-head 规范(kicker + 大标题 + 描述)+ 当前会话标记 + 签发入口。
 *
 * 纯呈现:签发只上报点击,弹窗开合由页面持有(页头不持有任何状态)。
 */
defineProps<{
  /** 当前登录用户名(描述行左侧) */
  userName?: string
  /** 当前会话是否由某个 token 承载(命中则显示「当前会话」标记) */
  hasCurrentToken: boolean
}>()

const emit = defineEmits<{
  /** 打开「签发新 token」弹窗 */
  issue: []
}>()

function onIssue(): void {
  emit('issue')
}
</script>

<template>
  <div class="aw-page-head">
    <div>
      <p class="aw-kicker">
        agentworkshop / api tokens
      </p>
      <h1>API Token</h1>
      <p class="sub">
        {{ userName }} · {{ $t('tokens.k1upppaw026') }}
      </p>
    </div>
    <a-space class="head-actions">
      <a-tag
        v-if="hasCurrentToken"
        color="green"
      >
        {{ $t('tokens.khcxmsc006') }}
      </a-tag>
      <a-button
        type="primary"
        @click="onIssue"
      >
        <span class="i-tabler-plus" />
        {{ $t('chips.issue') }}
      </a-button>
    </a-space>
  </div>
</template>

<style scoped>
/* 描述行:.sub 在 TokensAuthGate.vue(登录门描述)另有一份同样的拷贝 ——
   有意重复(scoped 样式不能外移成公共 css),改一处同步两处。 */
.sub { margin: 8px 0 0; font-size: 12.5px; color: var(--ink-faint); }

.head-actions { padding-bottom: 4px; }

/* ══ 窄屏(v9):页头操作占满行 ══════════════════════════════════════════
   原页面里它与表格的横向卷轴规则同属一个 @media 900 块,拆组件时随各自标记走:
   操作组规则归本组件,表格规则归 TokensTable.vue。 */
@media (max-width: 900px) {
  .head-actions { width: 100%; }
  .head-actions :deep(.ant-btn) {
    flex: 1 1 100%;
    width: 100%;
    min-height: 40px;
  }
}

@media (max-width: 640px) {
  /* 窄屏字号收边:与 TokensAuthGate.vue 的同名规则有意重复(同上)。 */
  .sub { font-size: 11.5px; line-height: 1.5; }
}
</style>
