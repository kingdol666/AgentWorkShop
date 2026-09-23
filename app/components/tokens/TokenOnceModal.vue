<script setup lang="ts">
/**
 * 一次性明文回显弹窗:默认掩码,眼睛切换显示,一键复制。
 *
 * ⚠️ 明文只在创建响应里出现一次 —— 全应用只有页面的 useTokenCreate 持有它(createdRaw),
 * 本组件是纯呈现:raw / masked / revealed / copied 全部由页面下发,只上报点击意图,
 * 不复制明文、不重新计算掩码、不持有任何本地状态(关闭后由页面清空明文)。
 */
defineProps<{
  /** 弹窗开合(= 页面是否还持有明文) */
  open: boolean
  /** 创建响应里的明文(唯一副本在页面) */
  raw: string
  /** 掩码形态(由页面按明文算出,避免组件各算一份) */
  masked: string
  /** 是否已点眼睛展开 */
  revealed: boolean
  /** 是否刚复制成功(勾选图标 1.6s) */
  copied: boolean
  /** 本次创建用的标签(空则回落「未命名」) */
  label: string
}>()

const emit = defineEmits<{
  /** 眼睛切换(掩码 ↔ 明文) */
  toggle: []
  /** 复制明文 */
  copy: []
  /** 关闭(取消 / 动画结束 / 知道了):通知页面清空明文 */
  dismiss: []
}>()

function onToggle(): void {
  emit('toggle')
}

function onCopy(): void {
  emit('copy')
}

function onDismiss(): void {
  emit('dismiss')
}
</script>

<template>
  <!-- 明文回显(仅创建时一次):默认掩码,眼睛切换,一键复制 -->
  <a-modal
    :open="open"
    :title="$t('tokens.createdTitle')"
    :footer="null"
    :mask-closable="false"
    @cancel="onDismiss"
    @after-close="onDismiss"
  >
    <div class="once-banner">
      <span class="i-tabler-circle-check" />
      <span>{{ $t('tokens.k12149oy011') }}</span>
    </div>
    <div class="raw-row">
      <code class="raw">{{ revealed ? raw : masked }}</code>
      <button
        class="raw-op"
        :title="revealed ? $t('tokens.hidePlain') : $t('tokens.showPlain')"
        @click="onToggle"
      >
        <span :class="revealed ? 'i-tabler-eye-off' : 'i-tabler-eye'" />
      </button>
      <button
        class="raw-op"
        :class="{ ok: copied }"
        :title="copied ? $t('tokens.copied') : $t('tokens.copy')"
        @click="onCopy"
      >
        <span :class="copied ? 'i-tabler-check' : 'i-tabler-copy'" />
      </button>
    </div>
    <div class="once-meta">
      <span>{{ $t('tokens.k3p0p44027') }}{{ label || $t('tokens.kj3mklm028') }}</span>
      <span>{{ $t('tokens.usage') }}</span>
    </div>
    <a-button
      type="primary"
      block
      @click="onDismiss"
    >
      {{ $t('tokens.k1s5f5zd012') }}
    </a-button>
  </a-modal>
</template>

<style scoped>
.once-banner {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  margin-bottom: 12px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--tone-warning-dot);
  background: var(--tone-warning-bg);
  border-radius: var(--radius-chip);
}

.raw-row {
  display: flex;
  gap: 6px;
  align-items: stretch;
}

.raw {
  flex: 1 1 auto;
  padding: 10px 12px;
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: 0.02em;
  word-break: break-all;
  user-select: all;
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
}

.raw-op {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 42px;
  font-size: 15px;
  color: var(--ink-soft);
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
  transition: color var(--transition-fast), border-color var(--transition-fast);
}

.raw-op:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.raw-op.ok {
  color: var(--tone-success-dot);
  border-color: var(--tone-success-dot);
}

.once-meta {
  display: flex;
  gap: 14px;
  justify-content: space-between;
  margin: 10px 2px 14px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-faint);
}

@media (max-width: 640px) {
  .once-meta { flex-direction: column; gap: 4px; }
  .raw-op { width: 44px; min-height: 44px; }
}
</style>
