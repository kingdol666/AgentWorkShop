<script setup lang="ts">
/**
 * 切换 auto 控制模式 · 风险确认弹窗(产线 Co-Pilot P2 auto 治理,计划 §5.4/铁律 2)
 *
 * 由 TownAgentBindings.vue 挂载(该组件持有唯一一条 select @change 切换链,
 * 经 TownRightRail/TownAgentInspector 自 TownView 的 useTownAgentBindings 注入),
 * 状态与确认/取消回调全部来自调用方(props down / events up,不持有响应式副本)。
 * 文案键 i18n autoMode.*(五要素:影响节点/免审范围/整包护栏/切回方式/双写者提示)。
 * 手写 modal-mask 固定层惯例(与 DcwAddNodeModal 同款,scoped 各持一份副本),不用 a-modal。
 */
defineProps<{
  open: boolean
  /** 受影响节点名列表(autoMode.affected 的 {p0}) */
  nodeNames: string[]
  /** 上次确认提交失败 → 亮 autoMode.switchFail */
  fail: boolean
}>()

const emit = defineEmits<{ confirm: [], cancel: [] }>()
</script>

<template>
  <div
    v-if="open"
    class="modal-mask"
    @click.self="emit('cancel')"
  >
    <div
      class="modal"
      role="alertdialog"
      :aria-label="$t('autoMode.confirmTitle')"
    >
      <h3 class="m-title">
        {{ $t('autoMode.confirmTitle') }}
      </h3>
      <p class="m-line strong">
        {{ $t('autoMode.affected', { p0: nodeNames.join('、') }) }}
      </p>
      <p class="m-line">
        {{ $t('autoMode.exempt') }}
      </p>
      <p class="m-line">
        {{ $t('autoMode.guard') }}
      </p>
      <p class="m-line">
        {{ $t('autoMode.revert') }}
      </p>
      <p class="m-line warn">
        {{ $t('autoMode.dual') }}
      </p>
      <p
        v-if="fail"
        class="m-err"
      >
        {{ $t('autoMode.switchFail') }}
      </p>
      <div class="m-actions">
        <button
          class="pill-btn outline"
          @click="emit('cancel')"
        >
          {{ $t('autoMode.cancelBtn') }}
        </button>
        <button
          class="pill-btn danger"
          @click="emit('confirm')"
        >
          {{ $t('autoMode.confirmBtn') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   .modal-mask/.modal 在多组件出现,各持一份逐字相同的副本(惯例同 DcwAddNodeModal) */
.modal-mask { position: fixed; z-index: 50; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--scrim); backdrop-filter: blur(2px); }
.modal { width: 480px; max-width: 94vw; max-height: 88vh; overflow-y: auto; padding: 20px 22px; background: var(--surface-glass-strong); backdrop-filter: var(--aurora-blur); border: 1px solid var(--glass-line); border-radius: var(--radius-panel); box-shadow: var(--glass-edge), var(--shadow-float); }
.m-title { margin: 0 0 12px; font-size: 15.5px; }
.m-line { margin: 0 0 8px; font-size: 12px; line-height: 1.6; color: var(--ink-soft); }
.m-line.strong { color: var(--ink); font-weight: 600; }
.m-line.warn { color: var(--tone-warning-dot); }
.m-err { margin: 2px 0 6px; font-size: 12px; color: var(--tone-danger-dot); }
.m-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 14px; }

@media (max-width: 900px) {
  .modal { width: calc(100vw - 20px); max-width: calc(100vw - 20px); padding: 16px 14px; }
  .m-actions { flex-wrap: wrap; }
  .m-actions > * { flex: 1 1 auto; }
  /* 触摸目标:手持命中区 ≥40px(main.css 只在 pointer:coarse 下兜底) */
  .pill-btn { min-height: 40px; }
}
</style>
