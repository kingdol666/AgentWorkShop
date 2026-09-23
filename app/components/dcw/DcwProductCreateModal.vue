<script setup lang="ts">
/**
 * 新建产品弹窗 —— 名称 + 描述;产品归入本产线。
 * 表单对象由页面 useDcwProducts 独占持有(经 v-model 就地读写同一 reactive 对象)。
 */
import type { DcwProductForm } from '../../pages/dcw/composables/useDcwProducts'

defineProps<{
  productSaving: boolean
  productError: string
}>()

const emit = defineEmits<{ submit: [], close: [] }>()

const productOpen = defineModel<boolean>('open', { required: true })
const productForm = defineModel<DcwProductForm>('form', { required: true })
</script>

<template>
  <div
    v-if="productOpen"
    class="modal-mask"
    @click.self="productOpen = false"
  >
    <div class="modal">
      <h3 class="m-title">
        {{ $t('dcwDetail.k1efduyf118') }}
      </h3>
      <div class="f-grid">
        <label class="f">
          <span>{{ $t('dcwDetail.k1avjrl6119') }}<em>*</em></span>
          <input
            v-model="productForm.name"
            class="inp"
            :placeholder="$t('dcwDetail.k12c11vm014')"
          >
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k40gkk096') }}</span>
          <input
            v-model="productForm.description"
            class="inp"
            :placeholder="$t('dcwDetail.k1hxx8hy015')"
          >
        </label>
      </div>
      <p
        v-if="productError"
        class="m-err"
      >
        {{ productError }}
      </p>
      <div class="m-actions">
        <button
          class="aw-pill outline"
          @click="productOpen = false"
        >
          {{ $t('dcwDetail.k3xdnn052') }}
        </button>
        <button
          class="pill-btn"
          :disabled="productSaving"
          @click="emit('submit')"
        >
          {{ productSaving ? $t('dcwDetail.k1bg4759156') : $t('dcwDetail.k1bg4kn6179') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.dim/.inp/.mini-btn/.modal-mask/.banner/.nodes-table/.sec-label/.st-pill 等)
   在此各持一份逐字相同的副本,以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */

.inp { padding: 5px 9px; font-size: 12.5px; color: var(--ink); background: var(--paper-deep); border: 1px solid var(--line-strong); border-radius: var(--radius-chip); }

.modal-mask { position: fixed; z-index: 50; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--scrim); backdrop-filter: blur(2px); }
.modal { width: 680px; max-width: 94vw; max-height: 88vh; overflow-y: auto; padding: 22px 24px; background: var(--surface-glass-strong); backdrop-filter: var(--aurora-blur); border: 1px solid var(--glass-line); border-radius: var(--radius-panel); box-shadow: var(--glass-edge), var(--shadow-float); }
.m-title { margin: 0 0 14px; font-size: 17px; }

.f-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }

.f { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-faint); }
.f em { margin-left: 3px; font-style: normal; }

.m-err { margin: 8px 0 0; font-size: 12px; color: var(--tone-danger-dot); }

.m-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.aw-pill.outline { color: var(--ink); background: var(--paper-raised); border-color: var(--line-strong); }

@media (max-width: 900px) {
/* ══ 窄屏自适应层(≤900 手持/平板竖,≤640 单列)════════════════════════════
   375px 下本页的三类实测缺陷:网关总控条右侧三件套不换行(整块顶出画布)、
   运行控制行的两个 150px 选择器 + 按钮并排超宽、微标签 9~10.5px。 */
  /* 触摸目标:手持命中区 ≥40px(main.css 只在 pointer:coarse 下兜底) */
  .pill-btn,
  .aw-pill,
  .inp {
    min-height: 40px;
  }
  /* 弹窗表单:两列/三列在窄屏一律落成一列,否则标签被压成竖排字 */
  .f-grid { grid-template-columns: 1fr; }
  .modal {
    width: calc(100vw - 20px);
    max-width: calc(100vw - 20px);
    padding: 16px 14px;
  }
  .m-actions { flex-wrap: wrap; }
  .m-actions > * { flex: 1 1 auto; }
}
</style>
